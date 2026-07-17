# F1 Prediction Engine — Plan & Status

> Full target spec (multi-source data stack, calibrated ML models, Monte
> Carlo live simulator, 6 differentiated agents) provided by the product
> owner 2026-07-17. This doc tracks what's actually built vs. what's still
> planned — see §"Status" for the honest line between the two.

## 1. Objective (as specified)

A prediction engine generating calibrated probabilities for F1 markets
(race winner, podium, top-6, head-to-head, safety car, rain, fastest lap,
expected finish, pit window, live win/podium probability) before and
during each race weekend. A numerical model generates the prediction; the
LLM/agent layer explains it, displays confidence, and adds personality —
the LLM must never directly decide the predicted outcome from raw data.

## 2. Five data sources, by role

| Source | Role | Stack fit |
|---|---|---|
| **FastF1** | Telemetry, lap timing, tyre/pace features | Python-only — no fit in this Node backend without a separate Python service |
| **Jolpica F1** | Historical results/standings backbone (career + recent form) | REST, Node-friendly — **built** |
| **Historical weather** | Session conditions, wet-weather scoring | REST (Open-Meteo etc.) — not started |
| **FIA official classifications** | Ground-truth results/penalties | Scraped/manual — not started |
| **OpenF1** | Live/recent race-state reconstruction | REST — not started |

Plus the already-live **API-SPORTS Formula-1 API** (current-season races,
drivers, teams, standings — see `F1_LEAGUE_CONTEXT.md`), which isn't one of
the five above but is what the live `/f1` page currently runs on.

## 3. Status — what's actually built (2026-07-17)

**Live and real:**
- `F1Team` / `F1Driver` / `F1Race` / `F1Prediction` (API-SPORTS, current
  2026 season) — race weekend, driver grid, live standings, player picks.
- `F1RaceResult` / `F1SeasonStanding` (Jolpica) — real historical race
  results and **point-in-time** standings (standings as of round N, not
  end-of-season, so a "before race" feature never leaks future data). See
  `jolpica-data.service.ts`.
- `jolpicaDataService.getDriverForm()` — recency-weighted last-5-race form
  score (35/25/18/13/9% weighting per the spec's §4 example), points, DNF
  rate. Computed from real stored results.
- AI Prediction button (`inference-service`'s `generateF1DriverPrediction`)
  — an LLM call grounded in real career stats + live standing, producing a
  short analysis and an explicit predicted-finish range. **This is the
  interim agent output, not the target architecture** — see §4.

**Not built (per the honest scope call made when this was requested):**
- FastF1 telemetry/pace/tyre-degradation pipeline (needs Python).
- Weather ingestion (any source).
- FIA reconciliation/ground-truth layer.
- OpenF1 live-race-state reconstruction.
- The actual numerical models (head-to-head, podium, winner, safety-car,
  rain, Monte Carlo simulator) — §5 of the full spec. None of these exist;
  building and *validating* them (walk-forward validation, calibration)
  is a real multi-day-minimum effort per model, not a single build.
- The 6-agent differentiated-personality layer (Synapse, Echo, Hybrid
  Kraken, Rocket Corgi, Lumen, Shiba Shield) — currently one undifferentiated
  prediction call, not six.
- `agent_predictions` / `prediction_outcomes` / `model_versions` tables and
  the structured JSON output format from §10 of the full spec.

**Why the gap:** the full spec is a genuine multi-week data-science build
(new data sources, model training + validation, a live simulator). Claiming
any of the above was "built" without real historical data behind it and
real validation would be a different flavor of the fabrication problem —
fake sophistication instead of fake activity. What's listed as "built"
above is real and checked against live API responses, nothing invented.

## 4. Interim vs. target prediction path

**Today:** `POST /v1/f1/drivers/:id/predict` → `inference-service` → one
LLM call, grounded in real stats, returns analysis + finish-range text.

**Target (per spec §1):** a numerical model (logistic regression / XGBoost
/ LightGBM initially, per §5) computes the actual probability; the LLM
layer only explains that number and adds agent personality. The LLM must
never be the thing deciding the prediction.

Swapping these later shouldn't change the API shape on the frontend side —
`/predict` can start returning `{ prediction, probability, confidence,
model_version }` once a real model exists behind it, additive to the
current `{ prediction }` text field.

## 5. Endpoints (Jolpica layer)

- `POST /v1/f1/sync-historical` — body `{ "season": 2025 }`, `X-Service-Key`
  gated. Pulls one season's results + point-in-time standings from Jolpica.
  Fire-and-forget (returns 202), takes roughly `2 × rounds × 300ms`.
- `GET /v1/f1/drivers/jolpica/:driverCode/form` — recency-weighted recent
  form for one driver, keyed by Jolpica's own driver slug (e.g. `norris`,
  not our internal `F1Driver.id`) since the two providers don't share a key.

## 6. Recommended next steps, in order

1. Run `sync-historical` for 2022-2025 to build up real recent-form data
   (the spec's minimum useful range).
2. Join `getDriverForm()`'s output into the existing predict endpoint so
   the LLM prediction is grounded in recent-form + live standing together,
   not live standing alone.
3. Historical weather ingestion (Open-Meteo — free, no key, REST) is the
   next-cheapest real win before touching FastF1/OpenF1/FIA.
4. FastF1 needs an explicit decision: stand up a small Python service, or
   defer pace/tyre features until that's worth the infra cost.
5. Model training only makes sense once (1)-(3) exist with enough real
   history behind them to validate against.
