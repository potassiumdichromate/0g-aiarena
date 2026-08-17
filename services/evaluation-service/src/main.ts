/**
 * evaluation-service — the verifier.
 *
 * Holds VERIFIER_ROLE and nothing else. Separate service and separate key from
 * base-chain-service's relayer by design: one drives a job's state, the other
 * judges its outcome (threat T3).
 *
 * Verdicts are never based on a number the provider supplied. The Python
 * evaluation worker independently re-runs the seeded harness against the
 * delivered checkpoint under a fresh seed root; this service settles on that.
 */

import Fastify, { FastifyRequest, FastifyReply, FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { pendingVerdicts, roleCheck, verifierAddress, verifyAndSettle } from './verifier.service';

const PORT = parseInt(process.env.PORT ?? '8081', 10);
const SERVICE_NAME = 'evaluation-service';

/**
 * Turn an error into something safe to serve publicly.
 *
 * ethers puts the offending value straight into its message, so echoing a
 * wallet-construction failure leaks the private key. Every branch here returns
 * a fixed string; the real error goes to the logs, which are not public.
 */
function classifyRoleError(err: unknown): string {
  const message = (err as Error)?.message ?? "";

  if (/invalid BytesLike|invalid private key|incorrect data length|invalid arrayify/i.test(message)) {
    return "A2A_VERIFIER_PRIVATE_KEY is malformed. Check for a trailing newline or wrapped paste.";
  }
  if (/not configured|is not configured/i.test(message)) {
    return "A required environment variable is not set.";
  }
  if (/could not detect network|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|fetch failed/i.test(message)) {
    return "Base RPC unreachable.";
  }
  if (/call revert|BAD_DATA|CALL_EXCEPTION/i.test(message)) {
    return "Escrow call failed. Check A2A_JOB_ESCROW_ADDRESS points at a deployed A2AJobEscrow.";
  }
  return "Verifier role check failed. See service logs.";
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

  // Everything except /health moves real money or reveals the verifier key's
  // address; internal callers only.
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.url.startsWith('/health')) return;
    const provided = req.headers['x-service-key'];
    const expected = process.env.INTERNAL_SERVICE_SECRET;
    if (!expected || provided !== expected) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
  });

  /**
   * Reports whether this key actually holds VERIFIER_ROLE. A misconfigured
   * verifier looks healthy right up until the first verdict reverts, so the
   * role check is part of the health signal rather than a separate endpoint.
   */
  app.get('/health', async () => {
    let role: unknown = null;
    try {
      role = await roleCheck();
    } catch (err) {
      // NEVER return the raw error here. /health is public and unauthenticated,
      // and ethers embeds the offending value in its message — so a malformed
      // A2A_VERIFIER_PRIVATE_KEY (a trailing newline is enough) put the key
      // material itself on a public URL. Classify instead of echoing.
      role = { error: classifyRoleError(err), configured: !!process.env.A2A_VERIFIER_PRIVATE_KEY };
      app.log.error({ err }, 'verifier role check failed');
    }
    return { status: 'ok', service: SERVICE_NAME, role };
  });

  app.get('/pending', async (req) => {
    const { limit } = req.query as { limit?: string };
    return { pending: await pendingVerdicts(limit ? Number(limit) : undefined) };
  });

  app.post('/jobs/:jobId/verify', async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    try {
      return await verifyAndSettle(jobId);
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });

  await app.listen({ port: PORT, host: '0.0.0.0' });
  app.log.info(`${SERVICE_NAME} listening on :${PORT} as verifier ${safeAddress()}`);
}

function safeAddress(): string {
  try { return verifierAddress(); } catch { return '(A2A_VERIFIER_PRIVATE_KEY not set)'; }
}

bootstrap().catch((err) => {
  console.error(`[${SERVICE_NAME}] Failed to start:`, err);
  process.exit(1);
});
