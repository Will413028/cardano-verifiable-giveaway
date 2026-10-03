# 需求清單、非功能需求與產品風險

快照：repo 尚無 commit（`git log` 回報 `does not have any commits yet`，2026-10-01），README.md、AGENTS.md 為未提交的工作區內容。
產生方式：逐句讀三份來源，人工編號。機械檢查：`python3 check_plan.py`（同目錄）。

## 1. 需求來源（逐句編號）

來源代號：

- **N**：產品構想筆記（私人筆記，未公開，2026-10-01）。只摘要與產品有關的句子，個人脈絡不收錄。
- **R**：repo 的 `README.md`（2026-10-01 工作區版本，原文引用）。
- **A**：repo 的 `AGENTS.md`（2026-10-01 工作區版本，原文引用）。

| 編號 | 來源句 |
|---|---|
| N1 | 服務創作者、社群管理員或開源專案的免費抽獎。（摘要） |
| N2 | 不以付費入場、Token／NFT 或加密貨幣獎金為核心。（摘要） |
| N3 | 主辦者固定參加名單、規則、算法版本與未來的 drand round，將整體 commitment 寫入 Cardano。（摘要） |
| N4 | 確認事前承諾已上鏈後，才使用尚未產生的公開 randomness。（摘要） |
| N5 | 參與者可取得原始資料，獨立核對 commitment、時間順序並重算得獎結果。（摘要） |
| N6 | Cardano 不是唯一可用的鏈；hash 不保存完整名單。（摘要） |
| N7 | 驗證範圍是已承諾名單與規則下的抽選，不等於證明所有合格參與者都被收錄，也不證明獎品已交付。（摘要） |
| N8 | 每場抽獎產生公開驗證連結，可能帶來分享與曝光；這是待驗證的獲客假設。（摘要） |
| N9 | 是否需要 smart contract 尚未決定。（摘要） |
| N10 | 待驗證：主辦者為何選這個版本、實際試用與重複使用、發布渠道能否帶來使用者、操作成本與差異化；只更換存證鏈不構成產品優勢。（摘要） |
| N11 | 減少對單一公司的信任就算足夠的價值，不要求 Cardano 獨有能力；接受外部事實或 attestor。（摘要） |
| N12 | 排除收款、分潤、預約，以及 Token／NFT 作為產品核心。（摘要） |
| N13 | 一般生活應用與服務既有 Cardano 使用者的工具都在接受範圍內。（摘要） |
| N14 | 尚未授權實作，也未授權對外聯絡。（摘要） |
| R1 | "Commit the entrant list, rules, algorithm version and a future drand round on Cardano." |
| R2 | "Use that round's verifiable randomness after the commitment is confirmed." |
| R3 | "Publish the necessary data and an independent result verifier." |
| R4 | "Payments, revenue splitting and bookings are outside the product scope." |
| R5 | "Token issuance, NFTs, betting and cryptocurrency prizes are not the product core." |
| R6 | "Verification covers selection from the committed list. It does not establish entrant eligibility, list completeness or prize delivery." |
| A1 | "Distinguish blockchain commitments and validator checks from claims about external facts." |
| A2 | "Do not present planned functionality as implemented, deployed or validated by users." |
| A3 | "Add development and verification commands only after a runnable scaffold exists and the commands can be checked." |

來源之間的用詞差異：N12 寫「Token／NFT 不作為產品核心」，R5 另含 betting 與 cryptocurrency prizes，兩者範圍一致（R5 較廣），以 R5 為準，不列決定題。N6「Cardano 不是唯一可用的鏈」與 README「Use Cardano」不衝突：鏈已選定 Cardano，N6 說明的是價值不依賴 Cardano 獨有能力。

## 2. 需求清單

「對應」欄：計畫的步驟編號，或「不做」「延後」（理由寫在計畫的「範圍」段）。「推論」項依 SKILL 判準處理：會改變範圍、契約、資料模型或成本的併入決定題，其餘寫成計畫前提（未確認）。

| ID | 類別 | 需求 | 來源 | 對應 |
|---|---|---|---|---|
| REQ-01 | 畫面 | 主辦者建立抽獎：輸入名單、規則（得獎人數）、選擇未來的 drand round | N3, R1 | 7 |
| REQ-02 | 畫面 | 承諾狀態：送出交易、等待確認、已確認並顯示距 round 的倒數 | N4, R2 | 7 |
| REQ-03 | 畫面 | 每場抽獎一個公開驗證頁（可分享的連結） | N8, R3 | 8 |
| REQ-04 | 畫面 | 獨立 verifier：參與者載入資料後重算並核對 commitment、時間順序、randomness 與得獎者 | N5, R3 | 6 |
| REQ-05 | 畫面 | 驗證邊界的固定說明：只涵蓋已承諾名單下的抽選，不證明資格、名單完整、獎品交付 | N7, R6, A1 | 6, 8 |
| REQ-06 | 畫面 | 參與者確認自己在已承諾名單內 | 推論（併入 D5） | 6 |
| REQ-07 | 介面 | Cardano 承諾交易的建構、簽署與送出 | N3, R1, N9 | 2, 7 |
| REQ-08 | 介面 | 由鏈上資料查詢承諾交易與其區塊時間 | N4, N5 | 2, 6 |
| REQ-09 | 介面 | 取得指定 drand round 並驗證 BLS 簽章 | N3, N4, R2 | 3, 6 |
| REQ-10 | 介面 | 公開的抽獎資料格式（bundle）與協定版本，供第三方重寫 verifier | N5, R3, N3 | 6 |
| REQ-11 | 資料實體 | Draw bundle：名單、規則、演算法版本、drand round、draw id | N3, R1 | 6 |
| REQ-12 | 資料實體 | Commitment：bundle hash、交易 id、區塊與時間 | N3, N6 | 6, 7 |
| REQ-13 | 資料實體 | Result：randomness、得獎者、可重算的中間值 | N5 | 6, 8 |
| REQ-14 | 資料實體 | 參與者識別資料的公開形式（明文、加鹽 hash 或兩層） | 推論（併入 D5） | 6 |
| REQ-15 | 流程 | 建立 → 承諾 → 確認 → 等 round → 開獎 → 公開 | N3, N4, R1, R2 | 7, 8 |
| REQ-16 | 流程 | 參與者驗證流程，不依賴本產品伺服器在線 | N5, N11 | 6, 9 |
| REQ-17 | 流程 | 承諾在 round 前未達確認門檻、或 round 已過時的處理規則 | 推論（併入 D7） | 7, 9 |
| REQ-18 | 流程 | 同一場抽獎只有一個有效承諾（防止主辦者挑結果） | 推論（併入 D3、D7） | 4, 6, 9 |
| REQ-19 | 流程 | 名單收集（報名表、社群平台匯入） | 推論（併入 D8） | 延後 |
| REQ-20 | 流程 | 產品需求與差異化的驗證 | N10, N8 | 1 |
| REQ-21 | 流程 | 驗證資料的保存與取得位置 | 推論（併入 D6） | 8 |
| REQ-22 | 範圍外 | 收款、分潤、預約 | N12, R4 | 不做 |
| REQ-23 | 範圍外 | Token 發行、NFT、下注、加密貨幣獎金作為產品核心 | N2, N12, R5 | 不做 |
| REQ-24 | 範圍外 | 證明參與資格、名單完整或獎品交付 | N7, R6 | 不做 |
| REQ-25 | 文件 | README 與頁面不得把規劃中的功能寫成已完成或已驗證 | A2 | 5, 11 |
| REQ-27 | 流程 | 量測公開驗證連結帶來的瀏覽與分享（獲客假設） | N8 | 10 |
| REQ-26 | 文件 | 開發與驗證指令只在可執行的 scaffold 存在且指令跑過後才寫進文件 | A3 | 5 |

## 3. 非功能需求

| 項目 | 門檻 | 狀態與依據 |
|---|---|---|
| 每場上鏈費用 | 預估約 0.17–0.2 ADA／場（fee = 44 × tx bytes + 155381 lovelace；400 bytes 約 0.173 ADA）。上限門檻未決 | 公式見 `external-interfaces.md` E2；實測於步驟 2；上限由 D9 一併拍板，由誰付見 D4 |
| 承諾確認到可開獎的延遲 | 未決：取決於 D7 的確認數門檻（例：15 個區塊約 5 分鐘） | 步驟 2 量測；由 D7 的時間規則拍板 |
| 名單規模 | 提案（未決）：10,000 筆名單在一般筆電瀏覽器內完成 verifier 重算 ≤ 2 秒 | 步驟 9 量測後定案 |
| 安全：金鑰 | 本產品不持有、不接觸任何私鑰（依 D4；選 B 時改寫） | 依 D4 |
| 安全：信任根 | verifier 寫死 drand quicknet 的 chain hash 與 group public key；不採用 relay 回傳的 key | `external-interfaces.md` E4 |
| 安全：鏈資料來源 | verifier 允許使用者指定或交叉比對 indexer；單一 indexer 回傳值不當成唯一事實（未決：是否預設交叉比對兩家） | 步驟 6、9；E5；預設交叉比對列在計畫「範圍」的延後項 |
| 隱私 | 公開 bundle 不含 email、電話等聯絡資料的明文 | D5 |
| 可觀測性 | 未決：是否蒐集驗證頁瀏覽數（產品驗證需要，但與隱私取捨） | 由 D11 拍板 |
| 資料保存 | 驗證資料在主辦者或本產品停止服務後仍可取得 | D6 |
| 可用性 | 有 bundle 與公開鏈、drand 資料即可完成驗證，不需要本產品伺服器在線 | 不變量 I4 |

## 4. 待驗證的產品風險

| 風險 | 目前證據 | 不證明什麼 |
|---|---|---|
| 有沒有人要：主辦者為什麼選這個版本而不是 RANDOM.ORG 或社群平台內建抽獎 | 本產品無任何試用、訪談或留存證據（N10）。RANDOM.ORG 公開抽獎紀錄顯示抽獎服務有實際使用（P1） | 不代表需要可重算或上鏈版本 |
| 差異化 | 已有 ProofDraw（P2）、GlassPick（P3）、OpenGiveaway（P4）、Verified Draws（P5）提供 hash 承諾、drand 或可本機重算 | 只換存證鏈不構成優勢（N10）；本產品能主張的增量是「時間順序與承諾不由單一公司控制，且可公開核對」（N11） |
| 會不會反覆用 | 無證據 | — |
| 獲客：公開驗證連結帶來分享與曝光 | 假設（N8），無證據 | — |
| 操作成本：主辦者需要 Cardano 錢包與 ADA | 無證據；可能排除非加密貨幣使用者的創作者（與 N1、N13 的目標族群有張力） | 見 D4 |
| 主辦者挑結果（建立多個承諾只公開有利的一個） | 協定層面的已知攻擊；任何「承諾＋未來亂數」方案都有 | 見 D3、D7、不變量 I6 |
