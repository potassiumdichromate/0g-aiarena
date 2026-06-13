import { IFootballDataProvider, NormalizedMatchResult, ProviderMatch } from '../types';

/**
 * Stubbed pending verification of Sportmonks v3 fixture/result field mapping
 * against their current API docs (§8.2 — explicitly left as an open decision
 * in the architecture). Constructing this provider succeeds so it can be
 * wired into the factory ahead of time, but every call throws until the
 * mapping is implemented.
 */
export class SportmonksProvider implements IFootballDataProvider {
  constructor(private readonly apiKey: string) {
    if (!apiKey) {
      throw new Error('SportmonksProvider requires SPORTMONKS_API_KEY to be set');
    }
  }

  async getSchedule(_seasonExternalId: string): Promise<ProviderMatch[]> {
    throw new Error('SportmonksProvider.getSchedule is not yet implemented (architecture §8.2)');
  }

  async getLiveAndFinishedResults(_externalIds: string[]): Promise<NormalizedMatchResult[]> {
    throw new Error('SportmonksProvider.getLiveAndFinishedResults is not yet implemented (architecture §8.2)');
  }
}
