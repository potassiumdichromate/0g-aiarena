# Contributing to AI Arena

Thank you for contributing. This document covers the development workflow,
code standards, and pull request process.

## Development Setup

```bash
# Clone the repository
git clone https://github.com/0g-ai/0g-AIArena.git
cd 0g-AIArena

# Install dependencies
pnpm install

# Start infrastructure
docker-compose up -d

# Run migrations
cd packages/db-client && pnpm prisma migrate dev && cd ../..

# Start all services
pnpm dev
```

## Repository Structure

```
apps/           — Next.js web application
services/       — 25 Node.js microservices
workers/        — Python/TypeScript background workers
packages/       — Shared libraries (types, utils, clients)
contracts/
  solana/       — Anchor programs (Rust)
  evm/          — Hardhat (Solidity)
unity/          — Unity C# SDK
ml/             — Python ML modules
infra/          — Kubernetes, Helm, Terraform
docs/           — Documentation
```

## Code Standards

### TypeScript

- Strict mode enabled (`"strict": true` in tsconfig.base.json)
- No `any` types — use `unknown` and narrow with type guards
- All async functions must handle errors explicitly
- Use Zod for runtime validation of external data
- Prefer `const` over `let`

### Python

- Python 3.11+ with type hints on all function signatures
- Use `dataclasses` for data-transfer objects
- Docstrings on all public functions and classes
- Format with `black`, lint with `ruff`

### Rust (Anchor)

- All public functions must have `/// doc comments`
- Use custom error types (`#[error_code]`) instead of generic errors
- Validate all account constraints with Anchor `#[account(...)]` attributes
- Never use `unwrap()` — propagate errors with `?`

### Solidity

- Solidity 0.8.24+
- NatSpec comments on all external functions
- Events for all state changes
- Follow Checks-Effects-Interactions pattern
- No `tx.origin` — use `msg.sender`

## Pull Request Process

1. Fork the repo and create a feature branch: `git checkout -b feature/your-feature`
2. Write code following the standards above
3. Add tests for new functionality
4. Run `pnpm typecheck && pnpm lint && pnpm test` and fix any failures
5. Open a PR against `main` with a clear description of what and why
6. Request review from at least one maintainer
7. Address all review comments before merging
8. Squash commits before merging

## Testing

```bash
# All tests
pnpm test

# Single service
cd services/identity-service && pnpm test

# Anchor programs
cd contracts/solana/agent-wallet && anchor test

# EVM contracts
cd contracts/evm && pnpm test

# Python ML modules
cd ml/behaviour_cloning && python -m pytest
```

## Commit Convention

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(agent-service): add clone agent endpoint
fix(inference): handle timeout edge case when 0G Compute is unreachable
docs(sdk): add spectator mode quickstart example
refactor(matchmaking): extract ELO window calculation to shared-utils
test(battle-service): add dispute resolution integration test
```

## Issue Reporting

For bugs: include reproduction steps, expected vs actual behaviour, and logs.
For features: describe the use case and why existing features don't cover it.

Security vulnerabilities should be reported privately to security@aiarena.gg.

## License

By contributing you agree your code will be licensed under the MIT License.
