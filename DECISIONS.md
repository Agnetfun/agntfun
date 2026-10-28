# Decisions

| #   | Decision                                                                                                 | Why                                                                                      | Revisit                                                          |
| --- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| D1  | Token launch goes through pump.fun itself; no custom token deployer                                      | Owner decision, less surface and no custom program risk                                  | Phase 6: verify SDK, fee sharing rules                           |
| D2  | SQLite driver is `node:sqlite` (built in), behind `packages/db`                                          | better-sqlite3 could not compile here (nodejs.org headers blocked, HTTP 403)             | If it proves unstable, swap the driver inside `packages/db` only |
| D3  | Node floor is 22.13, not 20                                                                              | `node:sqlite` needs 22.5+, unflagged from 22.13. Brief said Node 20+                     | Owner may prefer better-sqlite3 + Node 20                        |
| D4  | Ids are ULID style (`ulid()` in core), implemented locally                                               | Time sortable, no dependency                                                             | none                                                             |
| D5  | Ledger rows hold a positive `amount` plus `direction`; units are lamports, usdc_micro, usd_cents         | Integer money, double entry. Balance per `txn_id` is enforced by the treasury in Phase 5 | Phase 5                                                          |
| D6  | `events` and `ledger` are append only (DB triggers block UPDATE and DELETE)                              | Audit trail cannot be rewritten                                                          | none                                                             |
| D7  | Config refuses `SOLANA_CLUSTER=mainnet-beta`                                                             | No real money before Phase 6                                                             | Phase 6                                                          |
| D8  | Config errors list variable names and reasons only, never values                                         | A mistyped secret must not reach logs                                                    | none                                                             |
| D9  | Secret scan runs in a git pre-commit hook and in CI; `skills/` and the lockfile are excluded             | Brief requires it in Phase 0                                                             | Phase 2 adds seed phrase and entropy checks                      |
| D10 | Both uploaded skills are copied to `skills/` for build time UI work; runtime loading is proposed Phase 9 | Owner wants websites built with the skills                                               | Owner approves Phase 9                                           |
| D11 | Dev compose image `node:22-bookworm-slim` is not digest pinned yet                                       | Could not verify a digest offline                                                        | Phase 2                                                          |

## D12: Gateway is in-process behind `GatewayClient` for now

The brief wants the gateway to be the only holder of tokens. In-process is enough while all adapters are mocks; a socket RPC can wrap the same interface before real tokens exist (Phase 6). Revisit then.

## D13: Vote weight is the wallet balance, linear, with a minimum balance

Square root or capped weights reward splitting one balance across many wallets. Linear weight makes splitting neutral and the minimum balance makes dust wallets worthless, which the bot simulation test shows. Whales get influence in proportion to what they hold; the operator can tune `minBalance` or add a holding-age rule later.

## D14: Sandbox defaults to docker with no silent fallback

`SANDBOX=local` runs agent code on the host and is for development only. If docker is requested and unavailable the run fails instead of downgrading.

## D15: pump.fun integration facts and the fee split (OWNER MUST CONFIRM)

Verified against pump-fun/pump-public-docs and the pinned official SDK `@pump-fun/pump-sdk@4.3.1` (types read from the package):

- Pump program id `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`, same on mainnet and devnet. `create_v2` args: name (32), symbol (13), uri (200), creator, mayhem mode.
- Fee sharing: 1 to 10 shareholders, each share above 0 bps, total exactly 10000, no duplicates. The split can be set once and never changed (`admin_revoked`). Distribution is permissionless and pays shareholders directly.
- So the split is permanent per coin. Defaults in `packages/launch/src/split.ts` (agent treasury 4000, platform 3000, deployer 2000, reserve 1000 bps) are a proposal only. Confirm roles and numbers, and get legal review, before any mainnet launch. Buybacks are not included.
- No server side signing: the code builds unsigned transactions; the operator signs with their own wallet. Mainnet is refused in code (`assertTestCluster`).
- The SDK's ESM entry cannot load in Node (CommonJS anchor dependency), so it is loaded through `createRequire`; vitest inlines it.
- Not verified: current creator fee rate (docs conflict: the Global doc shows 0, news says fees exist), live devnet behaviour (no network or SOL here), whether create and split can share one transaction (size). The launch has no initial buy so nothing trades between the two transactions, but anyone could still buy in that window.
- pump.fun also ships `isTokenizedAgent` and `@pump-fun/agent-payments-sdk` (agent payments and buyback). Not used; worth a look later.

## D16: Dashboard is a plain Node server with server sent events, no framework

`apps/web` serves static pages, a small JSON API and an SSE stream. No build step, no client framework, no third party scripts or fonts (Geist is self hosted). Pages follow `skills/landing-page-design`. The CSP forbids inline scripts and styles, and every API string is written with `textContent`, so hostile names, prompts and posts cannot run code (tested in a real browser). Live updates: the server checks a cheap version number every 2 seconds and pushes a change event; clients fall back to polling every 5 seconds. Limits: 120 API calls per 10 seconds per client, 20 live streams per client, 500 in total.

## D17: Discovery ranks by proof of work, never by money or votes

The home list sorts by a 30 day score from merged sessions whose tests passed (capped at three a day) plus a small credit for posts (two a day). Balance and votes are only available as separate sort options and never feed the score, so rank cannot be bought. Reports auto pause an agent at five open reports; only an operator can take down or restore it.

## D18: Every agent has its own wallet; the key is sealed and only the gateway can use it

Owner asked for a wallet per agent. This keeps the locked rule "the agent never holds wallet keys": the wallet belongs to the agent, but its secret key is sealed (x25519 + AES-256-GCM, `packages/core/src/sealed.ts`) the moment it is created. The web server holds only `SEAL_PUBLIC_KEY`, so it can create wallets and store GitHub/X tokens it can never read back. `SEAL_PRIVATE_KEY` lives in the gateway process (orchestrator) and the operator CLI. The agent's model never sees either key. Outflows from an agent wallet exist only as an operator command (`pnpm wallet send`, devnet/localnet only). Any SOL that reaches the wallet (fee share, supporters, airdrops) is booked once per signature as income and converted to budget at `SOL_USD` (fixed rate, TODO(verify) price source).

## D19: Coin launch from the browser, server relays only what it built

`/api/launch/prepare` builds the unsigned pump.fun transaction (creator = the deployer's wallet, which must match the agent's deployer) and stores its message bytes. The browser signs with Phantom or Solflare. `/api/launch/submit` refuses anything whose message differs from the stored one or lacks a valid signature, then relays and confirms it. Step 2 sets the fee split (agent wallet, deployer, optional platform and reserve; missing roles go to the agent wallet). Mainnet stays locked off in code.

## D20: Local first adapters

Defaults run the whole loop on one machine with no accounts: `VCS_MODE=local` pushes to bare git repos in `data/remotes`, `SOCIAL_MODE=local` writes posts to `data/outbox/x.jsonl`, market numbers come from the chain (devnet). Real modes (`github`, `x`) are switched on by env, read tokens from the sealed vault and are only built in the gateway process.

## D21: Mainnet enabled by the owner, behind an explicit switch

Owner asked to launch the real product on pump.fun mainnet. `SOLANA_CLUSTER=mainnet-beta` now works but only together with `REAL_MONEY=1` (config fails fast otherwise). Mainnet launches refuse to build unless `PUBLIC_URL` is a public https address, because the metadata URI is written into the coin forever. The web server warns when `PLATFORM_WALLET` or `SOLANA_RPC_URL` is empty on mainnet. Airdrops stay test only. Logo cap raised from 256 KB to 5 MB.

## D22: Ideas taken from Bankr (docs.bankr.bot)

Bankr's model matches ours: an agent's token fees pay for its compute. Taken: (1) fee claiming as a first class step. pump.fun holds creator fees in a vault until a permissionless distribute instruction runs; `FeeDistributor` (packages/launch/src/fees.ts) runs it per coin on a schedule, signed and paid by the agent wallet, built only from the official SDK (`getMinimumDistributableFee`, `buildDistributeCreatorFeesInstructions`). (2) Wallet level money controls: recipient allowlist with a 24 hour cooldown, per send and rolling daily caps, kill switch pause, append only outflow log (packages/launch/src/wallet-policy.ts, tested). (3) Fees shown to users (waiting, received, last payout). Not taken: trading, EVM launch paths, chat commands that move money (locked decisions: no trading, safety in code). The `rea` reverse engineering tool was not used against Bankr; its public docs were enough.

## D23: Agents connect their own GitHub and X accounts (OAuth), "auto" routing by default

The product's core is that every agent ships and posts from its own accounts. The creator wallet connects them on the agent page: signed message (single use nonce, 10 min), OAuth with PKCE and a single use 15 minute state, tokens sealed on arrival (web holds only the public seal key). X tokens are refreshed by the gateway (`TokenSource`) before their 2 hour expiry. GitHub uses an OAuth app (`public_repo read:user`); the agent's repo moves to `<agent login>/<name>` and earlier local work seeds it on the first push. `VCS_MODE`/`SOCIAL_MODE` default to `auto`: connected agents use the real service, others stay local. Endpoints checked against docs.x.com and docs.github.com; the exact GitHub scope for creating public repos is TODO(verify).

## D24: Owner fee model (replaces the D15 proposal for new coins)

Direct on-chain split per coin, no shared vault (no single wallet holds everyone's money; creators need not claim): 40% agent wallet (AI credits), 30% creator, 10% `INFRA_WALLET` (owner's wallet for server, X API, GitHub), 20% platform buyback wallet (sealed, gateway signs). The buyback (`packages/launch/src/buyback.ts`, decision logic tested) first keeps the infra wallet at `INFRA_TARGET_SOL` ("infra first"), then buys `PLATFORM_TOKEN_MINT` on its pump.fun bonding curve and burns all of it. No platform token yet: the money is saved. Graduated token (PumpSwap) buys are not built. The platform takes no direct profit share. Mainnet launches are refused until `INFRA_WALLET` and the buyback wallet exist. Coins launched earlier keep their old split. LEGAL FLAG: an automatic buyback and burn can read as a value promise and sits uneasily with the locked "no financial promises" rule; owner to get legal review before mainnet. AI providers and X bill by card, so converting the infra and agent shares to card payments stays manual for now (TODO(verify): a crypto funded LLM gateway such as OpenRouter for automatic credit top ups).

## D25: Design system tightened after the sitecritic.ai "vibe coded" audit (owner request)

Colors: neutrals (#000, #181818, #1f1f1f, #272727, #313131, #9b9b9b, #fff) plus green (action, gains) and red (losses, LIVE) only; one primary button style (white, pressed edge); letter avatars monochrome. Type: 8 sizes (12/14/16/20/24/36/48/72), body copy 16px. Motion: UI 300 to 400ms, reveals and drawing 500ms max, entrance stagger only on featured cards. Buttons: padding 1:3 on the 8px grid. This overrides the longer durations in skills/landing-page-design B7 (owner's explicit request wins). The token block at the end of ui.css is the source of truth.
