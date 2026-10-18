# 後端需求、非功能需求與外部介面

來源：`docs/adr/2026-10-18-typescript-convenience-backend.md`（代號 BK）、`docs/adr/2026-10-18-wallet-auth-and-bounded-retention.md`（代號 WA）。查詢日期 2026-10-18。機械檢查：`python3 check_plan.py`（同目錄）。

## 需求清單

| ID | 類別 | 需求 | 來源 | 步驟 |
|---|---|---|---|---|
| BR-01 | API | 唯讀 indexer proxy，只放行驗證與建交易需要的 Koios 端點 | BK Decision | 8、9 |
| BR-02 | API | proxy 每次請求只查一個身分；以（身分鍵, offset）快取，只快取整頁深於 `CONFIRMATIONS` 的列舉頁（B6） | WA Decision；design-review 2026-10-18 | 9 |
| BR-03 | API | 依 IP 與 owner 限流（Rate Limiting binding）；Koios key 有全域日預算（單一 Durable Object 計數，跨機房精確） | WA Decision；design-review 2026-10-18 | 9 |
| BR-04 | API | CORS 只開放自家網域；每次操作的簽章 payload 放在 `Authorization` header，不發 session、不用 cookie（PD4）；讀取端點不加 CAPTCHA | WA Decision | 9 |
| BR-05 | API | 不記錄請求內容；IP 只保留到限流所需時間 | WA Decision | 9 |
| BR-06 | API | bundle 上傳：`sha256(bytes)` 等於已上鏈承諾的 bundleHash、通過 `validateBundle`、大小在協定的 byte 上限內 | WA Decision | 10 |
| BR-07 | 資料實體 | 代管紀錄以 `txHash` 為主鍵、owner 由該交易推導；bytes 以 bundleHash 定址並參照計數；擁有者刪除只移除自己的紀錄；營運端下架以 bundleHash 留 tombstone | WA Amendment 2 | 10 |
| BR-08 | 流程 | bundle 預設保存到 round 後 12 個月；到期自動下架 | WA Decision | 10 |
| BR-09 | API | 擁有者操作（刪除、延長）以 CIP-30 `signData` 簽章；payload 含網域、操作、bundleHash、network、一次性 nonce，5 分鐘有效；簽章 key 屬於 owner 地址 | WA Decision | 11 |
| BR-10 | 畫面 | 驗證連結帶 `txHash`＋bundleHash，beacon 與得獎者由 verifier 重算 | WA Decision | 10 |
| BR-11 | 畫面 | 草稿一律存本機 IndexedDB，可匯出 | WA Decision | 12 |
| BR-12 | API | 伺服器草稿需錢包簽章存取，保存 30 天 | WA Decision | 12 |
| BR-13 | 流程 | 刪除請求以整份 bundle 下架；介面提醒主辦者保留下載副本 | WA Decision | 11、13 |
| BR-14 | 文件 | 隱私說明（controller 角色、保存期限、刪除方式）與檢舉、下架流程 | WA Followup | 13 |
| BR-15 | 流程 | 交易由錢包 CIP-30 `submitTx` 送出，後端不經手交易 | BK Decision | 9 |
| BR-16 | 流程 | 驗證頁顯示鏈上證據來源，可填入相容 Koios API 且允許 CORS 的 indexer 網址；CLI 預設直連 | BK Decision | 9 |
| BR-17 | 流程 | 每個 owner 最多 20 份代管中的 bundle；每次延長 12 個月，總保存不超過 round 後 36 個月 | WA Amendment | 10、11 |
| BR-18 | 資料實體 | 每個身分最多 5 份伺服器草稿，每份不超過協定 byte 上限；內容存 R2、紀錄存 D1 | WA Amendment；D1 limits | 12 |

後端 ADR 範圍內的「彙總統計」不在本計畫，列在計畫「延後」（觸發條件：MVP 計畫 D11）。

## 非功能需求

| 項目 | 門檻 | 狀態與依據 |
|---|---|---|
| 上傳驗證的 CPU 時間 | 1 萬筆、每筆 200 字元的 bundle，hash＋`validateBundle` 在選定 Workers 方案的上限內 | 未量測；步驟 10 量測後拍板 PD2 |
| 後端停擺時的可驗證性 | 持有 bundle 者以 CLI 直連 indexer 仍能 PASS | 不變量 B1；步驟 8 起每步驗收 |
| Koios 額度 | 單一 IP 或地址不能耗盡全域預算 | 步驟 9 以壓測腳本驗證；限流值依量到的單次驗證請求數設定 |
| 保存 | bundle 12 個月、草稿 30 天，到期自動刪除 | 步驟 10、12 以時間注入測試驗證 |
| 憑證 | 後端不存密碼、email 或 OAuth token | 不變量 B3 |

## 外部介面

| ID | 介面 | 事實（會變動的參數附重查方法） | 來源 |
|---|---|---|---|
| X1 | Koios | Public 層「CORS: Restricted」，Free 層要 key、CORS Open；2026-10-18 真 Chrome 實測公開層 5 個端點皆被擋。重查：tiers 頁與本計畫步驟 9 的 E2E | [Koios tiers](https://koios.rest/tiers.html) |
| X2 | Cloudflare Workers | Free 方案每請求 CPU 10 ms、subrequest 50；付費方案 CPU 預設 30 秒。重查：limits 頁 | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| X3 | Cloudflare R2／D1／Rate Limiting／Durable Objects／Cron Triggers | bundle 與草稿內容存 R2、紀錄存 D1（單列上限 2 MB）；IP 突發限流用 Rate Limiting binding（單一機房、不精確、週期 10 或 60 秒）；全域日預算用 Durable Object；到期清理用 Cron Triggers（預設，可推翻）。重查：各自的 limits 頁 | [Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)、[D1 limits](https://developers.cloudflare.com/d1/platform/limits/)、[Durable Objects](https://developers.cloudflare.com/durable-objects/) |
| X4 | CIP-30 | `signData`（CIP-8 COSE_Sign1）、`submitTx`、`getUtxos` | [CIP-30](https://cips.cardano.org/cip/CIP-0030) |
| X5 | CIP-93 | 簽章 HTTP 請求的 payload 欄位（uri、action、時間戳）；Proposed 狀態，本產品另加 nonce、network、bundleHash | [CIP-93](https://cips.cardano.org/cip/CIP-0093) |

## 待驗證的產品風險

沿用 MVP 計畫 `requirements.md` §4；後端不新增產品假設。新增的營運風險：刪除請求與濫用處理量超過單人能力（觸發後端 ADR 的撤銷條件）。
