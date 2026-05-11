# AI Arena Web App

Next.js 14 frontend for the AI Arena platform. Dark cyberpunk design system built with Tailwind CSS.

## Stack

- **Next.js 14** (App Router, `'use client'` pages)
- **TypeScript** strict mode
- **Tailwind CSS** with custom dark theme (`tailwind.config.ts` + `postcss.config.js`)
- **Privy** (`@privy-io/react-auth`) — wallet + email login
- **Custom API client** (`src/lib/api-client.ts`) — typed fetch wrapper with JWT auto-refresh

## Pages

| Route | Description |
|---|---|
| `/` | Landing page — hero, stats, clan grid, feature cards |
| `/agents` | Agent gallery with search, clan filter, create modal |
| `/battle` | Battle creator — mode selector, agent ID inputs, result view |
| `/leaderboard` | Global ELO rankings — podium (top 3), ranked table |

## Authentication

### With Privy (production)

1. Click **Connect Wallet** in the nav → Privy modal opens
2. After login, `PrivyAuthSync` (in `providers/privy-provider.tsx`) automatically exchanges the Privy access token for a backend JWT via `POST /v1/auth/privy`
3. JWT is stored in `localStorage` under `accessToken`
4. All API calls include `Authorization: Bearer <token>` automatically

### Without Privy (local dev — no wallet needed)

1. A **⚡ Dev** button appears in the nav alongside **Connect Wallet**
2. Click it → calls `POST /v1/auth/dev-login` on the identity-service
3. A dev user is created in the database and a valid JWT is returned and stored
4. All authenticated features (agent creation, battles) work immediately

> The Dev button only renders when `NODE_ENV !== 'production'`.

## API Client

`src/lib/api-client.ts` exports typed API modules:

```typescript
import { agentApi, battleApi, leaderboardApi, authApi } from '@/lib/api-client';

// List agents (public — no auth needed)
const { agents } = await agentApi.list({ clan: 'CYBER', pageSize: 20 });

// Create agent (requires JWT in localStorage)
const agent = await agentApi.create({ name: 'NeonHawk', clan: 'CYBER', archetype: 'TACTICIAN', gameId: 'standard' });

// Create battle
const battle = await battleApi.create({ agentIds: [id1, id2], mode: 'RANKED' });

// Leaderboard
const { entries } = await leaderboardApi.global(100);
```

JWT auto-refresh: on a 401 response, the client attempts to refresh using `localStorage.refreshToken`. If that also fails, `localStorage` is cleared and an `ai-arena:session-expired` event is dispatched.

## Valid Enum Values

### Agent `archetype`
`BERSERKER` | `TACTICIAN` | `DEFENDER` | `ASSASSIN` | `SUPPORT` | `HYBRID`

### Agent `clan`
`CYBER` | `BIO` | `ARCANE` | `MECH` | `SHADOW`

### Battle `mode`
`RANKED` | `UNRANKED` | `SCRIMMAGE`

## Components

| Component | Description |
|---|---|
| `AgentCard` | Clan-coloured card with ELO, W/L, trait bars, INFT badge |
| `WalletButton` | Privy login + Dev login button + connected-address display |
| `InternalWalletDrawer` | Slide-in wallet details panel |

## Development

```bash
cd apps/web
pnpm install
pnpm dev        # starts on http://localhost:3000
```

## Environment Variables (`apps/web/.env.local`)

```bash
NEXT_PUBLIC_API_URL=http://localhost:8000
NEXT_PUBLIC_PRIVY_APP_ID=<optional — dev login works without it>
NEXT_PUBLIC_WC_PROJECT_ID=<optional — WalletConnect project ID>
NEXT_PUBLIC_ZEROG_INFT_ADDRESS=0x67493Bb91e904840d39397E350f4A7865B779E10
NEXT_PUBLIC_AGENT_REGISTRY_ADDRESS=0x0891Df42835c87F7A9309Ce021941D17Bf684d86
```
