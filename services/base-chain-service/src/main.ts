/**
 * base-chain-service — the only relayer/signer for KULT on Base mainnet.
 *
 * Holds the single Base relayer key (BASE_RELAYER_PRIVATE_KEY) and is the only
 * thing in the system that submits Base transactions. Every other service asks
 * it over HTTP (X-Service-Key, same trust boundary as inft-service and
 * arena-chain-service) rather than holding its own key.
 *
 * Scope by phase (docs/architecture/A2A_MARKETPLACE_BASE.md):
 *   Phase 1 (this)  ERC-8004 agent identity on the canonical registries
 *   Phase 6         A2AJobEscrow relaying + USDC settlement
 *   Phase 8         ERC-8004 reputation feedback on settlement
 *
 * Explicitly unrelated to services/okx-payment-proxy, which serves OKX.AI on X
 * Layer and is not touched by any of this.
 */

import Fastify, { FastifyRequest, FastifyReply, FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { identityRoutes } from './routes/identity.routes';
import { jobRoutes } from './routes/job.routes';
import { settlementRoutes } from './routes/settlement.routes';
import { attributionStatus } from './attribution';
import { reputationRoutes } from './routes/reputation.routes';
import { assertEncryptionConfigured } from './crypto';
import { getRelayerAddress, relayerBalanceEth, getProvider } from './contracts';
import {
  BASE_CHAIN_ID,
  ERC8004_IDENTITY_REGISTRY,
  ERC8004_REPUTATION_REGISTRY,
  BASE_USDC,
} from './config';

const PORT = parseInt(process.env.PORT ?? '8051', 10);
const SERVICE_NAME = 'base-chain-service';

/** Relayer balance below this and registrations will start failing. */
const LOW_BALANCE_ETH = 0.0005;

/** Public-safe classification of a relayer failure. Never echoes the raw error. */
function classifyRelayerError(err: unknown): string {
  const message = (err as Error)?.message ?? "";

  if (/invalid BytesLike|invalid private key|incorrect data length|invalid arrayify/i.test(message)) {
    return "BASE_RELAYER_PRIVATE_KEY is malformed. Check for a trailing newline or wrapped paste.";
  }
  if (/not configured|is not configured/i.test(message)) return "A required environment variable is not set.";
  if (/could not detect network|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|fetch failed/i.test(message)) return "Base RPC unreachable.";
  return "Relayer check failed. See service logs.";
}

/**
 * Accept POSTs that carry a JSON content-type but no body.
 *
 * Several endpoints here take no arguments — confirming a job, signing an
 * agreement, registering an identity. Browsers and HTTP clients routinely set
 * Content-Type: application/json on any POST, and Fastify's default parser
 * rejects an empty body in that case with FST_ERR_CTP_EMPTY_JSON_BODY.
 *
 * Treating an empty body as {} is the behaviour callers expect, and it means
 * an argument-free endpoint does not need every client to remember to send a
 * placeholder object.
 */
function acceptEmptyJsonBody(app: FastifyInstance): void {
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const raw = typeof body === 'string' ? body.trim() : '';
    if (raw === '') return done(null, {});
    try {
      done(null, JSON.parse(raw));
    } catch (err) {
      (err as Error & { statusCode?: number }).statusCode = 400;
      done(err as Error, undefined);
    }
  });
}

async function bootstrap(): Promise<void> {
  const app = Fastify({ logger: true });

  await app.register(cors, { origin: true });
  await app.register(helmet);
  acceptEmptyJsonBody(app);

  // GETs are open: everything they return is already public on Base, and
  // /registration.json must be fetchable by foreign agents that hold no KULT
  // credentials. Writes move real value and are internal-only.
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.routerPath === '/health') return;
    if (req.method === 'GET') return;

    const internalSecret = process.env.INTERNAL_SERVICE_SECRET;
    if (!internalSecret) {
      return reply.status(503).send({ error: 'INTERNAL_SERVICE_SECRET not configured' });
    }
    if (req.headers['x-service-key'] !== internalSecret) {
      return reply.status(401).send({ error: 'Invalid or missing X-Service-Key' });
    }
  });

  app.get('/health', async () => {
    // Report degraded rather than unhealthy on RPC/balance trouble: identity
    // reads still work, only writes are at risk, and flapping the health check
    // would take the service out of rotation for a recoverable condition.
    let relayer: Record<string, unknown> = { configured: false };
    try {
      const [balanceEth, blockNumber] = await Promise.all([
        relayerBalanceEth(),
        getProvider().getBlockNumber(),
      ]);
      relayer = {
        configured: true,
        address: getRelayerAddress(),
        balanceEth,
        lowBalance: Number(balanceEth) < LOW_BALANCE_ETH,
        blockNumber,
      };
    } catch (err) {
      // Same hazard as evaluation-service: /health is public and ethers puts
      // the offending value in its message, so a malformed relayer key would
      // be served to anyone. Classify, and log the real error privately.
      relayer = { configured: false, error: classifyRelayerError(err) };
      app.log.error({ err }, 'relayer health check failed');
    }

    return {
      status: 'ok',
      service: SERVICE_NAME,
      chain: { name: 'base', chainId: BASE_CHAIN_ID },
      contracts: {
        identityRegistry: ERC8004_IDENTITY_REGISTRY,
        reputationRegistry: ERC8004_REPUTATION_REGISTRY,
        usdc: BASE_USDC,
      },
      relayer,
      // ERC-8021 attribution fails silently when misconfigured — a bad builder
      // code just means transactions go untagged, with no error anywhere.
      // Surfacing it here is the only way to notice.
      attribution: attributionStatus(),
    };
  });

  await app.register(identityRoutes, { prefix: '/identity' });
  await app.register(jobRoutes, { prefix: '/jobs' });
  await app.register(settlementRoutes, { prefix: '/settlement' });
  await app.register(reputationRoutes, { prefix: '/reputation' });

  // Fail at boot, not on the first agent registration, if the encryption
  // secret is missing or malformed.
  assertEncryptionConfigured();

  await app.listen({ port: PORT, host: '0.0.0.0' });
  app.log.info(`${SERVICE_NAME} listening on :${PORT} (Base mainnet, chainId ${BASE_CHAIN_ID})`);
}

bootstrap().catch((err) => {
  console.error(`[${SERVICE_NAME}] Failed to start:`, err);
  process.exit(1);
});
