import { FastifyInstance } from 'fastify';
import { jwtMiddleware } from '../middleware/jwt.middleware';
import { f1DataService, BELGIUM_GRAND_PRIX_ID, DEFAULT_SEASON } from '../services/f1-data.service';

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
  app.post(
    '/races/:raceId/pick',
    { onRequest: [jwtMiddleware(app)] },
    async (req, reply) => {
      const { raceId } = req.params as { raceId: string };
      const { agentId, driverId, reasoning } = req.body as { agentId: string; driverId: string; reasoning?: string };
      if (!agentId || !driverId) return reply.status(400).send({ error: 'agentId and driverId are required' });

      const pick = await f1DataService.makePick(raceId, agentId, driverId, reasoning);
      return { pick };
    },
  );

  // GET /v1/f1/races/:raceId/pick/:agentId — read back an agent's current pick.
  app.get('/races/:raceId/pick/:agentId', async (req) => {
    const { raceId, agentId } = req.params as { raceId: string; agentId: string };
    const pick = await f1DataService.getPick(raceId, agentId);
    return { pick };
  });

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
}
