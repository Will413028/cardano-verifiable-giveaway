# 外部介面、既有先例與業界做法

查詢日期一律為 2026-10-01，方法為公開網頁搜尋與官方文件；未註冊任何服務、未呼叫付費 API、未安裝任何套件。標「未實測」的數字在對應 spike 實測後覆寫本表並註明日期。

## 外部介面

| ID | 介面 | 事實（會變動的參數附重查方法） | 來源 |
|---|---|---|---|
| E1 | Cardano transaction metadata | 單一 metadata 字串（UTF-8）最長 64 bytes，較長內容要切成陣列；CIP-20 以 label 674 放人類可讀訊息；整筆 metadata 上限約 16 KB（受最大交易大小限制）。label 註冊見 CIP-10。未實測 | [CIP-20](https://cips.cardano.org/cip/CIP-20)、[developers.cardano.org: transaction metadata](https://developers.cardano.org/docs/transaction-metadata/) |
| E2 | Cardano 手續費 | `fee = minFeeA × size(tx) + minFeeB`，查詢日 minFeeA = 44 lovelace/byte、minFeeB = 155381 lovelace；參數可由治理變更。重查：Blockfrost 相容 indexer 的 `GET /epochs/latest/parameters`（`min_fee_a`、`min_fee_b`；建立頁的 Evolution `BlockfrostProvider` 讀同一個端點）或 cardano-cli `query protocol-parameters`（2026-10-20 改寫）。未實測 | [docs.cardano.org: fee structure](https://docs.cardano.org/about-cardano/explore-more/fee-structure)、[IOHK: How Cardano's transaction fees work](https://iohk.io/en/blog/posts/2017/10/19/how-cardanos-transaction-fees-work/) |
| E3 | Cardano 區塊時間與確定性 | 平均 20 秒一個區塊；節點視 k = 2160 個區塊之後為不可逆（約 12 小時）；實務上交易所等待約 15 個確認（約 5–10 分鐘）。Ouroboros Peras 以投票縮短 settlement，目標約 2 分鐘，查詢日尚未確認已在主網啟用。未實測 | [cexplorer: Understanding Transaction Finality](https://cexplorer.io/article/understanding-transaction-finality)、[docs.cardano.org: time handling](https://docs.cardano.org/about-cardano/explore-more/time)、[Peras FAQ](https://peras.cardano-scaling.org/docs/faq/) |
| E4 | drand quicknet（League of Entropy mainnet） | period 3 秒；scheme `bls-unchained-g1-rfc9380`（unchained，簽章只對 round 編號）；chain hash `52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971`；genesis time 1692803367；randomness = sha256(signature)；round(t) = floor((t − genesis) / period) + 1。HTTP relay：`api.drand.sh`、`api2.drand.sh`、`api3.drand.sh`、`drand.cloudflare.com`。舊的 default 網路為 30 秒 chained，官方表示可能在未來淘汰。重查：`GET https://api.drand.sh/<chain hash>/info` | [quicknet is live](https://docs.drand.love/blog/2023/10/16/quicknet-is-live/)、[drand Protocol Specification](https://docs.drand.love/docs/specification/)、[drand explainer](https://docs.drand.love/blog/2023/06/02/drand-explainer/)、[drand-client (JS)](https://github.com/drand/drand-client) |
| E5 | 鏈上資料查詢（indexer） | **2026-10-20 改寫（階段計畫步驟 13，F15；決定見 PD7、PD8）。** 介面是 Blockfrost 形狀的 HTTP API：verifier 讀 `/txs/{hash}`、`/txs/{hash}/cbor`、`/txs/{hash}/utxos`、`/blocks/latest`、`/blocks/{height}`、`/accounts/{stake}/withdrawals`，建立頁另讀 `/accounts/{stake}`、協定參數與 UTxO。專案自架 [Dolos](https://github.com/txpipe/dolos)（MiniBF，1.6.1 實測於本機 emulator 開發鏈）：full archive、不需要 API key、`max_scan_items` 預設 3,000；它有狀態、不能跑在 Workers，部署形態是一台 VM，網頁經 `deploy/dolos-proxy/` 的 nginx（唯讀端點 allowlist、依 IP 限流、CORS 網域清單、不記錄請求內容）直接讀取，後端不轉發（PD8 A）；VM 與 proxy 都尚未部署（MVP 計畫步驟 10），preprod 規模的磁碟與同步時間屬階段計畫步驟 8c。CLI 沒有專案預設 indexer，必須以 `--indexer` 指定使用者自備的 full-archive Blockfrost 相容節點（Dolos 1.6.1 符合；db-sync 需要 `ioShelley`）。任何 indexer 都是信任點，信任範圍見 `docs/protocol-development.md`「What the indexer is still trusted for」。**Koios 已移除（2026-10-19）：** koios.rest 條款字面禁止系統性擷取、自動化使用與轉發，Will 決定不取得同意；託管 Blockfrost 依同一 ADR 不採用。原列的 Koios 公開層與 Blockfrost 免費層額度不再適用，原文見 git 歷史。重查：Dolos 的 release 與 MiniBF 文件 | [Dolos](https://github.com/txpipe/dolos)、[Blockfrost API](https://docs.blockfrost.io/)、`docs/adr/2026-10-19-self-hosted-dolos-indexer.md` |
| E6 | 瀏覽器錢包 | CIP-30 是瀏覽器錢包的 dApp 連接標準（取得地址、簽交易、送交易） | [Mesh](https://github.com/MeshJS/mesh)、[developers.cardano.org: builder tools](https://developers.cardano.org/tools/) |
| E7 | Off-chain TypeScript SDK | Mesh（含 CIP-30 BrowserWallet、Koios provider）、Evolution SDK（純 TypeScript、無 WASM）、Lucid Evolution、Blaze。預設選擇於步驟 2 依實測決定 | [MeshJS](https://meshjs.dev/)、[Mesh Koios provider](https://meshjs.dev/providers/koios)、[Lucid Evolution](https://github.com/Anastasia-Labs/lucid-evolution)、[Blaze](https://deepwiki.com/butaneprotocol/blaze-cardano) |
| E8 | 測試網 | preprod 是與主網相近的公開測試網，測試幣由 faucet 取得（可能需要人機驗證，列為需要人做的事） | [docs.cardano.org: testnet environments](https://docs.cardano.org/cardano-testnets/environments)、[faucet](https://docs.cardano.org/cardano-testnets/tools/faucet)（2026-10-20 換來源） |
| E9 | 第二錨點（替代方案） | OpenTimestamps：把 hash 錨定到 Bitcoin，證明檔可離線驗證；需等 Bitcoin 區塊確認（數小時級） | [OpenTimestamps (DGI)](https://www.dgi.io/ots/) |
| E10 | Canonical JSON | RFC 8785 JSON Canonicalization Scheme（JCS），讓不同語言對同一份 JSON 產生同一個 hash | [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) |

## 既有先例

| ID | 先例 | 證明了什麼 | 不證明什麼 |
|---|---|---|---|
| P1 | [RANDOM.ORG 公開抽獎紀錄](https://www.random.org/draws/records/) | 第三方抽獎服務有持續使用與重複主辦者 | 不代表主辦者需要可重算或上鏈 |
| P2 | [ProofDraw](https://proofdraw.com/)、[proofdraw/draw-lists](https://github.com/proofdraw/draw-lists)、[第三方 API 介紹](https://github.com/api-evangelist/proofdraw) | 「名單 SHA-256 承諾＋未來 drand round＋公開 verifier」已有人做成 API；名單以內容定址公開鏡像，並用 OpenTimestamps 存證 | 未驗證其部署與安全性；Git commit 時間與事後完成的 timestamp 不能當獨立的事前時間證明 |
| P3 | [GlassPick](https://jishnuteegala.com/projects/glasspick) | 可本機重算的開源 static SPA；可重算本身不需要上鏈 | 不提供公開的事前時間證明 |
| P4 | OpenGiveaway（搜尋結果顯示為 GitHub `AnandakumarNatarajan/opengiveaway`，2026-10-01 抓取時回 404，內容只來自搜尋摘要） | 摘要稱：SHA-256 與 Merkle root 承諾、抽選前以 OpenTimestamps 錨定到 Bitcoin、以預先指定的 Bitcoin 區塊當亂數 | 未能讀到原始碼，不作為設計依據 |
| P5 | [Verified Draws](https://verifieddraws.uk/) | 以 drand 做可分享驗證連結的抽獎已有商業產品 | 未查其承諾與時間證明方式 |
| P6 | [RFC 3797 Publicly Verifiable NomCom Random Selection](https://datatracker.ietf.org/doc/html/rfc3797) | 事先公開名單編號、演算法與未來公開亂數來源，事後任何人可重算——本產品流程的標準先例（IETF 每年使用） | 其 hash 選用 MD5，已不適合直接照搬 |
| P7 | [Sui 上的 raffle 合約設計（arXiv 2310.12305）](https://arxiv.org/pdf/2310.12305) | 鏈上合約執行抽選是另一端的做法 | 本產品不需要合約執行抽選（N11 接受外部事實） |

## 業界做法的光譜（供決定題引用）

- **時間證明的錨點**：中心化日誌（RANDOM.ORG）→ Git 公開紀錄（ProofDraw 的一部分）→ Bitcoin 錨定（OpenTimestamps，P2、P4）→ 公開鏈交易 metadata（本產品預設）→ 鏈上合約狀態（P7）。越右越不依賴單一營運者，成本與複雜度越高。
- **亂數來源**：營運者自產（不可驗證）→ 未來區塊 hash（P4；礦工或出塊者可影響）→ drand 門檻 BLS 簽章（P2、P5；需信任 League of Entropy 門檻成員不串通）→ 鏈上 VRF。
- **抽選演算法**：依 hash 排序取前 k 名（實作最簡單、易重寫）→ 以 hash 計數器流驅動 Fisher–Yates 並做 rejection sampling（無偏、通用）→ NIST SP 800-90A HMAC-DRBG 驅動 Fisher–Yates（標準化 DRBG，重寫門檻較高）。
- **名單公開形式**：明文公開（最易重算、隱私最差）→ 明文標籤＋加鹽 hash 的聯絡資料（兩層）→ 逐筆加鹽 hash＋Merkle root（P4；參與者需持有自己的 receipt 才能確認收錄）。
