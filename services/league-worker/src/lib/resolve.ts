import { prisma, CombatArchetype, EvolutionStage } from '@ai-arena/db-client';
import { normalizeTraits, AgentTraitVector } from '@ai-arena/shared-utils';

export interface AgentLeagueInfo {
  userId: string;
  archetype: CombatArchetype;
  evolutionStage: EvolutionStage;
  traits: AgentTraitVector;
}

// Ownership never transfers mid-season, so a single in-memory cache is safe
// for the lifetime of this process (§10.2 step 3).
const ownerCache = new Map<string, string>();

export async function resolveAgentOwner(agentId: string): Promise<string> {
  const cached = ownerCache.get(agentId);
  if (cached) return cached;

  const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId }, select: { userId: true } });
  ownerCache.set(agentId, agent.userId);
  return agent.userId;
}

export async function getAgentLeagueInfo(agentId: string): Promise<AgentLeagueInfo> {
  const agent = await prisma.agent.findUniqueOrThrow({
    where: { id: agentId },
    select: { userId: true, archetype: true, evolutionStage: true, traits: true },
  });
  ownerCache.set(agentId, agent.userId);

  return {
    userId: agent.userId,
    archetype: agent.archetype,
    evolutionStage: agent.evolutionStage,
    traits: normalizeTraits(agent.traits),
  };
}
