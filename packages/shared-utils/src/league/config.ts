import { DEFAULT_SCORING_CONFIG, DEFAULT_REPUTATION_CONFIG, ScoringConfig, ReputationConfig } from './scoring';

export interface BattleRulesConfig {
  dailyCreateCap: number;
  dailyAcceptCap: number;
  pendingExpiryHours: number;
  winTradingMinMatchups: number;
  winTradingProbabilityThreshold: number;
}

export interface FactionConfig {
  switchCooldownDays: number;
  activeWindowDays: number;
}

export interface RivalryConfig {
  narrativeThreshold: number;
  reputationRewardBase: number;
  reputationRewardPerMatchup: number;
  kpRewardBase: number;
  kpRewardPerMatchup: number;
}

export interface SettlementConfig {
  pollIntervalMinutes: number;
  correctionWindowHours: number;
}

export interface PredictionGenConfig {
  preGenHoursBefore: number;
  preGenWindowHours: number;
}

export interface LeagueConfig {
  scoring: ScoringConfig;
  reputation: ReputationConfig;
  lockBufferMinutes: number;
  battles: BattleRulesConfig;
  faction: FactionConfig;
  rivalry: RivalryConfig;
  settlement: SettlementConfig;
  predictionGen: PredictionGenConfig;
  kpWeeklyTarget: number;
}

/**
 * Full default shape of `LeagueSeason.config` (§20.1). Stored as the JSON
 * default for new seasons so all tunable constants are versionable without a
 * migration.
 */
export const DEFAULT_LEAGUE_CONFIG: LeagueConfig = {
  scoring: DEFAULT_SCORING_CONFIG,
  reputation: DEFAULT_REPUTATION_CONFIG,
  lockBufferMinutes: 0,
  battles: {
    dailyCreateCap: 20,
    dailyAcceptCap: 30,
    pendingExpiryHours: 24,
    winTradingMinMatchups: 3,
    winTradingProbabilityThreshold: 0.05,
  },
  faction: {
    switchCooldownDays: 7,
    activeWindowDays: 7,
  },
  rivalry: {
    narrativeThreshold: 5,
    reputationRewardBase: 50,
    reputationRewardPerMatchup: 20,
    kpRewardBase: 100,
    kpRewardPerMatchup: 30,
  },
  settlement: {
    pollIntervalMinutes: 2,
    correctionWindowHours: 24,
  },
  predictionGen: {
    preGenHoursBefore: 24,
    preGenWindowHours: 2,
  },
  kpWeeklyTarget: 5000, // §15.2 KP_WEEK_PROGRESS.target
};

/**
 * Merge a (possibly partial) `LeagueSeason.config` JSON value over the
 * defaults. Used so seasons created before a config key existed still get a
 * sensible value without a migration.
 */
export function resolveLeagueConfig(stored: unknown): LeagueConfig {
  const partial = (stored ?? {}) as Partial<LeagueConfig>;
  return {
    scoring: { ...DEFAULT_LEAGUE_CONFIG.scoring, ...partial.scoring },
    reputation: { ...DEFAULT_LEAGUE_CONFIG.reputation, ...partial.reputation },
    lockBufferMinutes: partial.lockBufferMinutes ?? DEFAULT_LEAGUE_CONFIG.lockBufferMinutes,
    battles: { ...DEFAULT_LEAGUE_CONFIG.battles, ...partial.battles },
    faction: { ...DEFAULT_LEAGUE_CONFIG.faction, ...partial.faction },
    rivalry: { ...DEFAULT_LEAGUE_CONFIG.rivalry, ...partial.rivalry },
    settlement: { ...DEFAULT_LEAGUE_CONFIG.settlement, ...partial.settlement },
    predictionGen: { ...DEFAULT_LEAGUE_CONFIG.predictionGen, ...partial.predictionGen },
    kpWeeklyTarget: partial.kpWeeklyTarget ?? DEFAULT_LEAGUE_CONFIG.kpWeeklyTarget,
  };
}
