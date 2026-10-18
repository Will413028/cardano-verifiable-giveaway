# 協定硬化與 TypeScript 便利層後端

**Goal：** verifier 的已知缺陷（附件 `inventory.md` F1–F7、F9–F16）全部依處置完成；新增的 TypeScript 後端（Cloudflare Workers）提供唯讀 indexer proxy、bundle 代管、錢包簽章的擁有者操作與草稿保存。CI 跑 `make check` 全綠；瀏覽器 E2E 在本機手動跑通（CI 沒有瀏覽器環境）。後端關閉時，持有下載 bundle 者仍能用 CLI 驗證。驗收見步驟 14。

**上層：** `docs/plans/2026-10-01-verifiable-giveaway-mvp.md`（MVP 計畫）。本檔沿用它的「全域約束與完成定義」，不重複；主清單見本機個人脈絡檔。

**附件：** `docs/plans/2026-10-18-hardening-and-backend/`：`inventory.md`（既有缺陷與會改變的行為，含處置與去向）、`requirements.md`（後端需求、非功能需求、外部介面）、`check_plan.py`（本計畫的一次性機械檢查）、`spike-s1.md`（步驟 2 的量測結果）。快照 commit `32d289c`。

## 前提（開工時核對過，2026-10-18）

- **會改到或取代的既有部署是否在線：** 無既有部署（README「Status」：No public deployment）。本計畫不部署後端；部署屬 MVP 計畫步驟 10，需要 Will 授權。鏈上沒有任何人依賴的承諾，協定可自由修改；上鏈後不能改的承諾已由 MVP 計畫 I3 規範。
- 後端範圍、禁止事項、帳號與保存期限依兩份 ADR：`docs/adr/2026-10-18-typescript-convenience-backend.md`、`docs/adr/2026-10-18-wallet-auth-and-bounded-retention.md`（來源：Will，2026-10-18；已確認）。
- Koios 公開層擋瀏覽器 CORS（真 Chrome 實測，2026-10-18；已確認）。Worker 從伺服器端呼叫不受 CORS 限制，本機開發不需要 API key（推論，步驟 8 驗證）；正式額度需要 Will 申請的 Free key（未確認）。
- Koios 條款是否允許代理轉發與快取（未確認；2026-10-18 步驟 1 查詢時 koios.rest 整站回 502，官方 repo `cardano-community/koios-artifacts` 的 `html/index.html` 搜尋 terms／proxy／cache／redistribute 無結果；步驟 9 開工時重查，不允許就停）。
- 真錢包仍延後（MVP 計畫前提 P2）：自動化測試用測試內產生的金鑰與 mock CIP-30，不使用任何個人錢包或助記詞；preprod 上尚無自己的承諾交易（MVP 附件 `spike-a.md`「鏈上樣本 0」），需要真承諾的驗收標為「等真錢包」（已確認）。
- 工具鏈（預設，可推翻）：Biome 負責 lint 與格式化；後端用 Wrangler 與 Miniflare 在本機執行，測試用 `@cloudflare/vitest-plugin`（原名 `@cloudflare/vitest-pool-workers`，0.23.0 標為 deprecated 並改名，步驟 8 於 2026-10-19 查核改用）；bundle 存 R2、紀錄存 D1、IP 突發限流用 Rate Limiting binding（計數只在單一機房內、不精確，週期只能 10 或 60 秒，見 [文件](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)，2026-10-18 查核），Koios 全域日預算用單一 Durable Object 計數器，到期清理用 Cron Triggers，讀取時另檢查 `expires_at`。新增套件屬下載，版本鎖在 lockfile。
- 開發期 metadata label 改用 [CIP-10 registry](https://github.com/cardano-foundation/CIPs/blob/master/CIP-0010/registry.json) 未登記的數字（預設，可推翻；步驟 4 選定並記錄查詢日期）；CIP-10 註冊留給 v1 凍結（MVP 計畫 D7）。
- 安全參數：簽章 payload 5 分鐘有效、nonce 一次性（依 [CIP-93](https://cips.cardano.org/cip/CIP-0093) 的建議時間窗）；不用 cookie（[OWASP CSRF Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)）。

**驗收基線：** commit `32d289c` 上 `make check` 全綠：lint、typecheck、13 個測試、10 組 Python vectors、`check_plan.py` OK（2026-10-18 實跑）。瀏覽器 E2E（`tools/browser-check.mjs`）與 `tools/mutation-check.mjs` 本次未跑，由步驟 1 建立基線。已知問題列在附件 `inventory.md`，依各自的處置在本計畫內修。

## 本階段依賴的不變量

沿用 MVP 計畫的 I1–I9；PD3 改寫 I5、I7（步驟 5 執行）。本計畫新增：

| 不變量 | 依賴它的機制（新系統先寫預計的模組） |
|---|---|
| B1 驗證不依賴後端：verifier 不引用後端模組；CLI 只直連 indexer 與 drand relay；後端停擺不影響 PASS 判定 | `packages/verifier/index.ts`、`packages/beacon/index.ts` 的 `fetchBeacon`、`apps/verifier-cli/index.mjs`、`apps/api/`（預計）；邊界由各套件 `package.json` 的 dependencies 與 `biome.json` 的 `noUndeclaredDependencies`、`noRestrictedImports`（禁止離開套件目錄的相對路徑）守住 |
| B2 後端不簽署、不送出交易、不持有私鑰、不產生 randomness、不判定 PASS／FAIL、不改寫 indexer 回應 | `apps/api/src/proxy.ts`（預計）、`apps/web/cardano.ts` 的 `submitTx` |
| B3 後端不存密碼、email、OAuth token 或 session token；只存一次性 nonce 的使用紀錄（PD4） | `apps/api/src/auth.ts`（預計）、D1 schema |
| B4 只代管已上鏈承諾、通過 `validateBundle` 的 bundle；代管紀錄以 `txHash` 為主鍵、owner 由該筆交易推導，bytes 以 bundleHash 定址並以參照計數回收；擁有者刪除只移除自己的紀錄，以 bundleHash 為鍵的 tombstone 只用於營運端下架 | `apps/api/src/bundles.ts`（預計）、`packages/protocol/index.ts` 的 `validateBundle`、D1 schema |
| B5 保存有期限：bundle 到 round 後 12 個月，每次延長 12 個月、總計不超過 round 後 36 個月（PD4）；伺服器草稿 30 天 | `apps/api/src/retention.ts`（預計）、Cron Trigger |
| B6 proxy 快取不得讓唯一性列舉漏掉交易：列舉頁只有在整頁交易都深於協定的 `CONFIRMATIONS` 時才快取（未滿頁與含淺層交易的頁都不快取，防 rollback 造成 offset 位移）；以 txHash 為鍵的 CBOR 回應可長期快取 | `apps/api/src/proxy.ts`（預計）的快取層、`packages/chain/index.ts` 的 `findCommitments` |

## 範圍

- 做：附件 `inventory.md` 處置為「修」的缺陷；附件 `requirements.md` 的 BR-01–BR-18；協定版本升到 `development-2`。
- 不做：部署與正式網域（MVP 計畫步驟 10、D9，需要 Will 授權）；主網；協定 v1 凍結與 CIP-10 註冊（MVP 計畫 D7）；真錢包驗收（MVP 計畫步驟 2、7）；名單收集與代簽代付（MVP 計畫範圍外）。
- 延後：
  - 彙總統計（後端 ADR 範圍內）——觸發條件：MVP 計畫 D11 選定服務，且進入 MVP 計畫步驟 10。
  - 上線後 Cloudflare 共用出口 IP 是否被 Koios 限流——觸發條件：部署到 preprod 環境（本機測不出來）。
  - 預設交叉比對兩家 indexer——觸發條件：維持 MVP 計畫的延後條件。
  - Mithril 交易收錄證明——觸發條件：`mithril-client-wasm` 的交易證明 API 不再需要 `unstable: true`，且 preprod 與主網都已啟用交易認證。
  - 硬體錢包 `signData` 相容性驗收——觸發條件：Will 提供 Ledger 或 Trezor 並授權。
  - 15 個確認的威脅說明（F8）——觸發條件：MVP 計畫 D7 凍結。

## 步驟

- [x] **1. 開工基線與設計審查**（被擋於：無）
  - 範圍：先 `make dev`，再以 `GIVEAWAY_PLAYWRIGHT_MODULE=<playwright-core/index.mjs> GIVEAWAY_CHROME_PATH=<Chrome 執行檔> node tools/browser-check.mjs` 跑瀏覽器 E2E；跑 `node tools/mutation-check.mjs`；兩者結果記入進度表。對本計畫跑 design-review skill，處理每個發現（改計畫或寫駁回理由）。
  - 消費端：無（不改程式）。
  - 不能動：程式碼。
  - 驗收：進度表貼兩個工具的實際輸出；design-review 的發現逐條有處置。
  - 停止條件：任一工具在快照上就失敗——把失敗列進基線，不在本步修。

- [x] **2. Spike S1：Cardano SDK 與 verifier 依賴比較**（被擋於：無）
  - 範圍：拋棄式程式放 `spikes/s1-sdk/`，不被產品引用。比較 Mesh（現用）、Evolution SDK、Blaze：瀏覽器 bundle 大小、需要的 polyfill 數、能否在瀏覽器與 Workers 解析交易 CBOR 並重算 tx hash 與 auxiliary data hash、能否驗證 CIP-8 COSE_Sign1 簽章、能否組出帶 metadata、`required_signers`（stake key hash）與 `invalid_hereafter` 的自轉交易、套件維護狀態；另外對 PD6-B 的最小依賴組合量同樣的 CBOR、hash 與 COSE 項目。產出附件 `spike-s1.md`。
  - 消費端：無（spike 不被引用）。
  - 不能動：產品程式碼；不連主網。
  - 驗收：`spike-s1.md` 每個 SDK 每個量測項都有數字或「不支援」並附重現指令；fixture 是 preprod 上一筆公開的帶 metadata 交易的原始 CBOR（開工時下載，txHash 記入 `spike-s1.md`）；每個選項以 body 原始 bytes 算出的 tx hash 等於該 txHash，改一個 byte 後要不同。
  - 停止條件：沒有任何 SDK 能在 Workers 驗證 COSE 簽章——停下回報，PD6 與步驟 11 改用新事實。
  - 完成後的狀態：PD1、PD6 可以拍板。

- [x] **3. 工程基線：Biome 與拆分 `app.ts`**（被擋於：步驟 1）
  - 範圍：導入 Biome（lint＋格式化）並接進 `make check`；把 `packages/*`、`apps/*` 改成各有 `package.json` 的 workspace 套件，跨套件以套件名稱引用並宣告 dependencies（pnpm 不讓未宣告的套件被解析），Biome `noRestrictedImports` 禁止跨套件的相對路徑，取代 `tools/lint.mjs` 以正則掃 import 的 spike 邊界檢查；把 `apps/web/app.ts` 拆成狀態、畫面與服務模組，移除模組層級的可變全域狀態。只改結構，不改行為（F12）。
  - 消費端：`rg -n "from '(\.\./)+(packages|apps|spikes)" apps packages tools tests`；`rg -n "app\.js|app\.ts|dist/library" tools Makefile tests`
  - 不能動：所有使用者看得到的行為、DOM id、`browser-check.mjs` 的斷言。
  - 驗收：`make check` 全綠；瀏覽器 E2E 與步驟 1 的基線相同；mutation：加入一行未格式化的程式碼、在 `apps/web` 以相對路徑引用 `spikes/`、在 `packages/protocol` 引用未宣告的 workspace 套件，`make check` 各自要失敗。
  - 停止條件：拆分需要改 DOM 或 E2E 斷言才能通過——停下，代表動到行為。
  - 完成後的形狀（2026-10-18，依開工 design-review 調整）：
    - 套件圖單向：`@giveaway/protocol` ← `beacon`、`chain` ← `verifier`（`packages/protocol/verifier.ts` 移到 `packages/verifier/index.ts`，解開套件循環）← `apps/web`、`apps/verifier-cli`。依賴宣告在使用它的套件；根目錄只留工具用的 devDependencies（esbuild、typescript、Biome、`tools/browser-check.mjs` 用的 Mesh，與以名稱引用 library 的 `@giveaway/verifier-cli`）。
    - CLI 擁有自己的產物：`apps/verifier-cli/library.ts` 打包成 `apps/verifier-cli/dist/library.mjs`（套件 export `./library`）；測試與 `tools/mutation-check.mjs` 以 `@giveaway/verifier-cli/library` 引用；`GIVEAWAY_LIBRARY` 替換機制沿用到步驟 4 改寫 mutation-check 時重評。網頁產物仍在根目錄 `dist/`。
    - 邊界：pnpm 的解析會往上層 `node_modules` 找，擋不住未宣告的依賴，改由 Biome `noUndeclaredDependencies` 擋；`noImportCycles` 擋模組循環；`noRestrictedImports` 在 `packages/*/*`、`apps/*/*` 禁止 `../**`（套件目前沒有子目錄；Biome 只比對字串、不解析路徑，套件出現子目錄時要加對應深度的 override），在 `tools/`、`tests/` 禁止 `../packages/**`、`../apps/**`、`../spikes/**`。spike 不需要專用規則。
    - tsconfig 依執行環境拆開：`tsconfig.base.json` 共用選項；`packages/tsconfig.json`（ES2023＋WebWorker，沒有 DOM）、`apps/web/tsconfig.json`（DOM）、`apps/verifier-cli/tsconfig.json`。
    - Biome 範圍：`packages`、`apps`、`tools`、`tests` 與根目錄 JSON；`tests/*.json` 由 `tools/reference.py` 產生，排除；HTML 不納入（格式化會改 inline 元素間的空白，屬可見行為；原 `tools/lint.mjs` 對 HTML 只查行尾空白，這項檢查不再保留，觸發條件：重寫 `index.html` 時改由產生器或 Biome HTML 處理）；organize imports 關閉。`tools/lint.mjs` 刪除。
    - 網頁：`app.ts`（入口與流程：擁有狀態、接事件，流程函式仍直接改 DOM，模式取自 `#network`）、`state.ts`（`createState()`，每次載入一份）、`view.ts`（DOM 輔助與整塊畫面的 render）、`services.ts`（不碰 DOM：分享連結編碼、代管 bundle、組 proof；`createChains()` 每次載入建立一份 `DemoChain` 與 `KoiosChain`，明確傳給 `verifyProof`）。沒有顯式流程狀態機，交給步驟 12。
    - build 仍由根目錄 `tools/build.mjs` 一支腳本建網頁與 CLI，網頁以 `absWorkingDir: apps/web` 解析它宣告的 alias；觸發條件：步驟 6 移除 alias，或部署需要先建網頁再 `wrangler deploy` 時，改成各套件自己的 `build` script 由根目錄 `pnpm -r run build` 串起（步驟 8 加入 Wrangler 時判定不需要：`apps/api` 沒有建置產物，見進度表）。
    - 套件邊界的業界替代：會解析路徑的 dependency-cruiser、eslint-plugin-boundaries，或每套件一份 tsconfig 搭配 Project References；觸發條件：任一套件出現第二層子目錄，或依深度寫的 override 漏擋一次。

- [x] **4. verifier 正確性修正與 `development-2`**（被擋於：步驟 3）
  - 範圍：F3（相依檢查在證據失敗時標「未評估」，`Check.passed` 改成三態，網頁與 CLI 的 JSON 輸出同步）、F4（刪除「Round has arrived」與對應的動態 import）、F5（proof 只帶 network、bundle、`txHash`、owner、beacon、winners；「已收錄」與「已確認」分成兩個型別，移除 `confirmedAt: 0`）、F6（torsion point 負向測試）、F7（改用開發期私有 label）；F18（確認輪詢的回應在抽獎被重設或取代後丟棄，不寫入狀態與畫面）；`giveaway-pending-1` 的型別與驗證器移到 `packages/protocol`（目前型別在 `apps/web/services.ts`，只驗 bundle）；`tests/core.test.mjs` 的 `GIVEAWAY_LIBRARY` 替換與 mutation-check 的產物文字竄改一併重評；協定文件定義 canonical bundle 的 byte 上限（由 entrant 數與長度上限推導最壞情況），網頁、CLI 與後端共用同一常數，取代各自的 8 MB 常數。協定版本升為 `development-2`：`tools/reference.py` 改版本字串後重產 `tests/vectors.json`，同步更新 `docs/protocol-development.md`。`tools/mutation-check.mjs` 改用新格式並接進 `make check`。round 前公告（`giveaway-pending-1`）改帶 `txHash`＋owner，不再帶完整 commitment。
  - 消費端：`rg -n "confirmedAt|giveaway-proof-1|giveaway-pending-1|development-1|LABEL|Round has arrived|validateProof|passed|Verdict|count\(\), 8|mutation-check|GIVEAWAY_LIBRARY|8_000_000|8 MB" packages apps tools tests docs Makefile`
  - 不能動：bundle 的欄位集合與 canonical JSON 規則；抽選演算法；DEMO PASS 與 PASS 的區分。
  - 驗收：`make check` 全綠（含 mutation-check）；重產的 vectors 由 Node 與 Python 兩邊算出相同的 bundle hash 與得獎者；inventory F3–F7 各一個回歸測試，把修正改回舊寫法時該測試要失敗；瀏覽器 E2E 與基線的差異只有已知的檢查項數與 proof 格式。
  - 停止條件：canonical 輸出除了 `version` 欄位之外有任何差異——停下，代表動到 canonical 規則。
  - 完成後的形狀（2026-10-18）：
    - 型別：`CommitmentRef`（`txHash`、owner）← `Inclusion`（唯一性列舉用）← `Confirmed`（加 `confirmedAt`，只有 `readCommitment` 產生）；proof 為 `giveaway-proof-2`、公告為 `giveaway-pending-2`，驗證器 `validateProof`、`validatePending` 都在 `packages/protocol`，多餘欄位一律拒收。
    - Demo：proof 不再帶 commitment，verifier 以 `demoInclusion(bundle)` 重算模擬證據；demo `txHash` 為 `SHA-256("giveaway-demo-commitment:" || bundleHash)`，只擋「改 bundle 沒重算 reference」，demo 證據不綁定任何東西（文件寫明）。
    - 檢查三態 `pass`／`fail`／`unevaluated`，欄位名 `result`；網頁以 `–` 顯示未評估。檢查項 8 → 7。
    - label `20261018`（CIP-10 registry 查於 2026-10-18，CIPs commit `befcdb7`）。
    - byte 上限：`BUNDLE_BYTE_LIMIT` 6,030,512、`ARTIFACT_BYTE_LIMIT` 12,224,608，推導寫在 `docs/protocol-development.md`；網頁兩處與 CLI 共用 `ARTIFACT_BYTE_LIMIT`，後端（步驟 8 起）同樣引用。
    - `GIVEAWAY_LIBRARY` 重評：刪除。它只為了讓測試載入被竄改的產物；改成 mutation-check 就地改寫檔案、跑指定測試、在 `finally` 還原，與原本的 vectors 竄改同一做法，測試不再有注入點。產物文字竄改保留（找不到目標時大聲失敗），新增「移除子群檢查」一項；步驟 6 換掉 `@harmoniclabs/crypto` 時那項會因找不到目標而失敗，屆時改寫成對應新函式庫的位置。
    - F18：每個流程在 await 前保存 `state.draw` 物件，await 後不是同一份就丟棄。`commit()` 的錢包等待不加判斷：`#network` 在 `#draw-form` 內，`run()` 期間被 `lockControls` 停用，使用者無法重設。

- [x] **5. 唯一性重設計**（被擋於：步驟 4）
  - 範圍：開工先確認 Koios 能依 PD3 的身分列舉交易（stake credential 用 `account_txs`、payment credential 用 `credential_txs`），記錄端點、排序是否穩定、分頁數與請求數。依 PD3 改寫 `checkUniqueness` 與 `findCommitments`，驗證頁與 CLI 列出衝突的承諾。同步改 `BOUNDARY` 常數、`docs/protocol-development.md` 的唯一性段，並在 MVP 計畫 I5、I7、D3、D7 加註由 PD3 接手（F1）。
  - 消費端：`rg -n "checkUniqueness|findCommitments|address_txs|BOUNDARY|different-drawId" packages apps tools tests docs`
  - 不能動：「同一區塊多筆時 fail closed」；分頁上限超過時判 FAIL；round 時間之後才收錄的承諾不影響已完成的抽獎（`docs/protocol-development.md` 現行規則）。
  - 驗收：回歸測試四個劇本——同錢包、同 round、不同 drawId；同錢包、相鄰 round（R 與 R+1）；round 後補送一筆；兩場時間區間不重疊的連續抽獎。前兩者新實作判 FAIL（舊實作 PASS），第三者不影響原抽獎，第四者兩場都 PASS；另加第五個：第三方用帶主辦者 stake 部分的地址、但沒有身分 key 簽章，送一筆區間重疊的承諾，主辦者的抽獎仍 PASS；mutation：把衝突判定改回（地址, drawId），前兩個劇本的測試要失敗。
  - 停止條件：Koios 沒有能依 PD3 身分列舉交易的端點——停下，PD3 的身分子題改用新事實。
  - 完成後的形狀（2026-10-19）：
    - Koios 列舉（preprod 實測）：stake credential 用 `GET account_txs?_stake_address=`，payment credential 用 `POST credential_txs`（body `_payment_credentials`）；預設依 block_height 遞減，明確指定 `order=block_height.asc,tx_hash.asc` 時遵守且重複查詢結果相同；同一高度可有多筆（1,171 筆的 credential 內 1 組），所以排序要加 tx_hash；每頁上限 1,000（`limit=5000` 只回 1,000）。停止條件未觸發。
    - 身分鍵：`identityOf(owner)`，base 地址（header type 0）取 stake address bech32、enterprise 地址（type 6）取 payment credential hex；其他地址型別拒收。步驟 9 的 proxy 以此鍵加 offset 快取。
    - 計入條件（步驟 5 的暫行做法）：列舉到的交易只有在 input 含主辦者地址本身時才算該身分的承諾——花費該地址的 input 需要主辦者 payment key 的簽章，第三方帶主辦者 stake 部分的地址與轉入的交易都不算。代價：同一錢包從另一個 payment 地址送出的承諾看不到。步驟 7 改為驗 `required_signers` 裡身分 key 的 witness，計入條件放寬到「input 帶此 credential 且身分 key 簽章」，同錢包換地址才會被列為衝突。
    - 規則：`checkUniqueness` 回傳 `{ passed, conflicts }`；`Verdict` 加 `conflicts`（txHash、drawId、round、blockHeight、blockTime），檢查項 `Earliest commitment` 改名 `Unique commitment`，網頁在該項下列出衝突。
    - 每次驗證的 Koios 請求數：列舉 ⌈(n+1)/1000⌉ 頁＋`tx_metadata` ⌈n/50⌉ 批＋每個含承諾 label 的批次 1 次 `tx_info`；n 達 5,000 時 FAIL。實測：169 筆的 stake 帳戶 5 次請求、1,171 筆的 payment credential 26 次。
    - 實測發現的既有缺陷（步驟 5 一併修）：Koios `tx_info` 未帶 `_inputs: true` 時 `inputs` 為空陣列，`readCommitment` 與 `findCommitments` 在真 Koios 上必然判「不是 input」；公開層 request body 超過 5 KiB 回 HTTP 413（75 個 hash 通過、76 個失敗），原本每批 100 個 hash 必然失敗。另：`tx_info` 回應沒有 `valid_contract` 欄位，`valid_contract === false` 的判斷永遠不成立，交步驟 7 以 CBOR 的 `is_valid` 取代。

- [x] **6. 依 PD1、PD6 更換依賴**（被擋於：步驟 4）
  - 範圍：依 ADR `docs/adr/2026-10-18-sdk-and-trust-path-dependencies.md`：把 `apps/web/cardano.ts` 的 Mesh 換成 Evolution SDK（鎖精確版本、只在建立頁延遲載入）；`packages/chain` 的 CBOR 用法換成自寫讀取器加 `@noble/hashes`、`@noble/curves`（自 `spikes/s1-sdk/options/minimal.mjs` 移入並改寫為 TypeScript）；以步驟 3 的 Biome `noRestrictedImports` 禁止 `packages/` 引用任何 Cardano SDK；網頁組完交易後以讀取器重讀未簽 CBOR，欄位不符就不呼叫 `signTx`；移除不再需要的 polyfill 與 alias（F16），`@harmoniclabs/crypto` 是否仍需 Buffer 在本步確認。
  - 消費端：`rg -n "@meshsdk|cst\.|polyfills|crypto-browserify|stream-browserify" apps packages tools package.json`
  - 不能動：交易內容（輸出、metadata、找零規則）；mainnet 拒絕與 preprod UTxO 核對。
  - 驗收：`make check` 與瀏覽器 E2E 全綠；同一組輸入在換 SDK 前後產生的未簽交易，解碼後比對語意欄位：輸入、輸出地址與金額、metadata 解碼後相等、找零地址、fee 在即時參數估計值的 2 倍以內；bundle 大小記錄在進度表。
  - 停止條件：新 SDK 產生的交易無法通過既有的 mock preprod 檢查。
  - mutation 補充：拿掉組完重讀的任一欄位核對，或讓 `packages/` 引用 `@evolution-sdk/evolution`，測試或 lint 要失敗。
  - 完成後的形狀（2026-10-19）：
    - 依賴：`apps/web` 只宣告 `@evolution-sdk/evolution` 0.6.0（它的 effect、@scure、@noble 由 lockfile 鎖定），`packages/chain` 加 `@noble/hashes` 2.4.0；移除 Mesh、buffer、process、events、crypto-browserify、stream-browserify、`apps/web/polyfills.js`、build 的 alias／inject／`define global`，以及只屬 Mesh 依賴樹的 `allowBuilds.chacha-native`。`@harmoniclabs/crypto` 不需要 Buffer：原始碼只有回傳 Uint8Array 的 `bigintToBuffer`，新 bundle 沒有裸 `Buffer` 識別字，E2E 在無 shim 下 DEMO PASS（瀏覽器 BLS 驗章走這條）。
    - 讀取器：`packages/chain/cbor.ts`（`decodeCbor`、`transactionParts`、`transactionHash`、`auxiliaryDataHash`、`auxiliaryMetadata`），由 `@giveaway/chain` 轉出。與 spike 的差異：map 整數鍵超過 2^53 拒收、不定長字串的 chunk 不得再是不定長、文字保留 BOM。`@noble/curves` 與 COSE 驗證（spike 的 `verifyCose`、`sigStructure`、`signingKeyHash`）本步沒有呼叫端，未移入；觸發條件：第一個呼叫端（步驟 7 的 vkey witness 驗章或步驟 11 的 COSE）移入時一併加依賴與 S1 的向量測試。
    - 組完重讀：`checkCommitmentTransaction(unsigned, plan)` 在 `@giveaway/chain`：body 只准欄位 0、1、2、7；唯一 input 等於核對過的 UTxO；兩個純 ADA 輸出，第一個 2 ADA、第二個找零，都給 change address；輸出＋fee＝input；aux hash 一致；metadata 只有 `LABEL` 且解碼後等於 `commitmentMetadata`；witness set 為空。簽完再核對 tx hash 不變（錢包只能加 witness）。步驟 7 加 `required_signers`（14）與 `invalid_hereafter`（3）時要同步放寬欄位白名單並加核對。
    - 錢包與送出：CIP-30 直接呼叫（`getNetworkId`、`getChangeAddress`、`getUtxos`、`signTx(tx, false)`），沒用 Evolution 的 `withCip30`：它以 `getUsedAddresses` 的地址判網路、不取 change address、`signTx` 固定 `partialSign=true`，用它會改變 mainnet 拒絕與找零規則。Evolution 負責 Address／Assets 型別、`makeTxBuilder` 組交易、Koios 讀取（`getProtocolParameters`、`getUtxosByOutRef`）。送出改為自己把原始 bytes POST 到 Koios `submittx`：Evolution provider 會先解碼再重新編碼（S1 量到它的重新編碼會改 bytes）；步驟 9 改由錢包 `submitTx`。ADR 寫「用 Evolution SDK 組交易與連 CIP-30 錢包」，連錢包這半句未照做，理由同上。
    - 交易編碼差異（語意相同）：auxiliary data 由 Shelley 的裸 map 改為 tag 259（Alonzo 格式），inputs 以 tag 258 set 編碼；步驟 7 的讀取器兩種都要接受（`auxiliaryMetadata` 已接受）。
    - E2E mock：Koios 的 UTxO 查詢由 `tx_info` 改為 `utxo_info`（Evolution provider 用的端點）；mock 錢包同意簽章時回傳 `a0`（空 witness set；CIP-30 規定回傳 CBOR witness set，原本的空字串只有 Mesh 接受）；UTxO 與地址改為手寫 CBOR 加 `encodeBech32`，不再引用 Mesh。斷言未改。
    - Lint：`biome.json` 的 `packages/*/*` override 拆出來，`noRestrictedImports` 加一組 Cardano SDK 名單（`@evolution-sdk`、`@meshsdk`、`@blaze-cardano`、`@cardano-sdk`、`@lucid-evolution`、`lucid-cardano`、`@emurgo`、`@dcspark`、`@harmoniclabs` 的 ledger／plu-ts／buildooor）。只套 `packages/`（本步範圍）；ADR 的「信任路徑」也包含後端，觸發條件：`apps/api` 開始驗交易或 COSE（步驟 9 起的 proxy 不讀 CBOR；步驟 11 驗 COSE）時同一組名單加到它的 override。
    - build：步驟 3 記的觸發條件（移除 alias）已發生，判定不拆：網頁 build 只剩入口與 `GIVEAWAY_API_URL` 的 define，`absWorkingDir` 一併拿掉（esbuild 由引用檔所在目錄解析依賴），一支 `tools/build.mjs` 沒有剩下的跨套件耦合。拆成各套件 `build` script 的觸發條件只剩部署（MVP 步驟 10）需要 `wrangler deploy` 前先建網頁。

- [ ] **7. 以交易 CBOR 驗證 metadata、身分與時間上限**（被擋於：步驟 5、6）
  - 範圍：verifier 向 indexer 取原始交易 CBOR，自行確認 tx hash 與 auxiliary data hash，再從 CBOR 解出 metadata（F2）。身分依 PD3：從 body 讀出 `required_signers`，驗對應 vkey witness 對 tx hash 的簽章，不回溯 input 的前一筆交易；沒有身分 key 簽章的交易不算任何身分的承諾（F1 的第三方劇本）。依 PD5，從 body 讀出 `invalid_hereafter`，以釘死的網路參數換算成時間，必須早於 round 時間（F17）；網頁 `prepareTransaction` 同步加上 `required_signers` 與 `invalid_hereafter`。CBOR 自驗只做承諾交易本身與唯一性列舉中 metadata label 符合的交易——indexer 能漏列交易，對其他交易自驗擋不住任何新攻擊，只會放大 Koios 用量。剩下的信任面（漏列交易、謊報收錄區塊與時間、謊報 input 地址；後者與漏列等價）寫進 inventory F13 的處置與 `docs/protocol-development.md`（F13）。CLI 與瀏覽器共用同一實作；`tools/reference.py` 以同一份 fixture CBOR 重算 tx hash 與 auxiliary data hash，維持雙實作交叉核對。
  - 消費端：`rg -n "readCommitment|tx_metadata|tx_info|commitmentFrom|payment_addr|prepareTransaction|setTTL|invalid" packages apps tools tests`
  - 不能動：確認數規則；`--indexer` 參數。
  - 驗收：F2 的回歸測試（indexer 回傳竄改的 metadata JSON、CBOR 不變），舊實作 PASS、新實作 FAIL；身分 key 的 witness 缺少或簽錯時 FAIL；CBOR 被改一個 byte 時 FAIL；`invalid_hereafter` 晚於 round 或缺少時 FAIL，網頁提示逾期須改用更晚的 round 重送；Node 與 Python 對 fixture 算出相同 hash；mutation：略過 auxiliary data hash 比對、witness 驗章或時間上限檢查，各自的測試要失敗。
  - 完成後的形狀（2026-10-19）：
    - 讀取：`KoiosChain.readCommitment` 讀 `tx_cbor`（取代 `tx_metadata`），`readCommitmentTransaction` 驗 body hash＝txHash、aux hash＝body 欄位 7，metadata 從 CBOR 解，`is_valid` 取自 CBOR（pre-Alonzo 三元素視為有效）；收錄區塊與時間仍取 `tx_cbor` 列的 `block_height`、`tx_timestamp`。主辦者地址是否為 input 仍由 `tx_info` 判定（CBOR 只有 input 參照），列為信任面。Koios 沒有該交易時丟 `NotIndexedError`；實測 `tx_cbor` 對部分剛上鏈的交易回 `cbor: null`（2026-10-19 掃 40 個區塊約 550 列中 8 列），比照「尚未收錄」處理，列舉中遇到則整份歷史判不完整。
    - 身分（PD3 身分 A）：`identityKeyHash(owner)` 取 base 地址的 stake key hash、enterprise 地址的 payment key hash；`verifiedSigners` 只回傳「列在 `required_signers` 且 vkey witness 以 Ed25519（`@noble/curves` 2.4.0，`zip215: false`）對 tx hash 驗章通過」的 key。步驟 5 的暫行計入條件（input 含主辦者地址）移除：列舉到、label 符合的交易，只要有效且身分 key 簽章就計入，不看 input 地址。與步驟 5 預告的「input 帶此 credential 且身分 key 簽章」不同：加上 input 條件時，主辦者可從不帶此 credential 的地址花費、但輸出給自己的地址，讓交易被列舉卻不計入，等於繞過；ADR 的「至少一個 input 來自帶此 credential 的地址」是組交易的要求（讓列舉看得到），對被驗的承諾由「不在列舉中即 FAIL」保證。
    - 第三方防護的順序：先看簽章再看 metadata 是否合法（`malformed` 與 `metadata` 分開），第三方在帶主辦者 stake 部分的地址放壞掉的 label 不會讓主辦者的歷史失敗；`invalid_hereafter` 只對被驗的承諾換算時間，列舉中的極端 slot 不會丟錯。
    - 時間上限（PD5）：`Confirmed` 加 `validUntil`（`invalid_hereafter` 的 Unix 時間，缺少為 null）；`checkValidityBound` 要求非 null、早於 round 時間、且 indexer 回報的收錄時間早於它，`checkTiming` 先呼叫它；檢查項仍 7 項，`Timing and confirmations` 的說明在上限不成立時寫「改用更晚的 round 重送」。slot 參數只釘 preprod（`PREPROD_SLOTS`：slot 86,400 = 1655769600、每 slot 1 秒），來源 Koios `/genesis` 與 `3883c2a9` 的 slot／時間，Evolution 0.6.0 的 `SLOT_CONFIG_NETWORK.Preprod` 相同；主網不支援，不需另作決定。網頁設 `commitmentValidUntil(round)`＝round 時間 − 15 × 20 秒（preprod 期望出塊間隔，`activeslotcoeff` 0.05），這是網頁的選擇，協定只要求早於 round。
    - 網頁：`prepareTransaction` 以 `addSigner` 與 `setValidity` 加欄位 14、3；`checkCommitmentTransaction` 白名單放寬為 0、1、2、3、7、14，核對唯一 required signer 等於身分 key、欄位 3 等於自己換算的 slot；簽完再以 `readCommitmentTransaction` 確認身分 witness 存在，錢包沒用 stake key 簽就不送出。確認輪詢在交易未被收錄（`NotIndexedError`）且已過 `validUntil` 時提示逾期、須改用更晚的 round 重送。
    - 步驟 6 記錄的缺口（拿掉 `checkCommitmentTransaction` 呼叫沒有測試擋）已補：E2E 新增「indexer 回報另一個 output index」，Evolution 依該 outref 組出花費別的 input 的交易，頁面須顯示 unexpected input 且 mock 錢包 `signTx` 0 次；把呼叫換成直接取 fee 與 hash 後 E2E exit 1（TimeoutError）。
    - 交叉核對：`tests/transactions.json`（3 筆 preprod 真交易、Conway 與 Shelley 編碼的測試承諾、Evolution 組出的未簽承諾）由 Node 測試與 `tools/reference.py --check`（自寫 CBOR walker＋hashlib blake2b）各自重算 tx hash 與 aux hash；Python 不驗 Ed25519（標準庫沒有）。測試金鑰由固定種子產生（`tests/cardano.mjs`），root devDependencies 加 `@noble/curves`、`@noble/hashes` 2.4.0 供測試與 E2E 簽章。
    - S1 的 29 個 COSE 向量未移入：屬步驟 11 的 COSE 驗證，本步沒有呼叫端。

- [x] **8. 後端 walking skeleton**（被擋於：步驟 3）
  - 範圍：新增 `apps/api/`（Workers，TypeScript），共用 `packages/`；`apps/api/tsconfig.json` 使用 Workers 型別，`make typecheck` 涵蓋它；依需要調整 `pnpm-workspace.yaml` 的 `allowBuilds`，CI 的 `pnpm install --frozen-lockfile` 要能通過。本機以 Wrangler 執行，`make check` 跑後端測試。網頁以建置時的 `GIVEAWAY_API_URL`（預設 `http://127.0.0.1:8787`）取得 proxy 位址。接通最薄的一條路徑：網頁經 proxy 取得 Koios `/tip` 並顯示（BR-01 的第一個端點）。B1 邊界以步驟 3 的套件邊界守住：`packages/*` 與 `apps/verifier-cli` 不宣告 `apps/api` 的套件，Biome 規則禁止相對路徑繞過（B1）；`apps/api/src/` 有子目錄，`biome.json` 要為它加對應深度的 `noRestrictedImports` override。
  - 消費端：無（新模組）；邊界檢查：`rg -n "apps/api" packages apps/verifier-cli`；設定：`rg -n "include|allowBuilds" tsconfig.base.json packages/tsconfig.json pnpm-workspace.yaml biome.json`
  - 不能動：CLI 的直連行為；Demo 模式。
  - 驗收：CI 的 install 與 `make check`（含後端 typecheck 與測試）全綠；本機瀏覽器經 proxy 取得 tip（真 Koios，唯讀）；mutation：在 `packages/protocol` 加一行引用 `apps/api`，以套件名稱與以相對路徑各一次，`make check` 都要失敗。
  - 停止條件：Worker 呼叫 Koios 公開層也被拒——停下回報，需要 Will 先申請 key。

- [ ] **9. proxy 完整版與交易改由錢包送出**（被擋於：步驟 7、8；前提「Koios 條款允許代理與快取」）
  - 範圍：BR-01、BR-02、BR-03、BR-04、BR-05、BR-15、BR-16：端點 allowlist、每請求一個身分、以（步驟 5 定下的身分鍵, offset）快取且依 B6 只快取深於 `CONFIRMATIONS` 的整頁、依 IP 與 owner 限流（Rate Limiting binding）、全域日預算（Durable Object）、CORS 只開放設定的網域、不記錄請求內容；交易改由 CIP-30 `submitTx` 送出（F14）；驗證頁顯示證據來源，並可填入任何相容 Koios API 且允許 CORS 的 indexer 網址（Koios 公開層不允許，文件寫明；F13 的後半）；新增不 mock 的瀏覽器 E2E（F10、F11），使用一筆 preprod 上任意帶 metadata 的公開交易（開工時選定並把 txHash 記入進度表）。一次完整驗證的 Koios 請求數以 mock indexer 的計數器量測，據此設定限流值。
  - 消費端：`rg -n "KoiosChain|DEFAULT_INDEXER|KoiosProvider|submitTx|koios\.rest" apps packages tools tests`
  - 不能動：B1、B2、B6；CLI 預設直連。
  - 驗收：後端測試涵蓋 allowlist 外端點被拒、超過限流回 429、跨網域 CORS 被拒、請求內容不出現在 log；不 mock 的 E2E 經 proxy 讀到選定交易的 metadata；全域預算在多個 Worker 實例並發下不超額；mutation：拿掉 allowlist、限流、全域預算或 B6 的深度條件，各自的測試要失敗（後者：快取含淺層交易的頁後模擬 rollback，唯一性列舉不得漏掉交易）；mock 錢包記錄 `submitTx` 被呼叫，改回 provider 送出時測試要失敗。
  - 停止條件：Koios 條款不允許代理轉發或快取——停下，交 Will 決定改用其他 indexer 或付費方案。
  - 需要人做的事：申請 Koios Free API key 存本機（碰憑證，由 Will 處理；本機與 CI 不需要，部署前需要）。

- [ ] **10. bundle 代管與 CLI 的 bundle 模式**（被擋於：步驟 9；PD2 擋住 CPU 驗收）
  - 範圍：BR-06、BR-07、BR-08、BR-10、BR-17：上傳門檻（hash 對上已上鏈承諾、`validateBundle`、協定的 byte 上限）、代管紀錄以 `txHash` 為主鍵（B4）、bytes 以 bundleHash 定址並參照計數、每個 owner 的保存額度、12 個月保存（Cron 清理，讀取時也檢查 `expires_at`）；驗證連結改為 `txHash`＋bundleHash，網頁以 bundleHash 從代管或其他網址取回並核對（F9）。下載產物改為兩個檔：canonical bundle bytes（`<drawId>.bundle.json`）與 proof。CLI 新增 `node apps/verifier-cli/index.mjs <bundle.json> --tx <txHash>`，自行向 drand relay 取 beacon 並重算；原本的 proof 模式保留。量測 1 萬筆×200 字元 bundle 在 Workers 的 CPU 時間，交 PD2 拍板。網頁 `apps/web/services.ts` 的 `assembleProof`（取 beacon 後重算得獎者組成 proof）移到 `packages/verifier`，CLI 的 bundle 模式共用它。
  - 消費端：`rg -n "loadUrl|share-link|bundle=|hash=|showShare|download" apps tools tests`；CLI：`rg -n "verifyProof|argv" apps/verifier-cli`
  - 不能動：B1、B4；CLI 的 proof 模式與 exit code 語意。
  - 驗收：後端測試涵蓋 hash 不符、`validateBundle` 失敗、超過大小、承諾不存在、他人以相同 bundleHash 另送承諾並搶先上傳後刪除（正主仍能上傳且連結有效）、營運下架後重傳被拒、超過 owner 額度、到期後讀取被拒與 Cron 清理（時間注入）；E2E 以新連結格式在 demo 模式完成 DEMO PASS；Node 測試以注入的假 chain 跑 CLI 的 bundle 模式，後端未啟動時結果 PASS；mutation：略過 `validateBundle`、營運下架 tombstone 或參照計數，各自的測試要失敗。真鏈的 CLI 交叉驗收等真錢包（MVP 計畫步驟 8）。
  - 停止條件：最壞情況的 CPU 時間超過付費方案上限——停下，代表要改成分段處理，交 Will 決定。

- [ ] **11. 擁有者簽章操作**（被擋於：步驟 10）
  - 範圍：BR-09、BR-13、BR-17：nonce 端點、CIP-30 `signData` payload（網域、操作、bundleHash、network、nonce，5 分鐘有效），依 PD4 的驗證形式送出；後端驗章並確認 key 屬於 owner 地址；刪除與延長（延長上限依 PD4）；刪除後介面提醒保留下載副本。
  - 消費端：無（新端點）；網頁呼叫端：`rg -n "signData" apps`
  - 不能動：B2、B3；owner 取自承諾交易，不取錢包目前的 change address。
  - 驗收：以測試內產生的金鑰簽章；測試涵蓋過期 payload、重用 nonce、別的網域、別的 network、非 owner 的 key、超過延長上限全部被拒；mutation：拿掉 nonce 一次性檢查或 key 與 owner 的比對，各自的測試要失敗。

- [ ] **12. 草稿保存**（被擋於：步驟 11）
  - 範圍：BR-11、BR-12、BR-18：本機 IndexedDB 草稿與匯出、重新整理後恢復；伺服器草稿內容存 R2、紀錄存 D1（D1 單列上限 2 MB，見 [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)），依 PD4 的身分與額度，需簽章存取、30 天後自動刪除。網頁流程改為由狀態推導畫面：模式與流程階段記在 `AppState`（目前取自 `#network` 與元素的 `hidden`），恢復時由狀態 render，取代步驟 3 留下的「流程函式直接改 DOM」。
  - 消費端：`rg -n "draft|bundle =|parseEntrants" apps/web`
  - 不能動：草稿不進入驗證流程；B3、B5。
  - 驗收：E2E：建立草稿、重新整理後恢復、匯出再匯入內容相同；後端測試：未簽章存取被拒、超過額度被拒、30 天到期刪除（時間注入）；mutation：拿掉到期清理或額度檢查，各自的測試要失敗。

- [ ] **13. 文件、隱私說明與下架流程**（被擋於：步驟 12）
  - 範圍：BR-13、BR-14、F15：隱私說明（controller 角色、保存期限、刪除方式、整份下架與保留下載副本的提醒）；檢舉與下架流程，營運端以 Wrangler CLI 手動下架並寫成 runbook（`docs/runbooks/takedown.md`）；更新 `AGENTS.md`、README、`docs/protocol-development.md` 的架構與協定描述；MVP 計畫 `external-interfaces.md` E5 改指 Koios tiers 頁。
  - 消費端：`rg -n "no product backend|GitHub Pages|static web application|Pricing.html" README.md AGENTS.md docs`
  - 不能動：驗證邊界文字（MVP 計畫 I7，PD3 改寫後的版本）；不把未部署的功能寫成已上線（MVP 計畫全域約束）。
  - 驗收：消費端搜尋指令沒有過期描述；runbook 在本機 Miniflare 照做一次能下架一份測試 bundle 並留下 tombstone；`make check` 全綠。
  - 需要人做的事：Will 決定公開的檢舉聯絡管道。

- [ ] **14. 收尾**（被擋於：步驟 13）：完成定義逐項核對（MVP 計畫）；`python3 check_plan.py` 確認 inventory 與需求清單沒有空格且每項都對應到點名它的步驟；獨立設計審查（design-review skill）；長期檢查（B1 邊界檢查、mutation-check、後端測試）已在 `make check` 與 CI；延後項附觸發條件搬回主清單；需要人做的事（Koios key、部署授權、硬體錢包、檢舉管道）列給 Will。驗收：上述指令輸出貼進進度表。

## 決定

- **PD1 網頁組交易用的 SDK**（狀態：已決 2026-10-18，Will：B Evolution SDK；擋住步驟：無；需要的事實：無。ADR：`docs/adr/2026-10-18-sdk-and-trust-path-dependencies.md`）
  - 選項 A Mesh、B Evolution、C Blaze 的量測與取捨見 ADR 與附件 `spike-s1.md`；Blaze 為備援。
- **PD6 verifier 與後端的 CBOR、雜湊、簽章依賴**（狀態：已決 2026-10-18，Will：B 最小依賴；擋住步驟：無；需要的事實：無。ADR 同上）
  - 自寫只讀 CBOR 讀取器加 `@noble/hashes`、`@noble/curves`，瀏覽器、CLI、Workers 共用；信任路徑禁止引用 Cardano SDK。
- **PD2 Workers 方案**（狀態：未決；擋住步驟：10 的 CPU 驗收；需要的事實：步驟 10 的 CPU 量測）
  - A：Free——零成本；每請求 CPU 10 ms。
  - B：付費方案——每月固定費用；CPU 預設 30 秒。
  - 建議：最壞情況超過 10 ms 就選 B，不為了留在 Free 而縮小 bundle 上限。
- **PD3 唯一性規則**（狀態：已決 2026-10-18，Will：規則 A；身分 A 即 `required_signers`＋witness，同日 design-review 後重新拍板；擋住步驟：無；需要的事實：步驟 5 開頭的列舉端點確認，不成立時重議身分。ADR：`docs/adr/2026-10-18-uniqueness-by-interval-overlap.md`）
  - 規則子題（攻擊劇本：主辦者送多筆承諾，開獎後公布有利的那一場；或開獎後補送一筆讓已完成的抽獎失效）：
    - A：時間區間重疊即衝突——每筆承諾的區間是〔收錄時間, round 時間〕；同一身分的兩筆承諾區間重疊就兩筆都判 FAIL，round 之後才收錄的承諾不影響已完成的抽獎。擋住換 drawId、換相鄰 round 與事後補送三種劇本；代價是同一錢包不能同時進行兩場時間重疊的抽獎，要同時辦就得用不同錢包，而跨錢包本來就無法判定。（建議）
    - B：（身分, round）——換相鄰 round 就能繞過。
    - C：維持（地址, drawId）以最早一筆為準——換 drawId 就能繞過，等於沒修 F1。
  - 身分子題（2026-10-18 Will 曾選「stake credential 取自地址」；同日 design-review 指出地址的 stake 部分不需持有者簽章即可放入，見 [CIP-19](https://cips.cardano.org/cip/CIP-0019)「both parts are owned and managed by separate entities」，第三方能用帶主辦者 stake 部分的地址送重疊承諾，讓主辦者的抽獎被判 FAIL；已重新拍板）：
    - A：身分 key 列在 `required_signers` 並附 witness——有 stake 部分時用 stake key，否則用 payment key；且承諾交易至少一個 input 來自帶此 credential 的地址，保證列舉看得到。ledger 強制 `required_signers` 的簽章，第三方送不出算數的承諾，也不必回溯前一筆交易。代價：CIP-30 錢包是否會為 `required_signers` 裡的 stake key 簽章尚未驗證（步驟 2 確認 SDK 能組、真錢包驗收確認錢包會簽），不支援時退回 B。（建議）
    - B：payment key 列在 `required_signers`——錢包支援度高；同一 HD 錢包換收款地址就是不同身分，能繞過。
    - C：stake credential 直接取自 input 地址（原選項）——第三方可製造衝突，讓任何主辦者的抽獎作廢。
  - 對不變量的影響：改寫 MVP 計畫 I5（唯一性規則）與 I7、`BOUNDARY` 常數的驗證邊界文字；提前拍板 MVP 計畫 D3、D7 的唯一性子題，步驟 5 在 MVP 計畫加註。
- **PD5 承諾交易的時間上限**（狀態：已決 2026-10-18，Will：A；擋住步驟：無；需要的事實：無。ADR：`docs/adr/2026-10-18-commitment-validity-upper-bound.md`）
  - 問題：「承諾在 round 之前收錄」目前完全採信 indexer 的 `tx_timestamp`。
  - A：承諾交易的 `invalid_hereafter` 必須早於 round 對應的 slot，verifier 從 CBOR 讀出並換算——ledger 保證超過上限的交易不會被收錄，收錄時間的上界不再依賴 indexer；代價：主辦者要預留上鏈時間，交易逾期未收錄就要改用更晚的 round 重送；slot 與時間的換算要釘死各網路參數。（建議，納入 `development-2`）
  - B：維持採信 indexer 的時間——不改交易；信任面不縮小。
  - 15 個確認的時間仍依賴 indexer，A 只縮小信任面。
- **PD4 擁有者驗證形式、草稿身分與額度**（狀態：已決 2026-10-18，Will：驗證形式 A、額度照建議預設；擋住步驟：無；需要的事實：無。ADR：`docs/adr/2026-10-18-wallet-auth-and-bounded-retention.md` 的 Amendment）
  - 驗證形式：
    - A：每次操作都簽章，簽好的 payload 放在 `Authorization` header，不發 session——無狀態，後端不存任何 token；代價是每次操作都要錢包確認。（建議）
    - B：簽一次換短效 session token——操作較順；要保存、過期與撤銷 token，增加 B3 的範圍。
  - 草稿身分：簽章錢包的身分（與 PD3 身分子題同一規則）；草稿在上鏈前就存在，無法取自承諾交易。
  - 額度與上限（數字為建議預設）：每個身分最多 5 份伺服器草稿、每份不超過協定的 bundle 上限；每個 owner 最多 20 份代管中的 bundle；每次延長 12 個月，總保存不超過 round 後 36 個月。

拍板順序：PD1、PD3、PD4、PD5、PD6 已決；PD2 等步驟 10 的量測。

## 進度

狀態值：未開始／進行中／程式完成待驗收／完成。

| 步驟 | 狀態 | 已跑的驗收 | 未跑的驗收與原因 | 消費端搜尋結果 | commit |
|---|---|---|---|---|---|
| 1 開工基線與設計審查 | 完成 | 在 `1d0b4b5` 上：`browser-check.mjs` 11 項 PASS、exit 0（Chrome 系統安裝版＋npx 快取的 playwright-core）；`mutation-check.mjs` 5 項（3 個 CLI 竄改、2 個測試竄改）全被擋下、exit 0；design-review 10 個發現：改 8（F-2、F-3、F-4、F-5、F-6、F-8、F-9、F-10）、提 2（F-1→PD3 身分子題重議、F-7→PD5）、駁回 0；指令檔對帳改 1 處（`AGENTS.md` 補後端邊界） | 無 | 無（不改程式） | 見本列提交 |
| 2 Spike S1：SDK 比較 | 完成 | `spikes/s1-sdk/` 的 `run-node.mjs`、`run-build-node.mjs`、`bundle.mjs`、`runtime.mjs`（Chrome 155.0.8059.82、miniflare 4.20260730.0）、`probe/run.mjs`，原始輸出在 `results/`；fixture `515d0ea3…`、`3883c2a9…`（preprod）＋2 筆合成；四個選項 × 每個量測項都有數字或「不支援」；每個選項的 tx hash 等於 txHash、翻一個 bit 後不同（Mesh 在 workerd 只能以只引 `resolveTxHash` 的入口量）；停止條件未觸發；`make check` exit 0 | 真錢包對 stake key 的 `signData`／`signTx`（等真錢包）；部署後的 Workers（只跑本機 workerd） | 無（spike 不被引用） | 見本列提交 |
| 3 工程基線 | 完成 | `make check` exit 0（Biome 30 檔、tsc 三份 tsconfig、13 個測試、10 組 Python vectors、MVP `check_plan.py` OK）；瀏覽器 E2E 11 項 PASS、`mutation-check.mjs` 5 項擋下，與步驟 1 基線相同；pin 轉紅：把查詢結果文字改掉，E2E exit 1；library 打包結果除路徑註解與 `?? []` 外相同；mutation 各自讓 `make check` exit 2：未格式化的一行（format）、`apps/web` 相對引用 `spikes/`（noRestrictedImports）、`packages/protocol` 引用未宣告的 `@giveaway/verifier-cli`（noUndeclaredDependencies，根目錄可解析仍被擋）、`packages/beacon` 相對引用兄弟套件、`packages/chain` 引用 Mesh、`tests` 相對引用套件、`packages` 使用 `document`（tsc TS2584）；`pnpm install --frozen-lockfile` exit 0；design-review 開工 9 項（改 7、記 2）、完成前 6 項（改 3、記 3）；行為等價審查 2 項競態：改為 await 後重讀狀態保留舊行為，缺陷記為 F18 | CI 上的 `make check`（未推送） | `from '../…(packages\|apps\|spikes)'`：0 筆；`app.ts\|dist/library`：只剩 `tools/build.mjs` 的入口與 CLI 產物路徑 | `d031696`、`69fb0e0`、`bf266ae`、本列提交 |
| 4 verifier 正確性與 development-2 | 完成 | `make check` exit 0（Biome 30 檔、三份 tsc、20 個測試、mutation-check 4 個 CLI 竄改擋下＋3 個檔案竄改讓測試失敗、10 組 Python vectors、MVP `check_plan.py` OK）；本計畫 `check_plan.py` OK；停止條件：10 組 canonical 除 `version` 外差異 0 筆，Node 與 Python hash／得獎者相同；回歸測試改回舊寫法各自 exit 1：F3（相依檢查標 pass）、F4（加回本機時鐘檢查）、F5（拿掉欄位集合檢查）、F7（label 674）、F6（mutation-check 移除 `isTorsionFree`；另以 scratchpad 實驗確認 S+T 不經子群檢查時 pairing 成立）；瀏覽器 E2E 12 項 PASS、exit 0（基線 11 項；檢查數 8→7；新增 F18 劇本，涵蓋輪詢回應的失敗與成功兩條路），F18 mutation：拿掉兩處判斷、只拿掉 `confirm` 的判斷，E2E 各自 AssertionError；獨立 review 0 HIGH、0 MED、4 LOW（改 3：E2E 補成功路徑、mutation-check 先驗未竄改 proof 為 DEMO PASS、文件改正 demo 綁定說法；駁回 1：`commit()` 等待期間重設，`#network` 被 `lockControls` 停用） | 無（CI `make check` 於 `7b12c26` 通過，run 39101195102）；E2E 的 500 ms 固定等待只能判斷「這段時間內畫面沒變」 | 步驟 4 的消費端搜尋：剩餘命中都是刻意保留（測試裡拒收舊格式、`app.ts` 主辦端提示「Round has arrived without verified confirmations」、`docs/adr/2026-10-01-local-first-protocol-defaults.md` 的歷史紀錄） | `cffdb0d`、本列提交 |
| 5 唯一性重設計 | 完成 | Koios 列舉確認（見步驟 5 完成後的形狀；`account_txs` 169 筆以每頁 50 翻 4 頁與單頁 1,000 順序相同；`credential_txs` 1,171 筆 2 頁）；以本版 `findCommitments` 對兩個真 preprod 地址唯讀列舉：stake 5 次、payment 26 次請求，0 筆承諾、無錯誤；`make check` exit 0（Biome 30 檔、三份 tsc、27 個測試、mutation-check 4 個 CLI 竄改＋4 個檔案竄改、10 組 Python vectors、MVP `check_plan.py` OK）；本計畫 `check_plan.py` OK；回歸測試（mock Koios，`tx_info` 不帶 `_inputs` 時回空 input）：同錢包同 round 不同 drawId 兩筆都 FAIL 並互列衝突、相鄰 round FAIL、round 後補送（同 drawId 同 round／新 round）原抽獎 PASS、時間不重疊的連續兩場都 PASS（第二場用 api.drand.sh 取得並以釘死公鑰驗過的 round 1000400 beacon）、第三方帶主辦者 stake 部分的地址送重疊承諾時主辦者 PASS；另有同區塊 fail closed、round 後收錄者不擋、目標不在歷史內 FAIL、超過 5,000 筆 FAIL（5 次請求後拒絕）；mutation：衝突判定改回（地址, drawId），前兩個劇本與補送劇本 FAIL（actual PASS／expected FAIL），已接進 mutation-check；`readCommitment` 拿掉 `_inputs` 時 5 個劇本 FAIL；CI 於 `6f36258` 通過（run 39152602084，與步驟 8 一起推送） | 同錢包換 payment 地址的承諾（PD3 身分 A 的 `required_signers`＋witness）：步驟 7 範圍，步驟 5 的計入條件看不到；真鏈上的承諾劇本：preprod 尚無承諾交易（等真錢包）；`account_txs` 是否列出 stake 只出現在 input 的交易：實測的交易 input 與 output 都帶該 stake，未分離驗證（Koios 文件推論會列）；瀏覽器 E2E 與網頁的衝突清單畫面：未跑（E2E 只有 demo，沒有衝突情境） | 開工前 37 筆；完成後（本進度列寫入前）35 筆：`address_txs` 只剩兩份 2026-10-18 ADR 的歷史量測紀錄與本計畫的搜尋指令；`different-drawId` 只剩本計畫的搜尋指令；`checkUniqueness`／`findCommitments` 只在 protocol、chain、verifier 與測試；`BOUNDARY` 只在 verifier 與 `apps/web/app.ts`；計畫與 ADR 的命中是規格文字 | `aebfa4b`、本列提交 |
| 6 依 PD1、PD6 更換依賴 | 完成 | `pnpm install --frozen-lockfile` exit 0；`make check` exit 0（Biome 37 檔、四份 tsc、34 個 Node 測試、`apps/api` 10 個 vitest、mutation-check 4 個 CLI 竄改＋9 個檔案竄改、10 組 Python vectors、MVP `check_plan.py` OK）；本計畫 `check_plan.py` OK；瀏覽器 E2E 12 項 PASS、exit 0（Chrome 系統安裝版＋npx 快取的 playwright-core；127.0.0.1:4320 被另一個 worktree 的 dev server 佔用，改以 `PORT=4321 node tools/serve.mjs` 起本步的 build，並以只把網址換成 4321 的暫存副本執行 `browser-check.mjs`，斷言未改，跑完刪除）；前後比對（harness 在 scratchpad、不入庫：把該版 `apps/web/cardano.ts` 照正式設定打包，在 Node 以 mock CIP-30 與 mock Koios 執行，攔截交給 `signTx` 的未簽 CBOR，用 S1 spike 的讀取器解碼；before 跑在 `543bf1e` 的匯出檔，after 跑在本步）兩組輸入（enterprise 地址 10 ADA、base 地址 25 ADA 的 #3）：輸入、輸出地址、2 ADA 轉帳輸出、找零地址、metadata 解碼後全等，輸出＋fee＝輸入，body 欄位都是 0、1、2、7；fee Mesh 178,921／180,153、Evolution 177,909／180,373 lovelace，對 minFeeA×未簽 bytes＋minFeeB 的比值 Mesh 1.034／1.027、Evolution 1.027／1.027（2 倍以內）；停止條件未觸發；bundle（esbuild minify，raw／gzip -9 bytes）：初始載入（app.js＋靜態 chunk）241,925／76,574 → 224,788／73,810，建立頁延遲載入的 cardano chunk 5,853,484／1,511,564 → 806,245／233,211，合計 6,095,409／1,588,138 → 1,031,033／307,021；mutation：拿掉 input、transfer output、change address、balance、metadata 任一核對，對應測試失敗（已接進 mutation-check）；`packages/chain` 引用 `@evolution-sdk/evolution`（已在 package.json 宣告時由 `noRestrictedImports` 擋，未宣告時另有 `noUndeclaredDependencies`）、子路徑 `@evolution-sdk/evolution/Address`、`packages/beacon` 引用 `@meshsdk/core`，`biome check` 各自 exit 1，同一檔的 `../protocol` 相對引用仍被擋；把 `cardano.ts` 交給核對的地址改掉，harness 在 `signTx` 之前丟出 transfer output 錯誤；preprod UTxO 核對的負向案例（mock Koios 回報不同金額、查無此 UTxO）都得到「Wallet UTxO is not on preprod」，`signTx` 0 次；CI 於 `eb9a4da` 通過（run 39154422737，job check: success）；主 session 重跑 `make check` exit 0、瀏覽器 E2E 12 項 PASS | 真錢包簽 Evolution 組出的交易（等真錢包）；`cardano.ts` 對 `checkCommitmentTransaction` 的呼叫本身沒有自動測試擋（E2E 只有核對通過的路徑，拿掉呼叫不會讓任何檢查失敗） | 開工前 13 筆：`apps/web/cardano.ts` 3、`apps/web/package.json` 3、`package.json` 1、`tools/browser-check.mjs` 3、`tools/build.mjs` 3；完成後 0 筆（rg exit 1）；改過的匯出 `prepareTransaction`（回傳形狀不變）、`wallets`（只回 id、name）的呼叫端只有 `apps/web/app.ts` 與 `state.ts` 的型別推導 | `b18d6a5`、本列提交 |
| 7 CBOR 驗證 metadata、身分與時間上限 | 程式完成待驗收 | `pnpm install --frozen-lockfile` exit 0；`make check` exit 0（Biome 38 檔、四份 tsc、47 個 Node 測試、`apps/api` 10 個 vitest、mutation-check 4 個 CLI 竄改＋14 個檔案竄改、Python 10 組 vectors＋6 筆交易 hash、MVP `check_plan.py` OK）；本計畫 `check_plan.py` OK；瀏覽器 E2E 14 項 PASS、exit 0（Chrome 系統安裝版＋npx 快取的 playwright-core；新增「與計畫不符的交易不會被簽」「逾期提示更晚的 round」，F18 劇本改由測試金鑰真簽章並走 `tx_cbor`）；F2 回歸：同一支測試對 `78a37e3` 的實作得 actual PASS／expected FAIL，對本步得 FAIL（scratchpad 以舊 library 的 `KoiosChain`、`verifyProof` 替換執行）；F17、PD3 witness、同錢包換地址、aux 替換四支新測試對舊實作也都失敗；mutation（已接進 mutation-check）：略過 aux hash 比對→`F2: auxiliary data replaced` 失敗、略過 Ed25519 驗章→`PD3 witness` 失敗、略過時間上限→`F17` 失敗，另有組完重讀的 required signers、validity 兩項；E2E mutation：拿掉 `checkCommitmentTransaction` 呼叫→E2E exit 1；Node 與 Python 對 6 筆 fixture 的 tx hash、aux hash 相同，改一個 byte 後不同；唯讀 Koios preprod：`findCommitments` 對步驟 5 的兩個地址 5 次、26 次請求（與步驟 5 相同）、0 筆承諾；真交易 `05aba404`（tag 258 `required_signers`）的 witness 驗章通過、改一個 byte 後不通過；審查修正 1（MED-1）：indexer 有交易列但 `cbor` 為 null 時改丟 `CborPendingError`（不再當 `NotIndexedError`），頁面過 `invalid_hereafter` 仍繼續輪詢、不叫人換 round 重送；新增 Node 測試「lists without its CBOR」與 E2E「indexed transaction without CBOR keeps polling past invalid_hereafter」，兩者在 `846d915` 上失敗（E2E 顯示 expired 訊息）、修正後通過；修正後 `make check` exit 0（48 個 Node 測試）、E2E 15 項 PASS（`tools/browser-check.mjs` 改讀 `PORT`） | CI（未推送）；真錢包是否替 `required_signers` 的 stake key 簽章、送出的承諾能否在 `invalid_hereafter` 前收錄（等真錢包）；Ed25519 與 ledger（libsodium）在非 canonical 簽章上的一致性：未量 | 開工前 49 行（`78a37e3`）；完成後 88 行，增加的是測試與新函式（`readCommitmentTransaction`、`invalidHereafter`、`checkValidityBound` 等）；`tx_info`、`payment_addr` 只剩 `readCommitment` 的主辦者 input 檢查與 E2E mock，`tx_metadata` 只剩列舉時挑選 label 的批次查詢與 E2E mock；`setTTL` 0 筆；改過的匯出：`Confirmed` 加 `validUntil`（建構處 `DemoChain.confirm`、`DemoChain.readCommitment`、`KoiosChain.readCommitment`）、`CommitmentPlan` 加 `signer`、`invalidHereafter`（呼叫端 `apps/web/cardano.ts` 與測試）、`checkTiming` 簽名不變（呼叫端 verifier、`app.ts` 的 `confirm`、`reveal`） | `f27faba`、本列提交 |
| 8 後端 walking skeleton | 完成 | `pnpm install --frozen-lockfile` exit 0（`allowBuilds` 加 `workerd: false`：與 esbuild 相同，binary 由平台 optionalDependency 提供，postinstall 只做檢查；本機 `wrangler dev` 與 vitest 都在不跑 postinstall 下啟動 workerd）；`make check` exit 0（Biome 37 檔、四份 tsc 含 `apps/api/tsconfig.json`、20 個 Node 測試、`apps/api` 10 個 vitest 測試跑在 workerd、mutation-check、10 組 Python vectors、MVP `check_plan.py` OK）；`make api`（`wrangler dev`，127.0.0.1:8787）＋curl `/tip`：HTTP 200、`Access-Control-Allow-Origin: http://127.0.0.1:4320`、真 Koios preprod tip（block 5307496、epoch 320），停止條件未觸發；`/blocks` 404、`/tip?select=hash` 400、POST 405；瀏覽器（Chrome 155.0.8059.82＋npx 快取 playwright-core，scratchpad 腳本，未進 repo）：`make dev` 頁面切到 preprod 後 `#chain-tip` 顯示「Preprod tip via the backend proxy: block 5307496 · epoch 320 …」，請求只有 `http://127.0.0.1:8787/tip`、直連 koios.rest 0 次；停掉 Wrangler 後顯示「unavailable … (Failed to fetch)」；`browser-check.mjs` 12 項 PASS、exit 0（與步驟 4 相同）；mutation：`packages/protocol` 加 `export { handle } from '@giveaway/api'` → `noUndeclaredDependencies`，`make check` exit 2；改成 `'../../apps/api/src/index.ts'` → `noRestrictedImports`（另有 4 個 `noImportCycles`），exit 2；新 override `apps/*/*/*` 禁止 `../../**`：`apps/api/src` 內引用 `../../../packages/…`、`../../web/…` 被擋，`../proxy.ts` 不擋；拿掉 query 拒收，對應 vitest 測試失敗；`GIVEAWAY_API_URL=` 空字串時 build 失敗（Invalid URL） | CI 於 `6f36258` 通過（run 39152602084，job check: success；Linux 上 workerd 不跑 postinstall 也能啟動，步驟 8 的疑點排除） | `rg -n "apps/api" packages apps/verifier-cli`：0 筆（exit 1）；`rg -n "include\|allowBuilds" tsconfig.base.json packages/tsconfig.json pnpm-workspace.yaml biome.json`：`packages/tsconfig.json` 的 `*/*.ts`（不含 apps）、`biome.json` 四組 includes（新增 `apps/*/*/*`）、`pnpm-workspace.yaml` 的 `allowBuilds`。步驟 3 的 build 觸發條件判定不需執行：`apps/api` 沒有建置產物，`wrangler dev` 與 vitest-plugin 各自打包 `src/index.ts`，`tools/build.mjs` 只多了 `GIVEAWAY_API_URL` 的 define；拆成各套件 `build` script 的觸發條件改為只剩步驟 6 移除 alias，或部署（MVP 步驟 10）需要 `wrangler deploy` 前先建網頁 | `19c26e2`、本列提交 |
| 9 proxy 完整版 | 未開始 | | | | |
| 10 bundle 代管與 CLI bundle 模式 | 未開始 | | | | |
| 11 擁有者簽章操作 | 未開始 | | | | |
| 12 草稿保存 | 未開始 | | | | |
| 13 文件、隱私說明與下架流程 | 未開始 | | | | |
| 14 收尾 | 未開始 | | | | |
