# 既有缺陷與行為盤點

快照：commit `32d289c`（2026-10-18）。來源：2026-10-18 的設計審查（兩輪獨立 subagent 審查）與本次讀碼；行號以快照為準。步驟 3 之後的路徑：`packages/protocol/verifier.ts` 移到 `packages/verifier/index.ts`，`tools/polyfills.js` 移到 `apps/web/polyfills.js`，`tools/lint.mjs` 已刪除。機械檢查：`python3 check_plan.py`（同目錄）。

處置值：修（附回歸測試：舊行為下會失敗）／接受（附理由）／等決定（附決定編號）。

## 既有缺陷

| ID | 缺陷 | 位置 | 處置 | 回歸測試或理由 | 步驟 |
|---|---|---|---|---|---|
| F1 | 唯一性只比對（地址, drawId），主辦者換 drawId 或地址就能送多筆承諾後挑結果 | `packages/protocol/index.ts:83-89`、`packages/chain/index.ts:65-90` | 修（依 PD3） | 同一錢包、同一 round、不同 drawId 的兩筆承諾，舊實作回 PASS，新實作要標出並判 FAIL；第三方帶主辦者 stake 部分、無身分 key 簽章的承諾不影響主辦者 | 5、7 |
| F2 | metadata 直接採信 indexer 的 JSON，indexer 可偽造 bundleHash | `packages/chain/index.ts:43-44,77-78` | 修 | indexer 回傳竄改過的 metadata JSON、原始 CBOR 不變時，舊實作 PASS，新實作要 FAIL | 7 |
| F3 | 鏈上證據失敗時，hash／時間／唯一性改用 proof 自帶的資料計算，可能顯示綠勾 | `packages/protocol/verifier.ts:15,23-28` | 修 | indexer 失敗時，舊實作有 `passed: true` 的相依檢查，新實作要標「未評估」 | 4 |
| F4 | 「Round has arrived」用本機時鐘，BLS 有效已證明 round 存在，只會因時鐘偏差誤判 | `packages/protocol/verifier.ts:30-31` | 修（刪除） | 本機時鐘落後、beacon 有效時，舊實作 FAIL，新實作 PASS | 4 |
| F5 | proof 帶著 preprod 會被重新讀取的 commitment 欄位（可偽造的冗餘）；`confirmedAt: 0` 當 sentinel | `packages/protocol/index.ts:14-21,94-98`、`packages/chain/index.ts:16,54` | 修 | proof 帶多餘欄位時，新 schema 要拒收；型別分開「已收錄」與「已確認」 | 4 |
| F6 | BLS 子群檢查由套件內部完成，但沒有測試鎖住 | `packages/beacon/index.ts` | 修 | 以 torsion point 構造的簽章要被拒絕；把檢查拿掉時測試要失敗 | 4 |
| F7 | metadata label 674 是 CIP-20 的訊息 label，payload 不符其格式，註解寫成「不是 CIP-10 註冊」 | `packages/chain/index.ts:4` | 修：改用開發期私有 label；CIP-10 註冊留給 v1 凍結（MVP 計畫 D7） | 讀到 674 的承諾時新實作要判為不支援 | 4 |
| F8 | 15 個確認沒有寫明防的是什麼威脅 | `packages/protocol/index.ts:6`、`packages/chain/index.ts:55-60` | 等決定（MVP 計畫 D7） | v1 凍結時一起定 | 延後 |
| F9 | 代管的是整份 proof 檔，hash 不在鏈上，無法以鏈上承諾當上傳門檻 | `apps/web/app.ts:196-205` | 修 | 驗證連結只帶 `txHash`＋bundleHash 時要能完成驗證；舊格式連結回明確錯誤 | 10 |
| F10 | 瀏覽器直連 Koios 被 CORS 擋，網頁 preprod 流程不可用 | `packages/chain/index.ts:30`、`apps/web/cardano.ts:10-15` | 修：原為經 proxy；2026-10-19 PD7 改為讀專案自架 Dolos（`permissive_cors` 預設開放，步驟 8b 換介面卡），是否仍經 proxy 依 PD8 | 不 mock indexer 的 E2E 經 proxy 取得 tip 與 metadata | 9 |
| F11 | 瀏覽器 E2E mock 掉 Koios，因此沒發現 F10 | `tools/browser-check.mjs:78` | 修 | 新增不 mock 的 E2E 路徑 | 9 |
| F12 | lint 只查行尾空白；無 formatter；`app.ts` 有 15 行超過 160 字元且使用全域可變狀態 | `tools/lint.mjs`、`apps/web/app.ts` | 修 | Biome 檢查納入 `make check`；故意加一行超長或未格式化的程式要失敗 | 3 |
| F13 | 需求「單一 indexer 回傳值不當成唯一事實」與預設只用一家 Koios 不符 | `docs/plans/2026-10-01-verifiable-giveaway-mvp/requirements.md` §3、`packages/protocol/verifier.ts:18` | 修（部分）：CBOR 自驗 metadata 與 owner＋可指定 indexer；剩下的信任面（漏列交易、謊報收錄區塊與時間）寫進協定文件；預設交叉比對維持 MVP 計畫的延後項。步驟 7 完成前半（2026-10-19）：承諾交易與列舉中 label 符合的交易都從 `tx_cbor` 自驗 tx hash、aux data hash、metadata、`required_signers` 的 witness 與 `invalid_hereafter`；剩下的信任面寫在 `docs/protocol-development.md`「What the indexer is still trusted for」：漏列交易（列舉本身與用來挑選的 metadata JSON）、謊報收錄區塊與時間（區間起點與 15 個確認的時間；收錄時間的上界已由 `invalid_hereafter` 交給 ledger）、謊報承諾交易的 input 地址（否認只會讓驗證失敗；列舉中的交易不看 input 地址，與漏列等價）；後半（可指定 indexer 的網頁）2026-10-19 依 PD7 移到步驟 8b（附件「步驟」欄只認整數，故仍列 9），證據來源顯示屬步驟 9 | 見 F2 的測試；驗證頁可改用其他 indexer | 7、9 |
| F14 | 交易經 Koios provider 送出，而非錢包 | `apps/web/cardano.ts:30` | 修：改用 CIP-30 `submitTx` | mock 錢包記錄 `submitTx` 被呼叫；改回 provider 送出時測試要失敗 | 9 |
| F15 | `external-interfaces.md` E5 的 Koios pricing 連結已 404 | `docs/plans/2026-10-01-verifiable-giveaway-mvp/external-interfaces.md:13` | 修：原為改指 tiers 頁；2026-10-19 PD7 後改為把 E5 改寫成 Blockfrost 相容 indexer 與 Dolos，Koios 標為已移除 | 不適用（文件） | 13 |
| F16 | 只為一筆自轉交易引入 Mesh 與 5 個 polyfill | `package.json`、`tools/build.mjs`、`tools/polyfills.js` | 等決定（PD1） | spike S1 的量測 | 2、6 |
| F17 | 承諾交易沒有設 validity interval 上限，「在 round 之前收錄」完全採信 indexer 的時間（design-review 2026-10-18） | `apps/web/cardano.ts:19-22`、`packages/protocol/verifier.ts` 的時間檢查 | 修（依 PD5） | `invalid_hereafter` 晚於 round 或缺少的承諾，舊實作 PASS、新實作 FAIL | 7 |
| F18 | 確認輪詢不經 `run()`：輪詢等 Koios 回應期間切換模式或重新預覽，回應落地後以 `undefined` 的 bundle 計算，狀態列顯示 TypeError 訊息、輪詢停止（步驟 3 行為等價審查 2026-10-18；步驟 3 刻意保留） | `apps/web/app.ts` 的 `scheduleConfirmation`、`confirm`、`reveal`（標「Read after the await」的三處） | 修 | 輪詢等待中重設抽獎，舊實作狀態列出現 TypeError，新實作丟棄過期的回應、不改畫面 | 4 |

## 會改變的既有行為

| 行為 | 現況 | 去向 |
|---|---|---|
| 協定版本字串 | `development-1` | 改寫：`development-2`（bundle 欄位不變；label、proof 格式、唯一性規則改變）。仍未凍結 |
| proof 格式 | `giveaway-proof-1`，含完整 commitment 欄位 | 改寫：只帶 network、bundle、`txHash`、owner、beacon、winners |
| round 前公告格式 | `giveaway-pending-1`，含完整 commitment | 改寫：只帶 network、bundle、`txHash`、owner |
| CLI 與網頁的 verdict | `Check.passed` 為 boolean；CLI 輸出 JSON | 改寫：三態（通過／失敗／未評估），CLI JSON 同步；「Round has arrived」移除 |
| 下載產物 | 單一 proof JSON（pretty-printed） | 改寫：canonical bundle bytes 與 proof 兩個檔 |
| CLI 輸入 | 只接受 proof 檔 | 保留 proof 模式；新增 `<bundle.json> --tx <txHash>`，自行取 beacon |
| `tools/mutation-check.mjs` | 不在 `make check` 內 | 改寫：改用新格式並接進 `make check` |
| 驗證連結 | fragment，或 hosted file URL＋整檔 hash | 改寫：小型結果維持 fragment；代管時帶 `txHash`＋bundleHash |
| 主辦者自架 bundle 的 URL 載入 | `loadUrl` 讀任意 HTTPS 網址 | 保留：仍可載入，改以 bundleHash 核對 |
| Demo 模式 | 假鏈＋真 drand 簽章，回 DEMO PASS | 保留 |
| CLI | 直連 Koios，可指定 `--indexer` | 改寫（PD7，2026-10-19）：沒有專案預設，必須以 `--indexer` 指定使用者自備的 full-archive Blockfrost 相容節點，沒給時明確報錯（步驟 8b）；CBOR 驗證（步驟 7）不變 |
| 網頁與後端的 indexer | koios.rest（網頁經步驟 8 的 proxy 取 `/tip`） | 改寫（PD7）：專案自架 Dolos、Blockfrost 形狀（步驟 8b）；驗證頁可改填使用者的 indexer；proxy 存廢依 PD8 |
