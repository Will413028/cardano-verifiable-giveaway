# 後端需求、非功能需求與外部介面

來源：`docs/adr/2026-10-18-typescript-convenience-backend.md`（代號 BK）、`docs/adr/2026-10-18-wallet-auth-and-bounded-retention.md`（代號 WA）、`docs/adr/2026-10-19-self-hosted-dolos-indexer.md`（代號 DL，2026-10-19）。查詢日期 2026-10-18；indexer 相關 2026-10-19 依 PD7 重寫。機械檢查：`python3 check_plan.py`（同目錄）。

## 需求清單

| ID | 類別 | 需求 | 來源 | 步驟 |
|---|---|---|---|---|
| BR-01 | API | 網頁直連專案 Dolos；Dolos 前的 reverse proxy 只放行驗證與建交易需要的 Blockfrost 形狀唯讀端點（PD8 A，2026-10-19）；`apps/api` 不轉發 indexer | BK Decision；DL Decision；PD8 | 8、9 |
| BR-02 | API | 已刪除（PD8 A，2026-10-19）：原「proxy 每次請求只查一個身分、以（身分鍵, offset）快取」是為了省 Koios 額度，proxy 移除後不再適用；B6 對任何日後的快取仍成立 | WA Decision；PD8 | 9 |
| BR-03 | API | 後端寫入端點依 owner 限流；公開讀取路徑的 IP 限流放在 Dolos 前的 reverse proxy；全域日預算刪除（PD8 A，2026-10-19） | WA Decision；design-review 2026-10-18；DL Followup；PD8 | 9 |
| BR-04 | API | CORS 只開放自家網域；每次操作的簽章 payload 放在 `Authorization` header，不發 session、不用 cookie（PD4）；讀取端點不加 CAPTCHA | WA Decision | 9 |
| BR-05 | API | 不記錄請求內容；IP 只保留到限流所需時間 | WA Decision | 9 |
| BR-06 | API | bundle 上傳：`sha256(bytes)` 等於已上鏈承諾的 bundleHash、通過 `validateBundle`、大小在協定的 byte 上限內（PD2 B，2026-10-20：付費方案，不另設代管上限） | WA Decision；PD2 | 10 |
| BR-07 | 資料實體 | 代管紀錄以 `txHash` 為主鍵、owner 由該交易推導；bytes 以 bundleHash 定址並參照計數；擁有者刪除只移除自己的紀錄；營運端下架以 bundleHash 留 tombstone | WA Amendment 2 | 10 |
| BR-08 | 流程 | bundle 預設保存到基準時間後 12 個月，基準時間＝min(round 的時間, 該承諾第一次被代管的時間)（Will 2026-10-20）；第一次代管時間在紀錄到期、刪除、下架後仍保留到 round 後 12 個月，所以重新上傳不重新起算（已過到期日 410）；到期自動下架 | WA Decision；WA Amendment 5 | 10、10b |
| BR-09 | API | 擁有者操作（刪除、延長）以 CIP-30 `signData` 簽章；payload 含網域、操作、bundleHash、network、一次性 nonce，5 分鐘有效；簽章 key 屬於 owner 地址 | WA Decision | 11 |
| BR-10 | 畫面 | 驗證連結帶 `txHash`＋bundleHash，beacon 與得獎者由 verifier 重算 | WA Decision | 10 |
| BR-11 | 畫面 | 草稿一律存本機 IndexedDB，可匯出 | WA Decision | 12 |
| BR-12 | API | 伺服器草稿需錢包簽章存取，保存 30 天 | WA Decision | 12 |
| BR-13 | 流程 | 刪除請求以整份 bundle 下架；介面提醒主辦者保留下載副本 | WA Decision | 11、13 |
| BR-14 | 文件 | 隱私說明（controller 角色、保存期限、刪除方式）與檢舉、下架流程 | WA Followup | 13 |
| BR-15 | 流程 | 交易由錢包 CIP-30 `submitTx` 送出，後端不經手交易 | BK Decision | 9 |
| BR-16 | 流程 | 驗證頁顯示鏈上證據來源（步驟 9），可填入 Blockfrost 相容、full archive 且允許 CORS 的 indexer 網址（步驟 8b）；CLI 沒有專案預設，必須以 `--indexer` 指定（步驟 8b） | BK Decision；DL Decision | 8b、9 |
| BR-17 | 流程 | 每個 owner 最多 20 份代管中的 bundle；每次延長 12 個月，總保存不超過基準時間後 36 個月（基準時間同 BR-08，重新上傳不改變它） | WA Amendment | 10、10b、11 |
| BR-18 | 資料實體 | 每個身分最多 5 份伺服器草稿，每份不超過協定 byte 上限；內容存 R2、紀錄存 D1 | WA Amendment；D1 limits | 12 |

PD7 對需求的處置（2026-10-19）：

| 項目 | 處置 | 理由 |
|---|---|---|
| 需求 BR-01 | 改寫（已改；PD8 A 後再改為直連 Dolos、allowlist 在 reverse proxy） | 「只放行 Koios 端點」的 Koios 已移除；只放行唯讀端點的要求對任何公開讀取路徑仍成立。是否還要 Workers proxy 是決定，不由計畫改寫代為刪除 |
| 需求 BR-02 | 刪除（PD8 A，2026-10-19） | 每請求一個身分與（身分鍵, offset）快取是為了省 Koios 額度；Dolos 沒有第三方額度。刪除需求屬決定 |
| 需求 BR-03 | 改寫（已改：去掉 Koios key；PD8 A 後全域預算刪除、IP 限流移到 reverse proxy） | Koios key 與日額度已不存在；IP 與 owner 限流仍需要（owner 限流屬後端寫入端點） |
| 需求 BR-04、BR-05 | 保留 | 不依賴 Koios，適用於後端既有端點與任何公開讀取路徑 |
| 需求 BR-15 | 保留 | 錢包 `submitTx` 的理由是 B2（後端不經手交易），與 indexer 無關 |
| 需求 BR-16 | 改寫（已改） | 「相容 Koios API」改為 Blockfrost 相容且 full archive；「CLI 預設直連」改為無專案預設（B1） |
| 需求 X1 | 改寫（已改） | Koios 不再是依賴，改記 Dolos 的事實 |
| 非功能「後端停擺時的可驗證性」 | 改寫（已改） | CLI 改由使用者自備 indexer |
| 非功能「Koios 額度」 | 改寫為「公開讀取路徑的負載」（已改）；限流位置依 PD8 A 放在 reverse proxy，初值在步驟 9 定 | 原門檻保護的是 Koios 全域預算 |

後端 ADR 範圍內的「彙總統計」不在本計畫，列在計畫「延後」（觸發條件：MVP 計畫 D11）。

## 非功能需求

| 項目 | 門檻 | 狀態與依據 |
|---|---|---|
| 上傳驗證的 CPU 時間 | 1 萬筆、每筆 200 字元的 bundle，hash＋`validateBundle` 在選定 Workers 方案的上限內 | 步驟 10 本機 workerd 量得最壞 276 ms／請求（`a@……@` 回溯）；步驟 10b email 改寫為線性後同構造 n＝1 萬為 25 ms（`apps/api/bench/cpu-report.json`），但每次上傳固定的兩次鏈上讀取淨 3.17 ms（程序 CPU）、冷啟動一次 isolate 內牆鐘取樣 31 ms，Free 的 10 ms ÷ 3 幾乎不剩（計畫 PD2「步驟 10b 量測與停止」）；Will 2026-10-20 選 PD2 B（付費方案，CPU 預設 30 s，不設代管上限）。Cloudflare 計費 CPU 未量：部署前重量（計畫「延後」） |
| 後端停擺時的可驗證性 | 後端與專案 Dolos 都停擺時，持有 bundle 者以 CLI 搭配自備的 full-archive indexer（`--indexer`）仍能 PASS | 不變量 B1；步驟 8 起每步驗收，步驟 8b 起改用自備 indexer |
| 公開讀取路徑的負載 | 單一 IP 或地址不能耗盡專案 Dolos 的容量（原「Koios 額度」，PD7 改寫） | 步驟 8b 量單次驗證請求數（n＝265 時 276 次）；限流放在 Dolos 前的 reverse proxy（PD8 A），初值與驗證在步驟 9；實際值在部署時（MVP 計畫步驟 10）定 |
| 保存 | bundle 12 個月、草稿 30 天，到期自動刪除 | 步驟 10、12 以時間注入測試驗證 |
| 憑證 | 後端不存密碼、email 或 OAuth token | 不變量 B3 |

## 外部介面

| ID | 介面 | 事實（會變動的參數附重查方法） | 來源 |
|---|---|---|---|
| X1 | Dolos MiniBF（Blockfrost 相容 API） | 不需要 key；`permissive_cors` 預設 true；`/addresses/{a}/transactions` 接受 `addr_vkh`；穩定版 1.6.1 沒有 `/accounts/{stake}/transactions`（pre-release 才有；stake 身分依 PD9 改用 `/accounts/{stake}/addresses`＋逐址列舉，步驟 8b 實測；步驟 9b 起依 PD10 改讀 `/accounts/{stake}/withdrawals`，0 ADA withdrawal 有列出、`order=asc` 穩定，實測）；page×count 超過 `max_scan_items`（預設 3000）時拒絕；儲存模式 Ledger-only／Sliding history／Full archive；需要有狀態的 VM。2026-10-19 讀碼，未實跑。重查：Dolos 版本的 `minibf.mdx` 與步驟 8b 的 `spike-dolos.md`。（原 X1 為 Koios，PD7 移除；Koios 條款與 tiers 的查詢紀錄在計畫進度表步驟 9） | [Dolos](https://github.com/txpipe/dolos)、[Blockfrost OpenAPI](https://docs.blockfrost.io/) |
| X2 | Cloudflare Workers | Free 方案每請求 CPU 10 ms、subrequest 50；付費方案 CPU 預設 30 秒。重查：limits 頁 | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| X3 | Cloudflare R2／D1／Rate Limiting／Durable Objects／Cron Triggers | bundle 與草稿內容存 R2、紀錄存 D1（單列上限 2 MB）；IP 突發限流用 Rate Limiting binding（單一機房、不精確、週期 10 或 60 秒）；全域日預算用 Durable Object；到期清理用 Cron Triggers（預設，可推翻）。重查：各自的 limits 頁 | [Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)、[D1 limits](https://developers.cloudflare.com/d1/platform/limits/)、[Durable Objects](https://developers.cloudflare.com/durable-objects/) |
| X4 | CIP-30 | `signData`（CIP-8 COSE_Sign1）、`submitTx`、`getUtxos` | [CIP-30](https://cips.cardano.org/cip/CIP-0030) |
| X5 | CIP-93 | 簽章 HTTP 請求的 payload 欄位（uri、action、時間戳）；Proposed 狀態，本產品另加 nonce、network、bundleHash | [CIP-93](https://cips.cardano.org/cip/CIP-0093) |

## 待驗證的產品風險

沿用 MVP 計畫 `requirements.md` §4；後端不新增產品假設。新增的營運風險：刪除請求與濫用處理量超過單人能力（觸發後端 ADR 的撤銷條件）。
