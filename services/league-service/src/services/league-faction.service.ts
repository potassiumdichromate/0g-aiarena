import { prisma, LeagueTribe, LeagueUserProfile } from '@ai-arena/db-client';
import { addDays } from '@ai-arena/shared-utils';
import { getEventBus, LEAGUE_SUBJECTS } from '@ai-arena/event-bus';
import { leagueRepo, requireActiveSeason, configFor } from '../lib/season';
import { ConflictError, BadRequestError } from '../lib/errors';

class LeagueFactionService {
  /** §12.1 — POST /v1/league/faction */
  async joinFaction(userId: string, tribe: LeagueTribe): Promise<LeagueUserProfile> {
    const season = await requireActiveSeason();
    const config = configFor(season);

    const profile = await leagueRepo.getOrCreateUserProfile(userId);

    if (profile.factionId) {
      const cooldownEnds = addDays(profile.lastFactionSwitchAt ?? profile.factionJoinedAt!, config.faction.switchCooldownDays);
      if (new Date() < cooldownEnds) {
        throw new ConflictError(`faction switch available after ${cooldownEnds.toISOString()}`);
      }
    }

    const qualifies = await this.hasQualifyingAction(userId, season.id, tribe);
    if (!qualifies) throw new BadRequestError('no qualifying action for this faction yet');

    const updated = await leagueRepo.setFaction(userId, tribe, !profile.factionId);

    const bus = await getEventBus();
    await bus.publish(LEAGUE_SUBJECTS.LEAGUE_FACTION_JOINED, { userId, tribe }).catch(() => {});

    return updated;
  }

  /** §12.2 — user owns >=1 agent enrolled this season with `tribe === tribe`. */
  private async hasQualifyingAction(userId: string, seasonId: string, tribe: LeagueTribe): Promise<boolean> {
    const agentIds = (await prisma.agent.findMany({ where: { userId }, select: { id: true } })).map((a) => a.id);
    if (agentIds.length === 0) return false;

    const count = await prisma.leagueAgentSeasonStats.count({ where: { seasonId, agentId: { in: agentIds }, tribe } });
    return count > 0;
  }
}

export const leagueFactionService = new LeagueFactionService();
