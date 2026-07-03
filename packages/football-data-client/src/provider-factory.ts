import { IFootballDataProvider } from './types';
import { InternalAdminProvider } from './providers/internal-admin.provider';
import { ApiFootballProvider } from './providers/api-football.provider';

/**
 * Selects the football data provider via `LEAGUE_DATA_PROVIDER` (§8.2).
 * Defaults to `internal-admin` outside production, since it is the only
 * provider that works without an external API key.
 *
 * `sportmonks` is intentionally not a case here — that implementation lives,
 * fully intact, at `./providers/alternate/sportmonks.provider.ts` (unwired on
 * purpose, chosen against on cost — see that file's header for how to bring
 * it back if API-Football ever stops being the right fit).
 */
export function createFootballDataProvider(env: NodeJS.ProcessEnv = process.env): IFootballDataProvider {
  const kind = env.LEAGUE_DATA_PROVIDER ?? 'internal-admin';

  switch (kind) {
    case 'api-football':
      return new ApiFootballProvider(env.API_FOOTBALL_API_KEY ?? '');
    case 'internal-admin':
      return new InternalAdminProvider();
    default:
      throw new Error(`Unknown LEAGUE_DATA_PROVIDER: ${kind}`);
  }
}
