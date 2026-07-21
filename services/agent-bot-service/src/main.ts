/**
 * agent-bot-service
 *
 * Keeps a trickle of filler agents flowing into the arena so real players
 * always have someone to face -- one agent per cycle, at a random interval
 * (default 30-60 min), forever. Each agent gets its own throwaway account
 * (randomly generated wallet address, not a real key) via identity-service's
 * /auth/bot-register, then POST /v1/agents through the public gateway --
 * the exact same path a real client would use, so it gets the full
 * personality-gen / 0G storage / INFT mint pipeline, not a shortcut.
 *
 * Deliberately NOT a batch/bulk minter: one agent, sleep, repeat.
 */

import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import { randomAgentPayload, randomIntervalMs } from './generators';

const PORT = parseInt(process.env.PORT ?? '8070', 10);
const GATEWAY_URL = (process.env.GATEWAY_URL ?? 'http://localhost:8000').replace(/\/$/, '');
const BOT_SECRET = process.env.BOT_REGISTRATION_SECRET ?? '';
const MIN_INTERVAL_MINUTES = Number(process.env.MIN_INTERVAL_MINUTES ?? 30);
const MAX_INTERVAL_MINUTES = Number(process.env.MAX_INTERVAL_MINUTES ?? 60);
const MINT_ON_STARTUP = (process.env.MINT_ON_STARTUP ?? 'true') !== 'false';

let mintedCount = 0;
let lastMintAt: string | null = null;
let lastAgent: { id: string; name: string; walletAddress: string } | null = null;
let lastError: string | null = null;
let stopped = false;
let timer: NodeJS.Timeout | null = null;

async function registerBotUser(): Promise<{ accessToken: string; walletAddress: string }> {
  const res = await fetch(`${GATEWAY_URL}/v1/auth/bot-register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Bot-Secret': BOT_SECRET },
    body: JSON.stringify({ label: 'agent-bot-service' }),
  });
  if (!res.ok) {
    throw new Error(`bot-register failed: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<{ accessToken: string; walletAddress: string }>;
}

async function createAgent(accessToken: string): Promise<{ id: string; name: string }> {
  const res = await fetch(`${GATEWAY_URL}/v1/agents`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(randomAgentPayload()),
  });
  if (!res.ok) {
    throw new Error(`agent creation failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { agent: { id: string; name: string } };
  return body.agent;
}

async function mintOne(): Promise<void> {
  const { walletAddress, accessToken } = await registerBotUser();
  const agent = await createAgent(accessToken);

  mintedCount += 1;
  lastMintAt = new Date().toISOString();
  lastAgent = { id: agent.id, name: agent.name, walletAddress };
  lastError = null;
  console.log(
    `[agent-bot] minted "${agent.name}" (${agent.id}) under wallet ${walletAddress} — total minted: ${mintedCount}`,
  );
}

function scheduleNext(): void {
  if (stopped) return;
  const delay = randomIntervalMs(MIN_INTERVAL_MINUTES, MAX_INTERVAL_MINUTES);
  console.log(`[agent-bot] next mint in ~${Math.round(delay / 60_000)} min`);
  timer = setTimeout(runCycle, delay);
}

async function runCycle(): Promise<void> {
  try {
    await mintOne();
  } catch (err) {
    lastError = (err as Error).message;
    console.error('[agent-bot] mint cycle failed:', lastError);
  }
  scheduleNext();
}

async function bootstrap(): Promise<void> {
  const app = Fastify({ logger: true });
  await app.register(helmet);

  app.get('/health', async () => ({
    status:              'ok',
    service:             'agent-bot-service',
    botSecretConfigured: Boolean(BOT_SECRET),
    mintedCount,
    lastMintAt,
    lastAgent,
    lastError,
    minIntervalMinutes: MIN_INTERVAL_MINUTES,
    maxIntervalMinutes: MAX_INTERVAL_MINUTES,
  }));

  await app.listen({ port: PORT, host: '0.0.0.0' });
  app.log.info(`agent-bot-service running on port ${PORT}`);

  if (!BOT_SECRET) {
    app.log.error('BOT_REGISTRATION_SECRET is not set — mint loop will not start.');
  } else if (MINT_ON_STARTUP) {
    runCycle();
  } else {
    scheduleNext();
  }

  const shutdown = async (signal: string) => {
    app.log.info(`${signal} received — shutting down`);
    stopped = true;
    if (timer) clearTimeout(timer);
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

process.on('uncaughtException', (err) => {
  console.error('[agent-bot] uncaught exception:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[agent-bot] unhandled rejection:', reason);
});

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
