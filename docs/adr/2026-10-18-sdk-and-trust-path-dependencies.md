---
title: 網頁組交易用 Evolution SDK，信任路徑用自寫 CBOR 加 noble
date: 2026-10-18
status: active
tags: [cardano-verifiable-giveaway, decision, architecture, dependencies]
---

# 網頁組交易用 Evolution SDK，信任路徑用自寫 CBOR 加 noble

## Context

兩題同批拍板（階段計畫 PD1、PD6）：網頁用哪套 SDK 組承諾交易；verifier（瀏覽器、Node CLI）與後端（Cloudflare Workers）在信任路徑上用什麼算 tx hash、aux data hash 與驗 CIP-8 簽章。現行 app 用 Mesh 1.9.1。事實來自 Spike S1（階段計畫附件 `spike-s1.md`，commit `c16e00a`，2026-10-18 本機量測）。

- `external` ledger 對送出時的原始 bytes 算 tx hash 與 aux data hash，重新編碼可能得到不同 bytes。S1 實測：Evolution 的 `TransactionBody.toHash` 對 preprod 交易 `515d0ea3…` 算錯，`AuxiliaryData.toHash` 對兩筆非 canonical aux 算錯。
- `external` Workers 只接受建置時匯入的預編譯 WASM，不准執行期從 bytes 編譯（[Cloudflare: WebAssembly](https://developers.cloudflare.com/workers/runtime-apis/webassembly/)）。S1 實測：Mesh、Blaze 的 ed25519 走 libsodium-wrappers（執行期編譯內嵌 WASM），在 workerd 不能用，Mesh 引入即讓 Worker 起不來。改用建置期匯入要修改套件的載入方式，S1 沒量。
- `external` 簽章格式是 CIP-30 `signData` 產生的 CIP-8 COSE_Sign1（[CIP-8](https://cips.cardano.org/cip/CIP-0008)、[CIP-30](https://cips.cardano.org/cip/CIP-0030)）。
- `inherited` verifier 不依賴後端、三個執行環境共用同一份驗證（[後端 ADR](./2026-10-18-typescript-convenience-backend.md) 不變量 B1）：仍成立。
- `inherited` 身分 key 列入 `required_signers`、承諾交易設 `invalid_hereafter`（[唯一性 ADR](./2026-10-18-uniqueness-by-interval-overlap.md)、[時間上限 ADR](./2026-10-18-commitment-validity-upper-bound.md)）：仍成立。
- 不算限制：現行 app 用 Mesh（無部署、無使用者，換掉只花自己的工）；計畫寫的「PD1 選 bundle 最小者」是自訂規則，下面另有理由。

## Options Considered

PD1 網頁組交易（三者都組得出含 metadata、`required_signers`、`invalid_hereafter` 的交易；錢包是否替 stake key 簽三者都未驗證）：

- **基準 A：Mesh。** 主流 Cardano TypeScript SDK、現行依賴（[MeshJS](https://meshjs.dev/)）。組交易＋錢包 bundle 1,519,596 bytes gzip、125 個套件、要 Node shim 與 globals；npm 最新版 2026-06-19。
- **B：Evolution SDK。** 純 TypeScript、無 WASM；295,246 bytes gzip、9 個套件、0 shim。0.6.0、近 90 天 8 版、週下載約 1,162；有效期以 Unix 時間設定再換成 slot。
- **C：Blaze。** 492,656 bytes gzip、86 個套件、要 shim 與空模組；週下載三者最高（10,831）。
- 未量：Lucid Evolution、CSL／CML。

PD6 信任路徑：

- **基準 A：SDK 交易物件加 CIP-8 參考實作。** 業界常見做法是直接用 SDK 解交易、用 `@emurgo/cardano-message-signing`（[Emurgo/message-signing](https://github.com/Emurgo/message-signing)，WASM）驗簽。S1 中只有 Evolution 在三個環境全過，但要避開會算錯的直覺 API，信任路徑帶 9 個套件；Mesh 的 `checkSignature` 缺 header 地址、alg、尾隨 bytes 與 `hashed` 檢查（23/29）；WASM 參考實作在 Workers 要改載入方式（推論，未量）。
- **B：最小依賴。** 自寫只讀的 CBOR 讀取器（切原始 byte 範圍，不重新編碼）＋`@noble/hashes`、`@noble/curves`（README 標示經獨立稽核），COSE_Sign1 依 CIP-8 自驗。S1 三個環境全過：4 筆交易的 hash 與 aux hash、29 個 COSE 向量；verify bundle 17,022 bytes gzip、2 個套件。
- **C：Web Crypto 的 Ed25519。** 少一個依賴；但瀏覽器、Node、workerd 是不同實作，非 canonical 點的處理可能不一致，同一份證據可能得到不同判定（推論，未量）。
- 未量：`@harmoniclabs/crypto`（`packages/beacon` 已用它做 BLS）、cbor2。

## Decision

- PD1 採 B：`apps/web` 用 Evolution SDK 組交易與連 CIP-30 錢包，鎖精確版本，只在建立頁延遲載入；移除 Mesh 與它需要的 polyfill。
- PD6 採 B：`packages/chain` 與後端的 tx hash、aux hash、COSE 驗證用自寫讀取器加 noble；信任路徑以 lint 禁止引用任何 Cardano SDK。
- 網頁組完交易後，以信任路徑的讀取器重讀未簽 CBOR，核對 metadata、`required_signers`、`invalid_hereafter` 與輸出，不符就不呼叫 `signTx`。

## Rationale

- PD1：B 打包進的套件 9 個，對 C 的 86 個、A 的 125 個；建立頁就是簽章頁，任何一個被植入的依賴都能在 `signTx` 前改輸出，套件數就是供應鏈攻擊面。B 還不要 polyfill、bundle 最小。代價是成熟度最低（0.x、使用者少、API 還在變）：鎖版本、升版要過組交易測試；組完重讀把「SDK 組錯還簽了」降成「組不出來」，C 作為能力相同的備援。延遲載入讓人數最多的驗證者不必下載 SDK。
- PD6：B 的信任路徑最小、三個環境同一份程式，正面滿足 B1；讀取器只切原始 bytes，沒有重新編碼這條會算錯的路。A 即使選 Evolution，也要長期靠 lint 擋同一套件裡會算錯的 API，並把組交易的依賴帶進信任路徑。組交易與驗證交易用不同程式，彼此成為核對。代價是 112 行解析與 COSE 程式要自己維護與測試，邊界情況全由自家測試負責；密碼運算交給 noble，`tools/reference.py` 可用另一語言對同一份 bytes 交叉核對。
- 不選 WASM 參考實作與 Web Crypto：前者在 Workers 要改寫載入、三個環境會分歧；後者的跨環境一致性沒有保證。

## Expected Outcome

- 網頁 bundle 不再需要 Mesh 帶來的 Node polyfill（`tools/build.mjs` 的 alias 與 inject；`@harmoniclabs/crypto` 是否仍需 Buffer 在步驟 6 確認）。
- verifier 與後端在瀏覽器、Node、Workers 用同一份程式，對 S1 fixture 的 hash 與 COSE 向量全對。
- 網頁組出的交易若欄位不符，送出前就被擋下。

## Followup

- 階段計畫步驟 6：換依賴、加 lint 限制、組完重讀。
- 階段計畫步驟 7：讀取器移入 `packages/chain`；S1 的 4 筆交易與 29 個向量轉為正式測試（含 mutation）；補鏈上 tag 258 `required_signers` 樣本、無 metadata 交易、`is_valid`（不在 tx hash 範圍內）的處理與 vkey witness 驗章；CIP-8 參考實作與 Evolution `verifyData` 可作為 devDependency 的測試對照。
- 真錢包驗收：錢包是否替 `required_signers` 的 stake key 簽、真實 `signData` 輸出的 header 欄位（等真錢包）。
- 步驟 10：在部署的 Workers 量 COSE 驗章 CPU。

## Revocation Triggers

- Evolution 停止維護，或升版破壞組交易且短期無修 → 改用 Blaze。
- 真錢包不肯替 Evolution 組出的 stake key `required_signers` 簽，而其他 SDK 可以 → 重評 PD1。
- 自寫讀取器或 COSE 出現安全缺陷，或出現無 WASM、保留原始 bytes、經稽核的函式庫且維護成本更低 → 重評 PD6。

## Amendment (2026-10-19)：錢包連線與送出不經 Evolution

- 實作步驟 6 時發現 Evolution 0.6.0 的 `withCip30` 以 `getUsedAddresses` 判斷網路、不取 change address，且 `signTx` 固定 `partialSign=true`；照用會改變計畫明列「不能動」的 mainnet 拒絕與找零規則。所以 `apps/web/cardano.ts` 直接呼叫 CIP-30（`getNetworkId`、`getChangeAddress`、`getUtxos`、`signTx(tx, false)`），Evolution 只負責組交易。
- 送出改為把簽好的原始 bytes POST 給 indexer，不經 Evolution：Spike S1 量到它會重新編碼，可能改變 bytes。
- 組完重讀的核對目前只涵蓋步驟 6 產生的欄位（input、輸出、找零、平衡、aux hash、metadata、body 欄位白名單）；`required_signers` 與 `invalid_hereafter` 由步驟 7 加入交易時一起核對。
- 代價：錢包相容性的處理留在自己的程式碼，Evolution 之後的錢包修正不會自動帶進來。觸發重評：Evolution 的 CIP-30 包裝改成取 change address 並可選 `partialSign`。

## Review Notes

## Related

- 階段計畫：`docs/plans/2026-10-18-hardening-and-backend.md` PD1、PD6、步驟 6、7、11；附件 `spike-s1.md`；spike 程式 `spikes/s1-sdk/`（commit `c16e00a`）。
- [TypeScript 便利層後端](./2026-10-18-typescript-convenience-backend.md)、[錢包簽章與限期保存](./2026-10-18-wallet-auth-and-bounded-retention.md)。
- Provenance：Spike S1 量測後，Will 於 2026-10-18 coding agent 對話回覆「按照你的建議」（PD1 B、PD6 B）；兩份獨立起草的 subagent 草稿也各自選了相同組合，其補充論點已併入。
