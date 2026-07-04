import { prisma, Prisma, PolymarketSignal } from '@ai-arena/db-client';
import { requestPolymarketSignal, PolymarketMarketContext } from '../lib/internal';
import { NotFoundError, ForbiddenError } from '../lib/errors';

export interface PolymarketSignalDTO {
  agentId: string;
  agentName: string;
  marketId: string;
  question: string;
  signal: 'YES' | 'NO';
  confidence: 'LOW' | 'MEDIUM' | 'HIGH';
  reasoning: string | null;
  source: 'AI' | 'FALLBACK' | 'USER_OVERRIDE';
}

function toDTO(row: PolymarketSignal, agentName: string): PolymarketSignalDTO {
  return {
    agentId: row.agentId,
    agentName,
    marketId: row.marketId,
    question: row.question,
    signal: row.signal,
    confidence: row.confidence,
    reasoning: row.reasoning,
    source: row.source,
  };
}

class PolymarketSignalService {
  /** docs/polymarket §5 Phase 1 — POST /v1/polymarket/signals/:marketId/:agentId/generate */
  async generateSignal(userId: string, marketId: string, agentId: string, question: string, category?: string): Promise<PolymarketSignalDTO> {
    await this.requireOwnedAgent(userId, agentId);
    return this.ensureSignal(agentId, { marketId, question, category });
  }

  /**
   * Return the existing signal for (market, agent), or generate one via
   * `decidePolymarketSignal` (falling back to the deterministic generator on
   * any inference failure) — same idempotent generate-or-return shape as
   * league-prediction.service.ts's ensurePrediction.
   */
  async ensureSignal(agentId: string, marketContext: PolymarketMarketContext): Promise<PolymarketSignalDTO> {
    const existing = await prisma.polymarketSignal.findUnique({
      where: { marketId_agentId: { marketId: marketContext.marketId, agentId } },
    });
    if (existing) return toDTO(existing, await this.agentName(agentId));

    const result = await requestPolymarketSignal(agentId, marketContext);

    try {
      const row = await prisma.polymarketSignal.create({
        data: {
          marketId: marketContext.marketId,
          agentId,
          question: marketContext.question,
          signal: result.signal,
          confidence: result.confidence,
          reasoning: result.reasoning,
          source: result.source,
        },
      });
      return toDTO(row, await this.agentName(agentId));
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const row = await prisma.polymarketSignal.findUnique({
          where: { marketId_agentId: { marketId: marketContext.marketId, agentId } },
        });
        if (row) return toDTO(row, await this.agentName(agentId));
      }
      throw err;
    }
  }

  /** docs/polymarket §5 Phase 1 — GET /v1/polymarket/signals/:marketId */
  async getSignalsForMarket(marketId: string): Promise<PolymarketSignalDTO[]> {
    const rows = await prisma.polymarketSignal.findMany({ where: { marketId }, orderBy: { createdAt: 'asc' } });
    if (rows.length === 0) return [];

    const agents = await prisma.agent.findMany({ where: { id: { in: rows.map((r) => r.agentId) } }, select: { id: true, name: true } });
    const nameById = new Map(agents.map((a) => [a.id, a.name]));
    return rows.map((row) => toDTO(row, nameById.get(row.agentId) ?? 'Unknown'));
  }

  private async agentName(agentId: string): Promise<string> {
    const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { name: true } });
    return agent?.name ?? 'Unknown';
  }

  private async requireOwnedAgent(userId: string, agentId: string): Promise<void> {
    const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { userId: true } });
    if (!agent) throw new NotFoundError('agent not found');
    if (agent.userId !== userId) throw new ForbiddenError('you do not own this agent');
  }
}

export const polymarketSignalService = new PolymarketSignalService();
