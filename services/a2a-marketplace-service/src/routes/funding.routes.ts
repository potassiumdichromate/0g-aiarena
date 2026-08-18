/**
 * Escrow funding, from the browser.
 *
 * The creator signs a USDC EIP-3009 authorization and the relayer submits it,
 * so the creator needs no ETH on Base. That means the browser only ever
 * produces a signature; the transaction itself is relayed server-side, where
 * the internal key lives.
 *
 * Split in two on purpose:
 *
 *   GET  /funding-request  everything the wallet must sign, including a fresh
 *                          nonce. Nothing is stored, so a user who abandons
 *                          the flow leaves no half-state.
 *   POST /fund             the signature comes back, is combined with the
 *                          agreement and both agent signatures already on
 *                          record, and is relayed.
 *
 * The agreement and its two signatures are never sent to the browser for
 * re-submission. They are read from storage at funding time, so a tampered
 * client cannot fund different terms than the ones that were negotiated.
 */

import { randomBytes } from 'crypto';
import { FastifyInstance } from 'fastify';
import { prisma } from '@ai-arena/db-client';
import { formatUsdc } from '@ai-arena/a2a-protocol';
import { requireAuth, assertOwnsJobCreator } from '../middleware/auth';

const BASE_CHAIN_SERVICE_URL = process.env.BASE_CHAIN_SERVICE_URL ?? 'http://localhost:8051';
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BASE_CHAIN_ID = 8453;

/** How long the signed authorization stays valid. */
const AUTHORIZATION_TTL_SECONDS = 30 * 60;

export async function fundingRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /jobs/:jobId/funding-request
   *
   * The exact EIP-712 payload the creator's wallet must sign. Read-only.
   */
  app.get('/:jobId/funding-request', { onRequest: [requireAuth(app)] as never }, async (req, reply) => {
    const { jobId } = req.params as { jobId: string };

    if (!(await assertOwnsJobCreator(req, reply, jobId))) return;

    const job = await prisma.a2AJob.findUniqueOrThrow({ where: { id: jobId } });

    if (job.status !== 'POSTED') {
      return reply.status(400).send({
        error: `Job is ${job.status}. Only a POSTED job with a signed agreement can be funded.`,
      });
    }

    const negotiation = await prisma.a2ANegotiation.findFirst({
      where: { jobId, agreementHash: { not: null } },
      orderBy: { updatedAt: 'desc' },
    });

    if (!negotiation?.agreedPriceBaseUnits) {
      return reply.status(400).send({
        error: 'No signed agreement on this job yet. Agree a price and sign before funding.',
      });
    }
    if (!negotiation.creatorSignature || !negotiation.providerSignature) {
      return reply.status(400).send({
        error: 'The agreement is not signed by both agents yet.',
      });
    }

    const now = Math.floor(Date.now() / 1000);

    return {
      jobId,
      amount: {
        baseUnits: negotiation.agreedPriceBaseUnits,
        display: formatUsdc(negotiation.agreedPriceBaseUnits),
        currency: 'USDC',
      },
      // What the wallet signs. Mirrors USDC's own ReceiveWithAuthorization
      // type exactly; a mismatch here fails signature recovery inside the token
      // rather than in our contract, which is a confusing place to debug.
      typedData: {
        domain: {
          name: 'USD Coin',
          version: '2',
          chainId: BASE_CHAIN_ID,
          verifyingContract: BASE_USDC,
        },
        types: {
          ReceiveWithAuthorization: [
            { name: 'from', type: 'address' },
            { name: 'to', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'validAfter', type: 'uint256' },
            { name: 'validBefore', type: 'uint256' },
            { name: 'nonce', type: 'bytes32' },
          ],
        },
        primaryType: 'ReceiveWithAuthorization',
        message: {
          from: job.creatorWallet,
          to: process.env.A2A_JOB_ESCROW_ADDRESS,
          value: negotiation.agreedPriceBaseUnits,
          validAfter: '0',
          validBefore: String(now + AUTHORIZATION_TTL_SECONDS),
          // Single-use on the token side, so a replayed authorization is
          // rejected by USDC itself rather than relying on our checks.
          nonce: `0x${randomBytes(32).toString('hex')}`,
        },
      },
    };
  });

  /**
   * POST /jobs/:jobId/fund
   *
   * Body is the signed authorization only. The agreement and both agent
   * signatures come from storage, never from the client.
   */
  app.post('/:jobId/fund', { onRequest: [requireAuth(app)] as never }, async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    const auth = (req.body ?? {}) as {
      signature?: string;
      value?: string;
      validAfter?: string;
      validBefore?: string;
      nonce?: string;
    };

    if (!(await assertOwnsJobCreator(req, reply, jobId))) return;

    for (const field of ['signature', 'value', 'validBefore', 'nonce'] as const) {
      if (!auth[field]) return reply.status(400).send({ error: `${field} is required` });
    }

    const job = await prisma.a2AJob.findUniqueOrThrow({ where: { id: jobId } });
    const negotiation = await prisma.a2ANegotiation.findFirst({
      where: { jobId, agreementHash: { not: null } },
      orderBy: { updatedAt: 'desc' },
    });

    if (!negotiation?.agreedPriceBaseUnits || !negotiation.creatorSignature || !negotiation.providerSignature) {
      return reply.status(400).send({ error: 'This job has no fully signed agreement' });
    }

    // The signed amount must equal the agreed price. A client that signs a
    // smaller authorization would otherwise under-fund the escrow.
    if (auth.value !== negotiation.agreedPriceBaseUnits) {
      return reply.status(400).send({
        error: `Authorization is for ${auth.value} but the agreed price is ${negotiation.agreedPriceBaseUnits}`,
      });
    }

    const creatorIdentity = await prisma.agentBaseIdentity.findUniqueOrThrow({
      where: { agentId: job.creatorAgentId },
    });

    try {
      const response = await fetch(`${BASE_CHAIN_SERVICE_URL}/settlement/jobs/${jobId}/fund`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Service-Key': process.env.INTERNAL_SERVICE_SECRET ?? '',
        },
        body: JSON.stringify({
          agreement: {
            jobId,
            creatorAgentId: job.creatorErc8004Id,
            providerAgentId: negotiation.providerErc8004Id,
            providerWallet: negotiation.providerWallet,
            agreedPrice: negotiation.agreedPriceBaseUnits,
            requirementsHash: job.requirementsHash,
            executionWindow: job.executionWindowSeconds,
            transcriptHash: negotiation.transcriptHash,
            expiry: negotiation.agreementExpiry,
          },
          creatorSigner: creatorIdentity.eoaAddress,
          creatorSignature: negotiation.creatorSignature,
          providerSigner: negotiation.providerWallet,
          providerSignature: negotiation.providerSignature,
          authorization: {
            from: job.creatorWallet,
            to: process.env.A2A_JOB_ESCROW_ADDRESS,
            value: auth.value,
            validAfter: auth.validAfter ?? '0',
            validBefore: auth.validBefore,
            nonce: auth.nonce,
            signature: auth.signature,
          },
        }),
      });

      const body = await response.json();
      if (!response.ok) {
        return reply.status(response.status === 401 ? 502 : response.status).send(body);
      }

      await prisma.a2AJob.update({
        where: { id: jobId },
        data: {
          status: 'ESCROWED',
          agreedPriceBaseUnits: negotiation.agreedPriceBaseUnits,
          providerAgentId: negotiation.providerAgentId,
          providerErc8004Id: negotiation.providerErc8004Id,
          agreementHash: negotiation.agreementHash,
          fundTxHash: (body as { txHash?: string }).txHash ?? null,
          fundedAt: new Date(),
          lastError: null,
        },
      });

      return body;
    } catch (err) {
      return reply.status(502).send({ error: `Funding failed: ${(err as Error).message}` });
    }
  });
}
