-- AI Arena PostgreSQL initialization script
-- Runs on first container start via docker-compose volume mount

-- Create extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE EXTENSION IF NOT EXISTS "btree_gin";

-- Create application database if not exists
-- (already created by POSTGRES_DB env var, this is just idempotent)
SELECT 'AI Arena database initialized' AS status;

-- Create read-only role for reporting
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'aiarena_readonly') THEN
        CREATE ROLE aiarena_readonly NOLOGIN;
    END IF;
END
$$;

-- Grant select on all current and future tables
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO aiarena_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO aiarena_readonly;

-- TimescaleDB hypertable setup will be done via Prisma migrations
-- This script just ensures extensions and roles exist before Prisma runs

SELECT version() AS postgres_version;
