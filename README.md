# Sentinel

A deterministic on-chain monitor for the positions you hold (stablecoin vaults, lending, RWA tokens). It reads state from your wallets on Ethereum mainnet and sends tiered Telegram alerts: **P0** exit now (inline ACK, repeats until acknowledged), **P1** decide within hours, **P2** daily digest. No LLM anywhere in the alert path. The spec is [`PLAN.md`](PLAN.md); this README covers setup and the Phase 0 runbook.

**Phase 0 status (skeleton).** The full pipeline runs end to end with one stub watcher (`proxy`: the three EIP-1967 slots). Real protocol watchers (Safe, timelock, Morpho, oracle, peg, liquidity, ...) arrive in Phases 1 to 4, each as a module that plugs into the same interface. Phase 0 proves: config, dual RPC, block tracking and reorg handling, SQLite, rules engine, Telegram (three bots, ACK loop, digest, `/status`), heartbeat, replay harness, Windows service.

## Contents

1. [How it works](#how-it-works) · 2. [Accounts and keys](#accounts-and-keys) · 3. [Install and configure](#install-and-configure) · 4. [Run it](#run-it) · 5. [Windows service](#windows-service-the-24x7-pc) · 6. [Phase 0 exit-criteria runbook](#phase-0-exit-criteria-runbook) · 7. [Replay](#replay-harness) · 8. [Docker](#docker-later-vps-migration) · 9. [Operations](#operations) · 10. [Layout](#repository-layout)

## How it works

```
new head (WS, HTTP poll fallback) -> target T = head - 2
  reads at T (Multicall3 + eth_getStorageAt) + eth_getLogs[cursor+1..T]   <- Alchemy, failover Infura
  watchers.fold(...)  -> samples       (pure; state reads are truth, events only add the tx link)
  position/           -> exposure USD, exit path OPEN/CLOSED
  rules/              -> opened / escalated / resolved   (hysteresis, persistence, cooldown, dedupe)
  alerts/             -> rendered alert rows (outbox)
  ---- one SQLite transaction incl. the new cursor ----
  Healthchecks.io ping only after that commit
telegram/ delivers the outbox, repeats P0 every 5 min until ACK, posts RESOLVED replies
```

Everything position-relative: exposure is read on-chain from the EOAs in `wallets.yaml`. Holdings are configuration (`config/holdings/*.yaml`); watcher code contains no protocol addresses (a test enforces it).

## Accounts and keys

Everything below goes into `.env` (copy `.env.example`). `sentinel config check` lists any variable that is missing or empty (names only, never values).

### Telegram: three bots, two chats, your user id

1. In Telegram, open **@BotFather**, send `/newbot` three times. Suggested names: `Sentinel P0`, `Sentinel P1`, `Sentinel P2`. Save each token (`TELEGRAM_P0_TOKEN`, `TELEGRAM_P1_TOKEN`, `TELEGRAM_P2_TOKEN`).
2. Create two Telegram groups (or use private chats with each bot): one for **P0**, one for **P1 + P2**. Add the matching bot(s) to each group. On your phone, give the P0 chat a distinct sound and allow it to override Do Not Disturb.
3. Send any message in each chat after adding the bots, then open `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser and read `message.chat.id` (negative for groups, e.g. `-1001234567890`). Set `TELEGRAM_P0_CHAT_ID`, `TELEGRAM_P1_CHAT_ID`, `TELEGRAM_P2_CHAT_ID` (P1 and P2 may share an id). Use numeric ids: `@channel` usernames are not accepted, because ACK authorisation compares the numeric chat id.
4. Get your numeric **user id** from **@userinfobot** and put it in `config/wallets.yaml` as `telegram_user_id`. Only that user can press ACK / Snooze or run commands; anyone else in the group gets "Not authorised" and nothing changes.
5. If a bot should read group commands (`/ack`, `/status`), in BotFather use `/setprivacy` -> Disable for that bot, or address commands as `/status@YourBot`.

### Healthchecks.io (the dead-man's switch)

1. Sign up at healthchecks.io (free tier: 20 checks, Telegram integration).
2. Create a check named `sentinel`. **Period 5 minutes, grace 5 minutes** (Sentinel pings after committed cycles, at most once per 60 s; a stalled chain also stops pings, which is intended).
3. Integrations: add Telegram (a chat you will see even if the P0 bot is down) and, ideally, email or SMS as a second route. This is the path that alerts you when Sentinel itself or Telegram delivery is dead.
4. Copy the ping URL (`https://hc-ping.com/<uuid>`) into `HEALTHCHECKS_PING_URL`.

### RPC providers

* **Alchemy** (primary, HTTPS + WSS): create an app on *Ethereum Mainnet*, copy the API key into `ALCHEMY_API_KEY`. Replay and 7-day windows need historical state: verify at signup that archive access is included on your tier (PLAN.md calls this an assumption, not a verified fact).
* **Infura / MetaMask Developer** (secondary): create a key with the Ethereum mainnet network enabled, copy into `INFURA_API_KEY`.
* **dRPC public endpoint** (canary): no key; already in `config/sentinel.yaml` (`https://eth.drpc.org`, marked `# verify`). It is only asked for `eth_blockNumber`.

### Safe Transaction Service API key

Needed from Phase 1 (queued-transaction watcher; unauthenticated access is limited to 5k requests/month). Create a key in the Safe developer dashboard (`developer.safe.global`), put it in `SAFE_TX_SERVICE_API_KEY`. Phase 0 only requires that the value is non-empty.

### Etherscan API key

Needed from Phase 1 (verified ABIs to decode queued calldata behind proxies). Create a key at `etherscan.io/apis` (the V2 key works for mainnet) and put it in `ETHERSCAN_API_KEY`.

## Install and configure

Requires Node 22+.

```bash
git clone https://github.com/bfcapll/sentinel && cd sentinel
npm ci
cp .env.example .env                                 # fill in every value
cp config/wallets.example.yaml config/wallets.yaml   # your EOAs + Telegram user id (gitignored)
npm run build
node dist/cli.js config check                        # fails loudly until everything is real
```

`config check` reports, per file and path: missing env vars, unfilled placeholders (`0x…`, `<…>`, `TODO`), unknown keys (typos are errors), bad checksums, dangling wallet labels and node references. It also lists every value still marked `# verify`; check each against Etherscan or the issuer repo and delete the marker (`--strict` makes remaining markers fail the check). The reference for every field is generated into [`config/SCHEMA.md`](config/SCHEMA.md) (`npm run gen:schema`; a test fails if it is stale).

The shipped `config/holdings/steakhouse-usdc.yaml` is the PLAN.md §5.2 worked example. **Every address in it is unverified**, and the vault roles (owner, curator, guardian, Safes) are `0x…` placeholders on purpose: the check fails until you read them from Etherscan / Morpho docs. Copy it as the template for each position (3 to 5 to start). Then pin the vault's markets:

```bash
node dist/cli.js config discover steakhouse-usdc            # reads withdrawQueue on-chain, writes markets.pinned (with comments)
node dist/cli.js config discover steakhouse-usdc --dry-run  # preview only
```

## Run it

```bash
node dist/cli.js telegram test        # one test message per bot: proves tokens + chat ids
node dist/cli.js run                  # foreground; Ctrl+C stops cleanly
node dist/cli.js status               # cursor, open conditions, RPC health (read from the DB)
npm run check                         # lint + typecheck + tests (before every push)
```

Other commands: `backup`, `healthcheck`, `demo p0|p1|resolve`, `replay`, `config schema`. Run `node dist/cli.js help`.

## Windows service (the 24x7 PC)

Layout (`C:\sentinel`): `app\` (code), `config\`, `.env`, `data\` (SQLite, WAL), `backups\`, `logs\` (rotated).

One-time, in an **elevated PowerShell**:

```powershell
winget install OpenJS.NodeJS.LTS      # Node 22 LTS, system-wide
winget install NSSM.NSSM              # or: choco install nssm
mkdir C:\sentinel; cd C:\sentinel
git clone https://github.com/bfcapll/sentinel app
cd app; npm ci; npm run build; npm prune --omit=dev
Copy-Item .\config C:\sentinel\config -Recurse
Copy-Item .env.example C:\sentinel\.env       # then edit C:\sentinel\.env
Copy-Item C:\sentinel\config\wallets.example.yaml C:\sentinel\config\wallets.yaml   # then edit
powershell -ExecutionPolicy Bypass -File .\deploy\windows\install-service.ps1
```

`install-service.ps1` verifies Node 22 and NSSM, runs `config check` (refuses to install on an invalid config), registers service **`sentinel`** (delayed auto-start, so it runs before login and after Windows Update reboots; restart on any exit after 10 s; Ctrl+C first on stop so SQLite closes cleanly; stdout/stderr to `logs\`, rotated at 10 MB or daily), sets service-failure restart actions, registers the nightly task `sentinel-maintenance` (03:30: online DB backup keeping `store.backup_keep` copies, delete logs older than 30 days) and starts the service.

Day to day: `Get-Service sentinel`, `nssm restart sentinel`, `Get-Content C:\sentinel\logs\sentinel.out.log -Tail 50` (JSON lines), update with `deploy\windows\update.ps1`, remove with `deploy\windows\uninstall-service.ps1`. Set Windows power settings to never sleep and keep Windows Update from restarting during active hours. The PowerShell scripts were written for Windows but have not been executed in the sandbox that built this; run them once with `-Verbose` and read the output.

## Phase 0 exit-criteria runbook

PLAN.md §10 exit: *service runs on the Windows box, `/status` works, kill-test triggers a Healthchecks alert, P0 ACK loop demo.* These need your accounts and the Windows box, so they are demonstrated by you with the steps below.

**0. Preconditions:** `config check` passes, `telegram test` delivered 3 messages, service installed.

**1. Service runs.** `Get-Service sentinel` shows `Running`; within a minute `node dist\cli.js status --config C:\sentinel\config` (cwd `C:\sentinel`) prints a cursor block that advances every ~12 s, and the Healthchecks check turns green. Reboot the PC once and confirm it comes back by itself.

**2. `/status` works.** Send `/status` to the **P1 bot**: you get head block, per-provider head/lag/errors with the active provider marked, last cycle duration, open conditions, exposure and exit path per holding, watcher health and the last Healthchecks ping. (`/status` sent to the P0 or P2 bot replies with a pointer to the P1 bot.)

**3. Kill test.** `Stop-Service sentinel` (or `taskkill /F /IM node.exe`, then `nssm stop sentinel` to prevent the automatic restart). Within *period + grace* (about 10 min) Healthchecks.io alerts you through its own integration. `Start-Service sentinel` and confirm recovery. Also try pulling the network cable for 2 minutes: the P1 `ops.rpc_lag` and (after 5 min) P0 `ops.chain_blind` alerts fire from the service itself once it can reach Telegram again.

**4. P0 ACK loop demo.** On the box (cwd `C:\sentinel`): `node app\dist\cli.js demo p0 --config config`. The running service delivers a **P0 DRILL** message to the P0 chat with `[ACK] [Snooze 1h]`. Verify, in order:
  * after 5 minutes an identical message arrives (`🔁 repeat #1`) and the previous one is edited to "superseded" with its buttons removed;
  * press **Snooze 1h**: repeats stop for an hour; (`status` shows it open);
  * press **ACK**: the message is edited to show who acknowledged it and repeats stop; `/ack <id>` does the same from any of the three bots;
  * from a *different* Telegram account in the group, press ACK on a fresh drill: you get "Not authorised" and nothing changes;
  * `node app\dist\cli.js demo resolve --config config` posts a `RESOLVED` reply under the message.
  P0 repeats are capped at one per minute across all alerts and stop after 24 h.

**5. Replay proof** (needs no accounts): `node dist/cli.js replay --config fixtures/demo/config --holding demo-proxy --from 1000 --to 1040 --fixture proxy-upgrade --timeline fixtures/proxy-upgrade.timeline.json` replays a recorded fixture (a silent implementation-slot write, then an admin change with an event) through the production scheduler and prints `timeline: PASS`.

## Replay harness

```
sentinel replay --holding <id> --from <block> --to <block> [--step N]
                [--record fixtures/<name>] [--fixture <name>]
                [--as-wallet <addr> | --position-usd <n>] [--timeline <file>] [--config DIR] [--out DIR]
```

Replay runs the **same scheduler** as live with `blockTag` pinned per step, the real watchers and rules, an in-memory store, and a fake Telegram sink that writes JSON lines to `replay-out/`. `--record` captures every RPC response (needs archive state on your primary RPC) into `fixtures/<name>.json`; `--fixture` replays it with no network (a request the fixture does not contain is a loud error). Timelines are `{ "expected": [{ block, condition_key, tier }], "must_not": [{ condition_key, tier? }] }`: each expected alert must fire at or before its block, and no `must_not` alert may fire. `--as-wallet` reads a real large holder's balances at that time; `--position-usd` fixes the exposure, so position-relative thresholds are meaningful.

`fixtures/proxy-upgrade.json` is a *synthetic* recording (an in-process scripted chain, `src/replay/synthetic.ts`, recorded through the real `--record` path); `npm run gen:fixtures` regenerates it and a test checks it is exactly what the recorder produces. Real incident fixtures (PLAN.md §8.2) are recorded the same way once you have an Alchemy key.

## Docker (later VPS migration)

`Dockerfile` and `compose.yaml` run the same command with the same layout (`/sentinel/config` mounted read-only, `/sentinel/data`, `/sentinel/backups`, secrets via `.env`), with a container `HEALTHCHECK` (`sentinel healthcheck`). A test keeps them in sync with the Windows installer. Not used on the Windows box.

```bash
docker compose up -d --build && docker compose logs -f sentinel
```

## Operations

* **Backup / restore:** nightly task, or `node dist/cli.js backup [--dest file]` (online, WAL-safe). Restore = stop the service, copy a backup over `data\sentinel.db`, start it; the cursor resumes from the backup and re-reads current state.
* **Acknowledging a legitimate change** (e.g. a planned proxy upgrade): put the new value in the holding YAML (`expect:` / `proxy:`) and restart; the condition resolves on the next cycle. Without an `expect`, the first observed value is pinned in SQLite (trust on first use).
* **Tuning thresholds:** per key in `config/sentinel.yaml` or a holding's `thresholds:` (keys in `config/SCHEMA.md`); no code change.
* **Alert for every failure mode:** RPC lag/blind (`ops.rpc_lag` P1, `ops.chain_blind` P0), watcher failing 3 cycles (`ops.watcher_error` P1; P0-class watcher for 10 min: P0), no committed cycle (Healthchecks.io), Telegram down (retries forever for P0; Healthchecks covers the rest).
* **Troubleshooting:** the log line `alert delivery failed; will retry` means Telegram is unreachable or a token/chat id is wrong; `getUpdates failed` the same for the poller. `CONFIG INVALID` at start: run `config check`.

## Repository layout

```
src/config/     zod schema, YAML loader ($ref, env, placeholders), discover, SCHEMA.md generator
src/rpc/        HTTP transport (batching), dual-provider client, health rules, Multicall3, fixtures, synthetic chain
src/chain/      head tracker (WS + poll fallback), cursor + reorg planner
src/watchers/   Watcher interface + registry; proxy (Phase 0 stub)
src/position/   exposure from on-chain balances, exit path
src/rules/      pure condition state machine, thresholds, default table
src/alerts/     tier escalation, routing to alert rows, message renderer
src/telegram/   three bots, delivery/repeat/ACK, commands, digest
src/store/      SQLite (WAL), migrations, repositories
src/health/     Healthchecks.io pinger, watcher-error accounting, status view
src/replay/     harness, timeline assertions, synthetic chain + scenarios
src/scheduler.ts  the one cycle code path (live and replay)
config/ fixtures/ deploy/windows/ Dockerfile compose.yaml
```
