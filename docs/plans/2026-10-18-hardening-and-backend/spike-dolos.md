# Spike：本機 Dolos emulator 開發鏈（步驟 8b）

狀態：**停在停止條件**（2026-10-19）。最新穩定版 Dolos 1.6.1 的 MiniBF 沒有 `/accounts/{stake}/transactions`，開發鏈上無法依 stake 帳戶列舉交易；步驟 8b 停止條件第一條成立，介面卡替換與其後的驗收都沒做，PD3 身分子題與列舉方式交 Will（選項與數字見文末）。payment credential（`addr_vkh`）列舉可用且排序穩定。

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

## 本步未做的事（因停止）

介面卡替換（`KoiosChain` → Blockfrost 形狀）、`packages/verifier` 移除預設 indexer、CLI `--indexer` 必填、網頁讀取與送出改 Blockfrost 形狀、驗證頁可填 indexer、mock 改寫、`docs/protocol-development.md` 更新、步驟 8b 的全部驗收與 4 個 mutation。「依實測決定」的兩項只留下資料：

- `NotIndexedError` 與 `CborPendingError` 的對應：Dolos 上 `/txs/{h}/cbor` 404 時 `/txs/{h}` 也是 404（40 次取樣＋讀碼），對 Dolos 等於「沒有這筆交易」；`CborPendingError` 只在其他 Blockfrost 相容節點出現「`/txs/{h}` 200 而 `/cbor` 404」時才會發生（推論）。
- 新的列舉上限：Blockfrost 形狀的上限由節點的 `max_scan_items` 決定（`page × count`，`count` ≤ 100）；預設 3000 的節點在第 31 頁回 400。上限要等身分與列舉方式定案後再訂。
