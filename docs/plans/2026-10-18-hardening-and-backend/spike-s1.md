# Spike S1：Cardano SDK 與 verifier 依賴比較

狀態：完成（本機量測）。日期：2026-10-18。程式：`spikes/s1-sdk/`（拋棄式，不被產品引用）。原始結果：`spikes/s1-sdk/results/*.json`。

本檔只記事實；PD1、PD6 的拍板在計畫的決定段。

## 環境與版本

- Node v26.10.0、pnpm 11.2.2、esbuild 0.28.2；Chrome 155.0.8059.82（系統安裝版，headless，經 npx 快取的 playwright-core 1.59.1）；workerd 經 miniflare 4.20260730.0，`compatibilityDate` 2026-07-01。workerd 是本機執行，不等於已部署的 Workers。
- 受測套件（鎖在 `spikes/s1-sdk/pnpm-lock.yaml`）：`@meshsdk/core` 1.9.1、`@evolution-sdk/evolution` 0.6.0、`@blaze-cardano/sdk` 0.3.3／`@blaze-cardano/core` 0.10.1、`@noble/hashes` 2.4.0、`@noble/curves` 2.4.0。
- 四個選項：
  - **mesh**、**evolution**、**blaze**：用 SDK 自己的 API 解析、算 hash、驗 COSE。
  - **minimal**（PD6-B）：`options/minimal.mjs` 自寫 112 行（含 COSE 驗證）的 CBOR 讀取器（保留每個元素的原始 byte 範圍）＋`@noble/hashes`（blake2b）＋`@noble/curves`（ed25519，`zip215: false`）。COSE_Sign1 依 CIP-8／RFC 9052 自行驗。
  - Blaze 沒有 CIP-8 驗證 API：blaze 選項的 COSE 是自組的，解析與每項檢查都與 minimal 相同，只把 ed25519 與 blake2b-224 換成 Blaze（libsodium）的原語。所以它的 COSE 結果量的是「Blaze 的密碼原語能不能用」，不是 Blaze 的 COSE 能力。

## Fixture

- 鏈上（preprod，2026-10-18 以 Koios `POST /tx_cbor` 下載，原始回應存 `fixtures/koios-tx_cbor.json`）：
  - `515d0ea3fe8c2c38b0825bc5cfc386f962845f3c733e29828cf43d7dad3e0207`：block 5304967，CIP-25 鑄造（label 721），866 bytes。
  - `3883c2a93818bc9502844a8f512ddd3a89a25ed2487d80235ad613d43cb93d12`：block 5304975，label 1 metadata，290 bytes。
- 合成（從未上鏈）：把 `3883c2a9` 的 aux data 改成非 canonical 編碼，body 的 key 7 就地換成新 aux 的 hash，tx hash 由新 body bytes 算出。兩種：label 寫成兩 byte 的 uint（`0x18 0x01`）、內層 map 改成 indefinite length。ledger 對送出的原始 bytes 算 hash，所以 verifier 必須保留原始 bytes。
- 每筆另有兩個變體：body 中第一個 input 的 tx id 最後一個 byte 翻一個 bit（hash 必須改變）、aux 中最後一個翻了仍是合法 CBOR 的 byte（aux hash 必須改變）。
- COSE 向量 29 個（`prepare.mjs`）：
  - 24 個：三個獨立產生器（依 RFC 9052 結構手寫的 noble 版、Evolution `signData`、Mesh `signData`）× base 地址／payment key 與 reward 地址／stake key 的有效簽章，加上換 payload、翻簽章 bit、攻擊者金鑰在 protected header 冒填主辦者地址、header 地址與受檢地址不同。
  - 5 個結構性負向（noble 產生）：payment key 簽 reward 地址、protected header 的 alg 是 ES256（-7）、COSE_Sign1 後多一個 byte、內嵌 payload 被換掉且呼叫端也傳被換的 payload、`hashed` 未設但內嵌的是 blake2b-224(message)。
  - 金鑰由 spike 內的固定字串導出，從未持有資金，不是個人錢包。

## 結果

### 解析交易並重算 tx hash 與 aux data hash（4 筆交易，各含 2 個竄改變體）

| 選項 | Node | Chrome | workerd |
|---|---|---|---|
| minimal | 4/4 hash、4/4 aux，竄改全數改變 | 同 Node | 同 Node |
| evolution | 同上，但只在用 `fromCBORHexWithFormat`＋`toCBORBytesWithFormat` 取 body、用 `CBOR.decodeItemWithOffset` 切 aux 原始範圍時；直覺 API 錯：`TransactionBody.toHash(body)` 3/4（`515d0ea3` 錯）、`AuxiliaryData.toHash` 2/4（兩筆非 canonical 錯） | 同 Node | 同 Node |
| mesh | 4/4、4/4 | 4/4、4/4（需 polyfill，見下） | 只 import `resolveTxHash` 時 hash 4/4；import `cst` 或 `checkSignature` 後 Worker 啟動即失敗（`No secure random number generator found`，libsodium 在模組頂層取亂數） |
| blaze | 4/4、4/4 | 4/4、4/4（需 polyfill） | hash 4/4、aux 4/4（需 `stream` shim 與 Buffer／process globals） |

### 驗證 CIP-8 COSE_Sign1（29 個向量，與預期一致的數量）

| 選項 | Node | Chrome | workerd |
|---|---|---|---|
| minimal | 29/29 | 29/29 | 29/29 |
| evolution（`SignData.verifyData`） | 29/29 | 29/29 | 29/29 |
| mesh（`checkSignature`＋自補 header 地址比對） | 26/29；不補時 23/29 | 26/29 | 不支援：Worker 無法啟動 |
| blaze（無 API；自組，見上） | 29/29 | 29/29 | 不支援：`initCrypto` 卡死（workerd 判定 promise 永不完成）；未初始化時 `crypto_sign_verify_detached is not a function` |

- Mesh 誤判為有效的 3 個（加了 header 比對之後）：alg ES256、COSE_Sign1 後多一個 byte、`hashed` 未設但 payload 是 blake2b-224(message)。不補 header 比對時再加 3 個「header 地址與受檢地址不同」。
- workerd 對 8-byte 空模組呼叫 `WebAssembly.compile` 得到 `Wasm code generation disallowed by embedder`（實測）。libsodium 因此初始化不了是推論：沒有直接量 libsodium 的 WASM 載入，只量到 `initCrypto` 卡死與未初始化錯誤。

停止條件（沒有任何 SDK 能在 Workers 驗證 COSE）未觸發：evolution 與 minimal 都能。

### 組出帶 metadata、`required_signers`（stake key hash）與 `invalid_hereafter` 的自轉交易（PD1）

同一份規格（假 UTxO 10 ADA、自轉 2 ADA、label 674 commitment metadata、`required_signers` 放 stake key hash、`invalid_hereafter` slot 136700000、2026-10-18 的 preprod epoch 320 參數），以 minimal 讀取器檢查產物。

| SDK | Node | Chrome | 未簽交易 | fee（lovelace，Node 量） | 檢查項 |
|---|---|---|---|---|---|
| mesh | 通過 | 通過 | 467 bytes | 185,037 | ttl、required signer、label 674、aux hash 一致 |
| evolution | 通過 | 通過 | 472 bytes | 185,257 | 同上 |
| blaze | 通過 | 通過 | 467 bytes | 185,037 | 同上 |

- Mesh 與 Blaze 的產出逐 byte 相同（`results/build-node.json` 兩筆 `cbor` 相等，tx hash 都是 `4227c816…`）；兩者底層都是 `@cardano-sdk/core`。
- Evolution 的有效期只能以 Unix 毫秒給（`setValidity({ to })`），經 `preprod.slotConfig`（zeroTime 1655769600000、zeroSlot 86400、1000 ms）換算；這組值與 Koios tip 推出的一致（`fixtures/koios-tip.json`：block_time − abs_slot = 1655683200 = 1655769600 − 86400）。
- fee 是否已計入 payment 與 stake 兩個 witness：由 fee 反推交易大小約 674／679 bytes，比未簽交易多約 207 bytes，推論已計入兩個 witness（推論，未簽署驗證）。
- 錢包會不會替 `required_signers` 裡的 stake key 簽章：未驗證（等真錢包）。

### 瀏覽器 bundle（esbuild、ESM、ES2022、minify；gzip level 9）

先不加任何 shim；失敗才補無法解析的 Node built-in，再不行才注入 Buffer／process globals。「Chrome 實跑」欄是 Chrome 實際跑通的最小變體（verify＋組交易合併入口）。

| 入口 | raw／gzip bytes | 打包進來的第三方套件 | 需要的 shim | Chrome 實跑 |
|---|---|---|---|---|
| verify：minimal | 43,917／17,022 | 2（noble ×2） | 0 | 不需 shim |
| verify：evolution | 786,099／235,867 | 9 | 0 | 不需 shim |
| verify：blaze（只引 `@blaze-cardano/core`） | 1,025,439／294,744 | 71 | `stream`＋Buffer、process globals | 需 globals |
| verify：mesh | 5,933,264／1,526,539 | 125 | `crypto`、`stream`＋Buffer、process globals | 需 globals |
| 組交易＋錢包：evolution（`build`、`Client`） | 1,008,216／295,246 | 9 | 0 | 不需 shim |
| 組交易＋錢包：blaze（`build`、`Blaze`、`WebWallet`） | 1,694,035／492,656（6 檔，含延遲載入的 cardano-message-signing WASM） | 86 | `stream`＋空模組 `fs`、`path`＋globals | 需 globals |
| 組交易＋錢包：mesh（`build`、`BrowserWallet`） | 5,928,683／1,519,596 | 125 | `crypto`、`stream`＋globals | 需 globals |

- Evolution 的 9 個套件含 `fast-check` 與 `pure-rand`；原因推論是模組匯出測試用的 `arbitrary`，tree shaking 拿不掉（未逐一確認）。
- 現行 app 的 Mesh 設定用 5 個 alias（Spike A）；本次 Mesh 入口實測只需 `crypto`、`stream` 兩個 alias 加兩個 globals，差異推論來自 app 另引了 `KoiosProvider` 等（未量）。

### workerd bundle（只含驗證路徑，單檔；大小含 harness 與內嵌的 fixture）

| 選項 | 結果 | gzip bytes |
|---|---|---|
| minimal | 全過，不需 shim | 21,808 |
| evolution | 全過，不需 shim | 240,805 |
| mesh | 不能用：只留 `resolveTxHash` 時 hash 可算；aux 與 COSE 所需的 import 讓 Worker 起不來；`nodejs_compat` 也一樣 | — |
| blaze | 驗證路徑整體不能用：hash 與 aux 可算，COSE 不行；`nodejs_compat` 也卡死 | — |

### 維護狀態（2026-10-18 以 `node maintenance.mjs` 查詢，原始值在 `results/maintenance.json`；近 90 天＝2026-07-20 之後）

| 套件 | 首版 | 版本數／近 90 天 | 最新版發布 | 週下載（10-10～10-16） | repo | 近 90 天 commit 作者 |
|---|---|---|---|---|---|---|
| `@meshsdk/core` | 2022-12 | 237／0 | 1.9.1，2026-06-19 | 4,691 | MeshJS/mesh：273 stars、85 open issues＋PR、Apache-2.0 | 7 |
| `@evolution-sdk/evolution` | 2025-07 | 60／8 | 0.6.0，2026-10-07 | 1,162 | IntersectMBO/evolution-sdk：22 stars、95、MIT | 8 |
| `@blaze-cardano/sdk` | 2024-05 | 139／4 | 0.3.3，2026-10-14 | 10,831 | butaneprotocol/blaze-cardano：64 stars、14、Apache-2.0 | 5 |
| `@noble/hashes`／`@noble/curves` | 2021-11／2022-12 | 46／2、54／2 | 2.4.0，2026-08-27 | 58,784,962／20,479,869 | paulmillr：931／963 stars、4／3、MIT；README 標示經獨立資安公司稽核（未查稽核報告本身） | 1／1 |

- 產品 repo（只裝 Mesh）的 `node_modules/.pnpm` 同時有兩版 `@meshsdk/core-cst`（1.9.0-beta.100、1.9.1）、兩版 `@cardano-sdk/core`（0.46.12、0.47.1）、兩版 `libsodium-wrappers-sumo`（0.7.10、0.8.4）；`@meshsdk/core` 1.9.1 依賴的 `@meshsdk/provider` 是 1.9.0-beta.101，它帶進 beta 版的 core-cst（`pnpm why`）。
- Blaze 的 1.0.0（2026-07-27）掛在 `catalyst` dist-tag，`latest` 是 0.3.3。
- Evolution 是 0.x，近 90 天 8 個版本，API 可能仍在變。

## 發現

1. **Evolution 的直覺 hash API 對真實交易算錯。** `TransactionBody.toHash` 會重新編碼，鏈上 `515d0ea3` 就算錯；`AuxiliaryData.toHash` 對非 canonical aux 算錯。正確做法要用 format tree 或 `CBOR.decodeItemWithOffset` 切原始範圍。採用 Evolution 進信任路徑時，這兩個 API 要由 lint 或測試擋住。
2. **Mesh `checkSignature` 的檢查不完整**：不比對 protected header 的地址、不檢查 alg、接受 COSE_Sign1 後的多餘 bytes、`hashed` 未設時也接受 blake2b-224 雜湊過的 payload（23/29；只補 header 比對後 26/29）。
3. **Workers 不准執行期編譯 WASM**，所以 `@cardano-sdk/crypto`（libsodium）在 Workers 不能做 ed25519；Mesh 更是只要引入就讓 Worker 起不來。Blaze 與 Mesh 都不能當後端的簽章驗證依賴。
4. **CBOR 與 hash 本身四個選項都做得到**；差別在 COSE、在 Workers 能不能跑，以及信任路徑帶進多少套件（2／9／71／125）。
5. 兩筆合成交易的預期 hash 由 `prepare.mjs` 以 minimal 的範圍切割加 noble 算出，minimal 在這兩筆上是自己對自己；Evolution（offset 路徑）、Mesh、Blaze 的結果一致，可視為交叉驗證，但不是鏈上真值。

## 未驗證

- 真錢包：CIP-30 `signData` 用 reward 地址（stake key）簽、`signTx` 會不會簽 `required_signers` 裡的 stake key——等真錢包（計畫前提）。
- 部署後的 Workers 行為（本次只在本機 workerd）；CPU 時間（步驟 10 量）。
- fee 是否涵蓋兩個 witness（上面是推論）。
- 硬體錢包（延後項）。

## 重現

在 `spikes/s1-sdk/` 執行：

```sh
pnpm install --frozen-lockfile
node prepare.mjs                 # 由 fixtures/koios-tx_cbor.json 與 epoch-params.json 產生 fixtures/vectors.json
node run-node.mjs                # Node：hash、aux、COSE → results/node.json
node run-build-node.mjs          # Node：組交易 → results/build-node.json
node bundle.mjs                  # 瀏覽器 bundle 大小與 shim → results/bundles.json
GIVEAWAY_PLAYWRIGHT_MODULE=<playwright-core/index.mjs> GIVEAWAY_CHROME_PATH=<Chrome 執行檔> node runtime.mjs   # Chrome 與 workerd → results/runtime.json
node probe/run.mjs               # Mesh、Blaze 在 workerd 的逐項結果 → results/workerd-items.json
node maintenance.mjs             # 需網路與已登入的 gh → results/maintenance.json
```

fixture 下載指令（已執行，結果已入庫）：

```sh
curl -fsS -X POST https://preprod.koios.rest/api/v1/tx_cbor -H 'Content-Type: application/json' \
  -d '{"_tx_hashes":["3883c2a93818bc9502844a8f512ddd3a89a25ed2487d80235ad613d43cb93d12","515d0ea3fe8c2c38b0825bc5cfc386f962845f3c733e29828cf43d7dad3e0207"]}' -o fixtures/koios-tx_cbor.json
curl -fsS 'https://preprod.koios.rest/api/v1/epoch_params?order=epoch_no.desc&limit=1' -o fixtures/epoch-params.json
curl -fsS https://preprod.koios.rest/api/v1/tip -o fixtures/koios-tip.json
```
