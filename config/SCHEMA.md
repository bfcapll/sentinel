# Sentinel configuration reference

> Generated from `src/config/schema.ts` by `npm run gen:schema`. Do not edit by hand; a test fails if this file is stale.

## How configuration is loaded

- `config/sentinel.yaml` global settings; `config/wallets.yaml` your EOAs and Telegram user id; `config/shared/*.yaml` control graphs and registries defined once; `config/holdings/*.yaml` one file per position.
- `${VAR}` and `${VAR:-default}` in any string are substituted from the environment, with `.env` filling in anything not already set. Unset or empty variables without a default are errors (names only, values are never printed).
- `{ $ref: shared/<name>, ...overrides }` is replaced by the contents of `config/shared/<name>.yaml`, with local keys winning (deep merge).
- `<node-id>` / `<node-id.expect.field>` resolve to an address inside the same holding (e.g. `address: <vault.expect.owner>`).
- Values like `0x…`, `<unresolved>`, `TODO`, `CHANGEME` are unfilled placeholders: `sentinel config check` fails loudly until they are replaced. A `# verify` comment next to a value is reported as a warning until you remove it.
- Unknown keys are errors (typos in a monitoring config must not pass silently).
- Run `sentinel config check` after any edit.

## Files

### `config/sentinel.yaml`

#### `sentinel`


| field | type | required | default | description |
|---|---|---|---|---|
| `chain` | `"ethereum"` |  | `"ethereum"` |  |
| `rpc` | object | yes |  |  |
| `cycle` | object |  | `{"slow_lane_secs":300,"max_log_range":500,"max_catchup_blocks":5000}` |  |
| `telegram` | object | yes |  |  |
| `healthchecks` | object | yes |  |  |
| `etherscan` | object | yes |  |  |
| `safe_tx_service` | object | yes |  |  |
| `explorer` | object |  | `{"tx_url":"https://etherscan.io/tx/{hash}","block_url":"https://etherscan.io/block/{number}","address_url":"https://etherscan.io/address/{address}"}` |  |
| `store` | object |  | `{"path":"./data/sentinel.db","backup_dir":"./backups","backup_keep":14}` |  |
| `logging` | object |  | `{"level":"info"}` |  |
| `thresholds` | map of object |  | `{}` | Global overrides of the default threshold table. |

#### `sentinel.rpc`


| field | type | required | default | description |
|---|---|---|---|---|
| `primary` | object | yes |  | Alchemy: HTTPS + WSS. |
| `secondary` | object | yes |  | Infura: cross-check + failover. |
| `canary` | object | yes |  | dRPC public endpoint: eth_blockNumber only. |
| `confirmations` | integer |  | `2` |  |
| `reorg_rescan_blocks` | integer |  | `12` |  |
| `poll_interval_ms` | integer |  | `4000` | HTTP head polling cadence (used when WS is silent). |
| `health_poll_ms` | integer |  | `12000` | How often every provider (incl. the canary) is asked for eth_blockNumber for the lag rules. |
| `ws_silence_ms` | integer |  | `20000` | Fall back to polling when WS delivers no head for this long. |
| `request_timeout_ms` | integer |  | `10000` |  |
| `lag` | object |  | `{"max_block_diff":5,"diff_secs":60,"stall_secs":90,"blind_secs":300}` |  |

#### `sentinel.rpc.primary`

Alchemy: HTTPS + WSS.

| field | type | required | default | description |
|---|---|---|---|---|
| `http` | string | yes |  | http(s) URL. `${ENV}` references are substituted from the environment / .env. |
| `ws` | string (`^wss?:\/\/`) |  |  | WebSocket URL. |

#### `sentinel.rpc.secondary`

Infura: cross-check + failover.

| field | type | required | default | description |
|---|---|---|---|---|
| `http` | string | yes |  | http(s) URL. `${ENV}` references are substituted from the environment / .env. |

#### `sentinel.rpc.canary`

dRPC public endpoint: eth_blockNumber only.

| field | type | required | default | description |
|---|---|---|---|---|
| `http` | string | yes |  | http(s) URL. `${ENV}` references are substituted from the environment / .env. |

#### `sentinel.rpc.lag`


| field | type | required | default | description |
|---|---|---|---|---|
| `max_block_diff` | integer |  | `5` |  |
| `diff_secs` | integer |  | `60` |  |
| `stall_secs` | integer |  | `90` |  |
| `blind_secs` | integer |  | `300` |  |

#### `sentinel.cycle`


| field | type | required | default | description |
|---|---|---|---|---|
| `slow_lane_secs` | integer |  | `300` |  |
| `max_log_range` | integer |  | `500` |  |
| `max_catchup_blocks` | integer |  | `5000` |  |

#### `sentinel.telegram`


| field | type | required | default | description |
|---|---|---|---|---|
| `bots` | object | yes |  |  |
| `repeat_minutes` | number |  | `5` |  |
| `repeat_cap_hours` | number |  | `24` |  |
| `global_repeat_min_interval_s` | integer |  | `60` |  |
| `snooze_minutes` | number |  | `60` |  |
| `digest` | object |  | `{"time":"09:00","timezone":"local"}` |  |

#### `sentinel.telegram.bots`


| field | type | required | default | description |
|---|---|---|---|---|
| `p0` | object | yes |  |  |
| `p1` | object | yes |  |  |
| `p2` | object | yes |  |  |

#### `sentinel.telegram.bots.p0`


| field | type | required | default | description |
|---|---|---|---|---|
| `token` | string | yes |  | Bot token from BotFather (kept in .env). |
| `chat_id` | string \\| integer | yes |  | Chat / group id the bot posts to. |

#### `sentinel.telegram.bots.p1`


| field | type | required | default | description |
|---|---|---|---|---|
| `token` | string | yes |  | Bot token from BotFather (kept in .env). |
| `chat_id` | string \\| integer | yes |  | Chat / group id the bot posts to. |

#### `sentinel.telegram.bots.p2`


| field | type | required | default | description |
|---|---|---|---|---|
| `token` | string | yes |  | Bot token from BotFather (kept in .env). |
| `chat_id` | string \\| integer | yes |  | Chat / group id the bot posts to. |

#### `sentinel.telegram.digest`


| field | type | required | default | description |
|---|---|---|---|---|
| `time` | string (`^([01]\d\\|2[0-3]):[0-5]\d$`) |  | `"09:00"` |  |
| `timezone` | string |  | `"local"` | IANA zone (e.g. America/New_York) or "local" for the host zone. |

#### `sentinel.healthchecks`


| field | type | required | default | description |
|---|---|---|---|---|
| `ping_url` | string | yes |  | Healthchecks.io ping URL; pinged only after a fully committed cycle. |
| `min_interval_s` | integer |  | `60` |  |
| `timeout_ms` | integer |  | `5000` |  |

#### `sentinel.etherscan`


| field | type | required | default | description |
|---|---|---|---|---|
| `api_key` | string | yes |  |  |
| `base_url` | string |  | `"https://api.etherscan.io/v2/api"` |  |

#### `sentinel.safe_tx_service`


| field | type | required | default | description |
|---|---|---|---|---|
| `api_key` | string | yes |  |  |
| `base_url` | string |  | `"https://api.safe.global/tx-service/eth/api"` |  |

#### `sentinel.explorer`


| field | type | required | default | description |
|---|---|---|---|---|
| `tx_url` | string |  | `"https://etherscan.io/tx/{hash}"` |  |
| `block_url` | string |  | `"https://etherscan.io/block/{number}"` |  |
| `address_url` | string |  | `"https://etherscan.io/address/{address}"` |  |

#### `sentinel.store`


| field | type | required | default | description |
|---|---|---|---|---|
| `path` | string |  | `"./data/sentinel.db"` |  |
| `backup_dir` | string |  | `"./backups"` |  |
| `backup_keep` | integer |  | `14` |  |

#### `sentinel.logging`


| field | type | required | default | description |
|---|---|---|---|---|
| `level` | `trace` \\| `debug` \\| `info` \\| `warn` \\| `error` |  | `"info"` |  |
| `file` | string |  |  | Log file path; stdout when omitted (NSSM captures and rotates stdout). |

#### `sentinel.thresholds.<key>`

Override of a default threshold (PLAN.md §6.2). Only the fields you set are overridden.

| field | type | required | default | description |
|---|---|---|---|---|
| `p0` | number |  |  |  |
| `p1` | number |  |  |  |
| `p2` | number |  |  |  |
| `direction` | `above` \\| `below` |  |  |  |
| `unit` | string |  |  |  |
| `persistence_blocks` | integer |  |  |  |
| `persistence_cycles` | integer |  |  |  |
| `resolve_factor` | number |  |  |  |
| `resolve_cycles` | integer |  |  |  |
| `cooldown_s` | integer |  |  |  |

### `config/wallets.yaml`

#### `wallets`


| field | type | required | default | description |
|---|---|---|---|---|
| `telegram_user_id` | integer | yes |  | Your numeric Telegram user id. Only this user may press ACK / Snooze or run commands. |
| `wallets` | list of object | yes |  | Your EOAs. Exposure is read on-chain from these. |

#### `wallets.wallets[]`


| field | type | required | default | description |
|---|---|---|---|---|
| `label` | string | yes |  |  |
| `address` | address | yes |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |

### `config/holdings/<id>.yaml`

#### `holding`


| field | type | required | default | description |
|---|---|---|---|---|
| `id` | string (`^[a-z0-9][a-z0-9-]*$`) | yes |  | Unique holding id; used in every condition key. |
| `enabled` | boolean |  | `true` |  |
| `chain` | `"ethereum"` |  | `"ethereum"` |  |
| `kind` | `metamorpho` \\| `morpho-vault-v2` \\| `aave-v3` \\| `curve-lp` \\| `uniswap-v3-lp` \\| `rwa-token` | yes |  |  |
| `asset` | object | yes |  |  |
| `wallets` | list of string | yes |  | Wallet labels from wallets.yaml that hold this asset. |
| `exposure` | object | yes |  |  |
| `control_graph` | list of object |  |  |  |
| `pending_actions` | list of object |  | `[]` |  |
| `pauses` | list of object |  |  |  |
| `markets` | object |  |  |  |
| `oracles` | object |  |  |  |
| `peg` | object |  |  |  |
| `liquidity` | object |  |  |  |
| `flows` | object |  |  |  |
| `thresholds` | map of object |  | `{}` | Threshold overrides keyed by rule key, e.g. `liquidity.ratio`. |

#### `holding.asset`


| field | type | required | default | description |
|---|---|---|---|---|
| `address` | address | yes |  | The token / vault share you hold. |
| `decimals` | integer | yes |  |  |
| `symbol` | string | yes |  |  |
| `loan_token` | object |  |  | Underlying asset (vault kinds). |

#### `holding.asset.loan_token`

Underlying asset (vault kinds).

| field | type | required | default | description |
|---|---|---|---|---|
| `address` | address | yes |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `symbol` | string | yes |  |  |
| `decimals` | integer | yes |  |  |

#### `holding.exposure`


| field | type | required | default | description |
|---|---|---|---|---|
| `price_feed` | string (`^(chainlink:[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\\|const:\d+(\.\d+)?\\|nav-oracle)$`) | yes |  | Price source for exposure: `chainlink:USDC/USD` (resolved via shared/chainlink-feeds), `const:1.0`, or `nav-oracle`. |
| `exit_size` | string (`^\d+(\.\d+)?%$`) \\| number |  | `"100%"` | Exit size used for peg checks and liquidity ratios: a percent of the position ("100%") or an absolute USD amount (number). |

#### `holding.control_graph[]#type=proxy`


| field | type | required | default | description |
|---|---|---|---|---|
| `id` | string (`^[a-z0-9][a-z0-9-]*$`) | yes |  | Node id, unique within the holding. Referenced by pending_actions and <id.expect.field> references. |
| `address` | address | yes |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `label` | string |  |  |  |
| `proxy` | object |  |  | Present when this contract sits behind an EIP-1967 proxy; enables the proxy watcher on it. |
| `type` | `"proxy"` | yes |  |  |
| `expect` | object |  |  | Expected EIP-1967 slot values. Omitted fields are pinned to the first observed value (trust on first use) and alert on any later change. 0x0 means "slot must stay empty". |

#### `holding.control_graph[]#type=proxy.proxy`

Present when this contract sits behind an EIP-1967 proxy; enables the proxy watcher on it.

| field | type | required | default | description |
|---|---|---|---|---|
| `implementation` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `admin` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `beacon` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |

#### `holding.control_graph[]#type=proxy.expect`

Expected EIP-1967 slot values. Omitted fields are pinned to the first observed value (trust on first use) and alert on any later change. 0x0 means "slot must stay empty".

| field | type | required | default | description |
|---|---|---|---|---|
| `implementation` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `admin` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `beacon` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |

#### `holding.control_graph[]#type=safe`


| field | type | required | default | description |
|---|---|---|---|---|
| `id` | string (`^[a-z0-9][a-z0-9-]*$`) | yes |  | Node id, unique within the holding. Referenced by pending_actions and <id.expect.field> references. |
| `address` | address | yes |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `label` | string |  |  |  |
| `proxy` | object |  |  | Present when this contract sits behind an EIP-1967 proxy; enables the proxy watcher on it. |
| `type` | `"safe"` | yes |  |  |
| `expect` | object |  |  |  |

#### `holding.control_graph[]#type=safe.proxy`

Present when this contract sits behind an EIP-1967 proxy; enables the proxy watcher on it.

| field | type | required | default | description |
|---|---|---|---|---|
| `implementation` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `admin` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `beacon` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |

#### `holding.control_graph[]#type=safe.expect`


| field | type | required | default | description |
|---|---|---|---|---|
| `threshold_min` | integer |  |  |  |
| `owners_known` | boolean |  |  |  |
| `owners` | list of address |  |  |  |
| `modules` | list of address |  |  |  |
| `guard` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |

#### `holding.control_graph[]#type=timelock`


| field | type | required | default | description |
|---|---|---|---|---|
| `id` | string (`^[a-z0-9][a-z0-9-]*$`) | yes |  | Node id, unique within the holding. Referenced by pending_actions and <id.expect.field> references. |
| `address` | address | yes |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `label` | string |  |  |  |
| `proxy` | object |  |  | Present when this contract sits behind an EIP-1967 proxy; enables the proxy watcher on it. |
| `type` | `"timelock"` | yes |  |  |
| `expect` | object |  | `{}` |  |

#### `holding.control_graph[]#type=timelock.proxy`

Present when this contract sits behind an EIP-1967 proxy; enables the proxy watcher on it.

| field | type | required | default | description |
|---|---|---|---|---|
| `implementation` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `admin` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `beacon` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |

#### `holding.control_graph[]#type=timelock.expect`


| field | type | required | default | description |
|---|---|---|---|---|
| `min_delay_s` | integer |  |  |  |

#### `holding.control_graph[]#type=access-control`


| field | type | required | default | description |
|---|---|---|---|---|
| `id` | string (`^[a-z0-9][a-z0-9-]*$`) | yes |  | Node id, unique within the holding. Referenced by pending_actions and <id.expect.field> references. |
| `address` | address | yes |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `label` | string |  |  |  |
| `proxy` | object |  |  | Present when this contract sits behind an EIP-1967 proxy; enables the proxy watcher on it. |
| `type` | `"access-control"` | yes |  |  |
| `expect` | object |  |  |  |

#### `holding.control_graph[]#type=access-control.proxy`

Present when this contract sits behind an EIP-1967 proxy; enables the proxy watcher on it.

| field | type | required | default | description |
|---|---|---|---|---|
| `implementation` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `admin` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `beacon` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |

#### `holding.control_graph[]#type=access-control.expect`


| field | type | required | default | description |
|---|---|---|---|---|
| `roles` | list of object |  |  |  |

#### `holding.control_graph[]#type=access-control.expect.roles[]`


| field | type | required | default | description |
|---|---|---|---|---|
| `role` | bytes32 | yes |  | 32-byte hex value (market id, storage slot, role hash). |
| `name` | string |  |  |  |
| `holders` | list of address | yes |  |  |

#### `holding.control_graph[]#type=owned`


| field | type | required | default | description |
|---|---|---|---|---|
| `id` | string (`^[a-z0-9][a-z0-9-]*$`) | yes |  | Node id, unique within the holding. Referenced by pending_actions and <id.expect.field> references. |
| `address` | address | yes |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `label` | string |  |  |  |
| `proxy` | object |  |  | Present when this contract sits behind an EIP-1967 proxy; enables the proxy watcher on it. |
| `type` | `"owned"` | yes |  |  |
| `expect` | object |  |  |  |

#### `holding.control_graph[]#type=owned.proxy`

Present when this contract sits behind an EIP-1967 proxy; enables the proxy watcher on it.

| field | type | required | default | description |
|---|---|---|---|---|
| `implementation` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `admin` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `beacon` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |

#### `holding.control_graph[]#type=owned.expect`


| field | type | required | default | description |
|---|---|---|---|---|
| `owner` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `pending_owner` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |

#### `holding.control_graph[]#type=metamorpho`


| field | type | required | default | description |
|---|---|---|---|---|
| `id` | string (`^[a-z0-9][a-z0-9-]*$`) | yes |  | Node id, unique within the holding. Referenced by pending_actions and <id.expect.field> references. |
| `address` | address | yes |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `label` | string |  |  |  |
| `proxy` | object |  |  | Present when this contract sits behind an EIP-1967 proxy; enables the proxy watcher on it. |
| `type` | `"metamorpho"` | yes |  |  |
| `expect` | object | yes |  | Expected MetaMorpho roles and parameters. Any deviation is a control-plane condition. |

#### `holding.control_graph[]#type=metamorpho.proxy`

Present when this contract sits behind an EIP-1967 proxy; enables the proxy watcher on it.

| field | type | required | default | description |
|---|---|---|---|---|
| `implementation` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `admin` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `beacon` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |

#### `holding.control_graph[]#type=metamorpho.expect`

Expected MetaMorpho roles and parameters. Any deviation is a control-plane condition.

| field | type | required | default | description |
|---|---|---|---|---|
| `owner` | address | yes |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `curator` | address | yes |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `guardian` | address | yes |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `allocators` | list of address |  |  |  |
| `timelock_s` | integer | yes |  |  |
| `fee_bps_max` | integer |  |  |  |

#### `holding.control_graph[]#type=morpho-blue`


| field | type | required | default | description |
|---|---|---|---|---|
| `id` | string (`^[a-z0-9][a-z0-9-]*$`) | yes |  | Node id, unique within the holding. Referenced by pending_actions and <id.expect.field> references. |
| `address` | address | yes |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `label` | string |  |  |  |
| `proxy` | object |  |  | Present when this contract sits behind an EIP-1967 proxy; enables the proxy watcher on it. |
| `type` | `"morpho-blue"` | yes |  |  |
| `expect` | object |  |  |  |

#### `holding.control_graph[]#type=morpho-blue.proxy`

Present when this contract sits behind an EIP-1967 proxy; enables the proxy watcher on it.

| field | type | required | default | description |
|---|---|---|---|---|
| `implementation` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `admin` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `beacon` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |

#### `holding.control_graph[]#type=morpho-blue.expect`


| field | type | required | default | description |
|---|---|---|---|---|
| `owner` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `fee_recipient` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |

#### `holding.control_graph[]#type=public-allocator`


| field | type | required | default | description |
|---|---|---|---|---|
| `id` | string (`^[a-z0-9][a-z0-9-]*$`) | yes |  | Node id, unique within the holding. Referenced by pending_actions and <id.expect.field> references. |
| `address` | address | yes |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `label` | string |  |  |  |
| `proxy` | object |  |  | Present when this contract sits behind an EIP-1967 proxy; enables the proxy watcher on it. |
| `type` | `"public-allocator"` | yes |  |  |
| `expect` | object |  |  |  |

#### `holding.control_graph[]#type=public-allocator.proxy`

Present when this contract sits behind an EIP-1967 proxy; enables the proxy watcher on it.

| field | type | required | default | description |
|---|---|---|---|---|
| `implementation` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `admin` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `beacon` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |

#### `holding.control_graph[]#type=public-allocator.expect`


| field | type | required | default | description |
|---|---|---|---|---|
| `admin` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `fee` | string |  |  |  |

#### `holding.control_graph[]#type=stablecoin-issuer`


| field | type | required | default | description |
|---|---|---|---|---|
| `id` | string (`^[a-z0-9][a-z0-9-]*$`) | yes |  | Node id, unique within the holding. Referenced by pending_actions and <id.expect.field> references. |
| `address` | address | yes |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `label` | string |  |  |  |
| `proxy` | object |  |  | Present when this contract sits behind an EIP-1967 proxy; enables the proxy watcher on it. |
| `type` | `"stablecoin-issuer"` | yes |  |  |
| `expect` | object |  |  |  |

#### `holding.control_graph[]#type=stablecoin-issuer.proxy`

Present when this contract sits behind an EIP-1967 proxy; enables the proxy watcher on it.

| field | type | required | default | description |
|---|---|---|---|---|
| `implementation` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `admin` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `beacon` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |

#### `holding.control_graph[]#type=stablecoin-issuer.expect`


| field | type | required | default | description |
|---|---|---|---|---|
| `owner` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `pauser` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `blacklister` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `master_minter` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |

#### `holding.pending_actions[]`


| field | type | required | default | description |
|---|---|---|---|---|
| `source` | `timelock` \\| `morpho-vault` \\| `safe-tx-service` | yes |  |  |
| `node` | string | yes |  | Control-graph node id this queue can affect. |

#### `holding.pauses[]`


| field | type | required | default | description |
|---|---|---|---|---|
| `kind` | string | yes |  |  |
| `address` | address | yes |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |

#### `holding.markets`


| field | type | required | default | description |
|---|---|---|---|---|
| `allowlist_mode` | `pin` \\| `open` |  | `"pin"` |  |
| `pinned` | list of bytes32 |  |  | Filled by `sentinel config discover <holding>`. |
| `collateral_allowlist` | list of string |  | `[]` |  |

#### `holding.oracles`


| field | type | required | default | description |
|---|---|---|---|---|
| `per_market` | `auto` \\| `manual` |  | `"auto"` |  |
| `staleness_margin` | number |  | `1.25` |  |
| `divergence_bps` | object |  |  |  |
| `explicit` | list of object |  |  |  |

#### `holding.oracles.divergence_bps`


| field | type | required | default | description |
|---|---|---|---|---|
| `p1` | number | yes |  |  |
| `p0` | number | yes |  |  |

#### `holding.oracles.explicit[]`


| field | type | required | default | description |
|---|---|---|---|---|
| `role` | string | yes |  |  |
| `address` | address | yes |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `kind` | `morpho-chainlink-v2` \\| `chainlink` \\| `hardcoded` \\| `nav` | yes |  |  |
| `heartbeat_s` | integer |  |  |  |
| `feeds` | list of address |  |  |  |

#### `holding.peg`


| field | type | required | default | description |
|---|---|---|---|---|
| `pools` | list of object |  |  |  |
| `sizes` | list of string (`^\d+(\.\d+)?%$`) |  | `["25%","50%","100%"]` |  |
| `persistence_blocks` | integer |  | `15` |  |

#### `holding.peg.pools[]`


| field | type | required | default | description |
|---|---|---|---|---|
| `kind` | `curve-ng` \\| `uniswap-v3` \\| `uniswap-v4` | yes |  |  |
| `address` | address | yes |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `i` | string \\| integer |  |  |  |
| `j` | string \\| integer |  |  |  |
| `fee` | integer |  |  |  |

#### `holding.liquidity`


| field | type | required | default | description |
|---|---|---|---|---|
| `metamorpho` | object |  |  |  |
| `thresholds` | object |  |  |  |

#### `holding.liquidity.metamorpho`


| field | type | required | default | description |
|---|---|---|---|---|
| `compute` | string |  |  |  |
| `also` | string |  |  |  |

#### `holding.liquidity.thresholds`


| field | type | required | default | description |
|---|---|---|---|---|
| `ratio_p1` | number | yes |  |  |
| `ratio_p0` | number | yes |  |  |

#### `holding.flows`


| field | type | required | default | description |
|---|---|---|---|---|
| `windows` | list of string (`^\d+(s\\|m\\|h\\|d)$`) |  | `["1h","6h","24h","7d"]` |  |
| `top_n_holders` | integer |  | `10` |  |
| `big_exit_pct_of_tvl` | number |  |  |  |

#### `holding.thresholds.<key>`

Override of a default threshold (PLAN.md §6.2). Only the fields you set are overridden.

| field | type | required | default | description |
|---|---|---|---|---|
| `p0` | number |  |  |  |
| `p1` | number |  |  |  |
| `p2` | number |  |  |  |
| `direction` | `above` \\| `below` |  |  |  |
| `unit` | string |  |  |  |
| `persistence_blocks` | integer |  |  |  |
| `persistence_cycles` | integer |  |  |  |
| `resolve_factor` | number |  |  |  |
| `resolve_cycles` | integer |  |  |  |
| `cooldown_s` | integer |  |  |  |

### `config/shared/<name>.yaml` (control-graph node, referenced with `$ref`)

#### `shared-node#type=proxy`


| field | type | required | default | description |
|---|---|---|---|---|
| `address` | address | yes |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `label` | string |  |  |  |
| `proxy` | object |  |  | Present when this contract sits behind an EIP-1967 proxy; enables the proxy watcher on it. |
| `type` | `"proxy"` | yes |  |  |
| `expect` | object |  |  | Expected EIP-1967 slot values. Omitted fields are pinned to the first observed value (trust on first use) and alert on any later change. 0x0 means "slot must stay empty". |

#### `shared-node#type=proxy.proxy`

Present when this contract sits behind an EIP-1967 proxy; enables the proxy watcher on it.

| field | type | required | default | description |
|---|---|---|---|---|
| `implementation` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `admin` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `beacon` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |

#### `shared-node#type=proxy.expect`

Expected EIP-1967 slot values. Omitted fields are pinned to the first observed value (trust on first use) and alert on any later change. 0x0 means "slot must stay empty".

| field | type | required | default | description |
|---|---|---|---|---|
| `implementation` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `admin` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `beacon` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |

#### `shared-node#type=safe`


| field | type | required | default | description |
|---|---|---|---|---|
| `address` | address | yes |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `label` | string |  |  |  |
| `proxy` | object |  |  | Present when this contract sits behind an EIP-1967 proxy; enables the proxy watcher on it. |
| `type` | `"safe"` | yes |  |  |
| `expect` | object |  |  |  |

#### `shared-node#type=safe.proxy`

Present when this contract sits behind an EIP-1967 proxy; enables the proxy watcher on it.

| field | type | required | default | description |
|---|---|---|---|---|
| `implementation` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `admin` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `beacon` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |

#### `shared-node#type=safe.expect`


| field | type | required | default | description |
|---|---|---|---|---|
| `threshold_min` | integer |  |  |  |
| `owners_known` | boolean |  |  |  |
| `owners` | list of address |  |  |  |
| `modules` | list of address |  |  |  |
| `guard` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |

#### `shared-node#type=timelock`


| field | type | required | default | description |
|---|---|---|---|---|
| `address` | address | yes |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `label` | string |  |  |  |
| `proxy` | object |  |  | Present when this contract sits behind an EIP-1967 proxy; enables the proxy watcher on it. |
| `type` | `"timelock"` | yes |  |  |
| `expect` | object |  | `{}` |  |

#### `shared-node#type=timelock.proxy`

Present when this contract sits behind an EIP-1967 proxy; enables the proxy watcher on it.

| field | type | required | default | description |
|---|---|---|---|---|
| `implementation` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `admin` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `beacon` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |

#### `shared-node#type=timelock.expect`


| field | type | required | default | description |
|---|---|---|---|---|
| `min_delay_s` | integer |  |  |  |

#### `shared-node#type=access-control`


| field | type | required | default | description |
|---|---|---|---|---|
| `address` | address | yes |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `label` | string |  |  |  |
| `proxy` | object |  |  | Present when this contract sits behind an EIP-1967 proxy; enables the proxy watcher on it. |
| `type` | `"access-control"` | yes |  |  |
| `expect` | object |  |  |  |

#### `shared-node#type=access-control.proxy`

Present when this contract sits behind an EIP-1967 proxy; enables the proxy watcher on it.

| field | type | required | default | description |
|---|---|---|---|---|
| `implementation` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `admin` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `beacon` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |

#### `shared-node#type=access-control.expect`


| field | type | required | default | description |
|---|---|---|---|---|
| `roles` | list of object |  |  |  |

#### `shared-node#type=access-control.expect.roles[]`


| field | type | required | default | description |
|---|---|---|---|---|
| `role` | bytes32 | yes |  | 32-byte hex value (market id, storage slot, role hash). |
| `name` | string |  |  |  |
| `holders` | list of address | yes |  |  |

#### `shared-node#type=owned`


| field | type | required | default | description |
|---|---|---|---|---|
| `address` | address | yes |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `label` | string |  |  |  |
| `proxy` | object |  |  | Present when this contract sits behind an EIP-1967 proxy; enables the proxy watcher on it. |
| `type` | `"owned"` | yes |  |  |
| `expect` | object |  |  |  |

#### `shared-node#type=owned.proxy`

Present when this contract sits behind an EIP-1967 proxy; enables the proxy watcher on it.

| field | type | required | default | description |
|---|---|---|---|---|
| `implementation` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `admin` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `beacon` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |

#### `shared-node#type=owned.expect`


| field | type | required | default | description |
|---|---|---|---|---|
| `owner` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `pending_owner` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |

#### `shared-node#type=metamorpho`


| field | type | required | default | description |
|---|---|---|---|---|
| `address` | address | yes |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `label` | string |  |  |  |
| `proxy` | object |  |  | Present when this contract sits behind an EIP-1967 proxy; enables the proxy watcher on it. |
| `type` | `"metamorpho"` | yes |  |  |
| `expect` | object | yes |  | Expected MetaMorpho roles and parameters. Any deviation is a control-plane condition. |

#### `shared-node#type=metamorpho.proxy`

Present when this contract sits behind an EIP-1967 proxy; enables the proxy watcher on it.

| field | type | required | default | description |
|---|---|---|---|---|
| `implementation` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `admin` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `beacon` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |

#### `shared-node#type=metamorpho.expect`

Expected MetaMorpho roles and parameters. Any deviation is a control-plane condition.

| field | type | required | default | description |
|---|---|---|---|---|
| `owner` | address | yes |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `curator` | address | yes |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `guardian` | address | yes |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `allocators` | list of address |  |  |  |
| `timelock_s` | integer | yes |  |  |
| `fee_bps_max` | integer |  |  |  |

#### `shared-node#type=morpho-blue`


| field | type | required | default | description |
|---|---|---|---|---|
| `address` | address | yes |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `label` | string |  |  |  |
| `proxy` | object |  |  | Present when this contract sits behind an EIP-1967 proxy; enables the proxy watcher on it. |
| `type` | `"morpho-blue"` | yes |  |  |
| `expect` | object |  |  |  |

#### `shared-node#type=morpho-blue.proxy`

Present when this contract sits behind an EIP-1967 proxy; enables the proxy watcher on it.

| field | type | required | default | description |
|---|---|---|---|---|
| `implementation` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `admin` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `beacon` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |

#### `shared-node#type=morpho-blue.expect`


| field | type | required | default | description |
|---|---|---|---|---|
| `owner` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `fee_recipient` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |

#### `shared-node#type=public-allocator`


| field | type | required | default | description |
|---|---|---|---|---|
| `address` | address | yes |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `label` | string |  |  |  |
| `proxy` | object |  |  | Present when this contract sits behind an EIP-1967 proxy; enables the proxy watcher on it. |
| `type` | `"public-allocator"` | yes |  |  |
| `expect` | object |  |  |  |

#### `shared-node#type=public-allocator.proxy`

Present when this contract sits behind an EIP-1967 proxy; enables the proxy watcher on it.

| field | type | required | default | description |
|---|---|---|---|---|
| `implementation` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `admin` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `beacon` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |

#### `shared-node#type=public-allocator.expect`


| field | type | required | default | description |
|---|---|---|---|---|
| `admin` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `fee` | string |  |  |  |

#### `shared-node#type=stablecoin-issuer`


| field | type | required | default | description |
|---|---|---|---|---|
| `address` | address | yes |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `label` | string |  |  |  |
| `proxy` | object |  |  | Present when this contract sits behind an EIP-1967 proxy; enables the proxy watcher on it. |
| `type` | `"stablecoin-issuer"` | yes |  |  |
| `expect` | object |  |  |  |

#### `shared-node#type=stablecoin-issuer.proxy`

Present when this contract sits behind an EIP-1967 proxy; enables the proxy watcher on it.

| field | type | required | default | description |
|---|---|---|---|---|
| `implementation` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `admin` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `beacon` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |

#### `shared-node#type=stablecoin-issuer.expect`


| field | type | required | default | description |
|---|---|---|---|---|
| `owner` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `pauser` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `blacklister` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `master_minter` | address |  |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |

### `config/shared/chainlink-feeds.yaml`

#### `chainlink-feeds`


| field | type | required | default | description |
|---|---|---|---|---|
| `feeds` | map of object | yes |  |  |

#### `chainlink-feeds.feeds.<key>`


| field | type | required | default | description |
|---|---|---|---|---|
| `address` | address | yes |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `decimals` | integer | yes |  |  |
| `heartbeat_s` | integer | yes |  |  |
| `deviation_bps` | number |  |  |  |

### `config/shared/tokens.yaml`

#### `tokens`


| field | type | required | default | description |
|---|---|---|---|---|
| `tokens` | map of object | yes |  |  |

#### `tokens.tokens.<key>`


| field | type | required | default | description |
|---|---|---|---|---|
| `address` | address | yes |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `decimals` | integer | yes |  |  |

### `config/shared/curve-pools.yaml`, `uniswap-v3-pools.yaml`

#### `pool-registry`


| field | type | required | default | description |
|---|---|---|---|---|
| `pools` | map of object | yes |  |  |

#### `pool-registry.pools.<key>`


| field | type | required | default | description |
|---|---|---|---|---|
| `address` | address | yes |  | Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum. |
| `tokens` | list of string |  |  |  |
| `fee` | integer |  |  |  |

### Threshold keys and defaults

Overridable globally in `sentinel.yaml` and per holding under `thresholds:` (only the fields you set are overridden). Binary conditions have no numbers: the watcher decides the tier (PLAN.md §6.2).

| key | p0 | p1 | p2 | direction | unit | persistence blocks | persistence cycles | resolve factor | cooldown s |
|---|---|---|---|---|---|---|---|---|---|
| `proxy.impl_changed` |  |  |  |  |  |  |  |  | 0 |
| `proxy.diamond_cut` |  |  |  |  |  |  |  |  | 0 |
| `owner.changed` |  |  |  |  |  |  |  |  | 0 |
| `owner.pending` |  |  |  |  |  |  |  |  | 0 |
| `safe.owner_set` |  |  |  |  |  |  |  |  | 0 |
| `safe.module_guard` |  |  |  |  |  |  |  |  | 0 |
| `role.grant` |  |  |  |  |  |  |  |  | 0 |
| `role.revoke` |  |  |  |  |  |  |  |  | 0 |
| `mint.unexpected` |  | 1 |  | above | % of supply / 24h |  |  |  | 0 |
| `timelock.queued` |  |  |  |  |  |  |  |  | 0 |
| `timelock.delay` |  |  |  |  |  |  |  |  | 0 |
| `timelock.cancelled` |  |  |  |  |  |  |  |  | 0 |
| `morpho.pending_cap` | 20 |  |  | above | % of vault in the market |  |  |  | 0 |
| `morpho.pending_removal` | 20 |  |  | above | % of vault in the market |  |  |  | 0 |
| `morpho.pending_timelock` | 86400 |  |  | below | seconds (new timelock) |  |  |  | 0 |
| `morpho.guardian` |  |  |  |  |  |  |  |  | 0 |
| `morpho.fee` | 30 |  |  | above | % fee |  |  |  | 0 |
| `morpho.bad_debt` | 1 |  |  | above | % of vault assets |  |  |  | 0 |
| `morpho.v2_gate` |  |  |  |  |  |  |  |  | 0 |
| `safe.proposed_tx` |  |  |  |  |  |  |  |  | 0 |
| `pause.protocol` |  |  |  |  |  |  |  |  | 0 |
| `aave.frozen` |  |  |  |  |  |  |  |  | 0 |
| `aave.caps` |  | 1.1 |  | below | supply cap / current supply |  |  |  | 0 |
| `blacklist.hit` |  |  |  |  |  |  |  |  | 0 |
| `oracle.stale` | 2 | 1.25 |  | above | x heartbeat |  | 2 |  | 0 |
| `oracle.divergence` | 300 | 100 | 50 | above | bps | 15 |  | 0.5 | 600 |
| `oracle.hardcoded` |  |  |  |  |  |  |  |  | 0 |
| `oracle.source_changed` |  |  |  |  |  |  |  |  | 0 |
| `peg.exit_cost` | 200 | 50 | 20 | above | bps | 15 |  | 0.5 | 600 |
| `peg.imbalance` | 70 | 55 | 45 | above | % max coin share | 30 |  | 0.9 | 600 |
| `liquidity.ratio` | 1 | 2 | 5 | below | withdrawable / position | 10 |  | 1.5 | 600 |
| `liquidity.utilization` | 98 | 92 | 85 | above | % utilization | 10 |  | 0.95 | 600 |
| `curator.new_market` |  |  |  |  |  |  |  |  | 0 |
| `curator.concentration` | 50 | 20 | 10 | above | pts (p0: % of vault) |  |  |  | 0 |
| `curator.public_alloc` |  | 10 |  | above | % of vault moved |  |  |  | 0 |
| `flows.tvl` |  |  |  |  | % change over window (windows in holding.flows) |  |  |  | 0 |
| `flows.top_holder` | 15 | 5 |  | above | % of TVL in one tx |  |  |  | 0 |
| `rwa.nav_stale` | 3 | 1.5 |  | above | x heartbeat |  |  |  | 0 |
| `rwa.nav_jump` | 100 | 25 | 0 | above | bps per update |  |  |  | 0 |
| `rwa.allowlist` |  |  |  |  |  |  |  |  | 0 |
| `rwa.redemption` |  |  |  |  |  |  |  |  | 0 |
| `rwa.supply_vs_aum` |  | 2 | 0.5 | above | % divergence |  |  |  | 0 |
| `rwa.admin_action` |  |  |  |  |  |  |  |  | 0 |
| `rwa.shared_redeemer` | 1 | 2 | 5 | below | x position | 10 |  |  | 600 |
| `ops.rpc_lag` |  |  |  |  |  |  |  |  | 0 |
| `ops.chain_blind` |  |  |  |  |  |  |  |  | 0 |
| `ops.watcher_error` | 10 | 3 |  | above | p1: consecutive cycles; p0: minutes for P0-class watchers |  |  |  | 0 |
| `ops.heartbeat` |  |  |  |  |  |  |  |  | 0 |

