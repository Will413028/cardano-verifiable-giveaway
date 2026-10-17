# 協定硬化與 TypeScript 便利層後端

**Goal：** verifier 的已知缺陷（附件 `inventory.md` F1–F7、F9–F16）全部依處置完成；新增的 TypeScript 後端（Cloudflare Workers）提供唯讀 indexer proxy、bundle 代管、錢包簽章的擁有者操作與草稿保存。CI 跑 `make check` 全綠；瀏覽器 E2E 在本機手動跑通（CI 沒有瀏覽器環境）。後端關閉時，持有下載 bundle 者仍能用 CLI 驗證。驗收見步驟 14。

**上層：** `docs/plans/2026-10-01-verifiable-giveaway-mvp.md`（MVP 計畫）。本檔沿用它的「全域約束與完成定義」，不重複；主清單見本機個人脈絡檔。

**附件：** `docs/plans/2026-10-18-hardening-and-backend/`：`inventory.md`（既有缺陷與會改變的行為，含處置與去向）、`requirements.md`（後端需求、非功能需求、外部介面）、`check_plan.py`（本計畫的一次性機械檢查）。快照 commit `32d289c`。

## 前提（開工時核對過，2026-10-18）

- **會改到或取代的既有部署是否在線：** 無既有部署（README「Status」：No public deployment）。本計畫不部署後端；部署屬 MVP 計畫步驟 10，需要 Will 授權。鏈上沒有任何人依賴的承諾，協定可自由修改；上鏈後不能改的承諾已由 MVP 計畫 I3 規範。
- 後端範圍、禁止事項、帳號與保存期限依兩份 ADR：`docs/adr/2026-10-18-typescript-convenience-backend.md`、`docs/adr/2026-10-18-wallet-auth-and-bounded-retention.md`（來源：Will，2026-10-18；已確認）。
- Koios 公開層擋瀏覽器 CORS（真 Chrome 實測，2026-10-18；已確認）。Worker 從伺服器端呼叫不受 CORS 限制，本機開發不需要 API key（推論，步驟 8 驗證）；正式額度需要 Will 申請的 Free key（未確認）。
- Koios 條款是否允許代理轉發與快取（未確認；步驟 9 開工時讀條款確認，不允許就停）。
- 真錢包仍延後（MVP 計畫前提 P2）：自動化測試用測試內產生的金鑰與 mock CIP-30，不使用任何個人錢包或助記詞；preprod 上尚無自己的承諾交易（MVP 附件 `spike-a.md`「鏈上樣本 0」），需要真承諾的驗收標為「等真錢包」（已確認）。
- 工具鏈（預設，可推翻）：Biome 負責 lint 與格式化；後端用 Wrangler 與 Miniflare 在本機執行，測試用 `@cloudflare/vitest-pool-workers`；bundle 存 R2、紀錄存 D1、限流用 Rate Limiting binding、到期清理用 Cron Triggers。新增套件屬下載，版本鎖在 lockfile。
- 開發期 metadata label 改用 [CIP-10 registry](https://github.com/cardano-foundation/CIPs/blob/master/CIP-0010/registry.json) 未登記的數字（預設，可推翻；步驟 4 選定並記錄查詢日期）；CIP-10 註冊留給 v1 凍結（MVP 計畫 D7）。
- 安全參數：簽章 payload 5 分鐘有效、nonce 一次性（依 [CIP-93](https://cips.cardano.org/cip/CIP-0093) 的建議時間窗）；不用 cookie（[OWASP CSRF Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)）。

**驗收基線：** commit `32d289c` 上 `make check` 全綠：lint、typecheck、13 個測試、10 組 Python vectors、`check_plan.py` OK（2026-10-18 實跑）。瀏覽器 E2E（`tools/browser-check.mjs`）與 `tools/mutation-check.mjs` 本次未跑，由步驟 1 建立基線。已知問題列在附件 `inventory.md`，依各自的處置在本計畫內修。

## 本階段依賴的不變量

沿用 MVP 計畫的 I1–I9；PD3 會改寫 I5、I7（見 PD3）。本計畫新增：

| 不變量 | 依賴它的機制（新系統先寫預計的模組） |
|---|---|
| B1 驗證不依賴後端：verifier 不引用後端模組；CLI 只直連 indexer 與 drand relay；後端停擺不影響 PASS 判定 | `packages/protocol/verifier.ts`、`packages/beacon/index.ts` 的 `fetchBeacon`、`apps/verifier-cli/index.mjs`、`apps/api/`（預計）、`tools/lint.mjs` 的邊界檢查 |
| B2 後端不簽署、不送出交易、不持有私鑰、不產生 randomness、不判定 PASS／FAIL、不改寫 indexer 回應 | `apps/api/src/proxy.ts`（預計）、`apps/web/cardano.ts` 的 `submitTx` |
| B3 後端不存密碼、email、OAuth token 或 session token（依 PD4） | `apps/api/src/auth.ts`（預計）、D1 schema |
| B4 只代管已上鏈承諾、通過 `validateBundle` 的 bundle；擁有權綁定第一筆（bundleHash, txHash, owner），刪除留 tombstone | `apps/api/src/bundles.ts`（預計）、`packages/protocol/index.ts` 的 `validateBundle`、D1 schema |
| B5 保存有期限：bundle 到 round 後 12 個月（延長上限依 PD4）、伺服器草稿 30 天 | `apps/api/src/retention.ts`（預計）、Cron Trigger |
| B6 proxy 快取不得讓唯一性列舉漏掉交易：未滿頁的最後一頁不快取 | `apps/api/src/proxy.ts`（預計）的快取層、`packages/chain/index.ts` 的 `findCommitments` |

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

- [ ] **1. 開工基線與設計審查**（被擋於：無）
  - 範圍：先 `make dev`，再以 `GIVEAWAY_PLAYWRIGHT_MODULE=<playwright-core/index.mjs> GIVEAWAY_CHROME_PATH=<Chrome 執行檔> node tools/browser-check.mjs` 跑瀏覽器 E2E；跑 `node tools/mutation-check.mjs`；兩者結果記入進度表。對本計畫跑 design-review skill，處理每個發現（改計畫或寫駁回理由）。
  - 消費端：無（不改程式）。
  - 不能動：程式碼。
  - 驗收：進度表貼兩個工具的實際輸出；design-review 的發現逐條有處置。
  - 停止條件：任一工具在快照上就失敗——把失敗列進基線，不在本步修。

- [ ] **2. Spike S1：Cardano SDK 比較**（被擋於：無）
  - 範圍：拋棄式程式放 `spikes/s1-sdk/`，不被產品引用。比較 Mesh（現用）、Evolution SDK、Blaze：瀏覽器 bundle 大小、需要的 polyfill 數、能否在瀏覽器與 Workers 解析交易 CBOR 並重算 tx hash 與 auxiliary data hash、能否從前一筆交易的 CBOR 解出 output 地址、能否驗證 CIP-8 COSE_Sign1 簽章、能否組出帶 metadata 的自轉交易、套件維護狀態。產出附件 `spike-s1.md`。
  - 消費端：無（spike 不被引用）。
  - 不能動：產品程式碼；不連主網。
  - 驗收：`spike-s1.md` 每個 SDK 每個量測項都有數字或「不支援」並附重現指令；同一筆 fixture 交易，三個 SDK 算出的 tx hash 一致，改一個 byte 後要不同。
  - 停止條件：沒有任何 SDK 能在 Workers 驗證 COSE 簽章——停下回報，PD1 與步驟 11 改用新事實。
  - 完成後的狀態：PD1 可以拍板。

- [ ] **3. 工程基線：Biome 與拆分 `app.ts`**（被擋於：步驟 1）
  - 範圍：導入 Biome（lint＋格式化）並接進 `make check`，保留 `tools/lint.mjs` 的 spike 邊界檢查；把 `apps/web/app.ts` 拆成狀態、畫面與服務模組，移除模組層級的可變全域狀態。只改結構，不改行為（F12）。
  - 消費端：`rg -n "from '\.\./\.\./packages|from '\./" apps/web`；`rg -n "app\.js|app\.ts" tools Makefile`
  - 不能動：所有使用者看得到的行為、DOM id、`browser-check.mjs` 的斷言。
  - 驗收：`make check` 全綠；瀏覽器 E2E 與步驟 1 的基線相同；mutation：加入一行未格式化的程式碼，`make check` 要失敗。
  - 停止條件：拆分需要改 DOM 或 E2E 斷言才能通過——停下，代表動到行為。

- [ ] **4. verifier 正確性修正與 `development-2`**（被擋於：步驟 3）
  - 範圍：F3（相依檢查在證據失敗時標「未評估」，`Check.passed` 改成三態，網頁與 CLI 的 JSON 輸出同步）、F4（刪除「Round has arrived」與對應的動態 import）、F5（proof 只帶 network、bundle、`txHash`、owner、beacon、winners；「已收錄」與「已確認」分成兩個型別，移除 `confirmedAt: 0`）、F6（torsion point 負向測試）、F7（改用開發期私有 label）。協定版本升為 `development-2`：`tools/reference.py` 改版本字串後重產 `tests/vectors.json`，同步更新 `docs/protocol-development.md`。`tools/mutation-check.mjs` 改用新格式並接進 `make check`。round 前公告（`giveaway-pending-1`）改帶 `txHash`＋owner，不再帶完整 commitment。
  - 消費端：`rg -n "confirmedAt|giveaway-proof-1|giveaway-pending-1|development-1|LABEL|Round has arrived|validateProof|passed|Verdict|count\(\), 8|mutation-check" packages apps tools tests docs Makefile`
  - 不能動：bundle 的欄位集合與 canonical JSON 規則；抽選演算法；DEMO PASS 與 PASS 的區分。
  - 驗收：`make check` 全綠（含 mutation-check）；重產的 vectors 由 Node 與 Python 兩邊算出相同的 bundle hash 與得獎者；inventory F3–F7 各一個回歸測試，把修正改回舊寫法時該測試要失敗；瀏覽器 E2E 與基線的差異只有已知的檢查項數與 proof 格式。
  - 停止條件：canonical 輸出除了 `version` 欄位之外有任何差異——停下，代表動到 canonical 規則。

- [ ] **5. 唯一性重設計**（被擋於：PD3；步驟 4）
  - 範圍：開工先確認 Koios 能依 PD3 的身分列舉交易（例如 stake credential 用 `account_txs`），記錄端點、分頁數與請求數，再交 PD3 的身分子題拍板。依 PD3 改寫 `checkUniqueness` 與 `findCommitments`，驗證頁與 CLI 列出衝突的承諾。同步改 `BOUNDARY` 常數、`docs/protocol-development.md` 的唯一性段，並在 MVP 計畫 I5、I7、D3、D7 加註由 PD3 接手（F1）。
  - 消費端：`rg -n "checkUniqueness|findCommitments|address_txs|BOUNDARY|different-drawId" packages apps tools tests docs`
  - 不能動：「同一區塊多筆時 fail closed」；分頁上限超過時判 FAIL；round 時間之後才收錄的承諾不影響已完成的抽獎（`docs/protocol-development.md` 現行規則）。
  - 驗收：回歸測試四個劇本——同錢包、同 round、不同 drawId；同錢包、相鄰 round（R 與 R+1）；round 後補送一筆；兩場時間區間不重疊的連續抽獎。前兩者新實作判 FAIL（舊實作 PASS），第三者不影響原抽獎，第四者兩場都 PASS；mutation：把衝突判定改回（地址, drawId），前兩個劇本的測試要失敗。
  - 停止條件：Koios 沒有能依 PD3 身分列舉交易的端點——停下，PD3 的身分子題改用新事實。

- [ ] **6. 依 PD1 更換 SDK**（被擋於：PD1；步驟 4）
  - 範圍：PD1 選維持 Mesh 時本步標「不做」並寫明依據。否則把 `apps/web/cardano.ts` 與 `packages/chain` 的 Mesh 用法換成選定的 SDK，移除不再需要的 polyfill 與 alias（F16）。
  - 消費端：`rg -n "@meshsdk|cst\.|polyfills|crypto-browserify|stream-browserify" apps packages tools package.json`
  - 不能動：交易內容（輸出、metadata、找零規則）；mainnet 拒絕與 preprod UTxO 核對。
  - 驗收：`make check` 與瀏覽器 E2E 全綠；同一組輸入在換 SDK 前後產生的未簽交易，解碼後比對語意欄位：輸入、輸出地址與金額、metadata 解碼後相等、找零地址、fee 在即時參數估計值的 2 倍以內；bundle 大小記錄在進度表。
  - 停止條件：新 SDK 產生的交易無法通過既有的 mock preprod 檢查。

- [ ] **7. 以交易 CBOR 驗證 metadata 與 owner**（被擋於：步驟 5、6）
  - 範圍：verifier 改向 indexer 取原始交易 CBOR，自行確認 tx hash 與 auxiliary data hash，再從 CBOR 解出 metadata；owner 是否為 input，改由取回 input 參照的前一筆交易 CBOR、自驗 hash 後解出 output 地址判定。唯一性列舉的交易清單仍來自 indexer，列出的每筆交易同樣走 CBOR 自驗。剩下的信任面——indexer 可以漏列交易，也可以謊報收錄區塊與時間——寫進 inventory F13 的處置與 `docs/protocol-development.md`（F2、F13）。CLI 與瀏覽器共用同一實作。
  - 消費端：`rg -n "readCommitment|tx_metadata|tx_info|commitmentFrom|payment_addr" packages apps tools tests`
  - 不能動：時間與確認數規則；`--indexer` 參數。
  - 驗收：F2 的回歸測試（indexer 回傳竄改的 metadata JSON、CBOR 不變），舊實作 PASS、新實作 FAIL；indexer 謊報 input 地址時要 FAIL；CBOR 被改一個 byte 時要 FAIL；mutation：略過 auxiliary data hash 比對或前一筆交易的 hash 比對，各自的測試要失敗。

- [ ] **8. 後端 walking skeleton**（被擋於：步驟 3）
  - 範圍：新增 `apps/api/`（Workers，TypeScript），共用 `packages/`；`apps/api/tsconfig.json` 使用 Workers 型別，`make typecheck` 涵蓋它；依需要調整 `pnpm-workspace.yaml` 的 `allowBuilds`，CI 的 `pnpm install --frozen-lockfile` 要能通過。本機以 Wrangler 執行，`make check` 跑後端測試。網頁以建置時的 `GIVEAWAY_API_URL`（預設 `http://127.0.0.1:8787`）取得 proxy 位址。接通最薄的一條路徑：網頁經 proxy 取得 Koios `/tip` 並顯示（BR-01 的第一個端點）。`tools/lint.mjs` 加上「`packages/` 與 `apps/verifier-cli` 不得引用 `apps/api`」的邊界檢查（B1）。
  - 消費端：無（新模組）；邊界檢查：`rg -n "apps/api" packages apps/verifier-cli`；設定：`rg -n "include|allowBuilds" tsconfig.json pnpm-workspace.yaml`
  - 不能動：CLI 的直連行為；Demo 模式。
  - 驗收：CI 的 install 與 `make check`（含後端 typecheck 與測試）全綠；本機瀏覽器經 proxy 取得 tip（真 Koios，唯讀）；mutation：在 `packages/protocol` 加一行引用 `apps/api`，`make check` 要失敗。
  - 停止條件：Worker 呼叫 Koios 公開層也被拒——停下回報，需要 Will 先申請 key。

- [ ] **9. proxy 完整版與交易改由錢包送出**（被擋於：步驟 7、8；前提「Koios 條款允許代理與快取」）
  - 範圍：BR-01、BR-02、BR-03、BR-04、BR-05、BR-15、BR-16：端點 allowlist、每請求一個地址、（address, offset）快取且未滿頁不快取（B6）、依 IP 與 owner 限流、全域預算、CORS 只開放設定的網域、不記錄請求內容；交易改由 CIP-30 `submitTx` 送出（F14）；驗證頁顯示證據來源並可改用其他 indexer（F13 的後半）；新增不 mock 的瀏覽器 E2E（F10、F11），使用一筆 preprod 上任意帶 metadata 的公開交易（開工時選定並把 txHash 記入進度表）。一次完整驗證的 Koios 請求數以 mock indexer 的計數器量測，據此設定限流值。
  - 消費端：`rg -n "KoiosChain|DEFAULT_INDEXER|KoiosProvider|submitTx|koios\.rest" apps packages tools tests`
  - 不能動：B1、B2、B6；CLI 預設直連。
  - 驗收：後端測試涵蓋 allowlist 外端點被拒、超過限流回 429、跨網域 CORS 被拒、請求內容不出現在 log；不 mock 的 E2E 經 proxy 讀到選定交易的 metadata；mutation：拿掉 allowlist、限流或「未滿頁不快取」，各自的測試要失敗（後者：快取最後一頁後再新增一筆承諾，唯一性列舉要看得到它）；mock 錢包記錄 `submitTx` 被呼叫，改回 provider 送出時測試要失敗。
  - 停止條件：Koios 條款不允許代理轉發或快取——停下，交 Will 決定改用其他 indexer 或付費方案。
  - 需要人做的事：申請 Koios Free API key 存本機（碰憑證，由 Will 處理；本機與 CI 不需要，部署前需要）。

- [ ] **10. bundle 代管與 CLI 的 bundle 模式**（被擋於：步驟 9；PD4 擋住每個 owner 的額度；PD2 擋住 CPU 驗收）
  - 範圍：BR-06、BR-07、BR-08、BR-10、BR-17、BR-18：上傳門檻（hash 對上已上鏈承諾、`validateBundle`、大小上限）、擁有權綁定第一筆、tombstone、每個 owner 的保存額度、12 個月保存與 Cron 清理；驗證連結改為 `txHash`＋bundleHash，網頁以 bundleHash 從代管或其他網址取回並核對（F9）。下載產物改為兩個檔：canonical bundle bytes（`<drawId>.bundle.json`）與 proof。CLI 新增 `node apps/verifier-cli/index.mjs <bundle.json> --tx <txHash>`，自行向 drand relay 取 beacon 並重算；原本的 proof 模式保留。量測 1 萬筆×200 字元 bundle 在 Workers 的 CPU 時間，交 PD2 拍板。
  - 消費端：`rg -n "loadUrl|share-link|bundle=|hash=|showShare|download" apps tools tests`；CLI：`rg -n "verifyProof|argv" apps/verifier-cli`
  - 不能動：B1、B4；CLI 的 proof 模式與 exit code 語意。
  - 驗收：後端測試涵蓋 hash 不符、`validateBundle` 失敗、超過大小、承諾不存在、第二個 owner 上傳同一 bundle、tombstone 後重傳、超過 owner 額度、到期清理（時間注入）；E2E 以新連結格式在 demo 模式完成 DEMO PASS；Node 測試以注入的假 chain 跑 CLI 的 bundle 模式，後端未啟動時結果 PASS；mutation：略過 `validateBundle` 或 tombstone 檢查，各自的測試要失敗。真鏈的 CLI 交叉驗收等真錢包（MVP 計畫步驟 8）。
  - 停止條件：最壞情況的 CPU 時間超過付費方案上限——停下，代表要改成分段處理，交 Will 決定。

- [ ] **11. 擁有者簽章操作**（被擋於：步驟 10；PD1；PD4）
  - 範圍：BR-09、BR-13：nonce 端點、CIP-30 `signData` payload（網域、操作、bundleHash、network、nonce，5 分鐘有效），依 PD4 的驗證形式送出；後端驗章並確認 key 屬於 owner 地址；刪除與延長（延長上限依 PD4）；刪除後介面提醒保留下載副本。
  - 消費端：無（新端點）；網頁呼叫端：`rg -n "signData" apps`
  - 不能動：B2、B3；owner 取自承諾交易，不取錢包目前的 change address。
  - 驗收：以測試內產生的金鑰簽章；測試涵蓋過期 payload、重用 nonce、別的網域、別的 network、非 owner 的 key、超過延長上限全部被拒；mutation：拿掉 nonce 一次性檢查或 key 與 owner 的比對，各自的測試要失敗。

- [ ] **12. 草稿保存**（被擋於：步驟 11；PD4）
  - 範圍：BR-11、BR-12：本機 IndexedDB 草稿與匯出、重新整理後恢復；伺服器草稿依 PD4 的身分與額度，需簽章存取、30 天後自動刪除。
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

- **PD1 Cardano SDK**（狀態：未決；擋住步驟：6、11；需要的事實：步驟 2）
  - A：維持 Mesh——不用改；代價是 5 個 polyfill 與較大的 bundle。
  - B：Evolution SDK——純 TypeScript、無 WASM（MVP 計畫 `external-interfaces.md` E7）；成熟度待 S1 確認。
  - C：Blaze——成熟度與 Workers 相容性待 S1 確認。
  - 建議：在「瀏覽器與 Workers 都能解析 CBOR、解出前一筆交易的 output 地址、驗 COSE 簽章」的選項中選 bundle 最小者；都能做時不偏好維持現狀。
- **PD2 Workers 方案**（狀態：未決；擋住步驟：10 的 CPU 驗收；需要的事實：步驟 10 的 CPU 量測）
  - A：Free——零成本；每請求 CPU 10 ms。
  - B：付費方案——每月固定費用；CPU 預設 30 秒。
  - 建議：最壞情況超過 10 ms 就選 B，不為了留在 Free 而縮小 bundle 上限。
- **PD3 唯一性規則**（狀態：規則子題未決，可現在拍；身分子題未決，需要的事實：步驟 5 開頭的列舉端點確認；擋住步驟：5）
  - 規則子題（攻擊劇本：主辦者送多筆承諾，開獎後公布有利的那一場；或開獎後補送一筆讓已完成的抽獎失效）：
    - A：時間區間重疊即衝突——每筆承諾的區間是〔收錄時間, round 時間〕；同一身分的兩筆承諾區間重疊就兩筆都判 FAIL，round 之後才收錄的承諾不影響已完成的抽獎。擋住換 drawId、換相鄰 round 與事後補送三種劇本；代價是同一錢包不能同時進行兩場時間重疊的抽獎，要同時辦就得用不同錢包，而跨錢包本來就無法判定。（建議）
    - B：（身分, round）——換相鄰 round 就能繞過。
    - C：維持（地址, drawId）以最早一筆為準——換 drawId 就能繞過，等於沒修 F1。
  - 身分子題：
    - A：stake credential，地址沒有 stake 部分時用 payment credential——同一 HD 錢包換地址也會被算進去。（建議，前提是 Koios 有可用的列舉端點）
    - B：payment credential——列舉最簡單；換地址就能繞過。
  - 對不變量的影響：改寫 MVP 計畫 I5（唯一性規則）與 I7、`BOUNDARY` 常數的驗證邊界文字；提前拍板 MVP 計畫 D3、D7 的唯一性子題，步驟 5 在 MVP 計畫加註。
- **PD4 擁有者驗證形式、草稿身分與額度**（狀態：未決；擋住步驟：10 的 owner 額度、11、12；需要的事實：無）
  - 驗證形式：
    - A：每次操作都簽章，簽好的 payload 放在 `Authorization` header，不發 session——無狀態，後端不存任何 token；代價是每次操作都要錢包確認。（建議）
    - B：簽一次換短效 session token——操作較順；要保存、過期與撤銷 token，增加 B3 的範圍。
  - 草稿身分：簽章錢包的身分（與 PD3 身分子題同一規則）；草稿在上鏈前就存在，無法取自承諾交易。
  - 額度與上限（數字為建議預設）：每個身分最多 5 份伺服器草稿、每份不超過協定的 bundle 上限；每個 owner 最多 20 份代管中的 bundle；每次延長 12 個月，總保存不超過 round 後 36 個月。
  - 選 A 時，後端 ADR 的「bearer token」改寫為「簽章 payload 放在 Authorization header」。

拍板順序：PD3 規則子題與 PD4 可以現在拍；PD3 身分子題等步驟 5 開頭的列舉確認；PD1 等步驟 2；PD2 等步驟 10 的量測。

## 進度

狀態值：未開始／進行中／程式完成待驗收／完成。

| 步驟 | 狀態 | 已跑的驗收 | 未跑的驗收與原因 | 消費端搜尋結果 | commit |
|---|---|---|---|---|---|
| 1 開工基線與設計審查 | 未開始 | | | | |
| 2 Spike S1：SDK 比較 | 未開始 | | | | |
| 3 工程基線 | 未開始 | | | | |
| 4 verifier 正確性與 development-2 | 未開始 | | | | |
| 5 唯一性重設計 | 未開始 | | | | |
| 6 依 PD1 更換 SDK | 未開始 | | | | |
| 7 CBOR 驗證 metadata 與 owner | 未開始 | | | | |
| 8 後端 walking skeleton | 未開始 | | | | |
| 9 proxy 完整版 | 未開始 | | | | |
| 10 bundle 代管與 CLI bundle 模式 | 未開始 | | | | |
| 11 擁有者簽章操作 | 未開始 | | | | |
| 12 草稿保存 | 未開始 | | | | |
| 13 文件、隱私說明與下架流程 | 未開始 | | | | |
| 14 收尾 | 未開始 | | | | |
