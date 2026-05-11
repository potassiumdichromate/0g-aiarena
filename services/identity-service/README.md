# identity-service

**Port: 8001**

Handles authentication via Privy (wallet + email login), JWT issuance and refresh, and user profile management. Creates a custodial Solana wallet for each user on first login.

## Authentication Flow

```
User connects wallet via Privy (MetaMask / WalletConnect on 0G Chain)
  → Privy gives frontend an access token
  → Frontend POSTs to /auth/privy with that token
  → identity-service verifies with Privy server SDK
  → Upserts user in DB, creates custodial Solana wallet (first login only)
  → Returns our JWT (access + refresh) — all subsequent API calls use this JWT
```

## API Routes

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/auth/privy` | None | Exchange Privy access token for our JWT |
| `POST` | `/auth/refresh` | None | Refresh access token using refresh token |
| `POST` | `/auth/logout` | None | Logout (stateless — client drops token) |
| `GET` | `/auth/nonce` | None | Legacy SIWE nonce (backward compat) |
| `GET` | `/auth/me` | JWT | Current user profile |
| `POST` | `/auth/dev-login` | None (dev only) | Bypass Privy — create/upsert dev user, return JWT |
| `GET` | `/users/me` | JWT | Get own user profile |
| `PUT` | `/users/me` | JWT | Update username / email / avatar |
| `POST` | `/users/link-wallet` | JWT | Link additional wallet |

## Dev Login Endpoint

`POST /auth/dev-login` is available **only when `NODE_ENV !== 'production'`**.

It creates or upserts a dev user with a synthetic wallet address (`0xdev-<username>-local`) and returns a fully valid JWT signed with the same `JWT_SECRET` as production flows. This allows local development and testing without a real Privy app ID or wallet.

**Request:**
```json
{ "username": "DevPlayer" }
```

**Response:**
```json
{
  "accessToken": "eyJ...",
  "refreshToken": "eyJ...",
  "expiresIn": 86400,
  "userId": "uuid",
  "walletAddress": "0xdev-devplayer-local",
  "custodialSolanaAddress": "DevSolana...",
  "isDev": true
}
```

The frontend **⚡ Dev** button (visible in the nav when `NODE_ENV !== 'production'`) calls this endpoint automatically and stores the tokens in `localStorage`.

## Custodial Solana Wallets

- Created once per user on first login
- Private key AES-256-CBC encrypted with `CUSTODIAL_WALLET_ENCRYPTION_KEY`
- Stored in DB — use AWS KMS in production instead of raw key storage
- Holds the user's $ARENA balance on Solana

## JWT Configuration

- Access token: 15 minutes (configurable via `JWT_ACCESS_EXPIRY`)
- Refresh token: 7 days (configurable via `JWT_REFRESH_EXPIRY`)
- Algorithm: HS256
- Both `identity-service` and `agent-service` must share the same `JWT_SECRET`

## Environment Variables

```bash
PORT=8001
DATABASE_URL=postgresql://...
REDIS_URL=redis://localhost:6379
JWT_SECRET=...                            # Must match all other services
JWT_ACCESS_EXPIRY=15m
JWT_REFRESH_EXPIRY=7d
PRIVY_APP_ID=...                          # From privy.io dashboard
PRIVY_APP_SECRET=...                      # From privy.io dashboard
CUSTODIAL_WALLET_ENCRYPTION_KEY=...       # 32-byte hex key for AES-256
NODE_ENV=development                      # Set to 'production' to disable dev-login
```
