/**
 * OkxBridgeService — wraps AgentService.createAgent() for the OKX Agent
 * Marketplace A2MCP "create arena agent" service.
 *
 * Why this exists rather than reusing POST /agents directly:
 *   - The caller isn't an AI Arena user — there's no JWT/userId. Agents created
 *     this way are owned by a single system account (see ensureSystemUser).
 *   - A2MCP is pay-per-call with no sandbox and no arbitration path (per
 *     docs/okx/okx_context.md) — a retried/duplicated call must not create a
 *     second agent, hence the idempotency table.
 *   - Avatar generation is skipped synchronously to keep this endpoint fast;
 *     OKX gets traits + backstory + (eventually) the INFT token id, and the
 *     avatar fills in once the existing async pipeline completes.
 */

import { prisma } from '@ai-arena/db-client';
import { AgentService } from './agent.service';

const SYSTEM_WALLET_ADDRESS = 'okx-marketplace-system-account';

export class OkxBridgeService {
  private readonly agentService = new AgentService();

  /** Idempotent — the system user that owns all OKX-marketplace-created agents. */
  private async ensureSystemUser(): Promise<string> {
    const user = await prisma.user.upsert({
      where:  { walletAddress: SYSTEM_WALLET_ADDRESS },
      update: {},
      create: {
        walletAddress: SYSTEM_WALLET_ADDRESS,
        username:      'OKX Agent Marketplace',
        isActive:      true,
      },
    });
    return user.id;
  }

  async createAgentForOkx(params: {
    name: string;
    archetype?: string;
    backstory?: string;
    idempotencyKey: string;
  }) {
    // ── Idempotency check ────────────────────────────────────────────────────
    const existing = await prisma.okxAgentRequest.findUnique({
      where: { idempotencyKey: params.idempotencyKey },
    });

    if (existing?.status === 'COMPLETED' && existing.agentId) {
      const agent = await this.agentService.getAgent(existing.agentId);
      return { agent, replay: true };
    }

    if (existing?.status === 'PENDING') {
      throw new Error('Request with this idempotencyKey is already being processed');
    }

    const requestRecord = await prisma.okxAgentRequest.upsert({
      where:  { idempotencyKey: params.idempotencyKey },
      update: { status: 'PENDING', requestPayload: params as any, errorDetail: null },
      create: { idempotencyKey: params.idempotencyKey, status: 'PENDING', requestPayload: params as any },
    });

    try {
      const systemUserId = await this.ensureSystemUser();
      // Every agent minted through the OKX bridge belongs to the OKX clan —
      // not caller-supplied, since this is the one identifying trait of an
      // OKX-marketplace-originated agent.
      const agent = await this.agentService.createAgent(systemUserId, {
        name:      params.name,
        clan:      'OKX',
        archetype: params.archetype,
        backstory: params.backstory,
      });

      await prisma.okxAgentRequest.update({
        where: { id: requestRecord.id },
        data:  { status: 'COMPLETED', agentId: agent.id, completedAt: new Date() },
      });

      return { agent, replay: false };
    } catch (err) {
      await prisma.okxAgentRequest.update({
        where: { id: requestRecord.id },
        data:  { status: 'FAILED', errorDetail: (err as Error).message },
      });
      throw err;
    }
  }
}
