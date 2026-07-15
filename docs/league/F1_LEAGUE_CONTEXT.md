# F1 League — Data Source Reference

> Captured 2026-07-15 from the live dashboard at `dashboard.api-football.com/formula/*` (same vendor — API-SPORTS — as the football League's `api-football.com` provider, sibling product). Written up here so the F1 build reuses real, verified endpoint shapes instead of guessing.

## Provider

- **Product**: API-SPORTS "Formula-1 API" (`api-formula-1.com`), same account family as the football provider already wired into `packages/football-data-client`.
- **Base URL**: `https://v1.formula-1.api-sports.io/`
- **Auth header**: `x-apisports-key: <key>`
- **Docs**: https://api-sports.io/documentation/formula-1/v1
- **Dashboard**: https://dashboard.api-football.com/formula/tester (live request builder — every endpoint below was verified there, not assumed)

### ⚠️ Plan limitation — blocks "upcoming race" until resolved

The API key currently in use (`98faff50a40b02a6858e76bad995bfe8` — **set this as an env var, e.g. `F1_API_KEY`, never commit it**) is on the **free plan**, which restricts the `season` parameter on season-scoped endpoints (`races`, `rankings/*`) to **2022–2024 only**:

```
GET /races?season=2026&competition=15
→ {"errors":{"plan":"Free plans do not have access to this season, try from 2022 to 2024."}}
```

This means **the real 2026 race calendar and current-season standings are not reachable on this key**. `teams` and `drivers?id=` (profile/career data, not season-scoped) work fine regardless of plan — so driver bios and the AI-prediction popup can be built now, but the "Upcoming Race: Belgian GP" section needs either a paid plan upgrade or a temporary stand-in using 2024 data until upgraded. Flag this to the user before building the upcoming-race section specifically.

## Endpoints (full list, from the live tester's dropdown)

`status` · `timezone` · `seasons` · `competitions` · `circuits` · `teams` · `drivers` · `races` · `rankings/teams` · `rankings/drivers` · `rankings/races` · `rankings/fastestlaps` · `rankings/startinggrid` · `pitstops`

### `GET /races?season={2022-2024}&competition={id}`
Full race weekend — every session (Practice 1/2/3, Qualifying, Race), not just the race itself.
```json
{
  "id": 1922,
  "competition": { "id": 15, "name": "Belgium Grand Prix", "location": { "country": "Belgium", "city": "Francorchamps" } },
  "circuit": { "id": 15, "name": "Circuit de Spa-Francorchamps", "image": "https://media.api-sports.io/formula-1/circuits/15.png" },
  "season": 2024,
  "type": "Race",
  "laps": { "current": null, "total": 44 },
  "fastest_lap": { "driver": { "id": 10 }, "time": "1:44.701" },
  "distance": "308.2 Kms",
  "timezone": "utc",
  "date": "2024-07-28T13:00:00+00:00",
  "weather": null,
  "status": "Completed"
}
```
`type` values seen: `Race`, `1st Qualifying`, `2nd Qualifying`, `3rd Practice`, `2nd Practice`, `1st Practice` (sprint weekends add `Sprint`/`Sprint Qualifying`, not confirmed live).

### `GET /teams` (no params — unrestricted, works on free plan)
All 20 teams ever tracked, current + defunct. Rich profile data.
```json
{
  "id": 1, "name": "Red Bull Racing", "logo": "https://media.api-sports.io/formula-1/teams/1.png",
  "base": "Milton Keynes, United Kingdom", "first_team_entry": 1997, "world_championships": 6,
  "highest_race_finish": { "position": 1, "number": 130 }, "pole_positions": 111, "fastest_laps": 100,
  "president": "Laurent Mekies", "director": "Laurent Mekies", "technical_manager": "Pierre Waché",
  "chassis": "RB22", "engine": "Red Bull Ford", "tyres": "Pirelli"
}
```

### `GET /drivers?id={id}` (unrestricted, works on free plan)
Full driver profile — exactly what the "click driver → popup with history" feature needs.
```json
{
  "id": 1, "name": "Nico Rosberg", "abbr": "ROS", "image": "https://media.api-sports.io/formula-1/drivers/1.png",
  "nationality": "German", "country": { "name": "Germany", "code": "DE" }, "birthdate": "1985-07-27",
  "number": 6, "podiums": 57, "career_points": "1594",
  "highest_race_finish": { "position": null, "number": null }, "highest_grid_position": null,
  "teams": [ { "season": 2016, "team": { "id": 5, "name": "Mercedes-AMG Petronas", "logo": "..." } }, ... ]
}
```
Note: `drivers` with no params 400s ("requires at least one parameter"); `team=` is not a valid filter param (only `id`/`search` confirmed).

### `GET /rankings/drivers?season={2022-2024}`
Full driver standings for a season.
```json
{
  "position": 1,
  "driver": { "id": 25, "name": "Max Verstappen", "abbr": "VER", "number": 3, "image": "https://media.api-sports.io/formula-1/drivers/25.png" },
  "team": { "id": 1, "name": "Red Bull Racing", "logo": "..." },
  "points": 437, "wins": 9, "behind": null, "season": 2024
}
```

## Known IDs

**Grand Prix Belgium** → `competition.id = 15`, `circuit.id = 15` ("Circuit de Spa-Francorchamps")

**All 39 Grand Prix IDs** are listed at `dashboard.api-football.com/formula/ids` — not fully re-captured here (only Belgium was needed); re-fetch `GET /competitions` live if more are needed, it's unrestricted.

**All 20 teams** (`GET /teams`, unrestricted):
| ID | Name | Status |
|---|---|---|
| 1 | Red Bull Racing | Active |
| 2 | McLaren Racing | Active |
| 3 | Scuderia Ferrari | Active |
| 4 | Force India | Defunct |
| 5 | Mercedes-AMG Petronas | Active |
| 6 | Lotus F1 Team | Defunct |
| 7 | Racing Bulls | Active |
| 8 | Sauber F1 Team | Renamed (→18) |
| 9 | Manor Marussia F1 Team | Defunct |
| 10 | Caterham F1 Team | Defunct |
| 11 | HRT Formula One Team | Defunct |
| 12 | Williams F1 Team | Active |
| 13 | Alpine F1 Team | Active |
| 14 | Haas F1 Team | Active |
| 15 | Virgin Racing | Defunct |
| 16 | Manor Racing | Defunct |
| 17 | Aston Martin F1 Team | Active |
| 18 | Stake F1 Team Kick Sauber | Active (2024-25 name) |
| 19 | Cadillac Formula 1 Team | Active (new 2026 entrant) |
| 20 | Audi Revolut F1 Team | Active (2026 Sauber rebrand) |

**Driver IDs**: not bulk-captured (119 historical drivers, ID column didn't render reliably via the dashboard's Ids table UI). Resolve on demand via `GET /rankings/drivers?season=2024` (gives id+name+team for the ~24 current-era drivers in one call) rather than the Ids page.

## Architecture recommendation

Mirror `packages/football-data-client`'s `IFootballDataProvider` pattern exactly: a new `IF1DataProvider` interface + `ApiFormula1Provider` adapter, feeding **new, F1-shaped Prisma models** (not `LeagueMatch` reuse — F1 has no home/away team; it has races, sessions, drivers, constructors, grid/finish positions). See the main conversation for the fuller architecture discussion — this doc is the data-source reference half of that, not the schema design.
