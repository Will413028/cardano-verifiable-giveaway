# Spike：本機 Dolos emulator 開發鏈（步驟 8b）

狀態：**完成**（2026-10-19）。第一輪停在停止條件：最新穩定版 Dolos 1.6.1 的 MiniBF 沒有 `/accounts/{stake}/transactions`（下文「停止條件與交給 Will 的選項」，保留為紀錄）。Will 2026-10-19 選 PD9 的 B（`/accounts/{stake}/addresses`＋逐址列舉）後續做：補測、介面卡替換與全部驗收見文末「PD9 拍板後：補測、實作與驗收」。

本檔只記事實與量測；拍板在計畫的決定段。標記：**實測**＝本機開發鏈上跑出來的；**讀碼**＝讀 Dolos 原始碼得到、未實跑；**推論**＝由前兩者推得。

## 環境與版本

- macOS arm64（Darwin 25.5.0）、Node v26.10.0、pnpm 11.2.2。
- Dolos **1.6.1**（GitHub release `v1.6.1`，2026-09-17，標為 Latest）：`dolos-aarch64-apple-darwin.tar.gz` sha256 `f792c63b…3d2a58`（與 release 附的 `.sha256` 相同），解出的執行檔 sha256 `6ce29e33…3c9053`；原始碼 `source.tar.gz` sha256 `1fd51645…bc51a`。以下「讀碼」都指這份原始碼。
- 對照用 Dolos **1.7.0-alpha.1**（pre-release，2026-08-24）：tarball sha256 `6912c4a4…ba9ff8`（與 `.sha256` 相同），執行檔 sha256 `8b8480f7…03cc31`。只為了給停止條件的選項提供數字，不是本步選用的版本。
- 執行檔、原始碼與資料目錄都在 repo 外：`/Users/will/second-brain/.projects/personal/cardano-verifiable-giveaway-wt/tools-dolos/`（以下 `$T`）。沒有下載任何 snapshot、沒有 Mithril、沒有連 preprod 或主網（設定裡沒有 peer，`upstream` 只有 `block_production_interval`）。

## 開發鏈設定（`tools/devchain/`）

- `dolos.toml`：`[upstream] block_production_interval = 1`（emulator 模式：沒有 `peer_address` 時 `UpstreamConfig` 反序列化成 `Emulator`，`crates/core/src/config.rs`）；`[serve.minibf] listen_address = "127.0.0.1:3010"`、`max_scan_items = 100000`；`[genesis] force_protocol = 9`（直接從 Conway 開始：emulator 只打包 Conway 交易，`src/sync/emulator.rs` 對非 Conway 交易回 `WorkerError::Panic`）；沒有 `sync.max_history`，archive 不修剪（full archive，`crates/core/src/lib.rs` 只在設定 `max_history` 時修剪 archive）；`chain.magic = 42`。
- genesis：`byron.json`、`alonzo.json`、`conway.json` 照抄 Dolos 1.6.1 的 `crates/cardano/src/include/devnet/`（preprod 的 genesis 去掉 initialFunds），`shelley.json` 同一來源，改三處：`networkMagic` 42（避免與 preprod 的 1 混淆）、`systemStart` `2022-06-20T00:00:00Z`、`initialFunds`。Biome 不格式化這四個檔（`biome.json` 排除 `tools/devchain/*.json`），保持與來源相同的 bytes。
- 時鐘：`force_protocol` 時 era 從 slot 0、時間＝Shelley `systemStart` 開始（讀碼，`crates/cardano/src/genesis/mod.rs` `bootstrap_eras`）；1655683200＋slot 與釘死的 preprod 時鐘（`PREPROD_SLOTS`：slot 86,400＝1655769600、每 slot 1 秒）相同。實測：block 1 的 `time` 1655683201、`/genesis` 的 `system_start` 1655683200。emulator 的 slot 從 `block_production_interval` 起、每塊加一個 interval（讀碼），所以 slot＝高度，時間落在 2022-06-20，早於任何 drand round；這讓測試承諾的 `invalid_hereafter`（preprod 時鐘換算）在 ledger 上仍是未來、又早於 round。
- 資金：Shelley genesis 的 `initialFunds` 有效（實測：genesis 後 `/addresses/{a}/utxos` 回 10,000,000 ADA 的 UTxO）。**但 1.6.1 花費 genesis 中 base 地址的 UTxO 會 panic**（實測：第一次設定把資金放在 base 地址，花費時 Dolos 以 exit code 101 結束，log 為 `panicked at crates/cardano/src/model/accounts.rs:364:38: existing account`，位置 point 138）：genesis 不會為 base 地址的 stake credential 建 account，`ControlledAmountDec::apply` 對不存在的 account `expect`。改成 genesis 只資助各 payment key 的 enterprise 地址（`60‖payment`），再以交易轉到 base 地址（`tools/devchain/devchain.mjs` 的 `fanOut`）。
- 測試金鑰：`tests/cardano.mjs` 的 `testKey(seed)`（secret＝32 個 seed byte）。organizer＝payment 1＋stake 2；organizerSecond＝payment 6＋stake 2；thirdParty＝payment 3＋stake 2（只有 payment 3 的 key）；other＝payment 4＋stake 5；enterprise＝payment 7。沒有個人錢包或助記詞。
- 送出：MiniBF `POST /tx/submit`（`Content-Type: application/cbor`，原始 bytes），1.6.1 送出前做 phase-1 驗證（讀碼，`crates/cardano/src/validate.rs`；實測：費用、餘額、簽章都要正確才回 200，回應本文是 tx hash 純文字）。交易由 `tests/cardano.mjs` 的 `buildTransaction` 組（本步加上 `inputs`、`outputs`、`fee` 參數，預設值不變），費用＝`min_fee_a`×簽章後大小＋`min_fee_b`＋2,000。

## 重現指令

```sh
T=/Users/will/second-brain/.projects/personal/cardano-verifiable-giveaway-wt/tools-dolos
REPO=<本 repo 的 checkout>
mkdir -p $T/download $T/bin && cd $T/download
gh release download v1.6.1 -R txpipe/dolos -p 'dolos-aarch64-apple-darwin.tar.gz*'
shasum -a 256 dolos-aarch64-apple-darwin.tar.gz && cat dolos-aarch64-apple-darwin.tar.gz.sha256
tar -xzf dolos-aarch64-apple-darwin.tar.gz -C $T/bin
mkdir -p $T/run && cp $REPO/tools/devchain/*.json $REPO/tools/devchain/dolos.toml $T/run/
cd $T/run && $T/bin/dolos-aarch64-apple-darwin/dolos daemon -c dolos.toml > dolos.log 2>&1 &
cd $REPO && pnpm install --frozen-lockfile && make build
node tools/devchain/spike.mjs $T/run/captures.json > $T/run/report.json
du -sh $T $T/run/data
```

對照版：同樣步驟換成 `v1.7.0-alpha.1`、`listen_address` 改 `127.0.0.1:3011`，以 `DEVCHAIN_URL=http://127.0.0.1:3011` 執行 `spike.mjs`。每次都用全新的資料目錄（測試金鑰與交易內容是決定性的，兩次執行的 tx hash 相同）。

原始輸出（入庫）：`dolos-1.6.1-report.json`、`dolos-1.6.1-captures.json`（`spike.mjs` 看到的每個 MiniBF 回應：狀態碼、標頭、本文），以及 1.7.0-alpha.1 的同名檔。下一個介面卡步驟的 mock 從 captures 抄，不自己編（`docs` 內的 tx hash、地址都只屬於開發鏈的測試金鑰）。

## 磁碟

| 項目 | 大小（`du -sh`，實測） |
|---|---|
| 1.6.1 執行檔目錄（解開後，含 README 等） | 49M |
| 1.6.1 下載的 tarball＋原始碼 tarball | 24M |
| 1.6.1 原始碼（解開） | 11M |
| 一次完整 `spike.mjs` 後的資料目錄（約 85 塊、549 筆交易） | 3.6M（1.6.1）、3.1M（1.7.0-alpha.1） |
| `$T` 全部（兩個版本、原始碼、5 個執行目錄） | 180M |

遠低於 5 GB 上限。

## 量測結果

每項先寫 1.6.1，括號內是 1.7.0-alpha.1。兩版都跑過兩輪（`run2`／`run-1.7.0-alpha.1` 用較早版本的 `spike.mjs`，最終的 `run3`／`run3-1.7.0-alpha.1` 用入庫版本），每一項的結論相同（只有「含多筆的區塊數」差 1，屬送出時機）；下表取 `run3`。

| 項目 | 結果 | 依據 |
|---|---|---|
| emulator 能送交易並打包 | 能。每塊最多 10 筆（`maxPerBlock` 10）；30 筆一起送時分散在連續幾塊 | 實測 |
| 依 stake 帳戶列舉 `/accounts/{stake}/transactions` | **1.6.1：HTTP 404、本文空字串（路由不存在）**。（1.7.0-alpha.1：200，列出 265 筆＝organizer 263 筆＋另兩個帶 stake 2 的地址各 1 筆 fan-out；列中多一個 `address` 欄位） | 實測；1.6.1 的 `crates/minibf/src/lib.rs` 沒有此路由、`docs/content/apis/minibf.mdx` 也沒列，v1.7.0-alpha.1、v2.0.0-alpha.0、main 的 `lib.rs` 有（讀碼，2026-10-19 經 GitHub API） |
| `/addresses/{stake_test…}/transactions` | 404 JSON「The requested component has not been found.」（兩版相同）：stake 地址當成完整地址比對，永遠對不到 base 地址的輸出 | 實測＋讀碼（`routes/addresses.rs` `address_matches`） |
| 依 payment credential 列舉 `/addresses/{addr_vkh…}/transactions` | 可用。enterprise 身分送出 263 筆（3 筆 fan-out＋260 筆），列出 263 筆，送出的全部都在 | 實測 |
| `order=asc` 重複查詢 | 同一高度（`to=<tip>`）以下列舉兩次，集合與順序相同（`sameOrder` true），0 筆重複；5 秒後（多 6 塊）再列舉，結果仍相同 | 實測 |
| 同一區塊多筆的次序 | 依 `block_height` 再依 `tx_index` 遞增（區塊內的位置）；26–27 個區塊各含多筆 | 實測；`find_txs` 以區塊內 index 產生（讀碼） |
| 跨頁重複或遺漏 | `count=100`（3 頁）與 `count=10`（27 頁）串起來的序列相同，0 重複、0 遺漏 | 實測 |
| `count` 上限 | `count=101` → 400 `{"error":"Bad Request","message":"querystring/count must be <= 100","status_code":400}` | 實測 |
| 超過 `max_scan_items` | `max_scan_items = 100000` 時 `page=1000&count=100`（剛好 100,000）回 200 `[]`；`page=1001` 回 **400** `{"error":"Bad Request","message":"pagination scan limit exceeded, reduce page number or count","status_code":400}`。判斷條件是 `page × count > max_scan_items`，與實際筆數無關；預設 3000 時 `count=100` 第 31 頁起就被拒 | 實測＋讀碼（`pagination.rs` `enforce_max_scan_limit`） |
| 頁超過結尾 | 200 `[]`（不是 404） | 實測 |
| 從未出現的身分 | `addr_vkh` 沒有任何交易時 404 JSON「component not found」（不是 `[]`） | 實測 |
| stake／payment 只出現在 input 的交易 | thirdParty（payment 3＋stake 2）把一個 UTxO 全部轉給 other、沒有找零：payment 3 的 `addr_vkh` 列舉有列出（兩版）。（1.7.0-alpha.1 的 stake 2 帳戶列舉也有列出）；1.6.1 沒有 stake 帳戶列舉可測 | 實測；`has_address` 會查 input 前一筆交易的輸出地址（讀碼），需要該筆前一筆交易在 archive 中 |
| 剛上鏈交易的 `/txs/{h}/cbor` | 每 20 ms 同時讀 `/txs/{h}`、`/cbor`、`/utxos`、`/metadata`，20 筆 × 兩版：四個端點一起由 404 變 200（送出後 741–1,053 ms），**從未出現「`/txs/{h}` 200 但 CBOR 404」**（`listedWithoutCbor` 0）。404 的本文是空字串、沒有 `Content-Type` | 實測；四個路由都從 `get_block_by_tx_hash` 取同一個區塊（讀碼，`routes/txs.rs`）。例外：genesis 的虛擬交易 `/txs/{h}` 由 `hacks::genesis_tx_content_for_hash` 回 200，`/cbor` 仍 404（讀碼，未實測） |
| 尚未產生的區塊 | `/blocks/{height}`（例如收錄高度＋14 還沒出塊時）回 **400** `{"status_code":400,"error":"Bad Request","message":"Missing, out of range or malformed block number."}`，不是 404 | 實測（`confirmation-block`、`unknown-block`） |
| 不存在的交易 | `/txs/{h}`、`/cbor`、`/utxos`、`/metadata` 都是 404、空本文 | 實測 |
| 沒有 metadata 的交易 | `/txs/{h}/metadata` 200 `[]` | 實測 |
| CORS | 所有回應（含 400、404、500）都有 `access-control-allow-origin: *`、`access-control-expose-headers: *`；`OPTIONS` 預檢回 200、`access-control-allow-methods: *` | 實測（`permissive_cors` 未設定＝預設 true） |
| 可查的儲存模式或最早區塊 | 沒有：`/` 只回 `{"url","version"}`，`/health` 只回 `is_healthy`，`/genesis` 是 genesis 參數，`/network/eras` 回 500（空本文）；`/blocks/1` 200、`/blocks/0` 404。最早可查區塊只能逐一試，儲存模式（是否 full archive）不對外 | 實測 |
| 列舉的請求數 | n＝263：`count=100` 3 次（＝⌈(n+1)/100⌉，最後一頁不滿 100 才知道結束）、`count=10` 27 次 | 實測（只量列舉；每筆 `/txs/{h}/metadata` 與讀承諾的請求要等介面卡實作後才量得到） |
| 1.6.1 以 `/accounts/{stake}/addresses`＋逐址列舉代替 stake 列舉 | 3 個地址、合併去重後 265 筆（與 1.7.0-alpha.1 的 stake 列舉筆數相同）、6 次請求 | 實測（只在開發鏈上；見選項 B 的代價） |

emulator 與真實網路的差異（推論）：emulator 不分叉、不 rollback，所以「rollback 後頁位移」量不到；區塊每秒一塊、slot＝高度；區塊 body hash 為零、`protocol_version` (1,0)。排序穩定性與 preprod 是否相同由步驟 8c 量（ADR Amendment 的觸發條件）。

## 對計畫前提的修正（事實，未改計畫的前提段）

- 計畫前提與 ADR `2026-10-19-self-hosted-dolos-indexer.md` 寫「有 `/accounts/{stake}/transactions`（stake credential）」：對穩定版 1.6.1 不成立；只有 pre-release（1.7.0-alpha.1、2.0.0-alpha.0）與 main 有。
- 「剛上鏈交易的 `/txs/{h}/cbor` 回 404 還是空值」：Dolos 上 `/txs/{h}` 與 `/cbor` 同時 404、同時 200，沒有「列出但沒有 CBOR」的狀態。
- 「Dolos 是否提供可查的儲存模式或最早區塊」：沒有。計畫延後項「偵測使用者節點的歷史不完整」的觸發條件未成立。
- 新的 HTTP 事實（介面卡要照著處理，不能自己編）：路由不存在是 404 空本文、未知身分是 404 JSON、頁超過結尾是 200 `[]`、超過掃描上限是 400、`count` 上限 100、未出的區塊是 400。

## 停止條件與交給 Will 的選項

停止條件（計畫步驟 8b）：「開發鏈上 Dolos 無法依 payment credential 或 stake 帳戶列舉……停下，PD3 身分子題與列舉方式交 Will」。1.6.1 無法依 stake 帳戶列舉（上表第 2 列），條件成立。payment credential 列舉可用；`max_scan_items` 調高後深頁可讀（第 1000 頁 200），第三條停止條件未觸發。

以下只列事實與代價，不替 Will 選：

- **A：用有 `/accounts/{stake}/transactions` 的 Dolos（目前只有 pre-release 1.7.0-alpha.1／2.0.0-alpha.0），或等它進穩定版。** 開發鏈上 1.7.0-alpha.1 的 stake 列舉完整（265 筆，含只在 input 出現 stake 的交易）、重複查詢與跨頁一致（實測）。代價：專案 Dolos 與文件要求使用者節點跑 pre-release；CLI 的使用者節點也要是有此路由的版本。介面卡、身分規則都不用改。
- **B：維持穩定版 1.6.1，stake 身分改成 `/accounts/{stake}/addresses` 列出地址、逐一 `/addresses/{a}/transactions` 後依（高度, index）合併去重。** 開發鏈上結果與 A 相同（265 筆、6 次請求）。地址列表來自「曾收到帶此 stake 的輸出」（讀碼，`by_stake_addresses` 掃 `blocks_by_stake_stream` 的輸出）；能從某地址花費，該地址必先收過輸出，所以理論上不漏（推論）。代價：請求數改成「地址數 × 每址頁數」，而任何人都能造出帶主辦者 stake 部分的新地址（CIP-19）並各送一筆，讓每次驗證多出任意多次請求（放大驗證成本的濫用面，推論）；列舉方式變更屬計畫停止條件要交 Will 的「列舉方式」。
- **C：身分改用 payment credential（PD3 身分子題的 B）。** `addr_vkh` 列舉在 1.6.1 可用且穩定（實測）。代價即 PD3 當初的取捨：同一 HD 錢包換收款地址就是不同身分，可繞過唯一性。

## 第一輪停止時未做的事（2026-10-19，已由 PD9 拍板後的續做完成）

介面卡替換（`KoiosChain` → Blockfrost 形狀）、`packages/verifier` 移除預設 indexer、CLI `--indexer` 必填、網頁讀取與送出改 Blockfrost 形狀、驗證頁可填 indexer、mock 改寫、`docs/protocol-development.md` 更新、步驟 8b 的全部驗收與 4 個 mutation。「依實測決定」的兩項只留下資料：

- `NotIndexedError` 與 `CborPendingError` 的對應：Dolos 上 `/txs/{h}/cbor` 404 時 `/txs/{h}` 也是 404（40 次取樣＋讀碼），對 Dolos 等於「沒有這筆交易」；`CborPendingError` 只在其他 Blockfrost 相容節點出現「`/txs/{h}` 200 而 `/cbor` 404」時才會發生（推論）。
- 新的列舉上限：Blockfrost 形狀的上限由節點的 `max_scan_items` 決定（`page × count`，`count` ≤ 100）；預設 3000 的節點在第 31 頁回 400。上限要等身分與列舉方式定案後再訂。

## PD9 拍板後：補測、實作與驗收（2026-10-19）

全部在 Dolos 1.6.1 開發鏈上（每輪全新資料目錄，`tools/devchain/dolos.toml` 不變），只用測試金鑰。標記同上：實測／讀碼／推論。

### Koios 介面卡做過的檢查與新介面卡的對應

| 檢查 | Koios（`KoiosChain`，至 `e9040f2`） | Blockfrost 形狀（`BlockfrostChain`） |
|---|---|---|
| indexer 網址 | 只准 https、不帶帳密 | https，或本機（127.0.0.1、localhost、[::1]）的 http；不帶帳密、query、fragment（`indexerUrl`）。CLI 使用者的 Dolos 多半跑在本機 |
| 非 2xx | 丟 `HTTP <status>` | 丟 `IndexerError`：狀態決定失敗，本文只挑訊息（404 空本文＝「未知項目或節點缺此端點」、JSON 的 `message`、400 掃描上限加註 `max_scan_items` 太低） |
| 回應形狀 | 不是陣列就丟 | 不是 JSON 就丟；列表必須是陣列且不超過 100 列 |
| 承諾參照 | txHash 64 hex、owner `addr_test1…` | 同 |
| 交易不存在 | `tx_cbor` 沒有該列 → `NotIndexedError` | `/txs/{h}` 404 → `NotIndexedError` |
| 列出但沒有 CBOR | `cbor: null` → `CborPendingError` | `/txs/{h}` 200 而 `/txs/{h}/cbor` 404 → `CborPendingError`（Dolos 上沒出現過，見下） |
| CBOR 自驗、`is_valid`、身分 witness、`invalid_hereafter` | `readCommitmentTransaction` | 不變 |
| 主辦者是 input | `tx_info`（`_inputs: true`）的 `payment_addr.bech32` | `/txs/{h}/utxos` 的 `inputs[].address`，排除 `collateral`、`reference`（Koios `tx_info` 的 `inputs` 不含這兩種，推論自其 schema） |
| 收錄區塊與時間 | `tx_cbor` 列的 `block_height`、`tx_timestamp`，安全整數 | `/txs/{h}` 的 `block_height`、`block_time`，安全整數，且 `hash` 等於 txHash |
| 確認 | `blocks?block_height=eq.<h+14>`，沒有就「Waiting」 | `/blocks/latest` 的 `height` < h+14 就「Waiting」（不靠 400 判斷；Dolos 對未出的區塊回 400）；否則讀 `/blocks/<h+14>`，`height` 必須相等、`time` 是安全整數 |
| 列舉端點 | stake：`account_txs`；payment：`credential_txs` | stake：`/accounts/{stake}/addresses` 分頁，再逐址 `/addresses/{a}/transactions`；payment：`/addresses/{addr_vkh}/transactions`（PD9） |
| 排序 | `order=block_height.asc,tx_hash.asc` | `order=asc`（節點依高度、區塊內位置）；合併後在客戶端依（高度, `tx_index`）排序 |
| 列表結束 | 一頁少於 1,000 列 | 一頁少於 100 列（含 `[]`）；其他任何回應（400、404、5xx）整個唯一性判 FAIL |
| 上限 | 滿頁後 offset＋1,000 ≥ 5,000 就丟 | 兩段列數總和 Σ > L＝2,900 就丟；地址數 > L 時不查任何地址就丟 |
| 列的驗證 | `tx_hash` 64 hex | `tx_hash` 64 hex，`block_height`、`block_time`、`tx_index` 安全整數；同一 tx_hash 在不同地址的列高度或位置不同就丟 |
| 挑選 label | `tx_metadata` 每批 50 個 hash（公開層 5 KiB 限制），`metadata[LABEL].protocol` | 每筆 `/txs/{h}/metadata`（Blockfrost 形狀沒有批次），`label === "20261018"` 且 `json_metadata.protocol` 相符；非 2xx 就丟 |
| label 相符者的 CBOR | `tx_cbor` 批次，缺列或 `cbor: null` 就丟「evidence is incomplete」 | `/txs/{h}/cbor`，404 或不是字串就丟同一訊息 |
| 計入條件 | 有效、身分 key 驗章、metadata 或 malformed | 不變 |
| 歷史中的收錄區塊與時間 | `tx_cbor` 列 | 列舉列的 `block_height`、`block_time` |

網頁與後端：Evolution 的 Koios provider 換成 `BlockfrostProvider`（無 key；`/epochs/latest/parameters`、`/txs/{h}/utxos`）；送出由 Koios `submittx` 換成 `POST /tx/submit`（Dolos 回純文字 hash，Blockfrost 回 JSON 字串，兩者都接受且必須等於本機算出的 hash；錢包 `submitTx` 仍是步驟 9）；後端 `/tip` 的上游改成 `INDEXER_URL` 的 `/blocks/latest`，原樣轉發；網頁讀鏈的位址由建置設定 `GIVEAWAY_INDEXER_URL`（預設本機開發鏈 `http://127.0.0.1:3010`）決定，驗證頁可填使用者自己的 indexer。

### 補測（`node tools/devchain/pd9.mjs`，原始輸出 `dolos-1.6.1-pd9-report.json`）

| 項目 | 結果 | 依據 |
|---|---|---|
| 已花光的地址仍在 `/accounts/{stake}/addresses` | 是。payment 8＋stake 2 的地址收 10 ADA 後整筆轉走，`/addresses/{a}/utxos` 回 200 `[]`，帳戶地址列表仍列出它，`/addresses/{a}/transactions` 列出收與花兩筆 | 實測 |
| 一筆交易輸出到 3 個帶同一 stake 的地址 | 該 tx 在 3 個地址的列表各出現一次（列數 3），合併去重後 1 筆 | 實測 |
| 帳戶地址列表的分頁與排序 | 500 個地址：`count=100` 兩次與 `count=10`（51 次請求）串起來順序相同、0 重複；不是字典序 | 實測 |
| PD10：灌列數的成本 | 一筆最大交易：248 個輸出（各 1 ADA，給「攻擊者 payment＋主辦者 stake」的不同地址）、16,322 bytes、手續費 875,549／875,593 lovelace；每筆讓 Σ 列數 +248、地址數 +248（兩筆 5→501 列、4→500 個地址）。開發鏈參數 `min_fee_a` 44、`min_fee_b` 155,381、`max_tx_size` 16,384、`coins_per_utxo_size` 4,310，與 `e9040f2` 的 `tests/epoch-params.json`（preprod epoch 316）相同 | 實測 |
| PD10：推到 L＝2,900 以上 | ⌈2,901／248⌉＝12 筆、手續費約 10.5 ADA；輸出共約 2,976 ADA 仍屬攻擊者（持有 payment key 可收回，收回本身又要手續費、又加列數）。上限 100,000 時約 404 筆、約 354 ADA 手續費 | 推論（由上一列的實測值計算） |
| 灌列數同時灌請求數 | 500 個地址的身分列舉 506 次請求 | 實測 |

停止條件逐條：已花光地址有列出、重複查詢排序穩定（下方驗收）、`max_scan_items` 調高後深頁可讀（第一輪），三條都未觸發。

### 依實測決定的兩項

- `NotIndexedError`／`CborPendingError`：第一輪 20 筆×2 版取樣，`/txs/{h}`、`/cbor`、`/utxos`、`/metadata` 一起由 404 變 200，從未出現「列出但沒有 CBOR」（實測）。所以 `/txs/{h}` 404 對應 `NotIndexedError`（網頁在過了 `invalid_hereafter` 後才據此說逾期）；`/txs/{h}` 200 而 `/cbor` 404 仍對應 `CborPendingError`，留給其他 Blockfrost 相容節點，兩個錯誤的語意不變（計畫「不能動」）。列舉中 label 相符的交易 `/cbor` 404 一律是「歷史證據不完整」、判 FAIL，不當成不在歷史內。
- 上限 L＝2,900（`HISTORY_ROW_LIMIT`，寫進 `docs/protocol-development.md`）：Dolos 以 page × count > `max_scan_items`（預設 3,000）拒絕；列表要讀到第一個不滿 100 列的頁才算結束，r 列需要第 ⌊r/100⌋＋1 頁；2,900 是讓這一頁（第 30 頁）仍在預設值內的最大 100 倍數，所以使用者的 Dolos 保持預設就能讀完所有會被接受的歷史（測試以 mock 的 `maxScan` 3,000 跑 2,900 列與 2,901 列兩側）。請求數在 L 時約 2,940 次（推論，見下）。比 Koios 時期的 5,000 低；PD10 未決，上限高低不改變「第三方能便宜灌爆」的結論，只改變成本倍數。

### 驗收（`node tools/devchain/acceptance.mjs <out>`，原始輸出 `dolos-1.6.1-acceptance-report.json`、`dolos-1.6.1-adapter-captures.json`）

| 項目 | 結果 |
|---|---|
| 同一身分在同一高度以下列舉兩次 | 帳戶 2 個地址、265 列、去重 265 筆，等於送出的 265 筆（3 筆 fan-out、1 筆給第二地址的 fan-out、260 筆自轉、1 筆承諾），0 漏、0 多；兩次集合與順序相同；27 個區塊含多筆（實測） |
| CLI `--indexer http://127.0.0.1:3010` | PASS、exit 0，7 項全 pass（實測） |
| 竄改 bundle（加一個 entrant 並重算得獎者） | FAIL、exit 1，`Commitment hash: fail`（實測） |
| 不給 `--indexer` | exit 2，stderr 列出節點要求（含 full archive）（實測） |
| 同一 stake 的第二個 payment 地址再送一筆重疊承諾後重驗 | FAIL、exit 1，衝突列出該筆 `f50883ea…`（衝突只在第二個地址：PD9 合併在真節點上看得到）（實測） |
| enterprise 身分（`addr_vkh` 列舉） | PASS、exit 0、9 次請求（實測） |
| 花費 genesis UTxO 的交易 | `/txs/{h}/utxos` 的該 input `address` 是空字串（實測）；從 genesis UTxO 直接送的承諾會被判「主辦者不是 input」。只影響開發鏈，preprod 的 genesis UTxO 早已花掉；腳本改由一般交易的輸出送承諾 |

一次完整驗證的請求數（實測，`BlockfrostChain` 注入計數的 fetch）：

- stake 身分 n＝265（2 個地址、265 列）：276 次＝讀承諾 5（`/txs/{h}`、`/cbor`、`/utxos`、`/blocks/latest`、`/blocks/{h+14}`）＋地址列表 1 頁＋逐址 4 頁（264 列 3 頁、1 列 1 頁）＋metadata 265＋label 相符者的 CBOR 1。重跑一次同樣 276。本機 365 ms（只代表 localhost，不代表網路延遲）。
- payment 身分 n＝2：9 次＝5＋1 頁＋2＋1。
- 一般式：5＋⌈(A＋1)/100⌉（只有 stake）＋Σ_a ⌈(r_a＋1)/100⌉＋n＋k（A 地址數、r_a 各地址列數、k label 相符筆數）（由上兩點與程式推得）。以步驟 5 的 preprod 數字代入（推論，實測留給 8c）：payment 1,171 筆約 5＋12＋1,171＋k ≈ 1,188＋k 次；stake 169 筆、地址數未知，約 180＋k 次；L＝2,900 時約 2,940 次。供 PD8。

真節點上的網頁（`node tools/devchain/browser-live.mjs <out>`，只 mock CIP-30 錢包，原始輸出 `dolos-1.6.1-browser-live-report.json`；Chrome 155.0.8059.82）：驗證頁對開發鏈讀 enterprise 承諾 PASS、對 organizer 承諾 FAIL 並列出重疊承諾，請求只到頁面本身與 `127.0.0.1:3010`（真 CORS）；建立頁以開發鏈上真的 UTxO 讓 Evolution `BlockfrostProvider` 讀 `/epochs/latest/parameters` 與 `/txs/{h}/utxos` 組出交易（估計手續費 0.186665 test ADA）、經 `/tx/submit` 送出、輪詢到「Fifteen confirmations verified」；經 `make api` 的 `/tip` 顯示開發鏈 tip（實測）。

### 重現

```sh
# 開發鏈（每輪全新資料目錄）同「重現指令」；之後：
make build
node tools/devchain/pd9.mjs > pd9-report.json          # 補測；與 acceptance 分開各用一條全新鏈
node tools/devchain/acceptance.mjs <out>                # 驗收、請求數、captures
make dev & make api &                                   # 頁面 4320、後端 8787
GIVEAWAY_PLAYWRIGHT_MODULE=… GIVEAWAY_CHROME_PATH=… node tools/devchain/browser-live.mjs <out>
```

未量到：rollback 後的頁位移（emulator 不 rollback）；preprod 規模的請求數與時間（步驟 8c）。
