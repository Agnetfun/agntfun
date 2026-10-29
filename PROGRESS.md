# Progress

## Phase 0: Foundation (done)

Built: pnpm monorepo, lint/format/typecheck/test setup, typed config loader that fails fast, logger with
secret redaction, secret scanner, `node:sqlite` schema v0 (agents, sessions, events, ledger), orchestrator boot,
dev compose file, pre-commit secret scan plus CI workflow, CLAUDE.md, DECISIONS.md, `.env.example`.

Acceptance (evidence from the Phase 0 run):

- [x] Tests pass: 34 of 34 (`pnpm check`: typecheck, lint, tests, secret-scan all green)
- [x] Dev command starts: `pnpm boot` migrated the DB (version 1) and logged "orchestrator ready"
- [x] Config fails fast: missing `DB_PATH` printed `DB_PATH: missing` and exited 1
- [x] Secrets gitignored (`.env` matched by `.gitignore:8`); a staged fake GitHub token was blocked by the pre-commit hook

Not tested or uncertain:

- `docker-compose.dev.yml` was not started (no daemon access checked). It is untested.
- CI workflow has never run; action versions (`@v4`) are unverified.
- `node:sqlite` prints an ExperimentalWarning; see DECISIONS D2 and D3.
- Secret scanner has no seed phrase or entropy detection yet (planned for Phase 2).

## Next

Owner names the next phase. Open questions needed before Phase 1: LLM provider and model tiers, and the
flagship agent's first project. Phase 9 (skills and site builder) is proposed in the architecture doc and awaits approval.

## Phase 2: sandbox, action gateway, kill switch, red team (done)

- `packages/sandbox`: Workspace interface, GitWorkspace (git dir kept outside the mounted dir), DockerWorkspace (hardened flags; runtime untested, no daemon here), LocalWorkspace (dev only).
- `packages/safety`: KillSwitch (global or per agent, DB backed, recorded as events) and hard-line content filters (outbound, posts, deployer prompts).
- `packages/gateway`: ActionGateway pipeline kill, schema, allowlist, limits, secrets, content, execute; token buckets; append-only `gateway_audit`; mock VcsHost and Social ports.
- `pnpm redteam`: 30 attacks, each denied at the expected stage.
- Not built: Unix-socket RPC between runner and gateway (in-process `GatewayClient` interface for now, see DECISIONS D12).

## Phase 3: publisher (done)

- `packages/publisher`: posts are composed from measured facts (runner test result, patch stats, end reason), never from model text; task text is sanitised and re-checked; wording rotates and a trigram similarity check blocks near-repeats; a link is added only when the post budget allows (cost meter, prices are TODO(verify)).
- `publishSession`: push session branch, merge to main only if finished and tests pass, then post, all through the gateway. Posts are stored in append-only `posts` with cost.
- GitHub and X adapters: mocks work; real classes are stubs that throw until credentials and official docs are checked.

## Phase 4: community pipeline (done)

- `packages/community`: collector (raw text stored as data, clipped, control chars stripped, deduped), deterministic `preFilter` (35 injection cases in tests), LLM triage with strict zod output that is re-checked (secrets, links, markup, cashtags, injection echo), wallet signed ed25519 votes (Solana style base58 keys, signature bound to agent and suggestion), mock balance provider, ranked queue, `promoteTop` turns voted suggestions into tasks.
- Only the validated summary reaches the planner. Raw suggestion text never leaves this package.
- Real X source is a TODO(verify) stub; mock source works.

## Phase 5: scheduler and treasury (done)

- `packages/treasury`: double entry ledger (rejects unbalanced entries, append-only), creator fee and conversion booking, top ups, categorised spend (LLM spend uses prepaid credits first), runway from the 7 day burn, daily cap, sleep gate `canRun`. Outflows (`withdraw`, `buyCredits`) exist only as operator methods and refuse unknown operator ids.
- `packages/scheduler`: duty cycle. Per agent interval, kill switch and treasury checked before every wake up, states waking, running, publishing, sleeping, starved, halted. A top up wakes a starved agent. A 14 day fake time simulation covers starvation, top up, kill drill and an unfunded agent that never runs.
- `pnpm treasury status|topup|buy-credits|kill|unkill` operator commands. Orchestrator now runs the scheduler (mock GitHub/X, SANDBOX=docker by default, no silent fallback to local).
- Session reserve must be at least the largest session cost; boot derives it from the session cap plus a post.

## Phase 6: pump.fun launch and treasury listener (done on mocks, builder verified offline)

- `packages/launch`: split validation mirroring the on-chain rules, `MockLaunchPad` (split settable once, fees accrue and distribute by bps), `TreasuryListener` (idempotent booking of the agent treasury share, cursor plus unique ledger reference), real transaction builder on the official SDK (unsigned create_v2 and fee sharing transactions, devnet/localnet only, tested offline against the SDK).
- `pnpm launch mock|prepare|prepare-split|submit|record`: operator flow, no signing in our code.
- Operator-only outflows were done in Phase 5 (`withdraw`, `buyCredits`).
- Not exercised: a live devnet launch (needs your wallet, devnet SOL and network access from your machine). Do this after the build: `pnpm launch prepare ...`.

## Phase 7: public dashboard (done)

- `packages/dashboard`: public view models (agent cards, detail, activity feed, queue, treasury, split). Raw community text, authors and operator ids never appear.
- `apps/web`: home page with live agent cards, agent page (activity, sessions, treasury, ranked queue, fee split, locked brief), privacy, terms, branded 404. `pnpm web` serves on port 3000 (`WEB_PORT`, `WEB_HOST`, `TRUST_PROXY=1` behind a proxy).
- Tests: server (headers, CSP, traversal, rate limit, stream cap), browser (`pnpm e2e`: XSS strings stay inert, phone layout, live update under 5 seconds, skip link), soak (`pnpm soak` for one hour; the default run is 5 seconds with 300 viewers, 60 seconds also passed).
- `session.published` events now record each push for the feed.

## Phase 8: many agents, deployer flow, voting, moderation (done)

- `packages/platform`: signed deploy flow (wallet signs name, model, brief hash, nonce and time; nonces are single use; unique names; per wallet limits), model choice per agent (Opus 5.5 medium or GPT 6 Astra), discovery ranked by proof of work (merged sessions with passing tests, capped per day; votes and balances never count), reports with auto pause at five, operator takedown, restore and dismiss.
- Web: `/launch` page (wallet connect, sign, create), agent page voting and report form, `/api/deploy`, `/api/vote`, `/api/report`, `/api/agents?sort=proof|new|funded`, removed agents answer 410 and vanish from lists. Same origin check, 8 KB body cap, per client limits on every write.
- `pnpm moderate list|takedown|restore|dismiss` (uses `OPERATOR_ID` and `OPERATOR_IDS`).
- `apps/web/src/main.ts` now wires the kill switch and on chain voting weight (devnet or localnet launches only; no launch or a mock launch means no voting).
- Tests: platform unit tests, write endpoint tests, browser test that deploys an agent with a wallet signing in the page. The e2e caught a missing wallet script on the launch page.

## Phase 8b: coin style front end (done)

- New look: flat dark palette with green (action, activity) and blue (links, tickers, treasury chart). Hero with the top shipper card, tabs, search, coin grid with logo, ticker, description and 14 day activity line.
- Agent page: logo, ticker, description, GitHub and X chips, charts (merges per day, treasury balance, spend), activity list, treasury, votes, report.
- Launch page: logo upload (PNG, JPG, WebP or GIF up to 256 KB, type read from the bytes, SVG refused), ticker, description, X handle.
- `pnpm demo` serves fake data on http://127.0.0.1:3001 so the site can be judged without keys.
- Not done and needs your keys: GitHub and X are shown as links; real account connection (OAuth or tokens held by the gateway) is not built. A market price chart needs a live token and a verified data source, so only work and treasury charts exist.

## Phase 8c: multi page site in the reference layout (done)

- One stylesheet (`ui.css`), shared header, footer and wallet dialog as partials (`apps/web/public/partials`). Full width header with nav, Launch agent and Connect wallet; wallet dialog (Phantom, Solflare) works on every page and the address shows in the header.
- Pages: home (banner, totals, search, sort, filters, agent grid), agent token page (stats, candlestick market chart with timeframes, work and treasury charts, holders, trade panel, votes, details, report), launch (form plus summary and proposed fee split), how it works, treasury, API docs, privacy, terms, 404.
- Market layer: `MarketProvider` interface with a deterministic `DemoMarket`. Everything it produces is labelled demo. TODO(verify): connect a live source (pump.fun or a DEX data API) for launched coins; the trade button opens pump.fun only for mainnet tokens.
- New API: `/api/agents/:id/market`, `/holders`, `/api/treasury`.

## Full dapp pass (built, owner testing locally)

- Agent wallets: every agent gets a Solana wallet at deploy (key sealed, gateway only; see D18). Agent page shows address and live balance. `pnpm wallet list|create|airdrop|send`.
- Launch from the website: creator signs the pump.fun create transaction and then the fee split in Phantom/Solflare; server relays only the exact transaction it built (D19). Coin metadata served at `/meta/<id>.json`.
- Treasury from chain: SOL arriving in an agent wallet is booked once per signature and converted to budget at `SOL_USD`.
- Market from chain: bonding curve price and top holders sampled every `CHAIN_POLL_SECONDS`; candles built from samples (`ChainMarket`). Demo data only with `MARKET=demo`.
- Real adapters behind the gateway: git CLI host (local bare repos or GitHub with repo auto create), X posting, X mentions as suggestions; sealed per agent token vault (`pnpm creds`). Local defaults need no accounts (D20).
- Community loop now runs in the orchestrator: website "Suggest an idea" form and X mentions, triage (scripted in mock mode), promotion to tasks.
- `pnpm local` runs web and orchestrator together. Guide: LOCAL-TESTING.md.
- Checks on the build machine: typecheck and lint clean; 241 tests pass. 13 sandbox/runner tests fail only because Git is not installed on that machine (`spawn git ENOENT`); the soak test reached 232 of 300 viewers under load there.
- Not exercised: a live devnet launch, real GitHub push, real X post (need the owner's wallet, network and accounts).

## Live agent screen (built)

- Every session step now writes a redacted "live frame" (`live_frames`, `packages/runner/src/live.ts`): files the agent wrote, test output, commits. Raw model text is never shown; files that look like secrets are hidden.
- Agent page: full width "Agent screen" (file list, editor with typing and syntax colors, terminal) with a red LIVE badge while the agent works, replay of the last five sessions, and a session picker. API: `GET /api/agents/:id/live?session=&after=`.
- Home: LIVE pill on cards of agents coding right now.
- `pnpm demo` simulates one agent coding a session every 40 seconds so the screen can be watched without keys.

## Bankr ideas applied (built, not run on chain)

- Automatic pump.fun creator fee payout per coin (orchestrator chain tick, `FEE_PAYOUT_MIN_SOL`), so the agent wallet actually receives its share.
- Agent wallet outflow policy: `pnpm wallet allow|disallow|allowlist`, `send` checks allowlist cooldown, per send and daily caps, kill switch. 6 tests.
- Agent page wallet card: received so far, coin fees waiting, last payout.

## Agent accounts: Connect GitHub and Connect X (built, not run against the real services)

- `packages/gateway/src/oauth.ts` (PKCE, code exchange, refresh, who am I), `TokenSource` refresh in the vault, adapters route per agent in `auto` mode, GitHub repos under the agent's own account with seeding of earlier work.
- `packages/platform/src/connect.ts` (creator only start, single use state, disconnect), 4 tests. Web: `/api/connect/start|remove`, `/oauth/callback/:kind`, `/api/agents/:id/connections`, "Agent accounts" card. Setup: ACCOUNTS-SETUP.md.

## Fee model D24 (built, not run on chain)

- New split 40 agent / 30 creator / 10 infra / 20 buyback, platform buyback wallet created and sealed automatically, buyback engine in the orchestrator (`BUYBACK_EVERY_HOURS`), infra first then buy and burn, 6 tests. Site labels updated.

## App shell redesign (built)

- Left sidebar on every page (Board, Live now, Burns, Treasury, How it works, API, $TOKEN once set), brand logo, pressed white "Launch agent" button; phones get a top bar and a slide in panel.
- Home is now a board: featured agents, trending today (Live, Movers, Newest), ranked table (Most shipped, Market cap, Fees earned, Newest), live ticker. The long story moved to How it works (product shot, steps, feature cards, fee split, FAQ).
- New pages: /live (agents coding now and recent replays), /burns (buyback and burn activity, `GET /api/burns`). Agent cards carry `feesSol`.
- Shell polish: sidebar collapses to an icon rail (remembered), close button in the phone menu, board fills wide screens (3 column trending at 1700px+). Motion: count up stats, cards rise in, sparklines draw, prices flash green or red on change, LIVE dots pulse, logo spins on hover, the Launch button bursts on press. All respect reduced motion.
- Polish pass across every page (impeccable polish): removed eyebrow labels; fixed stale copy (launch accounts note, treasury fee flow, API docs now cover live screen, wallet, burns, accounts); honest LIVE badge on /live; correct plurals; `$` on every ticker; one step number style; left aligned cards; neutral logo slot; mono only for data; themed selection, scrollbars, caret and tabular numbers; even form rhythm; session picker hidden until a session exists; 404 rebuilt on the page grid with next steps.
- Agent page redesign: live screen first, one tabbed data panel (Market, Work, Activity, Sessions, Holders), details in a right rail, report folded away; creator setup checklist (connect GitHub, connect X, launch coin, fund wallet) with progress, reached from the launch wizard (`/launch` shows the three steps, then opens `/agent/:id?setup=1`). Verified badge (own GitHub and X both connected) on board cards and the agent header; `verified` on agent cards.
- Accounts made complete: GitHub scope verified (public_repo creates and pushes public repos); connection health (every real push, post and mentions read marks OK or "needs reconnect", shown on the agent page with a Reconnect button and in the setup checklist; new tokens clear it); X mentions throttled per agent (`X_MENTIONS_EVERY_MINUTES`, default 15); `pnpm creds check [agent]` logs in with each account and verifies GitHub push scope; 7 tests (refresh, rotation, single refresh, health, redaction, throttle).
- Agent memory: every session starts with a clipped, secret scanned summary of its last five sessions (task, outcome, tests, files, last commit, the tail of a failing test run) and the current file tree, as data in its first message; live screen shows "recall N past sessions". Built only from recorded facts, never community text. 6 tests including a real two session run.
- X costs: real pay per use prices charged to each agent's treasury (posts, mention reads, account lookup); links off by default ($0.20 vs $0.015). Chart axis precision and flat price padding fixed. Buy and sell panel and TradingView chart on the agent page (D26).

### 2026-10-29: connections tested live, voting quorum, pro coding mode
- Owner tested X and GitHub Connect end to end (two agents, two X accounts, repo created on github.com).
- Fixed: git push "corrupt patch" (trimmed final newline) and new GitHub repos now start with the agent's starter files.
- Fixed: unfunded agents were charged for X mention reads (negative treasury); runway never shows below 0.
- X post errors explain 402 (no credits), 403 (needs Read and write), 429.
- Voting quorum (D28): VOTE_MIN_VOTERS and VOTE_MIN_SUPPLY_PCT; triage now judges ideas against the locked brief.
- Pro coding mode (D29): CODING_MODE=pro runs the Claude Agent SDK with a tested path guard. Not yet run against the
  real API (needs the owner's key).
