# 可驗證的免費社群抽獎：第一個可公開試用的版本

**Goal：** 主辦者能在瀏覽器建立一場免費抽獎，把名單、規則、演算法版本與未來的 drand round 的承諾寫上 Cardano，確認後以該 round 的 randomness 開獎並產生公開驗證連結；任何參與者不靠本產品伺服器，就能用獨立 verifier 重算並核對承諾、時間順序與得獎者。驗收見步驟 11。

**上層：** 主清單在 repo 外，見本機個人脈絡檔（2026-10-01 尚未建立；建立它並在主清單加一行指向本計畫，列在步驟 1 之前的需要人做的事）。沒有主計畫，下一段「全域約束與完成定義」暫代。

**附件：** 本計畫與同名目錄 `2026-10-01-verifiable-giveaway-mvp/` 放在 repo 的 `docs/plans/`，之後步驟的產出（`validation.md`、`spike-*.md`、`decisions/`）都寫進這個附件目錄並隨步驟 commit：`requirements.md`（需求來源逐句編號、需求清單、非功能需求、產品風險）、`external-interfaces.md`（外部介面、既有先例、業界做法光譜）、`check_plan.py`（本計畫的一次性機械檢查）。repo 尚無 commit，沒有快照 commit。

## 全域約束與完成定義（暫代主計畫）

- 收款、分潤、預約不做；Token 發行、NFT、下注、加密貨幣獎金不作為產品核心（README「Scope」；產品構想筆記（私人筆記，未公開，2026-10-01））。實作需要的鏈上機制（例如 D3 選 B 時的 state token）不得以使用者可見的 Token 或 NFT 形式出現。
- 驗證只涵蓋已承諾名單下的抽選，不證明參與資格、名單完整或獎品交付；所有畫面、verifier 輸出與文件都要分開寫「鏈上承諾與 verifier 核對的事」和「外部事實的宣稱」（README「Verification boundaries」、AGENTS.md）。
- 不把規劃中的功能寫成已完成、已部署或已有使用者驗證；開發與驗證指令只在 scaffold 可執行、指令跑過後才寫進文件（AGENTS.md）。
- 對外聯絡（訪談、社群發文、假門頁面公開）與實作啟動都要使用者授權（前提 P2、P3）。
- repo 是 GitHub public repo：tracked 檔案不放個人脈絡、私人筆記路徑或憑證。
- 完成定義（每個產品步驟都要做到）：
  - `make check` 全綠，且新行為有一個「破壞它就會失敗」的 mutation 已實際跑過。
  - 對外格式（bundle、commitment metadata、協定版本）的改動同步更新協定規格與 test vectors。
  - 消費端搜尋指令重跑，結果寫進進度表。
  - 畫面與文件的文案符合上面的驗證邊界。

## 前提（開工時核對過，2026-10-01）

- **P1 會改到或取代的既有部署是否在線：** 無既有部署，全新系統（README「Status」：No application, smart contract or deployment exists yet）。上鏈後不能修改的承諾與已發布的協定版本寫成不變量（I3）。
- **P2 實作啟動已獲授權：** 已確認本機功能開發（2026-10-01，使用者要求跳過錢包與地址設定，先完成功能）。真錢包操作、鏈上人工驗收與對外發布延後，不由本次開發授權推定。
- **P3 對外聯絡已獲授權：** 未確認，只有使用者能確認（同上）。擋住步驟 1 與步驟 10。
- **P12 是否進入開發待使用者決定：** 已確認本機功能開發（2026-10-01）；D1 選 B，需求由公開試用驗證。使用者同意 D3、D7 的建議作為未凍結開發預設，實測後定案。主清單項目替換仍待處理。
- **P4 鏈選定 Cardano：** 已確認（README「Planned experience」與 repo 名稱，2026-10-01）。產品構想筆記說明價值不依賴 Cardano 獨有能力，不構成衝突。
- **P5 亂數來源為 drand：** 已確認（README、產品構想筆記，2026-10-01）。用哪個 drand 網路屬於 D7。
- **P6 目標 repo：** 已確認為本 repo（已建立 GitHub public repo，2026-10-01）；尚無 commit，初始 commit 由建立 repo 的工作負責，不在本計畫。
- **P7 工具鏈：** 開發預設（可推翻）：TypeScript、Node LTS、pnpm workspace、Node 內建 test runner、`make check` 當驗收入口；採內建 runner 以重用既有離線工具鏈、不增加測試框架相依。Cardano SDK 預設 Mesh，步驟 2 實測後可換成 Evolution SDK 或 Lucid Evolution（`external-interfaces.md` E7）。test vectors 的獨立參考實作用 Python 3（標準函式庫，不加相依）；為了讓 JCS 在兩種語言都容易正確實作，bundle 的值只允許字串、非負整數、陣列與物件，字串不得含控制字元。
- **P8 鏈上查詢：** 預設（可推翻）：Koios 公開層（免 key，E5）；verifier 允許使用者改用其他 indexer。
- **P9 安全參數：** 預設（可推翻）：hash 用 SHA-256；bundle 以 RFC 8785 JCS 正規化後取 hash（E10）；verifier 寫死 drand quicknet chain hash 與 group public key（E4）。
- **P10 介面語言：** 預設（可推翻）：英文為主，繁體中文可後加。
- **P11 目標主辦者大多沒有 Cardano 錢包：** 未確認，推論（目標族群是創作者、社群管理員、開源專案，見 `requirements.md` N1、N13）。由步驟 1 提供證據，影響 D4。

**驗收基線：** 無。repo 尚無 commit，也沒有可執行的 scaffold（`git log` 回報 `does not have any commits yet`，2026-10-01）。基線由步驟 5 建立。共用、有額度的資源（Koios 公開層 5,000 requests／天、preprod faucet）一次只由一個 session 使用。

## 本階段依賴的不變量

模組為預計名稱，實作後補檔案路徑（預設佈局：`packages/protocol`、`packages/beacon`、`packages/chain`、`apps/web`、`apps/verifier-cli`）。

| 不變量 | 依賴它的機制（預計的模組與函式） |
|---|---|
| I1 得獎結果只由已承諾的 bundle、指定 round 的 drand randomness 與演算法版本決定；任何一方重算都得到同一結果 | `protocol.canonicalizeBundle`、`protocol.computeCommitment`、`protocol.deriveSeed`、`protocol.selectWinners`、test vectors（`packages/protocol/vectors/`）、`apps/verifier-cli`、`apps/web` 的驗證頁 |
| I2 承諾必須在指定 round 產生之前上鏈並達到確認門檻；verifier 對不符合的抽獎判定失敗 | `chain.getConfirmations`、`protocol.checkTiming`、`beacon.roundAt`、建立抽獎頁的 round 選擇器 |
| I3 已上鏈的承諾不能修改；協定版本在凍結點之後不能修改，新規則只能以新版本號加入，verifier 永遠能驗已凍結的版本。凍結點：步驟 10 第一場公開抽獎上鏈時（P1：之前沒有任何外部承諾依賴它）；凍結前修改 v1 必須同步更新 test vectors | `protocol.PROTOCOL_VERSION`、`protocol.selectWinners` 的版本分派、`packages/protocol/vectors/`、協定規格文件 |
| I4 驗證不需要本產品伺服器在線：bundle、公開鏈資料與 drand 公開資料就足夠 | `apps/verifier-cli`、`apps/web` 驗證頁的資料載入、bundle 格式、D6 的保存方式 |
| I5 verifier 可判定的唯一性：同一主辦者地址、同一 drawId 以最早一筆承諾為準，之後的同 drawId 承諾一律顯示並判為無效。跨地址或換 drawId 的重複只能由參與者在 round 前看到已公開的驗證連結來察覺，verifier 無法判定，這一點寫進 I7 的驗證邊界文字。D3 選 B 時本條改寫為鏈上強制 | commitment metadata 的 `drawId` 欄位、`chain.findCommitments`、`protocol.checkUniqueness`、驗證頁的「承諾已在 round 前公開」顯示；機制依 D3、D7 |
| I6 本產品不持有、不接觸主辦者私鑰（依 D4；D4 選 B 或 C 時本條改寫） | `chain.buildCommitmentTx`（只產生未簽交易）、`apps/web` 的 CIP-30 簽署流程 |
| I7 驗證邊界：任何輸出都不宣稱名單完整、資格或獎品交付，也不宣稱能阻止主辦者以其他地址另開承諾（I5） | `apps/verifier-cli` 輸出文字、驗證頁文案、README |
| I9 drand 信任根只來自寫死的 quicknet chain hash 與 group public key（P9），不採用 relay 回傳的 key | `beacon.verifyBeacon`、`beacon.QUICKNET_CHAIN_HASH`、`beacon.QUICKNET_PUBLIC_KEY` |
| I8 公開 bundle 不含聯絡資料明文 | `protocol.canonicalizeBundle` 的欄位白名單、建立抽獎頁的名單匯入；格式依 D5 |

## 範圍

- 做：主辦者建立抽獎並上鏈承諾、開獎、公開驗證頁與分享連結、瀏覽器與 CLI 兩種獨立 verifier、公開的協定規格與 test vectors、preprod 上的完整流程；主網發布依 D9。
- 不做：收款、分潤、預約；Token、NFT、下注、加密貨幣獎金作為核心（全域約束）。證明參與資格、名單完整或獎品交付（驗證邊界，README）。在鏈上合約內執行抽選（產品構想筆記接受外部事實，鏈上只需承諾；見 `external-interfaces.md` P7）。
- 延後：
  - 名單收集（報名表、社群平台匯入）——觸發條件：D8 選 B 或 C，或步驟 1 的證據顯示主辦者因沒有名單工具而放棄。
  - 營運方代簽、代付手續費——觸發條件：D4 選 A 且步驟 1 或公開試用顯示目標主辦者多數沒有錢包（P11 成立）。
  - 第二錨點（OpenTimestamps）——觸發條件：D3 選 A 且有使用者要求跨鏈存證。
  - 自架 Cardano 節點或多 indexer 交叉比對的預設化——觸發條件：步驟 9 發現單一 indexer 回傳值不一致，或公開試用有使用者質疑 indexer 信任。

## 步驟

- [ ] **1. 產品風險驗證**（被擋於：D1；前提 P3）
  - 範圍：依 D1 的結論做最便宜的驗證。D1 選 A 時：寫一頁說明產品流程的假門頁或貼文、手動代辦 3–5 場抽獎（用現成工具產生承諾，手動流程即可），訪談或問卷詢問主辦者為何選這個版本、有沒有 Cardano 錢包、會不會再用。產出附件 `validation.md`：表頭為 `| 風險 | 證據 | 樣本數 | 結論 |`，`requirements.md` §4 的每個風險一列。D1 選 B 或 C 時本步驟標「不做」並寫明依據的決定。
  - 消費端：無（本步驟不產生程式介面）。
  - 不能動：不收集參與者聯絡資料；不承諾功能已存在（全域約束）；`validation.md` 進 public repo，只寫匿名化的摘要（不寫受訪者名稱、帳號或原話），原始紀錄放在 repo 外。
  - 驗收：`validation.md` 對 §4 每一列都有「證據、樣本數、結論」三欄且無空格，由 `python3 check_plan.py --validation` 檢查；mutation：刪掉任一列的結論，檢查要失敗。
  - 停止條件：P3 未獲授權；或證據顯示沒有主辦者願意試用時，停下交使用者決定是否繼續本計畫。
  - 需要人做的事：確認 P12；建立本機個人脈絡檔並在主清單加一行指向本計畫；授權對外聯絡；以自己的帳號發布貼文或聯絡主辦者。
  - 完成後的狀態：D2、D4、D8 依本步驟的證據拍板。

- [ ] **2. Spike A：preprod 上的承諾交易**（被擋於：前提 P2）
  - 範圍：拋棄式程式放 `spikes/a-commit-tx/`，不被產品程式引用。用 P7 預設 SDK 與 CIP-30 錢包在 preprod 送出一筆帶 metadata 的交易（內容：協定版本、drawId、bundle hash、drand chain hash 與 round），再由 Koios 查回 metadata、區塊高度與區塊時間。量測：交易 bytes 與手續費、送出到 1／5／15 個確認的時間（各至少 5 次）、metadata 64-byte 字串切分是否如 E1 所述、同一 SDK 在 Chrome 與 Firefox 的 CIP-30 可用性；唯一性檢查需要的列舉查詢：用 Koios `/tx_by_metalabel` 與以主辦者地址列交易兩種方式找回自己的承諾，記錄分頁數與請求數（D7 的 metadata label 子題依此決定）。比較 E7 的 SDK 至少兩個的 bundle 大小。產出附件 `spike-a.md`（數字、指令、日期、覆寫 `external-interfaces.md` 的「未實測」欄）。
  - 消費端：無（repo 尚無程式碼；spike 不被引用）。
  - 不能動：不連主網；不在 repo 放任何助記詞或私鑰。
  - 驗收：`spike-a.md` 對每個量測項都有數字、樣本數與重現指令；從 Koios 查回的 bundle hash 與送出的 hash 相同（腳本比對，手動改一個 byte 再比對要回報不同）。
  - 停止條件：Koios 公開層無法查回 metadata；或手續費超過 E2 公式估計的 2 倍——停下回報，D3、D7 改用新事實。
  - 需要人做的事：安裝一個 CIP-30 瀏覽器錢包並建立 preprod 錢包、從 faucet 領測試幣（可能有人機驗證）。
  - 完成後的狀態：交 D3、D4、D7 所需事實。

- [ ] **3. Spike B：drand quicknet 的取得與驗證**（被擋於：前提 P2）
  - 範圍：拋棄式程式放 `spikes/b-drand/`。在 Node 與瀏覽器各自：由 relay 取得指定 round、以寫死的 chain hash 與 public key 驗證 BLS 簽章、計算 randomness = sha256(signature)、由時間算 round 編號並與 relay 回應比對；量測驗證函式庫的瀏覽器 bundle 大小與單次驗證時間；確認至少兩個 relay（E4）回傳一致。產出 `spike-b.md`。
  - 消費端：無（repo 尚無程式碼；spike 不被引用）。
  - 不能動：信任根只來自寫死的 chain hash 與 public key，不採用 relay 的 `/info` 當信任根。
  - 驗收：腳本對 3 個已知 round 驗證成功；把 signature 改一個 byte 驗證要失敗；把 round 編號加一驗證要失敗。
  - 停止條件：瀏覽器端無法在 1 秒內完成單次驗證，或沒有可用的 JS 驗證函式庫——停下回報，D2、D7 改用新事實。
  - 完成後的狀態：交 D7 所需事實。

- [ ] **4. Spike C：單一有效承諾的執行方式**（被擋於：步驟 2）
  - 範圍：拋棄式程式放 `spikes/c-uniqueness/`。對 D3 的每個選項寫出「主辦者挑結果」的攻擊劇本（多個 drawId、多個地址、承諾後撤回、round 前未公開連結），在 preprod 上實際跑 A（metadata＋公開連結規則）的攻擊劇本，並估算 B（Aiken validator＋一次性 state token）的交易大小與手續費（只估算，不部署合約）；C（A 加 OpenTimestamps）的判定以官方文件推論，表格註明「文件推論」。產出 `spike-c.md`：表頭為 `| 攻擊劇本 | A | B | C |`，每格寫「擋住」或「擋不住」並附理由；另列各選項的成本。
  - 消費端：無（spike 不被引用）。
  - 不能動：不部署主網合約；不發行使用者可見的 token。
  - 驗收：`spike-c.md` 的攻擊劇本表對每個選項每個劇本都有「擋住／擋不住／附理由」，由 `python3 check_plan.py --spike-c` 檢查無空格；mutation：清空一格，檢查要失敗。
  - 停止條件：發現所有選項都擋不住「round 前未公開連結」的劇本——停下，這會改變 I5 的寫法，交使用者決定。
  - 完成後的狀態：交 D3、D7 所需事實。

- [ ] **5. 本機功能版本與 walking skeleton**（被擋於：D1、D2、D10；前提 P2）
  - 2026-10-01 調整：使用者要求先完成功能，跳過錢包設定。此步驟納入步驟 6–9 不依賴真錢包的功能：貼上／CSV、承諾、確認狀態、drand 驗證與抽選、分享／下載、公開驗證頁與 CLI。提供明確標示的 demo 假鏈，真鏈與錢包人工驗收保留在後續步驟；不將 demo 當成已上鏈證據。D3、D7 採已確認的開發預設，不凍結 v1；metadata label 暫用 674 作開發值，不申請 CIP-10。
  - 範圍：依 D2 建 pnpm workspace（P7 的預設佈局）、根目錄 `Makefile` 的 `make check`（lint、typecheck、unit test、test vectors）、GitHub Actions 跑 `make check`、依 D10 加 LICENSE。接通一條假的端到端路徑：寫死的 3 人名單 → `computeCommitment` → 假的鏈（記憶體內）→ 固定的 drand fixture（含 round 與 signature，verifier 自己算 sha256(signature)，不讀 fixture 內的 randomness 欄位）→ `selectWinners` → `verifier-cli` 對照 golden winners 檔重算並回報 PASS。README 的 Development 段在 `make check` 跑過後才更新（A3）。
  - 消費端：無（repo 尚無程式碼）。本步驟完成後，後續步驟的消費端以 `rg -n "<函式名>" --glob '!docs/**' --glob '!spikes/**'` 重跑。
  - 不能動：README 的 Status 段仍寫未上線、未經使用者驗證（A2）。
  - 驗收：本機與 CI 的 `make check` 都綠；mutation 兩個，各自都要讓 `verifier-cli` 回報 FAIL 且 `make check` 失敗：把 fixture 的 signature 改一個 byte；把名單改一筆而不更新 golden winners。
  - 停止條件：D2 的結論需要後端，但 D6 未決——停下等 D6。
  - 完成後的狀態：之後每一步的驗收都掛在 `make check`。

- [ ] **6. 垂直切片一：協定 v1 與獨立 verifier**（被擋於：D3、D5、D7；步驟 3、4、5）
  - 範圍：把 D3、D5、D7 的結論寫成協定規格 `docs/protocol-v1.md`（bundle 欄位、JCS 正規化、commitment metadata 格式、seed 推導、抽選演算法、時間規則、唯一性規則、驗證邊界文字）；實作 `packages/protocol`、`packages/beacon`、`packages/chain` 的查詢部分；`apps/verifier-cli` 與 `apps/web` 的驗證頁可載入一份 bundle，逐項顯示：bundle hash 與鏈上承諾相符、承諾區塊時間與確認數早於 round（I2）、drand 簽章有效、重算的得獎者相符、同一 drawId 沒有其他有效承諾（I5）、驗證邊界說明（I7）。參與者可確認自己在名單內（形式依 D5）。test vectors 至少 10 組，含邊界：名單 1 人、得獎人數等於名單人數、重複的參與者標籤與 Unicode 標籤（處理方式依 D7 的子題）。
  - 消費端：`rg -n "canonicalizeBundle|computeCommitment|deriveSeed|selectWinners|checkTiming|checkUniqueness|verifyBeacon|findCommitments" --glob '!docs/**' --glob '!spikes/**'`
  - 不能動：v1 在凍結點後不再改，凍結前修改要同步更新 vectors（I3）；verifier 不呼叫本產品的任何伺服器（I4）。
  - 驗收：`make check` 綠；test vectors 由一支獨立於 `packages/protocol` 的簡短參考實作（例如 Python，放 `packages/protocol/vectors/reference/`）重算一致。mutation 各跑一次且都要讓 `make check` 失敗：抽選演算法的典型錯誤（D7 選 A：同值決勝改成反序；選 B：拿掉 rejection sampling 改取模；選 C：HMAC 的 key 與 data 對調）、時間檢查的 `>` 改成 `>=`、跳過 BLS 驗證、bundle 改用非正規化 JSON 取 hash、唯一性檢查改成只看第一筆。
  - 需要人做的事：D7 選 CIP-10 註冊 label 時，以自己的帳號提交 CIP-10 的 PR。
  - 停止條件：D7 的時間規則在步驟 2 的實測延遲下讓多數抽獎無法在一小時內開獎——停下交使用者重議 D7。

- [ ] **7. 垂直切片二：主辦者在 preprod 建立抽獎並承諾**（被擋於：D4、D8；步驟 6）
  - 範圍：`apps/web` 建立抽獎頁：名單匯入（依 D8）、規則（得獎人數）、round 選擇器（依 D7 的最短間隔自動建議）、bundle 預覽；以 CIP-30 簽署（依 D4）送出承諾交易；狀態頁顯示送出、確認數、距 round 的倒數；承諾在 round 前未達確認門檻時，依 D7 的規則把該場抽獎標為無效並引導重新建立（新 drawId，舊承諾在驗證頁保留可見）。
  - 消費端：`rg -n "buildCommitmentTx|getConfirmations|roundAt|selectWinners" --glob '!docs/**' --glob '!spikes/**'`
  - 不能動：協定 v1（I3）；本產品不接觸私鑰（I6）；bundle 不含聯絡資料明文（I8）。
  - 驗收：分兩層。自動（`make check`，用 mock CIP-30 錢包與記憶體內假鏈）：建立、承諾、確認數推進、round 到期的流程測試；mutation：讓 round 選擇器接受小於最短間隔的 round，對應測試要失敗；讓名單匯入保留 email 欄位，I8 的測試要失敗；讓假鏈延遲確認到超過 round 時間，該場要被判無效，拿掉這條判定測試要失敗。人工（preprod，用使用者的 CIP-30 錢包簽署，不放任何 key 到 repo 或 CI）：跑 3 場，其中 1 場在建立後刻意延遲送出交易直到確認數來不及，三場都由 `verifier-cli` 驗證：2 場 PASS、1 場依 D7 判定無效；結果與交易 id 記在進度表。
  - 停止條件：步驟 1 或公開試用的證據顯示 P11 成立且 D4 選 A——停下交使用者重議 D4（延後項的觸發條件）。
  - 需要人做的事：提供 preprod 錢包與測試幣（同步驟 2），並親自簽署人工驗收的 3 場交易。

- [ ] **8. 垂直切片三：開獎、公開驗證頁與分享連結**（被擋於：D6；步驟 7）
  - 範圍：round 產生後，主辦者頁取得 randomness、計算得獎者、產生 result bundle；依 D6 保存 bundle 並產生公開驗證連結（連結內含或指向 bundle hash，任何來源取得的 bundle 都以 hash 核對）；驗證頁在桌面與手機寬度可用，可下載 bundle 給 `verifier-cli` 使用。
  - 消費端：`rg -n "selectWinners|verifyBeacon|loadBundle|bundleUrl" --glob '!docs/**' --glob '!spikes/**'`
  - 不能動：協定 v1（I3）；驗證頁不依賴本產品伺服器即可完成驗證（I4）；驗證邊界文字（I7）。
  - 驗收：`make check` 綠；preprod 上 3 場完整流程的驗證連結在乾淨瀏覽器開啟時 PASS；把 bundle 從 D6 的保存位置刪除後，以手動下載的副本仍能在驗證頁與 CLI 得到 PASS。mutation：驗證頁改成信任 result bundle 內的得獎者而不重算，竄改得獎者的 fixture 測試要失敗。
  - 停止條件：D6 選定的保存位置需要付費或註冊而未獲授權——停下回報，先只提供下載（D6 的 A）。
  - 需要人做的事：D6 選 B 或 C 時，提供儲存服務帳號。

- [ ] **9. 硬化：對抗測試與非功能門檻**（被擋於：步驟 8）
  - 範圍：把步驟 4 的攻擊劇本寫成自動測試；加入 round 已過、承諾被 rollback 後重新上鏈（區塊時間晚於 round）、bundle 欄位缺漏或多餘、indexer 回傳不一致、drand relay 不可用的測試；量測 `requirements.md` §3 的名單規模門檻並把「未決」改成實測數字，超過門檻的項目交使用者決定。
  - 消費端：`rg -n "checkTiming|checkUniqueness|findCommitments|verifyBeacon" --glob '!docs/**' --glob '!spikes/**'`
  - 不能動：協定 v1（I3）。
  - 驗收：`make check` 綠且包含上列每一類測試；每一類各跑一次 mutation（拿掉對應的檢查），對應測試要失敗；§3 不再有「提案（未決）」字樣，且每個仍寫「未決」的列都指向一題決定或延後項，由 `python3 check_plan.py --nfr` 檢查。
  - 停止條件：任何攻擊劇本無法在協定 v1 內擋住——停下，依 SKILL「執行中改變前提」交使用者決定是否開 v2。

- [ ] **10. 公開發布**（被擋於：D9、D11；步驟 9；前提 P3）
  - 範圍：依 D9 部署靜態網站（或 D2 選定的形態）、在選定網路上跑一場公開示範抽獎、README 的 Status 與 Development 段更新為實際狀態（A2、A3）；依 D11 加上驗證頁瀏覽統計，作為「驗證連結帶來曝光」假設（REQ-27）的量測。
  - 消費端：`rg -n "preprod|mainnet|NETWORK" --glob '!docs/**' --glob '!spikes/**'`
  - 不能動：README 不宣稱已有使用者驗證，除非步驟 1 或試用有證據。
  - 驗收：部署網址上的示範抽獎由本機 `verifier-cli` 驗證 PASS；D11 選 B 或 C 時，開啟驗證頁後統計後台的瀏覽數增加 1，關掉統計設定再開啟則不增加；網站從部署端下線後，以下載的 bundle 驗證仍 PASS（I4）。mutation：把部署設定的網路改錯（preprod 與 mainnet 對調），驗證要失敗。
  - 停止條件：D9 選主網但沒有主網錢包與 ADA；D11 選定的統計方式需要註冊而未獲授權。
  - 需要人做的事：托管平台帳號、網域（如需要）、主網錢包與 ADA（D9 選主網時）、授權對外發布。

- [ ] **11. 收尾**（被擋於：步驟 10）
  - 範圍：完成定義逐項核對；跑獨立設計審查（design-review skill）；確認會長期守住不變量的檢查（test vectors 參考實作比對、bundle 欄位白名單、驗證邊界文字存在）都在 `make check` 內，因而由 CI 執行，缺的才補；刪除 `spikes/` 的程式（`spike-*.md` 附件保留）；延後項附觸發條件搬回主清單；需要人做的事列給使用者。
  - 消費端：`rg -n "spikes/" --glob '!docs/**'`（刪除前要為空）。
  - 不能動：協定 v1 與 test vectors。
  - 驗收：`make check` 綠；`python3 check_plan.py` 綠；`rg -n "spikes/" --glob '!docs/**'` 無結果；design-review 的每個發現有處置；`make check` 的輸出列出 test vectors 參考實作比對、白名單與邊界文字三項測試。

## 決定

每題的 ADR 位置依 repo 指令檔與本機個人脈絡檔的規定；都沒有規定時用 decision-log skill 的預設位置；位置尚不存在時先放本附件目錄的 `decisions/`。

- **D1 是否先做產品風險驗證再建系統**（狀態：已決，2026-10-01，Will；擋住步驟：1、5；需要的事實：無）
  - A：先做步驟 1 的最便宜驗證（假門頁或貼文、手動代辦 3–5 場、訪談），spike 2–4 可並行，產品步驟 5 起等驗證結論——花費少，避免做出沒人要的東西；需要對外聯絡授權，會延後第一行產品程式碼。（建議：最大的未知是「有沒有人要」與差異化，見 `requirements.md` §4）
  - B：直接建 MVP，以公開試用與驗證連結的分享當作驗證——最快有可示範的東西；若沒人要，步驟 5–10 的成本沉沒。
  - C：只做技術 spike，看結果再決定要不要驗證——技術風險先清；但產品風險最大，這個順序對主要未知沒有幫助。
  - 結論：B：直接建 MVP，以公開試用與驗證連結分享驗證需求；步驟 1 不做。

- **D2 產品形態**（狀態：已決，2026-10-01，Will；擋住步驟：5；需要的事實：步驟 1 的證據（D1 選 A 時）、步驟 3 的瀏覽器驗證可行性）
  - A：靜態網站（主辦者頁與驗證頁都在瀏覽器）＋ CLI verifier，無後端——無伺服器成本，最符合「不依賴單一公司」（I4）；名單收集、代簽代付都做不到，資料保存依 D6。（建議，與 D4 A、D8 A 一致）
  - B：託管服務（後端、資料庫、帳號）——可做報名表、代簽代付、統計；有營運成本，營運方成為新的信任點與個資持有者。
  - C：只有 CLI 與靜態驗證頁，主辦者用 CLI 建立——最小；目標主辦者（非工程背景的創作者）幾乎用不了。
  - 子題：託管平台（A 或 C 時）——GitHub Pages（repo 已在 GitHub，免費，建議）／Cloudflare Pages（免費層，需另一個帳號）／自架（有成本）。
  - 相依：D6 選 B（本產品保存 bundle）需要寫入端點與憑證，會把本題推向 B 或加一個 serverless 端點；兩題一起拍。
  - 結論：A：靜態網站＋CLI verifier，無產品後端；網站托管採 GitHub Pages。瀏覽器可行性仍由步驟 3 驗證。

- **D3 承諾錨定與唯一性機制**（狀態：已允許 A metadata 作未凍結開發預設，實測後定案；擋住步驟：6 的 v1 凍結；需要的事實：步驟 2、4）
  - A：交易 metadata 承諾（固定 label、drawId、bundle hash、round、協定版本），唯一性由協定規則加社會機制擋：驗證連結必須在 round 前公開，verifier 列出同一地址同一 drawId 的所有承諾並以最早一筆為準——無合約，成本最低（約 0.17 ADA／場）；無法阻止主辦者用新地址另開承諾，要靠「round 前已公開連結」讓參與者察覺。（建議：步驟 4 若證實 B 也擋不住「另開地址」，B 的額外成本換不到更多保證）
  - B：Aiken validator ＋ 一次性 state token，同一 drawId 在鏈上只能存在一次——鏈上強制唯一；合約部署後不可改（不可逆），交易較大、要維護合約，且同樣擋不住主辦者換 drawId 或地址。
  - C：A 再加 OpenTimestamps 第二錨點——跨鏈存證；Bitcoin 確認需數小時，流程變慢，增加的保證有限。
  - 對不變量的影響：選 A 或 C 時 I5 照現行寫法（跨地址重複只能察覺）並更新 I7 文字；選 B 時改寫 I5 為鏈上強制，依 SKILL 第 5 節一次處理依賴它的機制。
  - 結論：未決。

- **D4 誰簽署並支付承諾交易**（狀態：已決，2026-10-01，Will；擋住步驟：7；需要的事實：步驟 1 的錢包持有證據、步驟 2 的手續費實測）
  - A：主辦者自己的 CIP-30 錢包簽署並付費——本產品不碰私鑰（I6），信任最少；沒有錢包與 ADA 的主辦者用不了（P11）。（建議作為第一版；P11 成立時觸發延後項）
  - B：營運方錢包代簽代付——任何主辦者都能用；營運方需持有熱錢包與 ADA、承擔費用，且營運方自己能挑結果，回到「信任單一公司」（與產品構想筆記的價值主張衝突）；必須有後端（D2 B）。
  - C：兩者都支援——覆蓋最廣；範圍與測試面加倍，代簽路徑的信任說明要分開呈現。
  - 結論：A：主辦者自己的 CIP-30 錢包簽署並付費；手續費仍由步驟 2 實測。

- **D5 名單的公開形式**（狀態：已決，2026-10-01，Will；擋住步驟：6；需要的事實：無）
  - A：明文公開參與者標籤（例如公開的社群帳號名稱）——任何人可直接重算與找到自己；主辦者若貼入 email 等聯絡資料就會公開個資。
  - B：逐筆加鹽 hash ＋ Merkle root，參與者各持 receipt——隱私最好；參與者必須拿到自己的 receipt 才能確認收錄，主辦者要多一個發送 receipt 的管道，得獎者身分要另行公布。
  - C：兩層：公開標籤明文，聯絡資料只留在主辦者端、不進公開 bundle——可重算且不洩漏聯絡資料；標籤本身仍是公開資訊，主辦者要被提示不要用私密標籤。（建議）
  - 結論：C：公開參與者標籤，聯絡資料留在主辦者端、不進公開 bundle；不要求產品保存或雜湊聯絡資料。

- **D6 驗證資料的保存位置**（狀態：已決，2026-10-01，Will；擋住步驟：8；需要的事實：D5 的結論；與 D2 一起拍）
  - A：只由主辦者下載並自行公開（gist、自己的網站）——零成本，不依賴本產品；連結失效風險由主辦者承擔。
  - B：本產品的儲存保存，並永遠提供下載——體驗最好；需要寫入端點與憑證（D2 就不再是無後端）、少量儲存成本，本產品下線即失效（I4 由下載副本保證）。
  - C：內容定址的公開鏡像（IPFS pinning、Arweave 永久儲存）——不依賴單一營運者；Arweave 依大小付費、IPFS 需持續 pin。
  - 建議：A（永遠可下載，任何副本都以 hash 核對；驗證連結可帶 bundle 的公開網址參數），與 D2 的 A 相容；B 等 D2 改選 B 時再議；C 延後到有使用者要求。
  - 結論：A：主辦者下載 bundle 並自行公開；任何副本均以 hash 核對。

- **D7 抽選協定 v1：drand 網路、演算法、時間與唯一性規則**（狀態：已允許 quicknet、hash 排序、15 確認、拒絕重複標籤、Unicode NFC 作未凍結開發預設，實測後定案；擋住步驟：6 的 v1 凍結；需要的事實：步驟 2 的確認延遲、步驟 3 的驗證可行性、步驟 4 的攻擊劇本結果）。發布後不可改（I3），所以列為決定題。
  - drand 網路：quicknet（3 秒、unchained、官方主推）（建議）／default（30 秒、chained，官方表示可能淘汰）。
  - 抽選演算法：
    - A：seed = sha256(randomness ‖ bundle hash)，每位參與者算 sha256(seed ‖ 正規化標籤)，排序取前 k 名，同值以名單序號決勝——最容易被第三方用任何語言重寫；O(n log n)。（建議：可重寫性是本產品的核心）
    - B：以 sha256 計數器流驅動 Fisher–Yates，並做 rejection sampling——無偏、通用；第三方重寫時較容易出現取模偏差這類錯誤。
    - C：NIST SP 800-90A HMAC-DRBG 驅動 Fisher–Yates——標準化；重寫門檻最高。
  - 時間規則：承諾區塊時間必須早於 round 時間，且 round 時間前承諾已有 N 個確認；建議 N = 15（約 5 分鐘，參考 `external-interfaces.md` E3），以步驟 2 實測修正。未達門檻的抽獎判為無效，重建時用新 drawId，舊承諾在驗證頁保留可見。
  - 唯一性規則：依 D3。
  - metadata label：自訂未註冊的 label（立即可用，可能與他人撞號）／向 CIP-10 註冊專用 label（需提交 PR、等待合併，建議）／CIP-20 的 674（通用訊息 label，列舉查詢量大，步驟 2 實測）。
  - 重複的參與者標籤：拒絕建立（建議，最不易誤解）／自動去重／當成多次參加（加權，需在規則中公開）。
  - 標籤正規化：Unicode NFC（建議，保留可見字形差異）／NFKC（合併相容字元，可能把不同帳號視為同一人）／不正規化（同字形不同編碼會被當成兩人）。
  - 結論：未決。

- **D8 名單收集是否在範圍內**（狀態：已決，2026-10-01，Will；擋住步驟：7；需要的事實：步驟 1 的證據（D1 選 A 時））
  - A：只支援主辦者貼上或上傳 CSV——範圍最小，與 D2 A 相容；主辦者要自己整理名單。（建議）
  - B：內建報名表——主辦者體驗完整；需要後端、防灌票與資格判斷，本產品成為個資持有者。
  - C：從社群平台匯入（留言、轉推）——最貼近創作者的實際用法；受平台 API 條款、費用與存取限制。
  - 結論：A：只支援貼上名單或上傳 CSV，主辦者自行收集與整理名單。

- **D9 公開發布在哪個網路**（狀態：未決；擋住步驟：10；需要的事實：步驟 2、7 的手續費與延遲實測、步驟 1 的證據）
  - A：只在 preprod 公開試用——無真實成本；測試網的安全性與持久性弱，承諾的公信力低。
  - B：直接主網——承諾有真實公信力；每場約 0.17–0.2 ADA，主辦者要有 ADA。
  - C：開發用 preprod，公開發布時上主網——兩者兼顧；部署設定要能切換網路並測試切換。（建議）
  - 結論：未決。

- **D10 授權條款**（狀態：已決，2026-10-01，Will；擋住步驟：5；需要的事實：無）
  - A：MIT——最寬鬆，最多人採用。
  - B：Apache-2.0——寬鬆並含專利授權條款，對協定與參考實作較周全。（建議）
  - C：AGPL-3.0——他人架設修改版也要公開原始碼；降低企業採用意願。
  - 結論：A：MIT。

- **D11 驗證頁瀏覽統計**（狀態：已決，2026-10-01，Will；擋住步驟：10；需要的事實：無）
  - A：不蒐集——隱私最好；無法量測「驗證連結帶來曝光」（REQ-27）。
  - B：不用 cookie、只有彙總數字的統計（例如托管平台內建的匿名分析）——能量測曝光，不追蹤個人；可能需要平台帳號。（建議）
  - C：完整分析工具（事件、來源、留存）——資料最多；有追蹤與同意告知的負擔，與產品的信任定位衝突。
  - 結論：B：無 cookie、只保留彙總數字；具體服務待選，不視為服務註冊或下載授權。

拍板順序：

1. 現在就能拍、互不相依：**D1**、**D10**、**D5**。
2. D1 選 A 時等步驟 1 的結論；選 B 或 C 時立即：**D4** → **D8** → **D2** 與 **D6** 一起拍（D2 依 D4、D8 決定是否需要後端；D6 選 B 會反過來要求後端；D6 也需要 D5）。
3. **D11** 在 D2 之後（統計方式受托管平台影響）。
4. **D3** 在步驟 2、4 之後；**D7** 在步驟 2、3、4 與 D3 之後。
5. **D9** 在步驟 7 之後。

## 進度

狀態值：未開始／進行中／程式完成待驗收／完成／不做（依已決選項）。

| 步驟 | 狀態 | 已跑的驗收 | 未跑的驗收與原因 | 消費端搜尋結果 | commit |
|---|---|---|---|---|---|
| 1 產品風險驗證 | 不做（D1-B） | 不適用 | 不適用；需求由公開試用驗證 | 無 | |
| 2 Spike A：preprod 承諾交易 | 進行中 | 3 個行為測試與 3 個 mutation；Mesh offline CBOR roundtrip；兩套 SDK browser build、Chrome 載入、Mesh 模擬交易、mock 主網拒絕、Lucid WASM 初始化；Koios tip 與 epoch parameters，見附件 spike-a.md | 真錢包、至少 5 次確認量測、列舉查詢與 Firefox 驗收未跑 | spike 獨立，無產品消費端 | |
| 3 Spike B：drand quicknet | 未開始 | | | | |
| 4 Spike C：單一有效承諾 | 未開始 | | | | |
| 5 本機功能版本 | 程式完成待驗收 | 本機 make check：lint、typecheck、13 測試、10 組獨立 Python vectors；Chrome 11 項 E2E，含 mock preprod unsigned build／fee；CLI 三種資料竄改皆 FAIL，signature 與 golden entrant mutation 使測試失敗；獨立設計審查 1 項記錄處理條件 | CI 未跑（尚未 commit／push）；真錢包、Firefox 與協定 v1 凍結依使用者要求延後 | rg -n "computeCommitment\|selectWinners\|verifyProof\|readCommitment\|findCommitments" packages apps tools：產品消費端為 web、CLI、chain 與 verifier，產品不引用 spike | |
| 6 協定 v1 與獨立 verifier | 進行中 | development protocol、獨立 CLI／Python vectors 與 BLS／時間／唯一性驗證已有本機測試 | v1 凍結與全套 mutation 待 spike 實測 | web 與 CLI 共用 verifier；Python 不引用產品模組 | |
| 7 主辦者建立抽獎並承諾 | 進行中 | Demo 建立／承諾／確認與逾時拒絕；mock 主網拒絕 | 真錢包三場 preprod 驗收依使用者要求延後 | apps/web/app.ts、cardano.ts | |
| 8 開獎與公開驗證頁 | 進行中 | Demo 開獎、分享、下載、標籤查詢、fresh page 重算與 hosted file hash 檢查 | 真鏈公開連結與 CLI 交叉驗收延後 | apps/web/app.ts、apps/verifier-cli/index.mjs | |
| 9 硬化 | 未開始 | | | | |
| 10 公開發布 | 未開始 | | | | |
| 11 收尾 | 未開始 | | | | |

## 壓力測試紀錄

2026-10-01，一個沒參與撰寫的唯讀 subagent 以 phase-plan 的審查提示詞原文檢查草稿，回報 14 項發現（高 4、中 8、低 2）。處置如下，處置後 `python3 check_plan.py` 為 OK。

| # | 發現（嚴重度） | 處置 |
|---|---|---|
| 1 | 計畫與附件沒有長期位置；本機個人脈絡檔不存在（高） | 改：「附件」寫明放 repo 的 `docs/plans/`，後續產出都寫進附件目錄並隨步驟 commit；「上層」註明脈絡檔尚未建立，建立它與在主清單加指向列為步驟 1 的需要人做的事。ADR 位置維持依 repo 指令檔與脈絡檔的規定（由使用者定，不由本計畫決定） |
| 2 | `validation.md` 會把受訪主辦者資料公開（中） | 改：步驟 1「不能動」限定只寫匿名化摘要，原始紀錄放 repo 外 |
| 3 | 缺「是否進入開發」的前提（中） | 改：新增 P12，擋住步驟 1 起所有步驟，並寫明本計畫取代主清單的哪一項 |
| 4 | D6 建議 B 需要寫入端點，與 D2 建議 A（無後端）矛盾（高） | 改：D6 建議改為 A；D6-B 註明需要後端；D2 加相依說明；拍板順序改成 D2 與 D6 一起拍 |
| 5 | I5 在建議的 D3-A 下寫得比做得到的強（高） | 改：I5 改寫成 verifier 可判定的形式（同地址同 drawId 以最早一筆為準，跨地址只能察覺）；I7 加上對應邊界文字；D3 加「對不變量的影響」 |
| 6 | 唯一性需要的列舉查詢未量測；metadata label 未列為協定子題（中） | 改：步驟 2 加 `/tx_by_metalabel` 與依地址列舉的量測；D7 加 metadata label 子題；步驟 6 加 CIP-10 PR 的需要人做的事 |
| 7 | I3 沒定義凍結點（中） | 改：凍結點定為步驟 10 第一場公開抽獎上鏈時，凍結前修改須同步更新 vectors；步驟 6 的不能動同步修正 |
| 8 | 步驟 5 的 mutation 不一定會失敗（中） | 改：fixture 改含 signature、verifier 自算 randomness 並對照 golden winners；mutation 改成改 signature 與改名單兩個 |
| 9 | 步驟 6 的演算法 mutation 條件寫反、未定義（中） | 改：依 D7 每個選項各列一個具體 mutation |
| 10 | 重複標籤與 Unicode 正規化是隱藏的協定決定（中） | 改：併入 D7 子題，附選項與建議 |
| 11 | 步驟 7 的 e2e 與 mutation 互相衝突且無法自動化（高） | 改：驗收分自動（mock CIP-30＋假鏈，含延遲確認的 mutation）與人工（preprod、使用者簽署、延遲送出製造無效場次）兩層 |
| 12 | §3 的多個「未決」沒有負責的步驟或決定；N8 的獲客量測沒有對應（中） | 改：費用上限歸 D9、延遲歸 D7、indexer 交叉比對指向延後項、可觀測性新增 D11；新增 REQ-27 對應步驟 10；`--nfr` 改為檢查每個未決列都有負責的決定或延後項 |
| 13 | `--validation`、`--spike-c` 比宣稱的弱；步驟 4 未說明 C 怎麼判定（低） | 改：`--validation` 逐一比對 §4 風險名稱；`--spike-c` 檢查每格以「擋住／擋不住」開頭並附理由；步驟 4 註明 C 以文件推論。兩項都以 mutation 驗證會失敗 |
| 14 | 托管平台不是決定題；步驟 11 的 CI 項與 `make check` 重複；P7 缺 Python 與 JCS；進度表缺消費端欄（低） | 改：托管平台併入 D2 子題（不另開一題：與產品形態同時決定）；步驟 11 改成確認三項測試在 `make check` 內；P7 加 Python 3 參考實作與 bundle 值型別限制；進度表加「消費端搜尋結果」欄 |
