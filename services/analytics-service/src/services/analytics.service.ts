import axios from 'axios';

const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL ?? 'http://localhost:8123';

export class AnalyticsService {
  private async query(sql: string): Promise<unknown[]> {
    const response = await axios.post(
      `${CLICKHOUSE_URL}/?output_format_json_quote_64bit_integers=0&default_format=JSON`,
      sql,
      { headers: { 'Content-Type': 'text/plain' }, auth: { username: 'ai_arena', password: 'password' } }
    );
    return (response.data as any).data ?? [];
  }

  async getAgentAnalytics(agentId: string) {
    // In production, queries go to ClickHouse telemetry tables
    // Fallback to Postgres for now
    const { prisma } = await import('@ai-arena/db-client');
    const agent = await prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent) return null;
    return {
      agentId,
      eloRating: agent.eloRating,
      winRate: agent.wins + agent.losses > 0 ? agent.wins / (agent.wins + agent.losses) : 0,
      totalBattles: agent.wins + agent.losses + agent.draws,
      wins: agent.wins,
      losses: agent.losses,
      draws: agent.draws,
    };
  }

  async getBattleAnalytics(gameId?: string) {
    const { prisma } = await import('@ai-arena/db-client');
    const battles = await prisma.battle.groupBy({
      by: ['mode'],
      _count: { id: true },
    });
    return { battles };
  }

  async getMetaAnalysis() {
    const { prisma } = await import('@ai-arena/db-client');
    const archetypes = await prisma.agent.groupBy({
      by: ['archetype'],
      _count: { id: true },
      _avg: { eloRating: true },
    });
    return { archetypes };
  }
}
