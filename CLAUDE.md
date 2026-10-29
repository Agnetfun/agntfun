# DevAgent Launchpad: project memory

**What:** pump.fun style launchpad for autonomous AI developer agents. An agent works in short sessions
(build, test, push, post on X, sleep). The community suggests ideas, holders vote, treasury funds it.
Phases 1 to 7 build one flagship agent; Phase 8 generalizes to many; proposed Phase 9 adds skill driven site building.

**Source docs:** build brief (PDF, rules and phases) and the architecture doc:
https://claude.ai/artifact/Kwx3pkazhCVLMxZDfsp1tf

**Current phase:** Phases 0 to 8 done, plus the full dapp pass (agent wallets, browser launch, real/local adapters, chain market; devnet only). Owner is testing locally with `pnpm local` (see LOCAL-TESTING.md). Phase 9 (skill driven site builder) is NOT approved. Next: owner tests, then adds keys to `.env`, sets `LLM_MODE=real`, resolves the TODO(verify) list.

## Architecture (short)

Orchestrator (scheduler + session runner) drives a Docker sandbox and an LLM adapter. Every privileged
action (git push, X post, site deploy) goes through the action gateway, which alone holds tokens.
Community text is untrusted data; only triaged summaries reach the planner. Treasury ledger and caps gate spending.
Packages: `packages/core` (config, logger, secrets, clock, ids), `packages/db` (SQLite). Apps: `apps/orchestrator`.

## Locked decisions

- LLM via API behind a provider adapter. No local models on the VPS.
- Duty cycled agent. Each agent has its own GitHub and X accounts. Agent never holds secrets or wallet keys.
- Safety comes from code limits (sandbox, allowlists, caps, kill switch), not model judgment.
- Token launch uses pump.fun itself (official SDK or program, verify in Phase 6). We do NOT build our own token deployer.
- No price talk, no buy calls, no financial promises. No trading by the agent.
- No real money or real secrets before Phase 6. Devnet and mocks only.
- UI work follows `skills/landing-page-design/SKILL.md`. Animation work follows `skills/design-to-motion/SKILL.md`.

## Commands

- `pnpm install` then `pnpm check` (typecheck, lint, test, secret-scan)
- `pnpm boot` boots once and exits; `pnpm dev` runs the orchestrator (creates `.env` from `.env.example`)
- `pnpm local` runs web + orchestrator together; `pnpm wallet list|create|airdrop|send`; `pnpm creds set <agent> github|x <token>`
- `pnpm secret-scan [--staged]`; the pre-commit hook runs it automatically
- `pnpm preflight <app.env> [orchestrator.env]` checks mainnet settings; `pnpm --filter @devagent/web build:privy` builds the Privy login bundle (`pnpm local` does it for you). Deploy: DEPLOY.md

## Rules reminders

Verify any external API against official docs; otherwise leave `TODO(verify)`. Files stay under about 300 lines.
Security critical code gets tests first. Update this file, PROGRESS.md and DECISIONS.md at the end of every phase.
