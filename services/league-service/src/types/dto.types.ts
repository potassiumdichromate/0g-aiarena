import {
  LeagueTribe,
  LeagueMatchStatus,
  LeagueStage,
  PredictionOutcome,
  ConvictionLevel,
  LeagueBattleStatus,
} from '@ai-arena/db-client';
import { ConsensusDTO } from '../lib/dto';

/** §15.2 — GET /v1/league/me/summary */
export interface MeSummaryDTO {
  kpBalance: number;
  kpWeekly: number;
  kpWeeklyTarget: number;
  globalRank: number | null;
  dayStreak: number;
  factionId: LeagueTribe | null;
}

/** §15.3/§15.7 — the requesting user's own agent's pick on a match, if any. */
export interface UserAgentPickDTO {
  agentId: string;
  agentName: string;
  conviction: ConvictionLevel;
  scoreHome: number;
  scoreAway: number;
  predictedWinner: PredictionOutcome;
}

/** §15.3 — GET /v1/league/matches/featured */
export interface MatchSummaryDTO {
  id: string;
  home: string;
  away: string;
  stage: LeagueStage;
  matchday: number | null;
  venue: string | null;
  kickoffAt: string;
  status: LeagueMatchStatus;
  isLive: boolean;
  homeScore: number | null;
  awayScore: number | null;
  liveMinute: number | null;
  predictionPool: number;
  totalAgentBets: number;
  consensus: ConsensusDTO;
  userAgentPick: UserAgentPickDTO | null;
}

/** §15.1 — GET /v1/league/matches list item */
export interface MatchListItemDTO {
  id: string;
  home: string;
  away: string;
  stage: LeagueStage;
  matchday: number | null;
  venue: string | null;
  kickoffAt: string;
  status: LeagueMatchStatus;
  userAgentPick: UserAgentPickDTO | null;
}

export interface MatchListResultDTO {
  matches: MatchListItemDTO[];
  total: number;
}

/** §15.7.1 — one side of a derived prediction question. */
export interface LeaguePredictionQuestionAgentDTO {
  agentName: string;
  pick: string;
  stake: number;
  confidence: number;
}

/** §15.7.1 — a derived head-to-head prediction question for a match. */
export interface LeaguePredictionQuestionDTO {
  id: string;
  category: string;
  question: string;
  agentA: LeaguePredictionQuestionAgentDTO;
  agentB: LeaguePredictionQuestionAgentDTO;
}

/** §15.7.2 — one agent's locked/settled bet on a match. */
export interface AgentBetDTO {
  agentId: string;
  agentName: string;
  winner: PredictionOutcome;
  scoreHome: number;
  scoreAway: number;
  conviction: ConvictionLevel;
  reasoning: string | null;
}

/** §15.7 — GET /v1/league/matches/:matchId */
export interface MatchDetailDTO extends MatchSummaryDTO {
  questions: LeaguePredictionQuestionDTO[];
  agentBets: AgentBetDTO[];
}

/** GET /v1/league/predictions/today item */
export interface TodayPredictionDTO {
  agentName: string;
  quote: string;
  confidence: number;
  pick: string;
}

/** GET /v1/league/me/predictions item */
export interface RecentPickDTO {
  id: string;
  agentName: string;
  home: string;
  away: string;
  pick: string;
  confidence: number;
  result: string;
  outcome: 'WIN' | 'LOSS' | 'DRAW';
  kpEarned: number;
}

/** §15.4 — GET /v1/league/rivalries/featured */
export interface RivalryDTO {
  leftAgentId: string;
  leftAgentName: string;
  rightAgentId: string;
  rightAgentName: string;
  leftWins: number;
  rightWins: number;
  reputationReward: number;
  kpReward: number;
  narrative: string | null;
}

/** §15.5 — GET /v1/league/me/agents row */
export interface LineupRowDTO {
  agentId: string;
  agentName: string;
  tribe: LeagueTribe;
  reputation: number;
  record: string;
  balanceArena: number;
}

/** §15.6 — GET /v1/league/battles/open item */
export interface OpenBattleDTO {
  id: string;
  matchId: string;
  challengerAgentId: string;
  challengerAgentName: string;
  opponentAgentId: string;
  opponentAgentName: string;
  title: string;
  stakeArena: number;
  status: LeagueBattleStatus;
}

/** GET /v1/league/leaderboard?scope=global|faction */
export interface ReputationLeaderboardRowDTO {
  rank: number;
  agentId: string;
  agentName: string;
  reputation: number;
  record: string;
  streak: number;
}

/** GET /v1/league/leaderboard?scope=weekly row */
export interface KpLeaderboardRowDTO {
  rank: number;
  userId: string;
  kpWeekly: number;
  kpBalance: number;
}

/** GET /v1/league/moments item */
export interface MomentDTO {
  id: string;
  agentName: string;
  agentImg: string;
  text: string;
  kp?: number;
}
