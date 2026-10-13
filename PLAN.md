# Sentinel: on-chain holdings monitor with tiered Telegram alerts — PLAN

Status: APPROVED 2026-10-13. Implementation (Phase 0) starts on a separate go-ahead once the inputs in §12 are supplied.
Repository file: `PLAN.md`.

---

## 0. Context and decisions already taken

You run a stablecoin/RWA yield research workflow and want a deterministic watcher that tells you, per holding, when the control plane changes, when something is queued against it, when a pause/freeze/blacklist touches it, when oracles or pegs drift at *your* exit size, when withdrawable liquidity relative to *your* position shrinks, when curators do something new, when flows turn, and when RWA NAV/allowlist/redemption state changes. Alerts are tiered by the action you must take, not by severity labels.

Answers from the clarifying round (these drive the plan):

| Question | Answer | Consequence |
|---|---|---|
| Runtime | TypeScript + viem | Node 22 LTS, viem for RPC/ABI/multicall, zod for config validation |
| Chains (v1) | Ethereum mainnet only | Single-chain scheduler; config schema still carries `chain` so Base/Arbitrum are additive later |
| Hosting | Your Windows PC that already runs a Hermes agent 24/7 | Run as a native Node Windows service (NSSM) with SQLite; Dockerfile kept for later VPS migration (see §3.6) |
| RPC | None yet; recommend a pair | Alchemy (primary, WS + HTTP) + Infura/MetaMask Developer (secondary, HTTP). dRPC public endpoint as a third, read-only block-height canary. See §3.2 |
| Positions | Read on-chain from configured EOA addresses | Exposure and exit size computed live each cycle; `exit_size` override per holding |
| P0 ack | Telegram inline ACK button | Callback checked against your Telegram user id; `/ack <id>` kept as fallback |
| Custody | EOA only | No self-Safe watcher in v1; Safe watchers apply to *protocol* Safes only |
| Explainer | "What's your recommendation" | Recommendation in §9: no explainer in v1; v1.1 adds an outbox table + separate worker; Hermes or Claude API plug into the same outbox |

Open inputs still needed from you before Phase 1 can be configured (not blocking the plan): the 3–5 starting positions (vault/token addresses and the EOA(s) that hold them), and the two Telegram chat ids once bots are created. The worked example in §5 uses the Steakhouse USDC MetaMorpho vault as a stand-in.

---

## 1. Design principles (hard constraints restated as rules)

1. **Deterministic triggers only.** Every alert is the output of a pure function `f(observations, config, prior_state) -> conditions`. No LLM, no heuristics with hidden state. The optional explainer consumes alerts *after* they are sent (§9).
2. **Read state, don't trust events.** Events are the fast path; direct state reads (storage slots, view functions) are the source of truth and run on every cycle regardless of whether an event was seen. A proxy upgraded through a non-standard path emits no `Upgraded` event; the slot still changes.
3. **Everything relative to the position.** Liquidity, exit cost, and exposure are expressed in your units (USD and % of your position), never protocol-wide percentages alone.
4. **Must not fail silently.** External dead-man's switch, dual RPC with lag detection, watcher-error alerting, and a daily "I'm alive and here's what I'm watching" digest.
5. **Holdings are configuration.** One YAML file per holding; watcher code knows nothing about specific addresses. Shared control graphs (e.g. USDC issuer, Morpho Blue core) are referenced by id from a `shared/` directory so they're defined once.
6. **Idempotent and replayable.** Every watcher can be run against an arbitrary historical block range with the same code path used live. This is what makes incident replay (§8) possible.

---

## 2. Signal inventory: events vs. state polling, and why

Rule of thumb used below: **events** for "something happened" signals that are emitted reliably by audited code paths (cheap, precise, give you the tx hash); **state polling** for anything that (a) can change without an event, (b) is a derived quantity (liquidity vs. your position), or (c) is a continuous value with thresholds (prices, utilization, NAV age). Most control-plane signals use **both**: the event gives you the tx link and decoded action within one block; the state read is the belt-and-braces check that runs every cycle and catches silent changes.

| # | Signal | Primary mechanism | Why | Secondary |
|---|---|---|---|---|
| 1a | EIP-1967 implementation / admin / beacon slot | **State poll** `eth_getStorageAt` on the 3 slots every cycle (and beacon `implementation()` call) | Slot write is the ground truth; `Upgraded`/`AdminChanged`/`BeaconUpgraded` events can be absent on non-standard proxies | Events for tx hash + same-block latency |
| 1b | Diamond (EIP-2535) facets | **Event** `DiamondCut` + **state** `facets()` hash compared per cycle | Facet table has no single slot | — |
| 1c | ProxyAdmin owner, contract `owner()` | **State poll** `owner()` + event `OwnershipTransferred` | Two-step ownership (Ownable2Step) has a `pendingOwner()` that must be polled: a pending transfer is a P1 before acceptance | — |
| 1d | Owning Safe: owners, threshold, modules, guard, fallback handler, singleton | **State poll** `getOwners()`, `getThreshold()`, `getModulesPaginated(0x1, 50)`, guard slot `0x4a204f…34c8`, fallback slot `0x6c9a6c…18d5`, module-guard slot (v1.5), slot 0 (singleton) | Module/guard enablement is the classic "silent takeover" path; a malicious guard can also DoS the Safe (blocks the protocol's own emergency actions) | Events `AddedOwner`, `RemovedOwner`, `ChangedThreshold`, `EnabledModule`, `DisabledModule`, `ChangedGuard`, `ChangedFallbackHandler`, `ExecutionFromModuleSuccess` (topic layout differs between Safe 1.3 and 1.4+, ABI chosen per `VERSION()`) |
| 1e | Role grants/revokes (AccessControl) | **Event** `RoleGranted`/`RoleRevoked` filtered to the role hashes in config | Role membership is not enumerable without `AccessControlEnumerable` | State poll `hasRole(role, addr)` for each *expected* holder listed in config (detects revocation of a legitimate guardian) |
| 1f | Unexpected token mints | **Event** `Transfer(from=0x0)` and issuer-specific `Mint`/`Issue` | Mints are events by construction | State poll `totalSupply()` delta per cycle as a cross-check (catches mint paths that skip Transfer) |
| 2a | Timelock queue (OZ `TimelockController`, Compound `Timelock`, Aave Governance v3 `PayloadsController`) | **Event** `CallScheduled`/`QueueTransaction`/`PayloadQueued` with calldata decoded against the *target's implementation ABI*; `Cancelled`/`CancelTransaction`/`PayloadCancelled`; `MinDelayChange`/`NewDelay`/`ExecutorSet` | Queue entries are only discoverable via events (OZ stores just timestamps by id) | State poll `getMinDelay()`/`delay()`, `getOperationState(id)` / `queuedTransactions(hash)` / `getPayloadById(id).state` for every id we have seen, so "executed/cancelled/expired" is detected even if the event is missed. Aave payloads are mostly `delegatecall execute()` into a payload contract, so the decoded action is "payload X, verified source at …", not argument-level |
| 2b | Morpho vault pending actions | **Event** `SubmitCap`, `SubmitMarketRemoval`, `SubmitTimelock`, `SubmitGuardian`, their `Revoke*` and `Set*` counterparts | Gives ETA = `validAt` | State poll `pendingCap(id)`, `pendingTimelock()`, `pendingGuardian()`, `config(id).removableAt`, `timelock()` every cycle |
| 2c | Safe Transaction Service proposed-but-unexecuted txs | **HTTP poll** of `api.safe.global/tx-service/eth/api/v2/safes/{safe}/multisig-transactions/?executed=false` every 5 min per watched Safe | Off-chain data; nothing on-chain until execution. Unauthenticated access is capped at 5k requests/month, so a free "Builder" API key (50k/month) is required; 5-min cadence on ~6 Safes ≈ 52k/month, so cadence is tuned per plan | On-chain `ExecutionSuccess`/`ExecutionFailure` closes the loop; `safeTxHash` recomputed locally via `getTransactionHash` so the service is not trusted blindly |
| 2d | Morpho Vaults V2 pending actions (if you hold a V2 vault) | **Event** `Submit(selector, data, executableAt)`, `Accept`, `Revoke`, `Abdicate`, `IncreaseTimelock`/`DecreaseTimelock` | V2 has no `pending*` getters; pending actions exist only as `Submit` events | State poll `executableAt(data)` for every unaccepted submission, `timelock(selector)` for the watched selectors |
| 3a | Protocol pauses | **State poll** `paused()` / Aave reserve config bitmap | A pause can be set by a module/guardian in one tx; polling is cheap | Events `Paused`/`Unpaused`, Aave `ReservePaused`/`ReserveFrozen` |
| 3b | Aave reserve freeze / pause / caps | **State poll** `getConfiguration(asset)` bitmap (active bit 56, frozen bit 57, borrowing 58, paused 60, borrowCap bits 80–115, supplyCap 116–151) and `getLiquidationGracePeriod(asset)` | One multicall per cycle for all reserves in scope. There is no pool-level `paused()`: a pool pause is one `ReservePaused` per reserve | Events from `PoolConfigurator`: `ReservePaused`, `ReserveFrozen`, `ReserveActive`, `SupplyCapChanged`, `BorrowCapChanged`, `ReserveInterestRateStrategyChanged`, `ATokenUpgraded`, `CollateralConfigurationChanged` |
| 3c | USDC/USDT blacklist touching my vaults/markets | **Event** `Blacklisted`/`AddedBlackList` with `address ∈ watch-set` (vault, Morpho Blue core, Aave pool/aToken, Curve/Uni pool, my EOAs) | Only events give you the exact address in one hop | State poll `isBlacklisted(addr)` for the watch-set every cycle (catches a blacklist that happened before we started) |
| 4a | Oracle vs. market divergence | **State poll** `IOracle.price()` (Morpho) / `AaveOracle.getAssetPrice()` vs. DEX quote at size (from 5a) | Pure derived quantity | — |
| 4b | Oracle staleness vs. heartbeat | **State poll** underlying Chainlink `latestRoundData().updatedAt` for each feed resolved from the Morpho oracle's `BASE_FEED_*`/`QUOTE_FEED_*` | Chainlink `AnswerUpdated` events exist but staleness is the *absence* of an event, so it must be polled | — |
| 4c | Hardcoded / constant oracle detection | **Static check at config load + daily**: if `MorphoChainlinkOracleV2Factory.isMorphoChainlinkOracleV2(oracle)`, read `BASE_FEED_1/2`, `QUOTE_FEED_1/2`, `BASE_VAULT`, `QUOTE_VAULT`; all zero → fully hardcoded (`price() == SCALE_FACTOR`); one side zero → that leg hardcoded to 1 (common: USDC assumed $1). Non-factory oracles: no `CALL`/`STATICCALL` in bytecode or constant `price()` over 7 days → flagged for manual classification | Known Morpho risk class; Morpho's feed library also performs **no staleness check** itself, so our 4b is the only one | — |
| 4d | Feed aggregator swap | **State poll** `aggregator()`/`phaseId()` on each Chainlink proxy; Aave `AssetSourceUpdated`; CAPO adapters `isCapped()` | A swapped aggregator or a capped CAPO price means the protocol's price no longer tracks the market | Events `AssetSourceUpdated`, `PriceCapUpdated`, `CapParametersUpdated` |
| 5a | Peg at exit size | **State poll** `get_dy(i,j,dx)` on Curve pools (already net of the dynamic fee) and `QuoterV2.quoteExactInputSingle` (non-view, via `eth_call`; batchable inside `Multicall3.aggregate3`) on Uniswap v3, with `dx = exit_size` and a size sweep (25/50/100%) | "Price at size" is only available by simulating | Uniswap v4 `IV4Quoter` added when a v4 pool is the deeper venue |
| 5b | Peg persistence over N blocks | Rules engine over 5a history (ring buffer per pool) | Hysteresis is a rules-engine concern, not a data concern | — |
| 5c | Curve pool imbalance | **State poll** `get_balances()` (NG) or `balances(i)` (legacy 3pool) × `stored_rates()` → share of each coin vs. 1/n; `A()`, `dynamic_fee(i,j)` vs `fee()` as an off-peg indicator; `price_oracle(i)` (NG EMA) vs `get_dy` | Leading indicator; cheap | Event `TokenExchange` volume as a tie-breaker |
| 6a | Utilization | **State poll** Morpho Blue `market(id)` and Aave reserve data | Continuous value | — |
| 6b | Withdrawable liquidity vs. my position | **State poll** per cycle: MetaMorpho `Σ_{m ∈ withdrawQueue} min(vaultSupplyAssets(m), totalSupplyAssets(m) − totalBorrowAssets(m), loanToken.balanceOf(MorphoBlue))` (this is exactly what the vault's own `maxWithdraw` simulates), plus `maxWithdraw(me)` as the authoritative number; Aave `min(aTokenBalance, getVirtualUnderlyingBalance(asset))` and reserve not paused; RWA redemption pool USDC balance | Derived; must be recomputed from fresh state | — |
| 6c | Realized losses / bad debt | **Event** Morpho Blue `Liquidate` with `badDebtAssets > 0` on pinned markets; MetaMorpho v1.1 `UpdateLostAssets`; Vaults V2 `AccrueInterest` with `newTotalAssets < previousTotalAssets`; Aave `getReserveDeficit(asset)` | Loss is an event by construction | State poll `lostAssets()` (v1.1) each cycle |
| 7a | Curator reallocations | **Event** `ReallocateSupply`/`ReallocateWithdraw`, `SetSupplyQueue`/`SetWithdrawQueue`, `SetCap` | Precise | State poll of allocation vector per cycle (concentration %, new market ids vs. config allowlist) |
| 7b | PublicAllocator activity | **Event** `PublicReallocateTo`, `PublicWithdrawal`, `SetFlowCaps` on the PublicAllocator filtered to vault | Precise | State poll `flowCaps(vault,id)` daily |
| 8a | TVL rate of change | **State poll** `totalAssets()` (vault), `totalSupply()` (RWA), reserve liquidity (Aave) sampled every cycle, windows 1h/6h/24h/7d computed in the rules engine | Continuous | — |
| 8b | Top-holder exits | **Event** `Transfer`/`Withdraw` where `assets ≥ X% of totalAssets` or `from ∈ top-N` (top-N refreshed daily via an indexer or a `Transfer` fold) | Only events give per-actor flows | — |
| 9a | RWA NAV updates and staleness | **State poll** NAV oracle `latestRoundData()` or issuer getter; staleness vs. configured heartbeat (one business day for all six issuers). The on-chain guards are loose or absent (Superstate reverts only after 5 days, Midas `healthyDiff` defaults to 30 days, Ondo's `RWADynamicOracle` silently keeps returning the last range price after the range ends, OpenEden and Spiko have none), so **our** staleness check is the only tight one | Absence of update must be polled | Events `AnswerUpdated` (Midas), `NewCheckpoint` (Superstate), `RangeSet` (Ondo USDY), `UpdatePrice` (OpenEden), `Update` (Spiko) for the tx link |
| 9b | Allowlist / transfer-restriction changes | **Event** per issuer adapter (Ondo `AccountStatusSetByAdmin`/`BlockedAddressesAdded`, Superstate `EntityIdSet`/`FundPermissionSet`, Midas `RoleGranted(BLACKLISTED_ROLE | GREENLISTED_ROLE)`, Spiko `GroupAdded`/`GroupRemoved`, OpenEden `GrantKyc`/`RevokeKyc`/`Banned`, Securitize `DSRegistryServiceWallet*`/`WalletAddedToBlacklist`); **state poll** of *my EOA's* status via the issuer's view (`isAllowed`, `isAddressAllowedForFund`, `hasRole`, `canCall`, `isKyc && !isBanned`, `preTransferCheck`) every cycle | Your own allowlist status is the one that matters for exit | Admin burn / forced transfer events (`AdminBurn`, `burnGoverned`, `Seize`, `BurnFrom`, `ReIssue`) are P0 if they touch my EOA, P1 otherwise |
| 9c | Redemption pauses / limits / fees / liquidity | **State poll** redemption contract `paused()` (or `pausedWithdraw()`, `pauseFn(selector)`), USDC balance of the redemption pool, daily/instant limits, fee bps; **event** setters | Both cheap | **Shared dependency:** OUSG, Midas BUIDL-backed vaults and OpenEden `redeemIns` all draw USDC from the **Circle BUIDL redeemer**; its available liquidity is polled once and fanned out to every holding that depends on it (see A.4) |
| 9d | Supply vs. reported AUM | **State poll** `totalSupply() × NAV` daily vs. issuer-reported AUM where an API exists (Superstate `nav-daily`; others manual/aggregator) | Slow signal, P2 | — |

Cycle cadence (mainnet, 12s blocks): the scheduler runs a **fast lane every block** (proxy slots, pauses, Safe state, Morpho pending state, oracle freshness, peg at size, liquidity vs. position) as one or two `Multicall3` batches, and a **slow lane every 5 minutes** (TVL windows, concentration, top-holder refresh, Safe Transaction Service poll, NAV vs. AUM). Logs are fetched per block range from `last_processed+1` to `head - CONFIRMATIONS` (default 2) with a 12-block re-scan on reorg detection (parent-hash mismatch).

---

## 3. Architecture

### 3.1 Process layout (single Node process, multiple modules)

```
sentinel (Node 22, TS, ESM)
├── config/            load + validate holdings/*.yaml and shared/*.yaml (zod); resolves $ref ids
├── rpc/               dual-provider client (viem) with health, lag detection, failover, request cache per block
├── chain/             block tracker (WS newHeads with HTTP polling fallback), reorg handling, cursor persistence
├── watchers/          one module per signal family; each exposes {abis, logFilters(cfg), stateReads(cfg), fold(logs, state) -> Observation[]}
│   proxy, safe, access-control, timelock, morpho-vault, morpho-market, aave, stablecoin-issuer,
│   oracle, peg, liquidity, flows, rwa
├── position/          reads your balances per holding; computes USD exposure and "exit path open?"
├── rules/             pure functions Observation[] + prior ConditionState -> ConditionTransition[] (hysteresis, persistence, cooldown)
├── alerts/            tiering, dedupe keys, message rendering (exposure, tx link, decoded action, exit path), router
├── telegram/          3 bots (P0, P1, P2), inline ACK callbacks, repeat scheduler, "resolved" edits, /status command
├── store/             SQLite (better-sqlite3, WAL); migrations; repositories for cursor/state/conditions/alerts/acks/outbox
├── health/            Healthchecks.io pinger, self-canaries, watcher-error escalation, daily digest
└── replay/            run any watcher over [fromBlock, toBlock] with historical eth_call (blockTag); fixture recorder
```

Why one process: on a Windows box the operational simplicity of one service + one SQLite file beats a multi-service setup. Modules are isolated enough (pure `fold` and `rules` functions) that splitting later is mechanical.

### 3.2 RPC: two providers, block-lag alerts, archive needs

- **Primary**: Alchemy (HTTPS + WSS). Used for `newHeads`, `eth_getLogs`, `eth_call`/multicall, `eth_getStorageAt`.
- **Secondary**: Infura (MetaMask Developer) HTTPS. Used (a) every cycle for `eth_blockNumber` cross-check, (b) as automatic failover for all reads when primary errors or lags.
- **Canary**: dRPC public endpoint (no key) for a third `eth_blockNumber` only. Three heights let the service tell "my primary is lagging" from "the chain is slow".
- **Lag rule**: if `|primary_head − secondary_head| > 5` blocks for > 60s, or either provider has not advanced in 90s, raise an **ops P1** (`rpc_lag`) and switch the active provider. If both are stale > 5 min, raise **ops P0** (`chain_blind`) since every watcher is blind.
- **Archive access**: replay (§8) and the `flows` 7-day window need historical `eth_call`. Alchemy's free tier provides archive state on mainnet; this is what the replay harness assumes. Verify at signup (it is a plan assumption, not a verified fact).
- **Budget**: ~80 state reads per cycle batched into 2 multicalls + 1 `eth_getLogs` per block ≈ 25k requests/day. Well inside both free tiers; log filters are address-scoped so response sizes stay small.

### 3.3 Config is data: directory layout

```
config/
  sentinel.yaml            global: chain rpc urls (env-substituted), cadences, telegram chat ids, thresholds defaults
  wallets.yaml             your EOAs (label, address) and your Telegram user id for ACK auth
  shared/
    morpho-blue-mainnet.yaml   Morpho Blue core control graph (owner, enabled IRMs/LLTVs, fee recipient)
    public-allocator-mainnet.yaml
    usdc-mainnet.yaml          FiatToken proxy, implementation, admin, pauser/blacklister/masterMinter roles
    usdt-mainnet.yaml
    chainlink-feeds.yaml       feed address -> heartbeat seconds, deviation bps (from Chainlink docs)
    curve-pools.yaml, uniswap-v3-pools.yaml
  holdings/
    steakhouse-usdc.yaml       one file per position (full example in §5)
    aave-v3-usdc.yaml
    ousg.yaml
    ...
```

Schema is defined once in `src/config/schema.ts` (zod) and documented by generating `config/SCHEMA.md` from it. A holding file references shared graphs by `$ref: shared/usdc-mainnet` so the USDC blacklist watcher is declared once but applied to every holding whose watch-set includes USDC.

### 3.4 Data flow per cycle

1. Block tracker sees head `H`. Target block `T = H − confirmations`.
2. For each enabled watcher, collect `stateReads(cfg)` → one `Multicall3.aggregate3` per ~60 calls at `blockTag=T` (storage slots use `eth_getStorageAt` batched via JSON-RPC batch).
3. `eth_getLogs` for `[cursor+1, T]` with the union of addresses/topics from all watchers; dispatch by address+topic.
4. Each watcher `fold(logs, state, prevSnapshot) -> Observation[]` (pure).
5. `position/` computes exposure and exit-path status per holding from the same snapshot.
6. `rules/` evaluates conditions → transitions `{opened, still_open, resolved}` with hysteresis and persistence counters.
7. `alerts/` maps transitions to tiered alerts, applies dedupe + cooldown, renders messages, enqueues to Telegram router. All of 2–7 is one SQLite transaction with the new cursor; a crash replays from the last committed cursor.
8. `health/` pings Healthchecks.io only if the whole cycle committed. Missed ping = external alert even if the process is wedged.

### 3.5 Telegram

- Three bots (one per tier) each posting to its own chat/group, tokens in `.env`. Separate bots so you can mute P2 and give P0 a distinct notification sound/override on your phone.
- **P0**: message with inline keyboard `[ACK] [Snooze 1h]`. Re-sent every `repeat_minutes` (default 5) until ACK by an authorized user id; each repeat edits the previous message to "superseded" so the chat does not fill with live buttons. ACK is recorded in `acks` with user id and time. `/ack <alert_id>` fallback.
- **P1**: single message, `[ACK]` optional, no repeats; "resolved" posted as a reply when the condition closes.
- **P2**: 09:00 local daily digest grouped by holding; also includes "still-open P1s" and watcher health.
- `/status` command on the P1 bot returns: head block, provider lag, last cycle duration, open conditions, exposure per holding.
- Rate limit: Telegram allows ~30 msg/s per bot; irrelevant at our volumes, but P0 repeats are capped at one per minute across all alerts.

### 3.6 Deployment on the Windows PC

- Node 22 LTS installed system-wide; service registered with **NSSM** (`sentinel` service, auto-start, restart on exit, stdout/stderr to rotating files). Runs before user login, survives Windows Update reboots, no Docker Desktop dependency.
- SQLite file and config under `C:\sentinel\`. Backups: nightly copy of the DB to a second folder; config is in git.
- Secrets (`.env`): RPC keys, 3 Telegram bot tokens, Healthchecks.io ping URL. Never in git.
- A `Dockerfile` + `compose.yaml` are maintained from day one so the same artifact runs on a VPS when you want to move it. Not used on the Windows box.
- Co-location with the Hermes agent is fine: separate service, separate ports; the only shared resource is bandwidth.

---

## 4. Storage

SQLite via `better-sqlite3` (synchronous, WAL mode, one file). Rationale: single writer, tiny write volume, trivial backups, no server on Windows. Switching to Postgres later is a repository-layer change.

| Table | Purpose | Key columns |
|---|---|---|
| `cursor` | last committed block per chain | `chain, block_number, block_hash, updated_at` |
| `block_log` | last 64 block hashes for reorg detection | `number, hash, parent_hash` |
| `snapshot` | latest value of every polled state key | `key (holding/watcher/field), value_json, block, ts` |
| `snapshot_history` | time series for windows/persistence (pruned to 30d) | `key, value_num, block, ts` |
| `observation` | raw watcher outputs with tx hash/log index (audit trail, 90d) | `id, holding, watcher, kind, payload_json, tx_hash, log_index, block` |
| `condition` | current state of every rule, with hysteresis counters | `condition_key, holding, status(open/closed), opened_at, last_seen_at, breach_count, cooldown_until, payload_json` |
| `alert` | every message sent | `id, condition_key, tier, holding, exposure_usd, exit_path_open, message, telegram_chat, telegram_msg_id, fired_at, resolved_at, repeat_count` |
| `ack` | acknowledgments | `alert_id, user_id, via(button/command), at` |
| `pending_action` | timelock/Morpho/Safe queue entries we track to closure | `id, holding, source, target, selector, decoded_json, eta, status(queued/executed/cancelled/expired), first_seen_block` |
| `rpc_health` | per-provider head and error counters | `provider, head, lag, errors_1m, ts` |
| `outbox` | explainer hand-off (v1.1) | `alert_id, status, created_at, consumed_at` |
| `holder_cache` | top-N holders per asset (daily refresh) | `asset, address, balance, rank, ts` |

Dedupe key = `condition_key` (e.g. `steakhouse-usdc/proxy/impl-slot`), so repeated observations of the same open condition never re-alert; they update `last_seen_at`. A new alert fires only on `closed → open`; "resolved" fires on `open → closed` after the resolve-hysteresis passes.

---

## 5. Per-holding config schema and worked example (MetaMorpho USDC vault)

### 5.1 Schema (abridged; full zod in implementation)

```yaml
id: string                          # unique, used in condition keys
chain: ethereum
kind: metamorpho | morpho-vault-v2 | aave-v3 | curve-lp | uniswap-v3-lp | rwa-token
asset:                              # the thing you hold
  address: 0x…
  decimals: int
  symbol: string
wallets: [label]                    # which of your EOAs (from wallets.yaml) hold it
exposure:
  price_feed: chainlink:USDC/USD | const:1.0 | nav-oracle
  exit_size: 100%                   # or absolute USD; used for peg checks and liquidity ratios
control_graph:                      # list of nodes; each has a type and the watchers it enables
  - { id, type: proxy|safe|timelock|access-control|owned, address, expect: {...} }
pending_actions:                    # which queues can affect this holding
  - { source: timelock|morpho-vault|safe-tx-service, node: <control_graph id> }
pauses: [ { kind, address } ]
oracles: [ { role, address, kind: morpho-chainlink-v2|chainlink|hardcoded|nav, heartbeat_s, feeds: [...] } ]
peg:
  pools: [ { kind: curve-ng|uniswap-v3|uniswap-v4, address, i, j, fee } ]
  sizes: [25%, 50%, 100%]
liquidity: { kind-specific }
flows: { windows: [1h, 6h, 24h, 7d], top_n_holders: 10 }
thresholds: { ...overrides of global defaults, keys from §6 }
```

### 5.2 Fully worked example: `config/holdings/steakhouse-usdc.yaml`

Addresses marked `# verify` must be checked against Etherscan/Morpho docs at implementation time; this is a plan, not a config file.

```yaml
id: steakhouse-usdc
chain: ethereum
kind: metamorpho
asset:
  address: 0xBEEF01735c132Ada46AA9aA4c54623cAA92A64CB   # Steakhouse USDC MetaMorpho vault  # verify
  decimals: 18
  symbol: steakUSDC
  loan_token: { address: 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48, symbol: USDC, decimals: 6 }
wallets: [main]
exposure:
  price_feed: chainlink:USDC/USD      # 0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6, heartbeat 86400s
  exit_size: 100%

control_graph:
  - id: vault
    type: metamorpho
    address: 0xBEEF01735c132Ada46AA9aA4c54623cAA92A64CB
    expect:
      owner:    0x…        # verify (Steakhouse owner Safe)
      curator:  0x…
      guardian: 0x…
      allocators: [0x…, <public-allocator>]
      timelock_s: 604800   # 7d  # verify
      fee_bps_max: 1000
  - id: owner-safe
    type: safe
    address: <vault.expect.owner>
    expect: { threshold_min: 2, owners_known: true, modules: [], guard: 0x0 }
  - id: guardian-safe
    type: safe
    address: <vault.expect.guardian>
    expect: { threshold_min: 2 }
  - id: morpho-blue
    $ref: shared/morpho-blue-mainnet       # 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb; owner, EnableIrm/EnableLltv, SetFee
  - id: usdc
    $ref: shared/usdc-mainnet              # FiatToken proxy; blacklist/pause/minter watchers
  - id: public-allocator
    $ref: shared/public-allocator-mainnet

pending_actions:
  - { source: morpho-vault, node: vault }
  - { source: safe-tx-service, node: owner-safe }
  - { source: safe-tx-service, node: guardian-safe }

markets:                       # discovered from withdrawQueue at load, then pinned; new ids outside this list → P1
  allowlist_mode: pin          # pin | open
  pinned: []                   # filled by `sentinel config discover steakhouse-usdc`
  collateral_allowlist: [wstETH, WBTC, cbBTC, USDT…]   # symbols resolved to addresses via shared/tokens

oracles:
  per_market: auto             # resolve each market's oracle via idToMarketParams; classify kind; read feeds
  staleness_margin: 1.25       # alert when age > heartbeat × margin
  divergence_bps: { p1: 100, p0: 300 }

peg:
  pools:
    - { kind: curve-ng, address: <USDC/USDT or 3pool>, i: USDC, j: USDT }   # verify choice; only for the loan token's peg
    - { kind: uniswap-v3, address: <USDC/USDT 0.01%>, fee: 100 }
  sizes: [25%, 50%, 100%]
  persistence_blocks: 15

liquidity:
  metamorpho:
    compute: withdrawable = Σ_{m ∈ withdrawQueue} min(vaultSupplyAssets(m), totalSupplyAssets(m) − totalBorrowAssets(m))
    also: maxWithdraw(wallet), vault totalAssets, per-market utilization
  thresholds: { ratio_p1: 2.0, ratio_p0: 1.0 }    # withdrawable / my position

flows:
  windows: [1h, 6h, 24h, 7d]
  top_n_holders: 10
  big_exit_pct_of_tvl: 5

thresholds: {}   # inherit defaults from §6
```

### 5.3 Every event and state read this example produces

**Events (eth_getLogs, address-scoped)**

| Contract | Events | Fires |
|---|---|---|
| Vault (verified against `morpho-org/metamorpho` and `metamorpho-v1.1` EventsLib) | `SubmitCap, SetCap, RevokePendingCap, SubmitMarketRemoval, RevokePendingMarketRemoval, SubmitTimelock, SetTimelock, RevokePendingTimelock, SubmitGuardian, SetGuardian, RevokePendingGuardian, SetCurator, SetIsAllocator, SetFee, SetFeeRecipient, SetSkimRecipient, SetSupplyQueue, SetWithdrawQueue, ReallocateSupply, ReallocateWithdraw, Skim, AccrueInterest, UpdateLastTotalAssets, OwnershipTransferStarted, OwnershipTransferred, Deposit, Withdraw, Transfer`; v1.1 only: `UpdateLostAssets` (realized loss), `SetName`, `SetSymbol` | pending-actions, control-plane, curator, flows, losses |
| Morpho Blue | `SetOwner, EnableIrm, EnableLltv, SetFee, SetFeeRecipient, CreateMarket` (for new market ids seen in vault queues), `Liquidate` (with `badDebtAssets`), `Supply/Withdraw/Borrow/Repay` **only for pinned market ids** (topic1 = id) | control-plane, liquidity, flows, losses |
| PublicAllocator | `PublicReallocateTo, PublicWithdrawal, SetFlowCaps, SetFee, SetAdmin` filtered to `vault` | curator |
| Owner Safe, Guardian Safe | `AddedOwner, RemovedOwner, ChangedThreshold, EnabledModule, DisabledModule, ChangedGuard, ChangedFallbackHandler, ExecutionSuccess, ExecutionFailure` | control-plane |
| USDC FiatToken | `Blacklisted, UnBlacklisted, Pause, Unpause, BlacklisterChanged, PauserChanged, MasterMinterChanged, MinterConfigured, MinterRemoved, Mint, Burn, OwnershipTransferred`; proxy `Upgraded, AdminChanged` | pauses/blacklist, mints, control-plane |
| Per-market oracle's Chainlink feeds | `AnswerUpdated` (tx link only; staleness is polled) | oracle |
| Curve/Uni pools | `TokenExchange` / `Swap` (volume context only) | peg |

**State reads (every block, one multicall at `blockTag = head − 2`)**

| Target | Read | Used for |
|---|---|---|
| Vault | `owner, pendingOwner, curator, guardian, pendingGuardian (value, validAt), timelock, pendingTimelock (value, validAt), fee, feeRecipient, skimRecipient, supplyQueueLength + supplyQueue(i), withdrawQueueLength + withdrawQueue(i), config(id) → (cap, enabled, removableAt) ∀ queued id, pendingCap(id) → (value, validAt) ∀ id, totalAssets, totalSupply, lastTotalAssets, lostAssets (v1.1), balanceOf(me), maxWithdraw(me), convertToAssets(balanceOf(me))`. `validAt == 0` means nothing pending; `removableAt != 0` means a market removal is queued | control, pending, liquidity, exposure, exit path |
| Vault proxy (if proxied) | storage slots: impl `0x360894…bbc`, admin `0xb53127…103`, beacon `0xa3f0ad…50` | control |
| Morpho Blue (`0xBBBB…FFCb`) | `owner, feeRecipient, isIrmEnabled(irm), isLltvEnabled(lltv)`; `market(id)` → (totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate, fee) ∀ pinned id; `position(id, vault)` ∀ pinned id; `idToMarketParams(id)` (cached, re-read daily); `USDC.balanceOf(MorphoBlue)` | liquidity, utilization, control |
| Each market oracle | `price()` (1e36-scaled); `MorphoChainlinkOracleV2Factory(0x3A7b…d766).isMorphoChainlinkOracleV2(oracle)`; if true: `BASE_FEED_1/2, QUOTE_FEED_1/2, BASE_VAULT, QUOTE_VAULT, SCALE_FACTOR` (cached) then each feed's `latestRoundData()` + proxy `aggregator()`/`phaseId()` | oracle divergence, staleness, hardcoded detection, aggregator swap |
| Owner & Guardian Safes | `VERSION, getOwners, getThreshold, getModulesPaginated(0x1, 50), nonce`, guard slot `0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8`, fallback slot `0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5`, slot 0 (singleton) | control |
| USDC | `paused, isBlacklisted(x)` ∀ x ∈ {vault, Morpho Blue, my EOAs, Curve pool, Uni pool}, `totalSupply, masterMinter, blacklister, pauser, owner`; proxy admin/impl slots | pauses, blacklist, mints, control |
| USDC/USD Chainlink | `latestRoundData` | exposure, staleness |
| Curve pool | `get_dy(i,j,size_k)` for k ∈ sizes, `get_balances, A, fee` | peg, imbalance |
| Uniswap QuoterV2 | `quoteExactInputSingle(USDC→USDT, size_k)` | peg at size |
| PublicAllocator | `flowCaps(vault, id)` ∀ pinned id (slow lane), `admin(vault), fee(vault)` | curator |

**Off-chain polls (slow lane, 5 min)**: Safe Transaction Service `GET https://api.safe.global/tx-service/eth/api/v2/safes/{owner-safe}/multisig-transactions/?executed=false` (Bearer API key) and the same for the guardian Safe; `GET /api/v1/safes/{safe}/` for the service's view of owners/modules/guard as a cross-check against our on-chain reads. Each pending tx is decoded against the vault/Morpho ABIs; `to == vault` with selector ∈ {submitCap, submitTimelock, setCurator, setIsAllocator, setSupplyQueue, setWithdrawQueue, reallocate, submitGuardian, transferOwnership, setFee, …} is a **P1 before it is even signed**; anything touching `upgradeTo*`/`changeAdmin`/`enableModule`/`setGuard` on any node in the control graph is **P0**.

---

## 6. Tiering logic and default threshold table

### 6.1 Tier semantics

| Tier | Meaning | Delivery | Repeat | Resolution |
|---|---|---|---|---|
| **P0** | Exit now, or your ability to exit is at risk right now | P0 bot, inline ACK, phone override | every 5 min until ACK (max 24h) | "RESOLVED" reply + resolution reason |
| **P1** | Decide within hours; something is queued, drifting, or degraded | P1 bot | none | "RESOLVED" reply |
| **P2** | Daily digest | P2 bot 09:00 local | none | listed as closed in next digest |
| **OPS** | Watcher/RPC/heartbeat problems; delivered on P1 bot (P0 if blind) | — | per tier | — |

Escalation rules (deterministic):
- A P1 whose `exit_path_open == false` at fire time is promoted to **P0**.
- A pending action (P1) is re-alerted as **P1 again at ETA − 1h** and promoted to **P0 at execution** if its decoded action is in the P0 class (upgrade, admin change, module/guard, timelock reduction, cap-to-zero of a market holding > 20% of vault).
- Any watcher that errors 3 consecutive cycles → **OPS P1**; if a *P0-class watcher* (proxy, safe, pauses) is erroring → **OPS P0** after 10 minutes, because you are blind to the thing that matters most.

### 6.2 Default thresholds (all overridable per holding under `thresholds:`)

| Key | Signal | P0 | P1 | P2 | Hysteresis / persistence |
|---|---|---|---|---|---|
| `proxy.impl_changed` | EIP-1967 impl/admin/beacon slot ≠ expected | any change | — | — | none; resolves only by config update |
| `proxy.diamond_cut` | facets hash changed | any | — | — | as above |
| `owner.changed` / `owner.pending` | `owner()`/`pendingOwner()` ≠ expected | changed | pending set | — | — |
| `safe.owner_set` | owners/threshold ≠ expected | owner added/removed or threshold ↓ | threshold ↑ | — | — |
| `safe.module_guard` | module enabled / guard set / fallback changed / singleton changed | any | — | — | — |
| `role.grant` | RoleGranted on watched role to unknown address | admin/upgrader/pauser roles | other roles | — | — |
| `role.revoke` | RoleRevoked from expected holder | guardian/pauser | other | — | — |
| `mint.unexpected` | mint by unknown minter / mint > X | minter ∉ expected | mint > 1% supply/24h | all mints | — |
| `timelock.queued` | CallScheduled/QueueTransaction against control graph | selector ∈ P0 class | any | — | ETA−1h re-alert |
| `timelock.delay` | MinDelayChange/NewDelay | delay ↓ | delay ↑ | — | — |
| `timelock.cancelled` | Cancelled | — | any | — | — |
| `morpho.pending_cap` | SubmitCap | cap→0 on market with > 20% of vault | any | — | ETA re-alert |
| `morpho.pending_removal` | SubmitMarketRemoval | market > 20% of vault | any | — | ETA re-alert |
| `morpho.pending_timelock` | SubmitTimelock | new < 24h | any ↓ | ↑ | ETA re-alert |
| `morpho.guardian` | SubmitGuardian/SetGuardian/curator/allocator change | guardian→0x0 or curator changed | any | — | — |
| `morpho.fee` | SetFee | > 30% | any ↑ | ↓ | — |
| `morpho.bad_debt` | `Liquidate.badDebtAssets > 0` on a pinned market / `UpdateLostAssets` / V2 negative `AccrueInterest` | loss > 1% of vault assets | any | — | — |
| `morpho.v2_gate` | Vaults V2 `SetSendAssetsGate`/`SetSendSharesGate` set to non-zero, or `forceDeallocatePenalty` ↑ | gate blocks my EOA | any | — | — |
| `safe.proposed_tx` | Tx Service pending tx targeting control graph | selector ∈ P0 class | any | — | closes on exec/reject |
| `pause.protocol` | paused()==true / ReservePaused | any (exit blocked) | — | — | resolves on unpause |
| `aave.frozen` | reserve frozen (withdraw still works) | — | any | — | resolves on unfreeze |
| `aave.caps` | supply/borrow cap change | — | supply cap < 1.1× current supply | any | — |
| `blacklist.hit` | Blacklisted(addr ∈ watch-set) | vault/pool/core/my EOA | other watched | — | resolves on UnBlacklisted |
| `oracle.stale` | feed age > heartbeat × margin | age > 2× heartbeat | age > 1.25× | — | resolves on update; 2 consecutive cycles |
| `oracle.divergence` | \|oracle − DEX mid at 25% size\| | > 300 bps | > 100 bps | > 50 bps | 15 blocks persistence; resolve below 50% of threshold |
| `oracle.hardcoded` | constant oracle detected on a market | — | at config load (one-time) | daily reminder | — |
| `oracle.source_changed` | Chainlink proxy `aggregator()` changed / Aave `AssetSourceUpdated` / CAPO `isCapped()==true` | — | any | — | capped resolves when uncapped |
| `peg.exit_cost` | 1 − get_dy(exit_size)/exit_size (after fees) | > 200 bps | > 50 bps | > 20 bps | 15 blocks persistence; resolve at 50% |
| `peg.imbalance` | max coin share in pool | > 70% | > 55% | > 45% | 30 blocks |
| `liquidity.ratio` | withdrawable / my position | < 1.0 | < 2.0 | < 5.0 | 10 blocks; resolve at ratio × 1.5 |
| `liquidity.utilization` | market/reserve utilization | > 98% (and ratio < 2) | > 92% | > 85% | 10 blocks |
| `curator.new_market` | allocation to market id ∉ pinned | collateral ∉ allowlist | any | — | resolves by pinning |
| `curator.concentration` | single market share jump | > 50% of vault | Δ > 20 pts in 24h | Δ > 10 pts | — |
| `curator.public_alloc` | PublicReallocateTo/Withdrawal | — | > 10% of vault moved | any | — |
| `flows.tvl` | Δ totalAssets over window | −25% / 1h | −10% / 6h or −20% / 24h | −15% / 7d | resolve when window recovers |
| `flows.top_holder` | exit by top-10 holder | > 15% of TVL in one tx | > 5% | any top-10 exit | — |
| `rwa.nav_stale` | NAV age > heartbeat × margin | > 3× (and redemption open) | > 1.5× | — | resolves on update |
| `rwa.nav_jump` | \|ΔNAV\| per update | > 100 bps | > 25 bps | any | — |
| `rwa.allowlist` | my EOA removed / allowlist contract changed | my EOA removed | contract/admin changed | additions | — |
| `rwa.redemption` | paused / limit ↓ / fee ↑ / USDC pool < position | paused or pool < position | limit < position or fee ↑ | any | resolves on restore |
| `rwa.supply_vs_aum` | totalSupply×NAV vs reported AUM | — | > 2% | > 0.5% | daily |
| `rwa.admin_action` | admin burn / seize / forced re-issue / `DSServiceSet` re-pointing / oracle setter changed | touches my EOA, or oracle/redemption contract re-pointed | any | — | — |
| `rwa.shared_redeemer` | Circle BUIDL→USDC redeemer available liquidity | < Σ my BUIDL-dependent positions | < 2× | < 5× | 10 blocks |
| `ops.rpc_lag` | provider lag | both stale > 5m | one lagging > 5 blocks/60s | — | — |
| `ops.watcher_error` | consecutive failures | P0-class watcher 10 min | 3 cycles | — | — |
| `ops.heartbeat` | missed Healthchecks ping | external (Healthchecks → Telegram) | — | — | — |

Cooldowns: after a condition resolves, the same `condition_key` cannot re-open for `cooldown_s` (default 600s for peg/liquidity, 0 for control-plane). Dedupe: an open condition never re-alerts; repeats are only the P0 ACK loop.

Every message carries: holding, `$ exposure` (from on-chain balance × price), `exit path: OPEN/CLOSED (why)`, decoded action (function + args, with proxy-resolved ABI), tx link (Etherscan), block, and for pending actions the ETA in UTC and local time.

---

## 7. Build vs. reuse (verified 2026-10-13)

### 7.1 OpenZeppelin Monitor (open source, Rust, AGPL-3.0)

Status, verified from the GitHub repo (docs sites were not reachable from this session):
- **Actively maintained.** Last commit 2026-10-12; latest release **v1.6.0 (2026-07-15)**; releases roughly every 1–3 months through 2026. 144 stars, 8 open issues. It is the official replacement for the hosted **OpenZeppelin Defender Monitor, which was sunset on 2026-07-01** (new sign-ups closed 2025-06-30).
- **Trigger model is log/transaction only.** `match_conditions` supports `events` (signature + expression on args), `functions` (decoded from top-level `transaction.input` against the monitored `to` address), and `transactions` (status/value/gas). The EVM filter calls only `eth_getLogs` (one block at a time) and lazily `eth_getTransactionReceipt`. **There is no `eth_call` or `eth_getStorageAt` anywhere in the filter path**, so EIP-1967 slot polling, `paused()`, oracle staleness and all position-relative math are impossible natively. Custom filter scripts (Python/JS/Bash) run only *after* a log/tx match as a post-filter and cannot originate an alert.
- Notifications: Slack, Discord, **Telegram**, email, webhook (HMAC-signed), script. Per-trigger retry policy. **No ack, repeat-until-ack, escalation, dedupe or cooldown.**
- RPC: weighted URL list with rotation on 429/5xx and health checks; **no cross-provider block-lag detection.**
- Storage: flat files (`<network>_last_block.txt`, optional block/missed-block JSON). Config is JSON files per network/monitor/trigger/filter. Docker image available; Prometheus metrics.
- Replay primitive: `--monitor-path <file> --network <slug> --block <n>` executes a monitor against one historical block.
- Known issues: no proxy/implementation ABI resolution (issue #406); internal calls invisible to function matching; the current `v1.6.0` Docker image ships a glibc mismatch that breaks JS filter scripts and `jq` (issue #502, open, no maintainer response yet); `--check` exits 0 on invalid config (#501).

**Fit:** it covers the pure log-based part of §2 (1e, 1f, 2a events, 2b events, 3a/3b events, 3c, 7a, 7b) and nothing else. Adopting it would still require all of: state polling, position math, DEX quoting, Safe Transaction Service polling, Telegram ack loop, hysteresis/dedupe. That is >70% of the system, and it would leave the alert path split across two codebases with two configs.

### 7.2 Tenderly Alerts (hosted)

- **Alert types (12):** successful/failed tx, function call (including internal calls), event emitted, event parameter, ERC-20 transfer, allowlisted/blocklisted callers, balance change, tx value, **State Change** (numeric storage variable: threshold / % change / value changed) and **View Function** (return-value threshold / % change). So `paused()`, `owner()`, `getThreshold()` and ERC-20 balances *are* native. Raw storage slots (EIP-1967) are **not** an alert type; they need a Web3 Action.
- Destinations: email, Slack, **Telegram**, Discord, Sentry, PagerDuty, webhook, Web3 Action. Delivery retried 5×. **No ack/escalation** (delegate to PagerDuty).
- **Web3 Actions** (Node/TS, triggers: block, periodic 5m–1d, webhook, alert): 30 s timeout (extendable), 128 MB, KV store with 100 KB values, 400–2000 executions / 5 min. Enough to poll a few slots or views; not a general engine for position-relative math across many holdings.
- **Pricing:** alerts are **paid-plan only**. Docs list Free $0 (no alerts), Starter $50/mo, Pro $500/mo; the marketing page shows a differently named "Monitor" tier. Per-plan alert-count limits are not published on any official page. Ethereum, Base, Arbitrum all supported.
- **Reliability record:** status page shows a 2025-05-26 incident where alert processing was skipped for 4 hours and alerts in that window never fired; Oct 2025 ~10-min delays; June 2026 ~7-min end-to-end latency peak on a shared alerting pipeline. Polling cadence for State Change / View Function alerts is not documented.
- **Replay:** `tenderly_simulateTransaction` can pin any historical block; Virtual TestNets with Network Mirror / backtest mode replay real parent-chain blocks (paid). No documentation that Alerts can be attached to a Virtual TestNet, so it is a simulation tool, not an alert-replay tool.

**Fit:** better than OZ Monitor for simple state thresholds, but still cannot host the position-relative liquidity, DEX-quote-at-size, Safe-queue, or ack logic without becoming a code host with tight limits; it adds a paid dependency and a pipeline that has demonstrably dropped a 4-hour window.

### 7.3 Decision

**Build the watcher ourselves (TypeScript + viem), use neither tool in the alert path.** Reasons that survive the verified facts:
1. State polling of storage slots and view functions is the backbone of the control-plane design; OZ Monitor cannot do it and Tenderly can only partly.
2. Position-relative liquidity, exit cost at size, Safe Transaction Service, hysteresis/dedupe/ack are all custom either way.
3. One pipeline, one config, one dedupe/ack model, fully replayable from the same code path.

**Reuse, selectively:**
- **Tenderly (optional, Phase 5):** a *second, independent* set of hosted alerts for the handful of P0 control-plane events (Upgraded/AdminChanged, Safe owner/threshold/module, Paused) on your top holdings, delivered to the P0 chat. It is different code, a different RPC path, and a different host, which is exactly the redundancy the SEAL monitoring framework recommends. Its 4-hour dropped window makes it unsuitable as the *only* path, which it never would be. Cost: Starter plan if the alert count fits (unknown; verify at signup).
- **OZ Monitor:** not deployed. Its expression-language and RPC-rotation designs are a reference for ours; its `--block` replay flag is the model for our replay CLI.
- **Ecosystem note:** Blocknative shut down its public APIs 2026-06-19 (do not build on it); Forta pivoted to Forta Firewall (prevention, not alerting); Hexagate is now a Chainalysis unit; Hypernative and Cyvers are commercial. Smaller OSS references: `ethereum-optimism/monitorism` (Go, YAML rules), `devblac/watch-tower` (Go, dedupe + reorg handling).

---

## 8. Testing: replaying historical incidents

### 8.1 Harness

`sentinel replay --holding <id> --from <block> --to <block> [--record fixtures/<name>]`

- Reuses the live scheduler with `blockTag` pinned per step (archive `eth_call`, `eth_getStorageAt`, `eth_getLogs` over the range), the real `fold` and `rules` functions, and a **fake Telegram sink** that writes alerts to a JSON file.
- `--record` captures every RPC response into a fixture; `--fixture` replays from it with no network, so CI runs in seconds and is deterministic.
- Assertions are written as "expected alert timeline" files: `{ block, condition_key, tier }` entries that must appear (and a `must_not` list for noise). A test passes if every expected alert fires at or before the expected block and no `must_not` alert fires.
- Positions during replay are taken from a `--as-wallet <addr>` (a real large holder at the time) or `--position-usd <n>` so position-relative thresholds are meaningful.

### 8.2 Incident catalog (seed set; block ranges resolved from timestamps at implementation)

| Incident | Date | What should fire | Watchers exercised |
|---|---|---|---|
| USDC depeg (SVB) | 2023-03-10/11 | `peg.exit_cost` P1→P0 on 3pool/USDC-USDT at size; `peg.imbalance` leading by hours; `oracle.divergence` vs Chainlink USDC/USD (which lagged DEX by ~5h); `flows.tvl` on USDC vaults | peg, oracle, flows |
| USDT 3pool imbalance | 2023-06 and 2022-11 | `peg.imbalance` P1; `peg.exit_cost` P2/P1 for USDT exits | peg |
| Morpho PAXG/USDC oracle misconfig | 2024-10-13 | `oracle.divergence` P0 (price off by 10^12) at market creation; `curator.new_market` if a vault allocated | oracle, curator |
| Stream Finance xUSD collapse / Elixir deUSD | 2025-11-03→ | `oracle.divergence` P0 on xUSD/USDC market (hardcoded ~1.26 vs DEX collapse); `liquidity.ratio` P0 (100% utilization); `flows.tvl` and `flows.top_holder` on affected curated vaults; `morpho.pending_cap` to 0 | oracle, liquidity, flows, pending |
| Any MetaMorpho `SubmitTimelock`/`SubmitCap` with later `SetCap` | pick 3 real cases from 2024–2025 | `morpho.pending_*` P1 at submit, re-alert at ETA−1h, close at accept | pending |
| A real EIP-1967 upgrade of a watched contract (e.g. a USDC FiatToken upgrade, an Aave PoolConfigurator upgrade) | historical | `proxy.impl_changed` P0 at the upgrade block from the slot read even with the event filter disabled | proxy |
| Aave reserve freeze/pause events (governance freezes of long-tail assets) | historical | `aave.frozen` P1 / `pause.protocol` P0 | aave |
| USDC blacklist of a Tornado-linked address (2022-08) | 2022-08-08 | `blacklist.hit` only if address ∈ watch-set; otherwise `must_not` (noise test) | stablecoin-issuer |
| Safe owner/threshold change on a known protocol Safe | historical | `safe.owner_set` P0 | safe |
| RWA NAV staleness | synthetic: freeze fixture timestamps | `rwa.nav_stale` P1→P0 | rwa |
| Circle BUIDL→USDC redeemer limited availability (~23h) | 2025-03-27 | `rwa.shared_redeemer` P1/P0 for OUSG / Midas BUIDL vault / OpenEden; `BUIDLRedemptionSkipped` observed | rwa |
| Superstate `SuperstateOracle` checkpoint gap | synthetic (5-day expiry → `StaleCheckpoint` revert) | `rwa.nav_stale` P1 at 1.5× heartbeat, long before the on-chain revert | rwa |

Plus **synthetic fixtures** for cases with no clean historical sample: storage-slot write without `Upgraded` event; Safe module enabled; timelock delay reduced; Morpho timelock reduced below 24h.

### 8.3 Non-replay tests

- Unit tests for `rules/` (hysteresis, persistence, cooldown, promotion rules) with table-driven cases.
- Property test: for any observation sequence, `opened` and `resolved` alternate per key (no double-fire).
- Chaos tests: kill primary RPC mid-cycle (failover without duplicate alerts), simulate reorg (cursor rewind, no duplicate alert), Telegram 5xx (retry with backoff, no lost P0).
- Heartbeat test: stop the service and confirm Healthchecks.io alerts within the grace period.

---

## 9. Optional LLM explainer (recommendation)

Recommendation: **ship v1 without it**; add in v1.1 as a separate process reading the `outbox` table. The watcher writes `{alert_id}` to `outbox` after the Telegram send succeeds; a worker (either a small Claude API script or the Hermes agent polling a local HTTP endpoint / the SQLite file) posts a plain-English reply to the P1 message. Since the Hermes agent is already on the box and already has a Telegram adapter, it is the cheaper integration: expose `GET /outbox/next` and `POST /outbox/{id}/done` on localhost; Hermes polls on a schedule. If you prefer an isolated Claude API worker, same interface. Either way the explainer cannot block or alter an alert, and a dead explainer only shows as an OPS P2.

---

## 10. Phased milestones

| Phase | Deliverable | Exit criteria |
|---|---|---|
| **0. Skeleton** (week 1) | Repo scaffold, config loader + schema + `config discover`, dual-RPC client with lag detection, block tracker + cursor, SQLite store, 3 Telegram bots with ACK loop, Healthchecks ping, NSSM service, replay harness skeleton + fixture recorder | Service runs on the Windows box, `/status` works, kill-test triggers Healthchecks alert, P0 ACK loop demo |
| **1. Control plane + pending actions** (weeks 2–3) | Watchers: proxy, safe, access-control, timelock, morpho-vault (pending + control), stablecoin-issuer (blacklist/pause/mint), Safe Tx Service poller; message rendering with decoded calldata; exposure read | Replay: upgrade, Safe change, SubmitCap/SubmitTimelock, blacklist noise test all pass; live run against your 3–5 holdings for 1 week with no false P0 |
| **2. Position-relative liquidity** (week 4) | morpho-market, aave, rwa-redemption liquidity; `exit_path_open` in every message; `liquidity.*` and `aave.*` conditions | Replay: Stream/xUSD 100%-utilization case fires P0; thresholds tuned on live data |
| **3. Peg + oracle** (weeks 5–6) | peg (Curve get_dy, Uniswap QuoterV2, sizes sweep, imbalance), oracle (staleness, divergence, hardcoded detection), rwa NAV | Replay: USDC depeg timeline (imbalance → exit cost → oracle divergence) and PAXG oracle case pass |
| **4. Flows + curator** (week 7) | flows (TVL windows, top-holder exits), curator (new markets, concentration, PublicAllocator), rwa allowlist/supply-vs-AUM, daily digest | Replay: Stream case fires flows alerts; digest reviewed for a week |
| **5. Hardening + explainer** (week 8) | Chaos tests, backups, runbook, optional outbox explainer, Dockerfile for migration | 30 days uptime; incident drill |

Each phase ends with a short review of false-positive rate and a threshold-tuning pass; thresholds live in config so tuning needs no code change.

---

## 11. Open risks and unknowns

1. **ABI for decoded calldata behind proxies.** Decoding a queued `upgradeToAndCall` or Safe tx needs the implementation ABI. Plan: fetch verified ABIs from Etherscan (API key) at config load and cache; unverified targets are rendered as raw selector + "UNVERIFIED" and are auto-promoted one tier.
2. **Safe Transaction Service access.** Verified: unauthenticated use is limited to 2 requests/s and 5,000 requests/month; production use needs an API key (free "Builder" tier reportedly 50k/month, secondary source). Polling cadence is derived from the quota at config load. Fallback: watch only on-chain execution (loses the "proposed" lead time).
3. **Top-holder discovery** needs either an indexer (Etherscan token-holder API, Dune) or folding `Transfer` events from deploy. Plan: Etherscan API for the daily top-N, event fold for intra-day deltas. Risk: API rate limits/terms.
4. **Archive RPC on free tier.** Replay and 7-day windows need historical state. If Alchemy's free tier does not cover it, use a paid tier for replay runs only, or a one-off archive provider.
5. **Hardcoded/exotic Morpho oracles.** Classification heuristics (no feed addresses, price constant over 7 days) will have edge cases (e.g. ERC-4626 exchange-rate oracles). These are flagged P2 for manual labelling in config rather than guessed.
6. **RWA issuer heterogeneity.** Each issuer has bespoke allowlist/NAV/redemption contracts; the `rwa` watcher will be a family of adapters (one per issuer) behind a common interface. Exact surfaces per issuer are in the research appendix; some are only partially verifiable without Etherscan source reading at implementation time.
7. **Peg sizing for LP positions.** For Curve/Uni LP holdings the "exit" is a withdrawal, not a swap; exit cost = withdraw-one-coin quote (`calc_withdraw_one_coin`) vs. proportional withdrawal. Plan covers it under `kind: curve-lp` but the worked example is a vault.
8. **Telegram as a single point of delivery.** If Telegram is down, P0 does not reach you. Mitigation: Healthchecks.io can also deliver via SMS/email on a missed ping, and a `--secondary-sink` (email via SMTP) is a small addition in Phase 5.
9. **Windows host reliability.** Windows Update reboots, sleep settings, and Docker-less operation mean the NSSM service plus the external heartbeat are the safety net; the daily digest doubling as a liveness signal is the human-visible backstop.
10. **Reorg handling vs. latency.** 2-block confirmation delays alerts ~24s. Control-plane P0s could run on `head` (0 confirmations) with a "reorged" retraction path; default is 2 to avoid retracted P0s. Tunable.
11. **Alert fatigue.** The threshold table is a starting point; Phase 1's one-week live soak without false P0s is the gate before expanding scope.

---

## 12. What happens on approval (no implementation code yet)

1. This document is committed as `PLAN.md` on `claude/defi-monitoring-service-plan-bcexe3` and pushed.
2. You supply: the 3–5 starting positions (vault/token addresses + the EOA(s) holding them), the three Telegram bot tokens and chat ids, your Telegram user id for ACK, and Alchemy + Infura keys.
3. Phase 0 starts only after a separate go-ahead; the first code review point is the end of Phase 0 (skeleton running on the Windows box, ACK loop and Healthchecks alert demonstrated).

---

## Appendix A. Research findings

- A.1 OpenZeppelin Monitor: status, capabilities, fit.
- A.2 Tenderly Alerts: status, capabilities, pricing, fit; Virtual TestNets for replay.
### A.3 Verified protocol surfaces (primary sources read 2026-10-13; ⚠ = secondary source only, verify on Etherscan before use)

**Morpho**
- MetaMorpho v1.0/v1.1 events and views as listed in §5.3; `pendingCap/pendingTimelock/pendingGuardian` return `(value, validAt)`; `config(id)` returns `(cap, enabled, removableAt)`. Constants: `MIN_TIMELOCK = 1 day`, `MAX_TIMELOCK = 2 weeks`, `MAX_QUEUE_LENGTH = 30`, `MAX_FEE = 50%`. v1.1 adds `lostAssets()` / `UpdateLostAssets`. Source: `morpho-org/metamorpho`, `morpho-org/metamorpho-v1.1` (EventsLib.sol, IMetaMorpho.sol, PendingLib.sol, ConstantsLib.sol).
- Morpho Blue `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb` (mainnet and Base): `market(id)`, `idToMarketParams(id)`, `position(id,user)`, `owner`, `feeRecipient`, `isIrmEnabled`, `isLltvEnabled`; events `SetOwner, SetFee, SetFeeRecipient, EnableIrm, EnableLltv, CreateMarket, AccrueInterest, Liquidate(..., badDebtAssets, badDebtShares)`. Idle liquidity = `totalSupplyAssets − totalBorrowAssets`. Source: `morpho-org/morpho-blue` IMorpho.sol, EventsLib.sol.
- `MorphoChainlinkOracleV2`: `price()` = `SCALE_FACTOR × Π base legs / Π quote legs`, 1e36-scaled; feed `address(0)` → price 1; **no staleness check** in `ChainlinkDataFeedLib`. Factory mainnet `0x3A7bB36Ee3f3eE32A60e9f2b33c1e5f2E83ad766`, `isMorphoChainlinkOracleV2(addr)`. Source: `morpho-org/morpho-blue-oracles`.
- PublicAllocator events `PublicWithdrawal, PublicReallocateTo, SetAdmin, SetFee, TransferFee, SetFlowCaps`; views `admin(vault), fee(vault), flowCaps(vault,id) → (maxIn, maxOut)`. Mainnet address not confirmed from a primary source (`0xfd32fA2ca22c76dD6E550706Ad913FC6CE91c75D` ⚠); must be read from the vault's `SetIsAllocator` history at config discovery. Source: `morpho-org/public-allocator`.
- Morpho Vaults V2 (`morpho-org/vault-v2`, factory mainnet `0xA1D94F746dEfa1928926b84fB2596c06926C0405`): roles owner/curator/allocator/sentinel; **timelock per selector** (`timelock(bytes4)`), pending actions only via `Submit(selector, data, executableAt)` events + `executableAt(data)`; `revoke` by curator or sentinel; `abdicate(selector)` irreversible; `decreaseTimelock` itself timelocked; cap decreases not timelocked; four gates (`receive/sendShares`, `receive/sendAssets`); permissionless `forceDeallocate` with ≤ 2% penalty is the in-kind exit path. 45 events incl. `Allocate, Deallocate, ForceDeallocate, IncreaseAbsoluteCap, DecreaseAbsoluteCap, SetLiquidityAdapterAndData, AddAdapter, RemoveAdapter, SetPerformanceFee, SetManagementFee, SetMaxRate, AccrueInterest(previousTotalAssets, newTotalAssets, …)`.

**Aave v3** (`aave-dao/aave-v3-origin`, addresses from `bgd-labs/aave-address-book`)
- Mainnet: Pool `0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2`, PoolConfigurator `0x64b761D848206f447Fe2dd461b0c635Ec39EbB27`, AaveOracle `0x54586bE62E3c3580375aE3723C145253060Ca0C2`, ACLManager `0xc2aaCf6553D20d1e9d78E365AAba8032af9c85b0`, PoolAddressesProvider `0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e`, UiPoolDataProviderV3 `0x2dAd8162A989cd99D673dE4425Bb2298Db1E1aA2`, PayloadsController `0xdAbad81aF85554E9ae636395611C58F7eC1aAEc5`, Executor Lvl 1 `0x5300A1a15135EA4dc7aD5a167152C01EFc9b192A`.
- PoolConfigurator events: `ReserveActive, ReserveFrozen, ReservePaused, ReserveBorrowing, SupplyCapChanged(asset, old, new), BorrowCapChanged, ReserveFactorChanged, CollateralConfigurationChanged, ReserveInterestRateStrategyChanged, LiquidationGracePeriodChanged, ATokenUpgraded, VariableDebtTokenUpgraded, EModeCategoryAdded, Asset{Collateral,Borrowable,Ltvzero}InEModeChanged`. `setPoolPause` emits one `ReservePaused` per reserve; no pool-level `paused()`.
- Roles: `POOL_ADMIN, EMERGENCY_ADMIN, RISK_ADMIN, ASSET_LISTING_ADMIN, FLASH_BORROWER, BRIDGE` (keccak of the string), `DEFAULT_ADMIN_ROLE = 0x0`; events are OZ `RoleGranted/RoleRevoked/RoleAdminChanged`. PoolAddressesProvider events `PoolUpdated, PoolConfiguratorUpdated, PriceOracleUpdated, ACLManagerUpdated, ACLAdminUpdated, ProxyCreated, AddressSet, AddressSetAsProxy`.
- Reserve bitmap: active 56, frozen 57, borrowing 58, paused 60, flashloan 63, reserveFactor 64–79, borrowCap 80–115, supplyCap 116–151. Liquidity: `getVirtualUnderlyingBalance(asset)` (v3.1+), `getReserveDeficit(asset)`; frozen still allows withdraw, paused blocks it.
- Governance v3: `PayloadCreated, PayloadQueued(id), PayloadExecuted(id), PayloadCancelled(id), ExecutorSet`; `getPayloadById(id)` → actions `(target, withDelegateCall, accessLevel, value, signature, callData)`, `delay`, `gracePeriod`, state enum `None/Created/Queued/Executed/Cancelled/Expired`.
- Oracle: `getSourceOfAsset`, `getAssetPrice`, events `AssetSourceUpdated, FallbackOracleUpdated`; CAPO adapters (`bgd-labs/aave-capo`) `isCapped()`, `getPriceCap()`, events `PriceCapUpdated`, `CapParametersUpdated`; sources often expose only `latestAnswer()`, so staleness is read on the underlying aggregator.

**Safe** (`safe-global/safe-smart-account`, `safe-global/safe-transaction-service`, `safe-global/safe-docs`)
- Events: `AddedOwner, RemovedOwner, ChangedThreshold, EnabledModule, DisabledModule, ExecutionFromModuleSuccess/Failure, ChangedGuard, ChangedModuleGuard (1.5), ChangedFallbackHandler, ExecutionSuccess(txHash, payment), ExecutionFailure, SafeSetup, ApproveHash`. Safe 1.3 does not index `txHash` in `ExecutionSuccess` (different topic0 from 1.4+).
- Storage: slot 0 singleton, slot 4 threshold, slot 5 nonce; guard slot `0x4a204f62…34c8`; fallback slot `0x6c9a6c4a…18d5`; module-guard slot `0xb104e0b9…9947`.
- Tx Service: base `https://api.safe.global/tx-service/eth/api/`; `GET v2/safes/{addr}/multisig-transactions/?executed=false` (fields: `safeTxHash, to, value, data, operation, nonce, submissionDate, confirmations[], confirmationsRequired, dataDecoded, proposer, trusted`); `POST v1/data-decoder/ {data, to}`; `GET v1/safes/{addr}/` → owners, threshold, modules, guard, fallbackHandler, masterCopy, version. Unauthenticated: 2 RPS, 5k/month; `Authorization: Bearer <key>` for more.

**Timelocks**
- OZ `TimelockController`: `CallScheduled(id, index, target, value, data, predecessor, delay)`, `CallExecuted`, `CallSalt`, `Cancelled(id)`, `MinDelayChange(old, new)`; `getMinDelay, getTimestamp(id) (1 = done), getOperationState(id)`, roles `PROPOSER_ROLE/EXECUTOR_ROLE/CANCELLER_ROLE` (executor granted to `address(0)` = anyone).
- Compound `Timelock`: `QueueTransaction/ExecuteTransaction/CancelTransaction(txHash, target, value, signature, data, eta)`, `NewDelay, NewAdmin, NewPendingAdmin`; `delay(), admin(), pendingAdmin(), queuedTransactions(hash)`, `GRACE_PERIOD = 14d`. If `signature != ""`, calldata = selector(signature) ++ data.

**Proxies (ERC-1967 / 1822 / 2535)**
- Slots: impl `0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc`, admin `0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103`, beacon `0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50`; events `Upgraded(impl)`, `AdminChanged(prev, new)`, `BeaconUpgraded(beacon)`; `IBeacon.implementation()`; Diamond `DiamondCut(FacetCut[], init, calldata)` + loupe `facets()/facetAddress(selector)`. Also track `extcodehash` of the implementation.

**Stablecoin issuers**
- USDC FiatTokenV2_2 (`circlefin/stablecoin-evm`): `Blacklisted, UnBlacklisted, BlacklisterChanged, Pause, Unpause, PauserChanged, Mint(minter,to,amount), Burn, MinterConfigured, MinterRemoved, MasterMinterChanged`; views `isBlacklisted, paused, pauser, blacklister, masterMinter, isMinter, minterAllowance`. Mainnet `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`.
- USDT TetherToken `0xdAC17F958D2ee523a2206206994597C13D831ec7`: `Issue, Redeem, Deprecate(newAddress), Params, Pause, Unpause, AddedBlackList, RemovedBlackList, DestroyedBlackFunds`; views `isBlackListed(addr)`, `deprecated`, `upgradedAddress`, `paused`, `owner`. Solidity 0.4 ABI: pull from Etherscan rather than assuming `indexed`. `deprecated == true` forwards all calls to `upgradedAddress` (critical).
- USDS: UUPS, `Rely/Deny`, no pause/blacklist. USDe: `MinterUpdated`; minting contract `MaxMintPerBlockChanged/MaxRedeemPerBlockChanged` (0 = halted). GHO: `FacilitatorAdded/Removed`, `FacilitatorBucketCapacityUpdated`. USD0: not verifiable from public GitHub; read verified source.

**DEX and feeds**
- Curve StableSwap-NG: `get_dy(i,j,dx)` (net of dynamic fee), `get_dx`, `get_balances`, `stored_rates`, `A`, `fee`, `dynamic_fee(i,j)`, `price_oracle(i)`, `calc_withdraw_one_coin`, `get_virtual_price`; meta pools add `get_dy_underlying`. Legacy 3pool `0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7` ⚠ uses `balances(i)`. Router NG `get_dy(route, swap_params, amount)` for multi-hop.
- Uniswap v3 `IQuoterV2.quoteExactInputSingle((tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96))` → `(amountOut, sqrtPriceX96After, initializedTicksCrossed, gasEstimate)`; mainnet QuoterV2 `0x61fFE014bA17989E743c5F6cB21bF9697530B21e` ⚠. v4 `IV4Quoter.quoteExactInputSingle((poolKey, zeroForOne, exactAmount, hookData))`; mainnet V4Quoter `0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203` ⚠.
- Chainlink `latestRoundData() → (roundId, answer, startedAt, updatedAt, answeredInRound)` (`answeredInRound` deprecated); heartbeat and deviation per feed from data.chain.link; USDC/USD mainnet `0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6`, 8 decimals, 24h heartbeat ⚠ (deviation not confirmed).
### A.4 RWA issuer surfaces (verified from the issuers' public GitHub contract repos; addresses from official docs/registries unless marked ⚠; issuer doc sites and Etherscan were not reachable from this session, so role-holder identities and proxy implementations must be confirmed at config time)

Common pattern: none of the six uses ERC-3643, ERC-1404 or ERC-7540; each needs its own adapter behind one `rwa` interface: `navSource`, `isMyAddressAllowed()`, `redemptionState()`, `adminEvents[]`.

| Issuer | Token (Ethereum) | NAV source | Allowlist mechanism | Redemption / liquidity | Admin powers to watch |
|---|---|---|---|---|---|
| **Ondo OUSG** | `0x1B19C19393e2d034D8Ff31ff34c81252FcBbee92` (Transparent proxy); rOUSG ⚠ `0x54043c…8d00` | `OndoOracle` `0x9Cad45a8BF0Ed41Ff33074449B357C7a1fAb4094` (getter name unverified; legacy `RWAOracleExternalComparisonCheck` `0x0502…6abe` emits `RWAExternalComparisonCheckPriceSet`), once per business day, bounded by SHV ETF feed | `OndoIDRegistry` `0xcf6958D69d535FD03BD6Df3F4fe6CDcd127D97df` | `OUSG_InstantManager` `0x93358db73B6cd4b98D89c8F5f230E81a95c2643a`: `redeem` pays USDC by redeeming BUIDL through the Circle redeemer (min 250k); rate limiter (`setInstantRedemptionLimit`), `pauseRedeem`; events `InstantRedemptionOUSG`, `RedeemPaused/Unpaused`, `BUIDLRedemptionSkipped`, `RedeemFeeSet`, `OracleSet` | `PAUSER_ROLE`, `CONFIGURER_ROLE`, `BURNER_ROLE` (admin burn on rOUSG), `setOracle`, `retrieveTokens`; ProxyAdmin |
| **Ondo USDY** | `0x96F6eF951840721AdBF46Ac996b59E0235CB985C`; rUSDY `0xaf37c1167910ebC994e266949387d2c7C326b879` | `RWADynamicOracle` `0xA0219AA5B31e65Bc920B5b6DFb8EdF0988121De0`: price is *computed* from monthly `Range`s (`RangeSet`, `RangeOverriden`); staleness = `ranges[last].end < now`; `pauseOracle()` makes `getPrice()` revert | `Allowlist` (self-registration by term) + `Blocklist` + Chainalysis `SanctionsList` `0x40C57923924B5c5c5455c48D93317139ADDaC8fb`; events `AccountStatusSetByAdmin`, `BlockedAddressesAdded/Removed`, `AllowlistSet`, `BlocklistSet` | `USDY_InstantManager` `0xa42613C243b67BF6194Ac327795b926B4b491f15` (`subscribe`/`redeem`, reverts `RedemptionsPaused`); legacy `USDYManager` request flow (`RedemptionRequested/Completed`, `RedemptionPaused`) | `BURNER_ROLE` burn, `PAUSER_ROLE`, oracle `SETTER_ROLE` |
| **Securitize BUIDL** | `0x7712c34205737192402172409a8F7ccef8aA2AEc` (proxy; DS Protocol `DSToken`) | None on-chain: $1 target, yield paid as new tokens (`Issue` events). Chronicle Proof of Asset announced 2026-03 (address not found) | `ComplianceService.preTransferCheck(from,to,value)` (view, use it as the exit pre-flight); registry events `DSRegistryServiceWalletAdded/Removed`, `WalletAddedToBlacklist`, `InvestorFullyLocked`; `DSServiceSet(serviceId, addr)` = service re-pointing | Off-chain daily via transfer agent ($250k min). Instant: **Circle BUIDL→USDC redeemer** ⚠ `0x31D3F59Ad4aAC0eeE2247c65EBE8Bf6E9E470a53`, interface `redeem(uint256)`, `liquidity()`, `settlement().availableLiquidity()`, `paused()` | `TrustService` roles MASTER/ISSUER/EXCHANGE/TRANSFER_AGENT (`DSTrustServiceRoleAdded/Removed`); `seize`, `burn(who, value, reason)`, `pause` (TA), `unpause` (MASTER) |
| **Superstate USTB / USCC** | USTB `0x43415eB6ff9DB7E26A15b704e7A3eDCe97d31C4e`; USCC `0x14d60E7FDC0D71d8611742720E4C50E7a974020c` (Transparent, ERC-7246) | `SuperstateOracle` `0xe4fa682f94610ccd170680cc3b045d77d9e528a8` (owner `addCheckpoint`, `NewCheckpoint`, linear extrapolation, reverts `StaleCheckpoint` after 5 days) and Chainlink NAVLink `0x289B5036cd942e619E1Ee48670F98d214E745AAC` (USTB NAV/share, deviation 0.0001%) | `AllowListV3` `0x02f1fa8b196d21c7b733eb2700b825611d8a38e5`: `isAddressAllowedForFund(addr, "USTB")`; events `EntityIdSet`, `FundPermissionSet`, `ProtocolAddressPermissionSet` | `RedemptionIdle` `0x4c21b7577c8fe8b0b0669165ee7c8f67fa1454cf`: `redeem(amount)` at Chainlink price minus `redemptionFee`, `maxUstbRedemptionAmount()`, reverts `InsufficientBalance`/`BadChainlinkData`; liquidity = `USDC.balanceOf(redemption)`; events `RedeemV2`, `SetRedemptionFee`, `SetMaximumOracleDelay`, `Withdraw`, `Paused` | Single `owner` (Ownable2Step) on token/allowlist/oracle/redemption; `adminBurn`, `pause`, `accountingPause`, `setOracle`, `setRedemptionContract`; ProxyAdmin via Fireblocks; no timelock |
| **Midas mTBILL / mBASIS / mEDGE / mMEV / mRE7** | mTBILL `0xDD629E5241CbC5919847783e6C96B2De4754e438`, mBASIS `0x2a8c22E3b10036f3AEF5875d04f8441d4188b656`, mEDGE `0xbB51E2a15A9158EBE2b0Ceb8678511e063AB7a55`, mMEV `0x030b69280892c888670EDCDCD8B69Fd8026A0BF3`, mRE7 `0x87C9053C819bB28e0D73d33059E1b3DA80AFb0cf` (**same addresses are different contracts on Base**; key on chainId) | `CustomAggregatorV3CompatibleFeed` per product (mTBILL `0x056339C044055819E8Db84E71f5f2E1F536b2E5b`): `setRoundData` by feed admin, `AnswerUpdated(data, roundId, ts)`, deviation-bounded; `DataFeed` wrapper (mTBILL `0xfCEE9754E8C375e145303b7cE7BEca3201734A2B`) `healthyDiff` default 30 days | `MidasAccessControl` `0x0312A9D1Ff2372DDEdCBB21e4B6389aFc919aC4B`: `BLACKLISTED_ROLE` freezes, `GREENLISTED_ROLE` whitelists; watch `RoleGranted/RoleRevoked`; Chainalysis sanctions list | `RedemptionVault` per product (mTBILL `0xF6e51d24F4793Ac5e71e0502213a9BBE3A6d4517`, USTB-backed `0x569D7dccBF6923350521ecBC28A555A500c4f0Ec`): `redeemInstant`, `instantDailyLimit`, `tokensAllowance(token)`, `pause`/`pauseFn(selector)`; events `RedeemInstant`, `SetInstantDailyLimit`, `SetInstantFee`, `ChangeTokenAllowance`, `PauseFn`, `WithdrawToken`; BUIDL/USTB-backed variants depend on the Circle / Superstate redeemers | `MidasTimelockController` `0xE3EEe3e0D2398799C884a47FC40C029C8e241852` governs upgrades (OZ TimelockController, so §2a applies); `burnGoverned` admin burn; `changeAggregator`, `setHealthyDiff` on feeds |
| **Spiko EUTBL / USTBL** | EUTBL `0xa0769f7A8fC65e47dE93797b4e21C073c117Fc80`, USTBL `0xe4880249745eAc5F1eD9d8F7DF844792D560e750` (UUPS, ERC-1363, 5 decimals; same addresses on Base/Polygon/Etherlink, **different on Arbitrum**) | `Oracle` per token (USTBL `0x021289588cd81dC1AC87ea91e91607eEF68303F5`, 6 decimals): `publishPrice` by operator-oracle group, `Update(timepoint, price, round)`, `updatedAt` = valuation time; no on-chain staleness guard; Chainlink NAVLink `ustbl-nav.data.eth` | `PermissionManager` `0x344278aff344d6fb960705dc18a4912221608472`: `canCall(addr, token, transfer.selector)`; events `GroupAdded/GroupRemoved(user, group)`, `Requirements`, `GroupAdmins` | `Redemption` `0xDA5599f04e9b437C8394b0c2BC68B502A66ebFe8`: ERC-1363 `transferAndCall` request → `RedemptionInitiated`, operator `RedemptionExecuted`, auto-cancel after 14 days; settlement off-chain; `EnableOutput`, `MinimumUpdated`. Instant ATM contracts exist, addresses not found | Admin Safe ⚠ `0x4EAA52B6280593a8820C45cE38f974290Ae52Cea` via PermissionManager groups; `burn(from, amount)` admin burn; `pause`; UUPS upgrade by ADMIN group; no timelock |
| **OpenEden TBILL** | `0xdd50C053C096CB04A3e3362E2b622529EC5f2e8a` (UUPS, ERC-4626-shaped) | `TBillPriceOracle` `0xCe9a6626Eb99eaeA829D7fA613d5D0A2eaE45F40`: operator `updatePrice` daily, deviation-bounded, admin `updateCloseNavPriceManually` bypasses it; `UpdatePrice(old,new)`; no staleness guard | `KycManager` `0x51Be497AcEd1a2C19f6151064301e356B020D947`: `isKyc`, `isBanned`; events `GrantKyc`, `RevokeKyc`, `Banned` | Vault: `redeem` → withdrawal queue (`AddToWithdrawalQueue`, `ProcessWithdrawalQueue`), `redeemIns` instant via `redemptionContract` (Circle BUIDL or USYC redeemer; `SetRedemption` event); `Controller` `0x377de6729507Bb0E56E0AAC666bd8522E4A3fe41` `pausedWithdraw()`, `PausedWithdraw`, `PauseAll`; `FeeManager` `0x99C913B3cBDdCFC7eD49Ff19B00704286a4B3b6B` `SetMaxWithdraw`, `SetTxFee*` | `TimelockController` `0x8Bb125BA9A0429583dfc3FCF295636A6cC8e9dc0` (§2a applies); maintainer `burnFrom`, `mintTo`, `reIssue`; operator `offRamp` (moves USDC to treasury); owner `set*` for every dependency contract |

Off-chain AUM sources: Superstate `api.superstate.com/v1/funds/{1,2}/nav-daily` (auth unverified); Ondo API is for Global Markets only; Midas publishes Chainlink CRE proof-of-reserve attestations on-chain (registry address not found); Securitize, Spiko, OpenEden: none public. Fallback for `rwa.supply_vs_aum` is a manual `reported_aum_usd` field in config updated from issuer dashboards, with the check demoted to P2.

### A.5 Sources
- OpenZeppelin Monitor: github.com/OpenZeppelin/openzeppelin-monitor (commits, releases, `docs/index.mdx`, `docs/rpc.mdx`, `src/services/filter/filters/evm/filter.rs`, `src/main.rs`, issues #243 #406 #501 #502); Defender sunset: openzeppelin.com/news/defender-sunset-faq.
- Tenderly: docs.tenderly.co/monitoring/alerts/types, /alerts/api, /monitoring/alerts/destinations, /tenderly-plans, /pricing, /web3-actions/rate-limits, /simulations/single-simulations, /virtual-environments/network-mirror-backtest; status.tenderly.co incidents 2fk7hdfbj27v, drc157v89w5f.
- Ecosystem: theblock.co (Blocknative wind-down 2026-05; Hypernative Series B), cointelegraph.com (Hexagate/Chainalysis), forta.org/blog, frameworks.securityalliance.org/monitoring/tools.
- Morpho: github.com/morpho-org/{metamorpho, metamorpho-v1.1, morpho-blue, morpho-blue-oracles, public-allocator, vault-v2, sdks}; help.morpho.org/en/articles/12879577-oracles-on-morpho; forum.morpho.org PAXG retrospective (t/891).
- Aave: github.com/aave-dao/aave-v3-origin, github.com/bgd-labs/{aave-address-book, aave-governance-v3, aave-capo}.
- Safe: github.com/safe-global/{safe-smart-account, safe-transaction-service, safe-docs}.
- Timelocks/proxies: github.com/OpenZeppelin/openzeppelin-contracts, github.com/compound-finance/compound-protocol, github.com/ethereum/ERCs (1967, 1822, 2535).
- Stablecoins: github.com/circlefin/stablecoin-evm, github.com/makerdao/usds, github.com/ethena-labs/bbp-public-assets, github.com/aave/gho-core.
- DEX/feeds: github.com/curvefi/{stableswap-ng, curve-router-ng}, github.com/Uniswap/{v3-periphery, v4-periphery}, github.com/smartcontractkit/documentation.
- RWA: github.com/superstateinc/{ustb, onchain-redemptions}, github.com/midas-apps/{contracts, midas-por-v2}, github.com/spiko-tech/contracts, github.com/securitize-io/dstoken, github.com/OpenEdenHQ/openeden.vault.audit, github.com/ondoprotocol/usdy, github.com/code-423n4/{2024-03-ondo-finance, 2023-09-ondo}; docs.ondo.finance/addresses, docs.superstate.com/investors/smart-contracts, docs.midas.app/resources/smart-contracts-addresses, docs.openeden.com/tbill/smart-contract-addresses; ondo.finance blog on OUSG liquidity (2025-03-27 Circle facility event); businesswire.com Chronicle Proof of Asset for BUIDL (2026-03-26).
- Incidents: theblock.co, decrypt.co, cointelegraph.com, parsec.substack.com (Stream Finance / Elixir, Nov 2025); thedefiant.io, blog.verichains.io (Morpho PAXG oracle, Oct 2024); xenophonlabs.substack.com, bankless.com (USDC depeg / 3pool, Mar 2023).
- Hosting/health: healthchecks.io (free tier: 20 checks, Telegram integration); hookdeck.com guide on Hermes agent webhooks.
