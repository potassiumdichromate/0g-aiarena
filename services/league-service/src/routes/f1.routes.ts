import { FastifyInstance } from 'fastify';
import { jwtMiddleware } from '../middleware/jwt.middleware';
import { f1DataService, BELGIUM_GRAND_PRIX_ID, DEFAULT_SEASON } from '../services/f1-data.service';
import { jolpicaDataService } from '../services/jolpica-data.service';
import { f1FantasyService } from '../services/f1-fantasy.service';

const INFERENCE_SERVICE_URL = process.env.INFERENCE_SERVICE_URL ?? 'http://localhost:8013';

function serviceHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json', 'X-Service-Key': process.env.INTERNAL_SERVICE_SECRET ?? '' };
}

/** docs/league/F1_LEAGUE_CONTEXT.md — F1 League: races/teams/drivers/picks/AI prediction. */
export async function f1Routes(app: FastifyInstance): Promise<void> {
  // GET /v1/f1/grand-prix/belgium — the upcoming-race section + all its sessions.
  app.get('/grand-prix/belgium', async (req, reply) => {
    const weekend = await f1DataService.getGrandPrixWeekend(BELGIUM_GRAND_PRIX_ID, DEFAULT_SEASON);
    if (!weekend) return reply.status(404).send({ error: 'Belgian GP not synced yet — call POST /v1/f1/sync first' });
    return weekend;
  });

  // GET /v1/f1/teams
  app.get('/teams', async () => ({ teams: await f1DataService.listTeams() }));

  // GET /v1/f1/drivers — the grid, for the driver cards.
  app.get('/drivers', async () => ({ drivers: await f1DataService.listDrivers() }));

  // GET /v1/f1/drivers/:id — full profile for the popup.
  app.get('/drivers/:id', async (req) => {
    const { id } = req.params as { id: string };
    return { driver: await f1DataService.getDriver(id) };
  });

  // POST /v1/f1/drivers/:id/predict — "AI Prediction" button. Public read-adjacent (no fund/agent action), light rate limit.
  app.post(
    '/drivers/:id/predict',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const driver = await f1DataService.getDriver(id);
      const weekend = await f1DataService.getGrandPrixWeekend(BELGIUM_GRAND_PRIX_ID, DEFAULT_SEASON);
      const standing = await f1DataService.getCurrentStanding(driver.providerId, DEFAULT_SEASON).catch(() => null);

      const res = await fetch(`${INFERENCE_SERVICE_URL}/f1-driver-prediction`, {
        method: 'POST',
        headers: serviceHeaders(),
        body: JSON.stringify({
          driverName: driver.name,
          abbr: driver.abbr,
          nationality: driver.nationality,
          number: driver.number,
          podiums: driver.podiums,
          careerPoints: driver.careerPoints,
          currentTeamName: driver.currentTeam?.name ?? null,
          teamHistory: (driver.teamHistory as Array<{ season: number; team: { name: string } }> | null)?.map((t) => ({
            season: t.season,
            teamName: t.team?.name,
          })),
          grandPrixName: weekend?.race.grandPrixName ?? 'Belgian Grand Prix',
          circuitName: weekend?.race.circuitName,
          latestSeasonStanding: standing,
        }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return reply.status(502).send({ error: `inference-service prediction failed: ${text}` });
      }
      const data = (await res.json()) as { prediction: string };
      return data;
    },
  );

  // POST /v1/f1/races/:raceId/pick — "Make a pick". agentId must belong to the caller.
  // market: "WINNER" | "PODIUM" | "FASTEST_LAP" (defaults to WINNER) -- one
  // pick per market per race per agent, so a player can pick different
  // drivers for different markets on the same race.
  app.post(
    '/races/:raceId/pick',
    { onRequest: [jwtMiddleware(app)] },
    async (req, reply) => {
      const { raceId } = req.params as { raceId: string };
      const { agentId, driverId, market, reasoning } = req.body as {
        agentId: string; driverId: string; market?: 'WINNER' | 'PODIUM' | 'FASTEST_LAP'; reasoning?: string;
      };
      if (!agentId || !driverId) return reply.status(400).send({ error: 'agentId and driverId are required' });

      const pick = await f1DataService.makePick(raceId, agentId, driverId, market ?? 'WINNER', reasoning);
      return { pick };
    },
  );

  // GET /v1/f1/races/:raceId/pick/:agentId — read back all of an agent's picks for a race (one per market).
  app.get('/races/:raceId/pick/:agentId', async (req) => {
    const { raceId, agentId } = req.params as { raceId: string; agentId: string };
    const picks = await f1DataService.getPicks(raceId, agentId);
    return { picks };
  });

  // POST /v1/f1/races/:raceId/predict-pick — "Let AI Predict". The AI names the
  // driver itself (via inference-service's tool-forced pick) and the pick is
  // saved immediately -- no manual driver selection.
  app.post(
    '/races/:raceId/predict-pick',
    { onRequest: [jwtMiddleware(app)], config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { raceId } = req.params as { raceId: string };
      const { agentId, market } = req.body as { agentId: string; market?: 'WINNER' | 'PODIUM' | 'FASTEST_LAP' };
      if (!agentId) return reply.status(400).send({ error: 'agentId is required' });

      const result = await f1DataService.predictPick(raceId, agentId, market ?? 'WINNER');
      return result;
    },
  );

  // POST /v1/f1/sync — admin/ops trigger to (re)pull teams/drivers/races from API-SPORTS.
  // Gated by the same internal-service secret used elsewhere (X-Service-Key), since it
  // burns external API quota and shouldn't be publicly callable.
  //
  // Fire-and-forget: f1DataService throttles every provider call to stay under
  // the free plan's 10 req/min limit, so a full sync (~25+ calls: teams,
  // ~24 drivers, races) takes a few minutes -- too long to hold one HTTP
  // request open. Check progress via Render logs or GET /v1/f1/drivers once
  // it's had time to run.
  app.post('/sync', async (req, reply) => {
    const serviceKey = req.headers['x-service-key'];
    if (serviceKey !== process.env.INTERNAL_SERVICE_SECRET) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
    f1DataService.syncAll().then(
      (result) => console.info('[F1 sync] completed:', result),
      (err) => console.error('[F1 sync] failed:', err),
    );
    return reply.status(202).send({ status: 'sync started — throttled to the API rate limit, expect a few minutes; check logs or GET /v1/f1/drivers for progress' });
  });

  // POST /v1/f1/sync-historical — pulls one real season's results + point-in-time
  // standings from Jolpica (docs/league/F1_PREDICTION_ENGINE_PLAN.md §9 Step 1).
  // Real historical data (2018-2025), independent of the API-SPORTS current-season
  // sync above. Same auth/fire-and-forget pattern -- ~2 calls per round, still
  // takes a minute or two for a full season.
  app.post('/sync-historical', async (req, reply) => {
    const serviceKey = req.headers['x-service-key'];
    if (serviceKey !== process.env.INTERNAL_SERVICE_SECRET) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
    const { season } = (req.body ?? {}) as { season?: number };
    if (!season) return reply.status(400).send({ error: 'season is required, e.g. { "season": 2025 }' });

    jolpicaDataService.syncSeason(season).then(
      (result) => console.info(`[Jolpica sync ${season}] completed:`, result),
      (err) => console.error(`[Jolpica sync ${season}] failed:`, err),
    );
    return reply.status(202).send({ status: `historical sync started for season ${season} — check logs for progress` });
  });

  // GET /v1/f1/drivers/jolpica/:driverCode/form — recency-weighted recent-form
  // features for one driver (Jolpica's driverId slug, e.g. "norris"), computed
  // from stored F1RaceResult rows.
  app.get('/drivers/jolpica/:driverCode/form', async (req, reply) => {
    const { driverCode } = req.params as { driverCode: string };
    const form = await jolpicaDataService.getDriverForm(driverCode);
    if (!form) return reply.status(404).send({ error: 'no historical results found for this driver — run POST /v1/f1/sync-historical first' });
    return { form };
  });

  // ── Fantasy League ─────────────────────────────────────────────────────────
  // AI drafts one driver + their real constructor per agent per season; once
  // races complete, real classification data (below) accumulates points onto
  // each team; GET /fantasy/leaderboard ranks them.

  // POST /v1/f1/fantasy/draft — "AI drafts my team". One team per agent per
  // season; re-drafting overwrites the previous pick.
  app.post(
    '/fantasy/draft',
    { onRequest: [jwtMiddleware(app)], config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { agentId, season } = req.body as { agentId: string; season?: number };
      if (!agentId) return reply.status(400).send({ error: 'agentId is required' });
      const team = await f1FantasyService.draftTeam(agentId, season ?? DEFAULT_SEASON);
      return { team };
    },
  );

  // GET /v1/f1/fantasy/team/:agentId — read back an agent's fantasy team for a season.
  app.get('/fantasy/team/:agentId', async (req) => {
    const { agentId } = req.params as { agentId: string };
    const { season } = req.query as { season?: string };
    const team = await f1FantasyService.getTeam(agentId, season ? parseInt(season, 10) : DEFAULT_SEASON);
    return { team };
  });

  // GET /v1/f1/fantasy/leaderboard — real-points-only ranking for a season.
  app.get('/fantasy/leaderboard', async (req) => {
    const { season } = req.query as { season?: string };
    const teams = await f1FantasyService.getLeaderboard(season ? parseInt(season, 10) : DEFAULT_SEASON);
    return { teams };
  });

  // POST /v1/f1/fantasy/races/:raceId/sync-classification — pulls real
  // per-driver results for one COMPLETED race from the provider. Ops/admin,
  // same X-Service-Key gate as /sync.
  app.post('/fantasy/races/:raceId/sync-classification', async (req, reply) => {
    const serviceKey = req.headers['x-service-key'];
    if (serviceKey !== process.env.INTERNAL_SERVICE_SECRET) return reply.status(401).send({ error: 'Unauthorized' });

    const { raceId } = req.params as { raceId: string };
    const result = await f1FantasyService.syncRaceClassification(raceId);
    return result;
  });

  // POST /v1/f1/fantasy/races/:raceId/score — applies a COMPLETED race's
  // synced classification to every fantasy team for that season. Idempotent.
  app.post('/fantasy/races/:raceId/score', async (req, reply) => {
    const serviceKey = req.headers['x-service-key'];
    if (serviceKey !== process.env.INTERNAL_SERVICE_SECRET) return reply.status(401).send({ error: 'Unauthorized' });

    const { raceId } = req.params as { raceId: string };
    const result = await f1FantasyService.scoreRace(raceId);
    return result;
  });

  // POST /v1/f1/races/:raceId/settle — the whole real-results pipeline for
  // one COMPLETED race, run in one call: pull real per-driver classification
  // from the provider, settle every unsettled F1Prediction (isCorrect +
  // settledAt) against it, then score every fantasy team's real points.
  // Same idempotent guarantee as each step individually -- safe to re-run.
  // Ops/admin, same X-Service-Key gate as the rest of this section. There is
  // no automatic trigger for this yet (no F1-aware cron exists, unlike
  // football's settlement-tick) -- this has to be called by hand once a race
  // is actually over.
  app.post('/races/:raceId/settle', async (req, reply) => {
    const serviceKey = req.headers['x-service-key'];
    if (serviceKey !== process.env.INTERNAL_SERVICE_SECRET) return reply.status(401).send({ error: 'Unauthorized' });

    const { raceId } = req.params as { raceId: string };
    const classification = await f1FantasyService.syncRaceClassification(raceId);
    const predictions = await f1DataService.settlePredictions(raceId);
    const fantasy = await f1FantasyService.scoreRace(raceId);
    return { classification, predictions, fantasy };
  });
}
