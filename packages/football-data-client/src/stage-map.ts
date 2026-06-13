import { LeagueStage } from './types';

/** Default raw-stage-label -> LeagueStage table, used by InternalAdminProvider. */
export const STAGE_LABEL_MAP: Record<string, LeagueStage> = {
  'Group Stage': 'GROUP',
  'Round of 32': 'ROUND_OF_32',
  'Round of 16': 'ROUND_OF_16',
  'Quarter-final': 'QUARTER_FINAL',
  'Quarter-finals': 'QUARTER_FINAL',
  'Semi-final': 'SEMI_FINAL',
  'Semi-finals': 'SEMI_FINAL',
  'Third Place Play-off': 'THIRD_PLACE',
  Final: 'FINAL',
};

export function mapProviderStage(label: string, table: Record<string, LeagueStage> = STAGE_LABEL_MAP): LeagueStage {
  return table[label] ?? 'GROUP';
}
