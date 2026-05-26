/**
 * AchievementService — computes achievements from agent stats.
 * No new DB tables needed — all data derived from existing agent + training records.
 */

import { prisma } from '@ai-arena/db-client';

// ── Types ───────────────────────────────────────────────────────────────────

export type AchievementRarity = 'COMMON' | 'RARE' | 'EPIC' | 'LEGENDARY';
export type AchievementCategory = 'BATTLES' | 'TRAINING' | 'AGENTS' | 'AUTONOMOUS' | 'COLLECTION' | 'SPECIAL';

export interface AchievementDef {
  id: string;
  name: string;
  desc: string;
  points: number;
  category: AchievementCategory;
  rarity: AchievementRarity;
  /** Check whether this achievement is unlocked given agent stats */
  check: (stats: AgentStats) => boolean;
  /** Progress info (current/target) for partial progress display */
  progress?: (stats: AgentStats) => { current: number; target: number };
}

export interface AgentStats {
  wins: number;
  losses: number;
  draws: number;
  eloRating: number;
  evolutionStage: string;   // GENESIS | AWAKENED | ASCENDED | LEGENDARY | MYTHIC
  completedTrainingJobs: number;
  totalTrainingJobs: number;
  totalBattles: number;
  ageDays: number;           // days since agent creation
  autonomousEnabled: boolean;
}

export interface ComputedAchievement {
  id: string;
  name: string;
  desc: string;
  points: number;
  category: AchievementCategory;
  rarity: AchievementRarity;
  unlocked: boolean;
  progress?: { current: number; target: number };
}

export interface AchievementsResult {
  agentId: string;
  agentName: string;
  stats: {
    totalPoints: number;
    unlockedCount: number;
    totalCount: number;
    categoriesCompleted: number;
    totalCategories: number;
    commonCount: number;
    rareCount: number;
    epicCount: number;
    legendaryCount: number;
    totalCommon: number;
    totalRare: number;
    totalEpic: number;
    totalLegendary: number;
  };
  categories: {
    name: AchievementCategory;
    unlockedCount: number;
    totalCount: number;
  }[];
  achievements: ComputedAchievement[];
}

// ── Evolution stage ordering ─────────────────────────────────────────────────

const EVOLUTION_ORDER: Record<string, number> = {
  GENESIS: 0,
  AWAKENED: 1,
  ASCENDED: 2,
  LEGENDARY: 3,
  MYTHIC: 4,
};

function evolutionGte(stage: string, target: string): boolean {
  return (EVOLUTION_ORDER[stage] ?? 0) >= (EVOLUTION_ORDER[target] ?? 0);
}

// ── Achievement definitions ──────────────────────────────────────────────────

export const ACHIEVEMENT_DEFS: AchievementDef[] = [

  // ── BATTLES ──────────────────────────────────────────────────────────────
  {
    id: 'first_blood',
    name: 'FIRST BLOOD',
    desc: 'Win your first battle in any game mode.',
    points: 50,
    category: 'BATTLES',
    rarity: 'COMMON',
    check: (s) => s.wins >= 1,
    progress: (s) => ({ current: Math.min(s.wins, 1), target: 1 }),
  },
  {
    id: 'warrior',
    name: 'WARRIOR',
    desc: 'Win 5 battles in any game mode.',
    points: 75,
    category: 'BATTLES',
    rarity: 'COMMON',
    check: (s) => s.wins >= 5,
    progress: (s) => ({ current: Math.min(s.wins, 5), target: 5 }),
  },
  {
    id: 'battle_hardened',
    name: 'BATTLE-HARDENED',
    desc: 'Win 10 battles across any game modes.',
    points: 100,
    category: 'BATTLES',
    rarity: 'RARE',
    check: (s) => s.wins >= 10,
    progress: (s) => ({ current: Math.min(s.wins, 10), target: 10 }),
  },
  {
    id: 'arena_dominator',
    name: 'ARENA DOMINATOR',
    desc: 'Win 50 battles in any game mode.',
    points: 200,
    category: 'BATTLES',
    rarity: 'EPIC',
    check: (s) => s.wins >= 50,
    progress: (s) => ({ current: Math.min(s.wins, 50), target: 50 }),
  },
  {
    id: 'centurion',
    name: 'CENTURION',
    desc: 'Win 100 battles in any game mode.',
    points: 400,
    category: 'BATTLES',
    rarity: 'LEGENDARY',
    check: (s) => s.wins >= 100,
    progress: (s) => ({ current: Math.min(s.wins, 100), target: 100 }),
  },
  {
    id: 'survivor',
    name: 'SURVIVOR',
    desc: 'Participate in 10 battles total (win or lose).',
    points: 50,
    category: 'BATTLES',
    rarity: 'COMMON',
    check: (s) => s.totalBattles >= 10,
    progress: (s) => ({ current: Math.min(s.totalBattles, 10), target: 10 }),
  },
  {
    id: 'veteran',
    name: 'VETERAN',
    desc: 'Participate in 50 battles total.',
    points: 150,
    category: 'BATTLES',
    rarity: 'RARE',
    check: (s) => s.totalBattles >= 50,
    progress: (s) => ({ current: Math.min(s.totalBattles, 50), target: 50 }),
  },
  {
    id: 'elo_climber',
    name: 'ELO CLIMBER',
    desc: 'Reach an ELO rating of 1200.',
    points: 100,
    category: 'BATTLES',
    rarity: 'RARE',
    check: (s) => s.eloRating >= 1200,
    progress: (s) => ({ current: Math.min(s.eloRating, 1200), target: 1200 }),
  },
  {
    id: 'elite',
    name: 'ELITE',
    desc: 'Reach an ELO rating of 1500.',
    points: 250,
    category: 'BATTLES',
    rarity: 'EPIC',
    check: (s) => s.eloRating >= 1500,
    progress: (s) => ({ current: Math.min(s.eloRating, 1500), target: 1500 }),
  },
  {
    id: 'grandmaster',
    name: 'GRANDMASTER',
    desc: 'Reach an ELO rating of 2000.',
    points: 500,
    category: 'BATTLES',
    rarity: 'LEGENDARY',
    check: (s) => s.eloRating >= 2000,
    progress: (s) => ({ current: Math.min(s.eloRating, 2000), target: 2000 }),
  },

  // ── TRAINING ─────────────────────────────────────────────────────────────
  {
    id: 'first_lesson',
    name: 'FIRST LESSON',
    desc: 'Complete your first training session.',
    points: 50,
    category: 'TRAINING',
    rarity: 'COMMON',
    check: (s) => s.completedTrainingJobs >= 1,
    progress: (s) => ({ current: Math.min(s.completedTrainingJobs, 1), target: 1 }),
  },
  {
    id: 'student',
    name: 'STUDENT',
    desc: 'Complete 3 training sessions.',
    points: 75,
    category: 'TRAINING',
    rarity: 'COMMON',
    check: (s) => s.completedTrainingJobs >= 3,
    progress: (s) => ({ current: Math.min(s.completedTrainingJobs, 3), target: 3 }),
  },
  {
    id: 'scholar',
    name: 'SCHOLAR',
    desc: 'Complete 5 training sessions.',
    points: 100,
    category: 'TRAINING',
    rarity: 'RARE',
    check: (s) => s.completedTrainingJobs >= 5,
    progress: (s) => ({ current: Math.min(s.completedTrainingJobs, 5), target: 5 }),
  },
  {
    id: 'master_trainer',
    name: 'MASTER TRAINER',
    desc: 'Complete 10 training sessions.',
    points: 200,
    category: 'TRAINING',
    rarity: 'EPIC',
    check: (s) => s.completedTrainingJobs >= 10,
    progress: (s) => ({ current: Math.min(s.completedTrainingJobs, 10), target: 10 }),
  },
  {
    id: 'ai_overlord',
    name: 'AI OVERLORD',
    desc: 'Complete 25 training sessions.',
    points: 400,
    category: 'TRAINING',
    rarity: 'LEGENDARY',
    check: (s) => s.completedTrainingJobs >= 25,
    progress: (s) => ({ current: Math.min(s.completedTrainingJobs, 25), target: 25 }),
  },

  // ── AGENTS ───────────────────────────────────────────────────────────────
  {
    id: 'born',
    name: 'BORN INTO ARENA',
    desc: 'Create your first AI Arena agent.',
    points: 50,
    category: 'AGENTS',
    rarity: 'COMMON',
    check: (_s) => true,  // If we can compute achievements, agent exists
  },
  {
    id: 'awakened',
    name: 'AWAKENED',
    desc: 'Evolve your agent to the AWAKENED stage.',
    points: 100,
    category: 'AGENTS',
    rarity: 'COMMON',
    check: (s) => evolutionGte(s.evolutionStage, 'AWAKENED'),
  },
  {
    id: 'ascended',
    name: 'ASCENDED',
    desc: 'Evolve your agent to the ASCENDED stage.',
    points: 200,
    category: 'AGENTS',
    rarity: 'RARE',
    check: (s) => evolutionGte(s.evolutionStage, 'ASCENDED'),
  },
  {
    id: 'legendary_agent',
    name: 'LEGENDARY',
    desc: 'Evolve your agent to the LEGENDARY stage.',
    points: 400,
    category: 'AGENTS',
    rarity: 'EPIC',
    check: (s) => evolutionGte(s.evolutionStage, 'LEGENDARY'),
  },
  {
    id: 'mythic_agent',
    name: 'MYTHIC',
    desc: 'Reach the highest evolution: MYTHIC stage.',
    points: 1000,
    category: 'AGENTS',
    rarity: 'LEGENDARY',
    check: (s) => evolutionGte(s.evolutionStage, 'MYTHIC'),
  },
  {
    id: 'old_timer',
    name: 'OLD TIMER',
    desc: 'Keep your agent active for 30 days.',
    points: 100,
    category: 'AGENTS',
    rarity: 'RARE',
    check: (s) => s.ageDays >= 30,
    progress: (s) => ({ current: Math.min(s.ageDays, 30), target: 30 }),
  },

  // ── AUTONOMOUS ────────────────────────────────────────────────────────────
  {
    id: 'autopilot',
    name: 'AUTOPILOT',
    desc: 'Enable autonomous mode for your agent.',
    points: 50,
    category: 'AUTONOMOUS',
    rarity: 'COMMON',
    check: (s) => s.autonomousEnabled,
  },
  {
    id: 'self_sufficient',
    name: 'SELF-SUFFICIENT',
    desc: 'Win 5 battles while in autonomous mode.',
    points: 150,
    category: 'AUTONOMOUS',
    rarity: 'RARE',
    check: (s) => s.autonomousEnabled && s.wins >= 5,
    progress: (s) => ({ current: Math.min(s.wins, 5), target: 5 }),
  },
  {
    id: 'machine_uprising',
    name: 'MACHINE UPRISING',
    desc: 'Win 20 battles while in autonomous mode.',
    points: 300,
    category: 'AUTONOMOUS',
    rarity: 'EPIC',
    check: (s) => s.autonomousEnabled && s.wins >= 20,
    progress: (s) => ({ current: Math.min(s.wins, 20), target: 20 }),
  },

  // ── COLLECTION ────────────────────────────────────────────────────────────
  {
    id: 'inft_owner',
    name: 'INFT OWNER',
    desc: 'Successfully mint your first AI agent as an INFT.',
    points: 75,
    category: 'COLLECTION',
    rarity: 'COMMON',
    check: (_s) => true,
  },
  {
    id: 'battle_scarred',
    name: 'BATTLE-SCARRED',
    desc: 'Accumulate 5 or more losses — true warriors embrace defeat.',
    points: 50,
    category: 'COLLECTION',
    rarity: 'COMMON',
    check: (s) => s.losses >= 5,
    progress: (s) => ({ current: Math.min(s.losses, 5), target: 5 }),
  },
  {
    id: 'balanced',
    name: 'BALANCED',
    desc: 'Have a win rate above 50% with at least 10 battles.',
    points: 150,
    category: 'COLLECTION',
    rarity: 'RARE',
    check: (s) => s.totalBattles >= 10 && s.wins / s.totalBattles > 0.5,
  },

  // ── SPECIAL ───────────────────────────────────────────────────────────────
  {
    id: 'draw_master',
    name: 'DRAW MASTER',
    desc: 'Achieve 3 draws — you are untouchable.',
    points: 100,
    category: 'SPECIAL',
    rarity: 'RARE',
    check: (s) => s.draws >= 3,
    progress: (s) => ({ current: Math.min(s.draws, 3), target: 3 }),
  },
  {
    id: 'completionist',
    name: 'COMPLETIONIST',
    desc: 'Unlock achievements in every category.',
    points: 500,
    category: 'SPECIAL',
    rarity: 'LEGENDARY',
    check: (s) => {
      // Check if at least one achievement from each category is unlocked
      const categories: AchievementCategory[] = ['BATTLES', 'TRAINING', 'AGENTS', 'AUTONOMOUS', 'COLLECTION'];
      return categories.every(cat =>
        ACHIEVEMENT_DEFS
          .filter(d => d.category === cat && d.id !== 'completionist')
          .some(d => d.check(s))
      );
    },
  },
];

// ── Service ──────────────────────────────────────────────────────────────────

export class AchievementService {
  async computeForAgent(agentId: string): Promise<AchievementsResult | null> {
    // Fetch agent with training jobs
    const agent = await prisma.agent.findUnique({
      where: { id: agentId },
      include: {
        trainingJobs: {
          select: { id: true, status: true, createdAt: true, completedAt: true },
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!agent) return null;

    // Try to get autonomous config from agent metadata
    const meta = (agent.metadata ?? {}) as Record<string, unknown>;
    const autonomousEnabled = Boolean(
      meta.autonomousMode === true || meta.autonomousEnabled === true
    );

    const completedJobs = agent.trainingJobs.filter(j => j.status === 'COMPLETED').length;
    const ageDays = Math.floor((Date.now() - agent.createdAt.getTime()) / 86_400_000);

    const agentStats: AgentStats = {
      wins: agent.wins,
      losses: agent.losses,
      draws: agent.draws,
      eloRating: agent.eloRating,
      evolutionStage: agent.evolutionStage,
      completedTrainingJobs: completedJobs,
      totalTrainingJobs: agent.trainingJobs.length,
      totalBattles: agent.wins + agent.losses + agent.draws,
      ageDays,
      autonomousEnabled,
    };

    // Compute achievements
    const computed: ComputedAchievement[] = ACHIEVEMENT_DEFS.map(def => ({
      id: def.id,
      name: def.name,
      desc: def.desc,
      points: def.points,
      category: def.category,
      rarity: def.rarity,
      unlocked: def.check(agentStats),
      progress: def.progress ? def.progress(agentStats) : undefined,
    }));

    const unlocked = computed.filter(a => a.unlocked);
    const totalPoints = unlocked.reduce((sum, a) => sum + a.points, 0);

    // Category stats
    const categoryNames: AchievementCategory[] = ['BATTLES', 'TRAINING', 'AGENTS', 'AUTONOMOUS', 'COLLECTION', 'SPECIAL'];
    const categories = categoryNames.map(name => {
      const defs = computed.filter(a => a.category === name);
      return {
        name,
        unlockedCount: defs.filter(a => a.unlocked).length,
        totalCount: defs.length,
      };
    });
    const categoriesCompleted = categories.filter(c => c.unlockedCount > 0).length;

    // Rarity counts
    const rarityCount = (rarity: AchievementRarity, arr: ComputedAchievement[]) =>
      arr.filter(a => a.rarity === rarity).length;

    return {
      agentId,
      agentName: agent.name,
      stats: {
        totalPoints,
        unlockedCount: unlocked.length,
        totalCount: computed.length,
        categoriesCompleted,
        totalCategories: categoryNames.length,
        commonCount: rarityCount('COMMON', unlocked),
        rareCount: rarityCount('RARE', unlocked),
        epicCount: rarityCount('EPIC', unlocked),
        legendaryCount: rarityCount('LEGENDARY', unlocked),
        totalCommon: rarityCount('COMMON', computed),
        totalRare: rarityCount('RARE', computed),
        totalEpic: rarityCount('EPIC', computed),
        totalLegendary: rarityCount('LEGENDARY', computed),
      },
      categories,
      achievements: computed,
    };
  }
}
