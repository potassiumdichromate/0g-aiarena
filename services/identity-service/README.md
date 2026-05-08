# identity-service

Handles authentication via Sign-In with Ethereum (SIWE), JWT issuance, and user profile management.

## Port: 8001

## API Routes

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | /auth/nonce | No | Get SIWE nonce for wallet |
| POST | /auth/login | No | SIWE login, returns JWT |
| POST | /auth/refresh | No | Refresh access token |
| POST | /auth/logout | No | Logout (client-side token deletion) |
| GET | /users/me | JWT | Get own user profile |
| PUT | /users/me | JWT | Update profile |
| POST | /users/link-wallet | JWT | Link additional wallet |

## Environment Variables

```
DATABASE_URL=postgresql://...
REDIS_URL=redis://...
JWT_SECRET=...
JWT_REFRESH_SECRET=...
PORT=8001
```
