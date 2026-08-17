/**
 * Identity routes.
 *
 * Auth follows arena-chain-service's convention exactly: GETs are open
 * (everything they expose is already public on Base and the registration file
 * MUST be openly fetchable — it is a tokenURI, and a foreign agent resolving
 * it has no KULT credentials), writes require X-Service-Key.
 */

import { FastifyInstance } from 'fastify';
import {
  ensureIdentity,
  getIdentity,
  getCardForServing,
  verifyOnChain,
  transferIdentityToOwner,
  signAsAgent,
  signTypedDataAsAgent,
} from '../agent-identity.service';
import { basescanTx, basescanToken } from '../config';

export async function identityRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /identity/agents/:agentId/registration.json
   *
   * The ERC-8004 tokenURI target. Serves the exact bytes whose Merkle root was
   * committed at registration — fetched back from 0G Storage rather than
   * regenerated, so the served document always matches its published hash even
   * after the agent's stats change.
   */
  app.get('/agents/:agentId/registration.json', async (req, reply) => {
    const { agentId } = req.params as { agentId: string };
    try {
      const { body, rootHash } = await getCardForServing(agentId);
      return reply
        .header('Content-Type', 'application/json')
        // Lets a verifier check the blob without a round-trip through our API.
        .header('X-0G-Storage-Root-Hash', rootHash ?? '')
        .header('Cache-Control', 'public, max-age=300')
        .send(body);
    } catch (err) {
      return reply.status(404).send({ error: (err as Error).message });
    }
  });

  /** GET /identity/agents/:agentId — local record + explorer links. */
  app.get('/agents/:agentId', async (req, reply) => {
    const { agentId } = req.params as { agentId: string };
    const identity = await getIdentity(agentId);
    if (!identity) return reply.status(404).send({ error: 'Agent has no Base identity yet' });

    return {
      identity,
      explorer: {
        registerTx: identity.registerTxHash ? basescanTx(identity.registerTxHash) : null,
        setWalletTx: identity.setWalletTxHash ? basescanTx(identity.setWalletTxHash) : null,
        token: identity.erc8004AgentId ? basescanToken(identity.erc8004AgentId) : null,
      },
    };
  });

  /**
   * GET /identity/agents/:agentId/verify
   * Reads Base directly — deliberately does not consult our DB for the answer,
   * only for which tokenId to look up.
   */
  app.get('/agents/:agentId/verify', async (req, reply) => {
    const { agentId } = req.params as { agentId: string };
    try {
      return await verifyOnChain(agentId);
    } catch (err) {
      return reply.status(404).send({ error: (err as Error).message });
    }
  });

  /** POST /identity/agents/:agentId/register — idempotent, resumable. */
  app.post('/agents/:agentId/register', async (req, reply) => {
    const { agentId } = req.params as { agentId: string };
    try {
      const identity = await ensureIdentity(agentId);
      return reply.status(201).send({
        identity,
        explorer: {
          registerTx: identity.registerTxHash ? basescanTx(identity.registerTxHash) : null,
          token: identity.erc8004AgentId ? basescanToken(identity.erc8004AgentId) : null,
        },
      });
    } catch (err) {
      return reply.status(502).send({ error: (err as Error).message });
    }
  });

  /** POST /identity/agents/:agentId/transfer-to-owner — hand NFT custody to the human. */
  app.post('/agents/:agentId/transfer-to-owner', async (req, reply) => {
    const { agentId } = req.params as { agentId: string };
    try {
      const result = await transferIdentityToOwner(agentId);
      return { ...result, explorer: basescanTx(result.txHash) };
    } catch (err) {
      return reply.status(502).send({ error: (err as Error).message });
    }
  });

  /** POST /identity/agents/:agentId/sign — sign a payload as this agent. */
  app.post('/agents/:agentId/sign', async (req, reply) => {
    const { agentId } = req.params as { agentId: string };
    const { message } = (req.body ?? {}) as { message?: string };
    if (!message) return reply.status(400).send({ error: 'message is required' });

    try {
      return await signAsAgent(agentId, message);
    } catch (err) {
      return reply.status(404).send({ error: (err as Error).message });
    }
  });
  /**
   * POST /identity/agents/:agentId/sign-typed-data
   *
   * Sign EIP-712 typed data as an agent. Internal only — this is the single
   * place an agent private key is used, so the marketplace service can compose
   * negotiation offers and agreements without ever holding one.
   */
  app.post('/agents/:agentId/sign-typed-data', async (req, reply) => {
    const { agentId } = req.params as { agentId: string };
    const body = (req.body ?? {}) as { domain?: any; types?: any; value?: any };

    if (!body.domain || !body.types || !body.value) {
      return reply.status(400).send({ error: 'domain, types and value are required' });
    }

    try {
      return await signTypedDataAsAgent(agentId, body.domain, body.types, body.value);
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });
}
