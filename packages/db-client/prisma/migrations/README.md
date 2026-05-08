# Prisma Migrations

This directory contains the migration history for the AI Arena PostgreSQL database.

## Running Migrations

```bash
# Development (creates migration files)
pnpm migrate:dev

# Production (applies existing migrations)
pnpm migrate
```

## Resetting the Database (dev only)

```bash
npx prisma migrate reset
```
