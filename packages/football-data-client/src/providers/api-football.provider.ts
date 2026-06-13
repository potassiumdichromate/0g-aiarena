import { IFootballDataProvider, NormalizedMatchResult, ProviderMatch } from '../types';

/**
 * Stubbed pending verification of API-Football fixture/result field mapping
 * against their current API docs (§8.2 — explicitly left as an open decision
 * in the architecture). Constructing this provider succeeds so it can be
 * wired into the factory ahead of time, but every call throws until the
 * mapping is implemented.
 */
export class ApiFootballProvider implements IFootballDataProvider {
  constructor(private readonly apiKey: string) {
    if (!apiKey) {
      throw new Error('ApiFootballProvider requires API_FOOTBALL_API_KEY to be set');
    }
  }

  async getSchedule(_seasonExternalId: string): Promise<ProviderMatch[]> {
    throw new Error('ApiFootballProvider.getSchedule is not yet implemented (architecture §8.2)');
  }

  async getLiveAndFinishedResults(_externalIds: string[]): Promise<NormalizedMatchResult[]> {
    throw new Error('ApiFootballProvider.getLiveAndFinishedResults is not yet implemented (architecture §8.2)');
  }
}
