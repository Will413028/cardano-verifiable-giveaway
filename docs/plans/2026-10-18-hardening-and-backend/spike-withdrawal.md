# Spike：承諾附 reward withdrawal（步驟 9b，PD10 W）

狀態：**spike 完成**（2026-10-19）。三項都有原始輸出；步驟 9b 的三條停止條件都**未觸發**（逐條見文末）。協定變更（`checkCommitmentTransaction`、列舉、enterprise 身分）未動，等步驟 9 合併後做。

範圍依計畫步驟 9b「spike（先做……）」(1)–(3)。本檔只記事實與量測；拍板在計畫的決定段。標記：**實測**＝本機跑出來的；**讀碼**＝讀原始碼得到、未實跑；**推論**＝由前兩者推得。

## 一句話結論

- 真 ledger（cardano-node 11.0.1，協定版本 10.0）上：主辦者註冊 stake 並委託 always-abstain 後，附 0 ADA withdrawal＋stake key witness 的承諾形交易被接受；第三方對主辦者 stake 的 withdrawal，不帶 witness、只列 `required_signers`、或附偽造簽章，三種都被拒（`MissingVKeyWitnessesUTXOW`／`InvalidWitnessesUTXOW`）；已註冊但未委託 DRep 時被拒（`ConwayWdrlNotDelegatedToDRep`）；reward 餘額 169,575,972 lovelace 時，0、餘額−1、餘額＋1 都被拒（`WithdrawalsNotInRewardsCERTS`），全額被接受（實測）。
- 註冊、DRep 委託與 withdrawal **不能放在同一筆交易**：ledger 以交易前的狀態檢查 withdrawal，同一筆拒絕並回兩個錯誤（實測）。第一次承諾前要先有一筆設定交易。
- Dolos 1.6.1 的 `/accounts/{stake}/withdrawals` 列出 0 ADA 與非 0 的 withdrawal；`order=asc` 重複查詢、跨頁順序穩定；同一區塊依區塊內位置；回應沒有 `tx_index`；Dolos 實際接受 `from`／`to`（實測）。
- Evolution SDK 0.6.0 組得出、mock CIP-30 簽得出「承諾＋0 ADA withdrawal」與「註冊＋DRep 委託」兩種交易，真 ledger 都接受；目前的 `checkCommitmentTransaction` 拒收（`unexpected body field 5`），這是 9b 要改的地方（實測）。

## 環境與版本

- macOS arm64（Darwin 25.5.0）、Node v26.10.0、pnpm 11.2.2、Docker Desktop 29.1.3。
- Dolos **1.6.1**：沿用步驟 8b 的執行檔與原始碼（`spike-dolos.md`「環境與版本」，sha256 同），`tools/devchain/dolos.toml` 只把 `listen_address` 改成 `127.0.0.1:3030`（避開另一個 worktree 用的 3010）。執行目錄 `tools-dolos/run-9b-1`（第一輪）、`run-9b-2`（入庫的那一輪），都是全新資料目錄。
- pallas-validate **1.3.0**（Dolos 1.6.1 的 `Cargo.toml` 釘的 pallas 版本）：crates.io 的 `pallas-validate-1.3.0.crate`，sha256 `d3a8b152…5d418a`，解在 `tools-dolos/run-9b-pallas-src/`，只用來讀碼。
- Yaci DevKit **0.12.0**（GitHub release `v0.12.0`，2026-10-14，revision `092380cb`）：`yaci-devkit-0.12.0.zip` sha256 `28851e1a…261f03`，解在 `tools-yaci/devkit-0.12.0/`（只取 compose 與設定）。映像 `bloxbean/yaci-cli:0.12.0@sha256:da194782…e2e38d`（arm64，image ID `34b32fa4eba8`）。容器內：**cardano-node 11.0.1**（git rev `97036a66`）、cardano-cli 11.0.0.0、cardano-submit-api；Yaci Store（同映像內建，`yaci-store.git.properties` commit `4bca8bf`）。
- Yaci 設定（`tools/devchain/yaci/`）：`compose.yml` 由 release 的 `scripts/docker-compose.yml` 改來（只留 yaci-cli、映像釘 digest、host port 改成 127.0.0.1 的 18090／18080／20000、名稱 `cvg-9b`）；`node.properties` 與 release 的差別只有一行 `protocolMajorVer=10`；`env` 是 release `config/env` 去掉 port 與 viewer 設定。啟動參數 `up --enable-yaci-store -e 100`（每 epoch 100 slot，slot 1 秒）。`nodeMode=companion`：Yano（Java）先 bootstrap，再由 Haskell cardano-node 接手當唯一的出塊節點；交易經 cardano-submit-api 送進 Haskell 節點，所以以下 ledger 結果都是 Haskell ledger 給的（實測：啟動 log「Haskell node restarted as block producer」、「Yano stopped」）。
- 協定版本：`cardano-cli conway query protocol-parameters` 的 `protocolVersion` **10.0**、`stakeAddressDeposit` 2,000,000、`txFeePerByte` 44、`txFeeFixed` 155,381（實測，`yaci-0.12.0-withdrawal-report.json` 的 `protocolVersion`）。
- 測試金鑰：`tests/cardano.mjs` 的 `testKey(seed)`。organizer＝payment 1＋stake 2（與步驟 8b 同）；third party＝payment 3 的 enterprise 地址；noDrep＝payment 4＋stake 5；sameTx＝payment 6＋stake 7；Evolution 用 payment 10＋stake 11。沒有個人錢包或助記詞；Yaci 的預設助記詞沒用到，資金來自 devnet 的 topup API。
- 沒有連任何公開網路或託管 indexer；Dolos 沒有 peer，Yaci devnet 是單機。

## (1) Dolos 1.6.1 emulator：`/accounts/{stake}/withdrawals` 的索引行為

腳本 `tools/devchain/withdrawal-spike.mjs`（交易由 `tools/devchain/withdrawal-tx.mjs` 組），原始輸出 `dolos-1.6.1-withdrawal-report.json`、`dolos-1.6.1-withdrawal-captures.json`（每個 MiniBF 回應）、`dolos-1.6.1-withdrawal-panic.log`。這一節只談索引；emulator 的 mempool 不跑 ledger 的 withdrawal、憑證與 DRep 規則（見下表「mempool」列），不能拿來推論真 ledger。

| 項目 | 結果 | 依據 |
|---|---|---|
| 0 ADA withdrawal 有列出 | 是。承諾形交易（2 ADA 給自己、找零、label metadata、stake key 為唯一 `required_signers`、`invalid_hereafter`、withdrawal `{stake 2: 0}`）在 `block_height` 11 收錄，列中 `amount` `"0"`；另 30 筆同形交易全部列出 | 實測 |
| 非 0 withdrawal 有列出 | 是。1 ADA 的 withdrawal 列為 `amount` `"1000000"`（`block_height` 12）。只能用「pallas 的平衡式」送進去，見下兩列 | 實測 |
| 回應欄位 | `tx_hash`、`amount`（字串）、`tx_slot`、`block_time`、`block_height`。**沒有 `tx_index`**（與計畫 PD10 讀到的 Blockfrost spec 相同） | 實測 |
| `order=asc` 重複查詢 | 同樣條件查兩次，順序相同（`sameOrderRepeatedAsc100` true） | 實測 |
| 分頁 | 33 列：`count=100` 1 次請求；`count=10` 4 次（最後一頁 3 列），串起來與 `count=100` 順序相同、0 重複、0 遺漏、0 多出 | 實測 |
| 不帶 `order` | 等於 `asc` | 實測；`Order` 預設 `Asc`（讀碼，`crates/minibf/src/pagination.rs`） |
| `order=desc` | 正好是 asc 的反序 | 實測 |
| 同一區塊多筆 | 3 個區塊各有多列，asc 下依區塊內位置（`/txs/{h}` 的 `index`）遞增 | 實測；`find_withdrawals_in_block` 依 `block.txs()` 的順序產生、desc 時反轉（讀碼，`routes/accounts.rs:383-414`） |
| `from`／`to` | **Dolos 接受**（Blockfrost spec 此端點沒有）：`from=15` 只回高度 ≥15、`to=15` 只回 ≤15、`from=15&to=15` 只回高度 15 的 10 列、`from=15:1` 跳過該區塊 index 0（19 列）；`from=16&to=15` 與 `from=abc` 回 400 `Invalid (malformed or out of range) from/to parameter(s).` | 實測；`PaginationParameters` 對所有路由解析 `from`／`to`（`height[:index]`），handler 以 `start_and_end_slots` 與 `should_skip` 套用（讀碼） |
| `count` 上限、頁超過結尾、錯的 `order` | `count=101` → 400 `querystring/count must be <= 100`；`page=50` → 200 `[]`；`order=up` → 400 `querystring/order must be equal to one of the allowed values` | 實測 |
| 掃描上限 | handler 開頭 `enforce_max_scan_limit`，與其他列表端點同（page × count > `max_scan_items` 回 400） | 讀碼（`routes/accounts.rs:806-858`）；本輪 `max_scan_items` 100000、未打到 |
| 未知 stake | stake 從未出現在任何輸出：404 `{"status_code":404,"error":"Not Found","message":"The requested component has not been found."}`；同一 stake 出現在輸出後（未註冊、未提領）：200 `[]`；格式錯的 stake 位址：400 空本文 | 實測；handler 先查 `AccountState` 實體是否存在（讀碼） |
| `/accounts/{stake}` | 註冊後 `registered` true、`drep_id` `drep_always_abstain`；0 ADA、1 ADA、0 ADA 三筆 withdrawal 之後 `withdrawals_sum` `"1000000"` | 實測 |
| `/txs/{h}/withdrawals` | `[{"address":"stake_test1uqqgk3…","amount":"0"}]` | 實測 |
| mempool：value preservation | 依 ledger 平衡（存入押金、withdrawal 算進 consumed）的註冊交易與 1 ADA withdrawal 交易都回 **400 空本文**；同樣內容改成「inputs = outputs + fee」（不計押金與 withdrawal）就回 200 並收錄 | 實測；pallas-validate 1.3.0 `phase1/conway.rs` `check_preservation_of_value` 只比 inputs 與 outputs＋fee（讀碼）；Dolos 的錯誤原因不回給呼叫端（`routes/tx/submit/mod.rs` 只回狀態碼，讀碼） |
| mempool：withdrawal witness、註冊、DRep | 第三方（只有 payment 3 的 witness）對主辦者 stake 的 0 ADA withdrawal：200、收錄、**出現在主辦者的列表中**；未註冊 stake 5 的 0 ADA withdrawal：200、收錄、列出 | 實測；Dolos 以空的 `CertState` 呼叫 phase-1（`crates/cardano/src/validate.rs`，讀碼）。只代表 emulator，真 ledger 見 (2) |
| 從未出現的 stake 的 withdrawal | 送出 200，之後 Dolos **panic 結束**：`panicked at crates/cardano/src/model/accounts.rs:662:38: existing account`（兩輪都一樣），之後連線被拒 | 實測（`dolos-1.6.1-withdrawal-panic.log`）；`WithdrawalInc::apply` 對不存在的帳戶 `expect`（讀碼） |

推論（未實測）：真網路上的 Dolos 不會走到上一列的 panic——ledger 只接受已註冊 stake 的 withdrawal（(2) 實測），而註冊憑證會建立帳戶實體；emulator 會走到，是因為它的 mempool 不檢查註冊。開發鏈上灌 withdrawal 列時，送出的每個 stake 都要先在某個輸出出現過。

## (2) 真 ledger：Yaci DevKit 0.12.0（cardano-node 11.0.1，協定版本 10.0）

腳本 `tools/devchain/withdrawal-yaci.mjs`，原始輸出 `yaci-0.12.0-withdrawal-report.json`（每筆送出的狀態碼與 cardano-submit-api 回的完整 ledger 錯誤、`stake-address-info`、Yaci Store 回應）。成功＝submit-api 回 202 且交易的輸出出現在節點的 UTxO（`included` true）。錯誤字串以下照抄（key hash `008b4784…079079` 是 stake 2）。

| 劇本 | 結果 | 依據 |
|---|---|---|
| 主辦者 stake 未註冊，承諾形交易附 0 ADA withdrawal＋stake witness | 拒：`ConwayWdrlNotDelegatedToDRep (KeyHash … "008b4784…")`＋`ConwayCertsFailure (WithdrawalsNotInRewardsCERTS (… Coin 0))` | 實測 |
| 同一筆交易內：註冊（`reg_cert` 7）＋DRep 委託（`vote_deleg_cert` 9，always-abstain）＋0 ADA withdrawal（stake 7） | 拒，錯誤與上一列相同（`ConwayWdrlNotDelegatedToDRep`＋`WithdrawalsNotInRewardsCERTS`）；之後 stake 7 的 `stake-address-info` 是 `[]`（整筆無效、沒註冊） | 實測 |
| 主辦者註冊（押金 2 ADA）＋`stake_vote_deleg_cert`（10：pool＋always-abstain），payment＋stake witness | 接受。之後 `stake-address-info`：`stakeRegistrationDeposit` 2000000、`voteDelegation` `alwaysAbstain`、`rewardAccountBalance` 0 | 實測 |
| 主辦者承諾形交易（2 ADA 給自己、找零、label metadata、stake key 為唯一 `required_signers`、`invalid_hereafter`）＋0 ADA withdrawal＋payment 與 stake witness | **接受**（tx `836ef896…`，`block_number` 71） | 實測 |
| 第三方（payment 3 的 input 與 witness）對主辦者 stake 送 0 ADA withdrawal，不帶 stake witness | **拒**：`ConwayUtxowFailure (MissingVKeyWitnessesUTXOW (NonEmptySet (fromList [KeyHash {unKeyHash = "008b4784…"}])))`，只有這一個錯誤 | 實測 |
| 同上，另把主辦者 stake key 放進 `required_signers` | 拒，同一個 `MissingVKeyWitnessesUTXOW` | 實測 |
| 同上，附一個主辦者 stake 公鑰的 vkey witness，但簽章被改一個 bit | 拒：`ConwayUtxowFailure (InvalidWitnessesUTXOW (VKey (VerKeyEd25519DSIGN "8139770e…") :| []))` | 實測 |
| stake 5 只註冊、未委託 DRep，0 ADA withdrawal＋stake witness | 拒：`ConwayWdrlNotDelegatedToDRep (KeyHash … "fd5939fb…")`，只有這一個錯誤（註冊與餘額條件都滿足） | 實測 |
| 同一個 stake 5 再送 `vote_deleg_cert` always-abstain 之後，同樣的 withdrawal | 接受 | 實測 |
| reward 餘額非 0 | 主辦者委託 pool 後約 355 秒（epoch 3 → 7）餘額變成 169,575,972 lovelace。依序送：0 → 拒；169,575,971（餘額−1）→ 拒；169,575,973（餘額＋1）→ 拒；三者都是 `ConwayCertsFailure (WithdrawalsNotInRewardsCERTS (… Coin <金額>))`。全額 169,575,972 → **接受**，之後餘額 0。每次送出前都重讀餘額，四次讀到的都是 169,575,972 | 實測 |
| 餘額會在 epoch 邊界改變 | 全額提領在 epoch 7 收錄；epoch 8 時 Yaci Store 的 `/accounts/{stake}` 顯示 `withdrawable_amount` 169,169,183（新一期 reward）。所以「全額」是哪個數字取決於交易收錄時的 epoch：跨過邊界、中間又有 reward 入帳時，組好的交易會變成金額不符而被拒 | 實測（數字）＋推論（跨邊界失效，由上一列的規則推得；跨邊界送出本身沒量） |

Yaci Store（同映像內建，Blockfrost 形狀的 `/api/v1`）的 `/accounts/{stake}/withdrawals`：

| 項目 | 結果 | 依據 |
|---|---|---|
| 0 ADA withdrawal 有列出 | 是（`amount` 0，`block_number` 71）；全額那筆也列出（`amount` 169575972） | 實測 |
| 欄位 | `block_number`、`block_time`、`address`、`tx_hash`、`amount`（數字，不是字串）、`epoch`、`slot`；沒有 `block_height`、`tx_slot` | 實測 |
| `order` | `order=asc` 與 `order=desc` 回**同樣的順序，新的在前**（2 列）——`order` 沒有作用 | 實測 |
| `count`／`page` | `count=1&page=2` 回較舊的那一列 | 實測 |
| `from`／`to` | 不報錯、不過濾（`from=1&to=2` 回全部 2 列） | 實測 |
| 未知 stake | 200 `[]`（Dolos 是 404） | 實測 |

這些差異只說明 Yaci Store 不能直接當本專案的 indexer（欄位名稱、型別與排序都不同）；本專案的 indexer 是 Dolos（PD7），以上只是觀察，不改計畫。

## (3) Evolution SDK 0.6.0 與 mock CIP-30

腳本 `tools/devchain/withdrawal-evolution.mjs`，原始輸出 `yaci-0.12.0-evolution-report.json`。版本 `@evolution-sdk/evolution@0.6.0`（`pnpm-lock.yaml`，實測：腳本從 `apps/web` 解析到的 `package.json` version）。在 Node 跑，不是在頁面裡：SDK 呼叫照抄 `apps/web/cardano.ts` 的 `prepareTransaction`（`payToAddress`、`attachMetadata`、`addSigner`、`setValidity`、`build({ fullProtocolParameters, availableUtxos, changeAddress })`），再加上 `.withdraw(...)`；mock CIP-30 的 `signTx` 與 `tools/devchain/browser-live.mjs` 相同（回一個含 payment、stake 兩個 vkey witness 的 witness set），簽完以 `Transaction.addVKeyWitnessesHex` 合併，原樣送到 Yaci 的 cardano-submit-api。

| 項目 | 結果 | 依據 |
|---|---|---|
| API | `withdraw({ stakeCredential, amount })`、`registerStake`、`delegateToDRep`、`delegateToPoolAndDRep`、`registerAndDelegateTo`；`DRep.alwaysAbstain()`、`Credential.makeKeyHash` | 讀碼（`dist/sdk/builders/TransactionBuilder.d.ts`、`operations/Operations.d.ts`） |
| 註冊＋DRep 委託 | `registerAndDelegateTo({ stakeCredential, drep: alwaysAbstain })` 產生一張 `vote_reg_deleg_cert`（12，押金 2,000,000）；mock 簽章後真 ledger **接受**、收錄；手續費 171,749＝簽好交易的線性最低費 | 實測 |
| 承諾＋0 ADA withdrawal | body 欄位 `[0,1,2,3,5,7,14]`；withdrawals `{e0‖stake 11: 0}`；`required_signers` 只有 stake 11；`invalid_hereafter` 136,819,248（preprod 時鐘換算，devnet 上是未來）。簽完 body hash 不變（`sameBody` true）；trust-path reader `readCommitmentTransaction` 讀出的 signers 含 stake key；真 ledger **接受**、收錄；手續費 183,673＝簽好交易的線性最低費（SDK 的估算把 stake witness 算進去了） | 實測 |
| 現行 `checkCommitmentTransaction` | 拒收：`Unsigned transaction has unexpected body field 5`——9b 要改的就是這裡（`COMMITMENT_BODY_FIELDS`，`packages/chain/index.ts`） | 實測 |
| 註冊＋委託＋withdrawal 同一筆 | SDK 組得出（body 欄位 `[0,1,2,4,5]`），但 ledger 會拒（(2) 第 2 列，以 `withdrawal-tx.mjs` 組的同形交易實測）；這筆 SDK 版沒有送 | 實測（組）＋實測（ledger，另一份 builder） |
| `BlockfrostProvider.getUtxosByOutRef` 對 Yaci Store | 失敗（`Blockfrost getUtxosByOutRef failed`）：Yaci Store 的 `/txs/{h}/utxos` 輸出沒有 `collateral` 欄位，SDK 的 schema 要求它（較早一輪的 stderr 是 effect ParseError：`["outputs"] … [0] … ["collateral"] is missing`，那份 log 已被後來的執行覆寫；入庫報告記下 Store 實際的輸出欄位列表，其中沒有 `collateral`）。腳本因此改用節點的 UTxO 自建 SDK 的 `UTxO`。對 Dolos 不適用：步驟 8b 的 browser-live 已在 Dolos 上走過 `getUtxosByOutRef`（`spike-dolos.md`） | 實測 |

缺的東西：沒有。限制：這是 Node 裡的 SDK 呼叫，不是頁面；真 CIP-30 錢包會不會為 withdrawal 的 stake key 簽，仍是 PD3 既有的「真錢包驗收」項目（MVP 計畫步驟 8），本 spike 沒有新增資訊。

## 對 9b 實作的事實（未拍板，交實作時用）

- 第一次承諾之前必須有一筆已收錄的「註冊＋DRep 委託」交易；不能與承諾同筆（實測，(2)）。`checkCommitmentTransaction` 是否放行憑證，依此只需放行 withdrawal（計畫寫「依 spike 定」）。
- withdrawal 金額不必由 verifier 檢查：ledger 只接受「餘額 0 時 0、否則全額」（實測，(2)）；verifier 只需確認身分 stake 的 reward account 在 withdrawals 裡（推論）。
- Dolos 列表沒有 `tx_index`，但 asc 下同區塊依區塊內位置排列、跨頁穩定（實測，(1)）；計畫「讀到第一列 `block_time ≥ roundTime(round)` 就停」在 Dolos 上可行。Dolos 另外接受 `from`／`to`，但 Blockfrost spec 沒有，CLI 使用者的其他節點不一定支援（推論）。
- 主辦者 stake 從未出現在 Dolos 時是 404，出現過但沒有 withdrawal 是 200 `[]`（實測）。被驗的承諾本身就帶 withdrawal，正常驗證不會遇到 404；介面卡要把 404 當成「列舉不完整」而非「沒有歷史」（推論，與 PD9 現行對其他 404 的處理一致）。
- 開發鏈（Dolos emulator）不擋第三方 withdrawal（實測，(1)），所以開發鏈上的驗收劇本不能用「ledger 會拒」當前提；verifier 的計數條件（身分 key 在 `required_signers` 且 witness 驗章通過）仍是唯一防線，維持「不能動」（推論）。

## 重現指令

```sh
REPO=<本 repo 的 checkout>
T=/Users/will/second-brain/.projects/personal/cardano-verifiable-giveaway-wt/tools-dolos
cd $REPO && pnpm install --frozen-lockfile && make build

# (1) Dolos：全新執行目錄、port 3030
R=$T/run-9b-2 && mkdir -p $R && cp tools/devchain/*.json tools/devchain/dolos.toml $R/
sed -i '' 's/127.0.0.1:3010/127.0.0.1:3030/' $R/dolos.toml
(cd $R && $T/bin/dolos-aarch64-apple-darwin/dolos daemon -c dolos.toml > dolos.log 2>&1 &)
DEVCHAIN_URL=http://127.0.0.1:3030 node tools/devchain/withdrawal-spike.mjs $R/captures.json > $R/report.json
# 最後一步會讓 Dolos panic 結束（預期），panic 訊息在 $R/dolos.log

# (2)(3) Yaci DevKit 0.12.0
cd tools/devchain/yaci && docker compose -f compose.yml up -d
docker exec -d cvg-9b-yaci sh -c '/app/yaci-cli.sh up --enable-yaci-store -e 100 --tail </dev/null > /clusters/cvg-9b-up.log 2>&1'
# 等到 curl -s http://127.0.0.1:18080/api/v1/blocks/latest 回區塊（約 2–3 分鐘）
cd $REPO
node tools/devchain/withdrawal-yaci.mjs > yaci-report.json          # 含等 reward，約 7–8 分鐘
node tools/devchain/withdrawal-evolution.mjs > evolution-report.json # 同一 devnet 重跑要換 EVO_PAYMENT_SEED／EVO_STAKE_SEED
cd tools/devchain/yaci && docker compose -f compose.yml down -v
```

Yaci 的坑（實測）：`up` 不要加 `-o`／`--overwrite`——它會刪掉映像內建的 `/app/store`，再去下載而失敗（`YaciStore version is not set`），Store 就起不來，只能重建容器。Store 的啟動檢查可能在 40 秒逾時報失敗，但之後仍會起來（三次啟動中有一次 log 出現「Starting Yaci Store: FAILED: not started after 40s」，隨後 `/api/v1/blocks/latest` 正常）。devnet 的 topup API 連續呼叫會回 500，要等上一筆入塊（腳本已處理）。第一輪 `withdrawal-yaci.mjs` 有一次送出沒有收到回應而卡住（同樣內容重送立即回 400），原因沒查；入庫版本對每個請求設 30 秒期限並重試一次，第二輪沒有再發生。

## 磁碟

| 項目 | 大小 | 依據 |
|---|---|---|
| `bloxbean/yaci-cli:0.12.0` 映像 | 3.454 GB（`docker system df -v` 的 SIZE／UNIQUE SIZE） | 實測。**不是本 spike 拉的**：`docker pull` 回「Image is up to date」，映像 5 天前已存在（另有一個不相干的已停止容器 `codex-cardano-preregistry-stable` 用它）；本 spike 沒有刪它 |
| `cvg-9b_cvg-9b-yaci-data` volume（跑完兩個腳本後） | 5.564 MB | 實測 |
| `cvg-9b-yaci` 容器可寫層 | 463 kB | 實測 |
| `tools-yaci/`（release zip、解開的設定、兩輪輸出） | 560 KB | 實測（`du -sh`） |
| `tools-dolos/run-9b-1`、`run-9b-2`、`run-9b-pallas-src` | 1.3 MB、1.6 MB、1.0 MB | 實測 |

合計約 3.46 GB，低於 5 GB。

## 停止條件（計畫步驟 9b，逐條）

- 「真 ledger 上第三方能送出帶主辦者 stake 的 withdrawal」：**未觸發**——三種第三方劇本都被 Haskell ledger 拒（(2)）。
- 「Dolos 不列出 0 ADA withdrawal」：**未觸發**——列出（(1)）。
- 「Evolution SDK 或 mock CIP-30 組不出這種交易」：**未觸發**——組得出、簽得出、真 ledger 接受（(3)）。
- 「Yaci DevKit 超過 5 GB」：**未觸發**——約 3.46 GB（映像為既有）。

## 未量到與不確定

- 真 CIP-30 錢包是否為 withdrawal 的 stake key 簽章（PD3 既有代價，真錢包驗收）。
- 跨 epoch 邊界組好、邊界後才送出的全額提領被拒：由規則推論，未實際跨邊界送出。
- preprod 上的 Dolos 對 withdrawals 列表的排序與分頁（只量了 emulator；8c 的範圍）。
- Dolos 400 空本文的具體原因：Dolos 不回傳，只能由 pallas 原始碼推得是 value preservation；沒有開 debug log 驗證。
- Yaci Store 的 `order` 只用 2 列量到「asc 與 desc 同為新到舊」，列數少；與本專案無關，未加量。
