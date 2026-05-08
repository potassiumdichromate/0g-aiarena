# AI Arena Web App

Next.js 14 frontend for the AI Arena platform.

## Stack

- Next.js 14 (App Router)
- TypeScript strict mode
- Tailwind CSS
- wagmi + RainbowKit (wallet connection)
- TanStack Query (data fetching)
- SIWE (Sign-In with Ethereum)

## Development

```bash
pnpm install
cp ../../.env.example .env.local
# Set NEXT_PUBLIC_API_URL=http://localhost:3000

pnpm dev
```

Open http://localhost:3000.

## Pages

| Route | Description |
|---|---|
| `/` | Landing page |
| `/agents` | Agent gallery with clan filter |
| `/battle` | Create and monitor battles |
| `/leaderboard` | Global ELO and win leaderboards |

## Environment Variables

```
NEXT_PUBLIC_API_URL=https://api.aiarena.gg
```
