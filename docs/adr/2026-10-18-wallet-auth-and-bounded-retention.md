---
title: 以錢包簽章取代帳號，後端只收已承諾的 bundle 並限期保存
date: 2026-10-18
status: active
tags: [cardano-verifiable-giveaway, decision, architecture, privacy]
---

# 以錢包簽章取代帳號，後端只收已承諾的 bundle 並限期保存

## Context

[TypeScript 便利層後端](./2026-10-18-typescript-convenience-backend.md) 留下兩題：主辦者帳號與濫用防護、bundle／草稿的保存與刪除。2026-10-18 Will 回覆「按照建議」，採用下列設計與預設數字。後端尚無程式碼，本決定不造成重工。

- `external` 資料保護法規（GDPR 第 5、17 條或在地同等規範）：標籤可能屬於個人資料，需要資料最小化、保存期限與刪除權。我們與主辦者之間沒有 GDPR 第 28 條的委託處理契約，對自己的營運資料（限流用 IP、濫用紀錄、草稿）很可能是 controller（推論，非法律意見）。
- `external` 主網每筆承諾要付手續費，可作為上傳門檻；preprod 測試幣可由 faucet 免費取得，此門檻在 preprod 無效。
- `external` 一次驗證的 `address_txs` 最多翻 10 頁（`packages/chain/index.ts:68-73`），經由我們的 key 轉發時，可被用來放大請求、耗盡額度。
- `external` 已上鏈的 hash 與已公開的標籤無法撤回。
- `inherited` 主辦者已用 CIP-30 錢包簽署承諾（MVP ADR D4-A）：仍成立，錢包身分不增加使用者門檻。
- `inherited` 伺服器草稿保存（便利層後端 ADR）：Will 已接受其法遵成本，維持不變。
- `inherited` 網頁目前代管的是整份 proof 檔，並對整個檔案算 hash（`apps/web/app.ts:200`）；proof 的 hash 不在鏈上，屬自有程式碼，本 ADR 改掉它。

## Options Considered

- **基準 A：錢包簽章登入，不建帳號。** Ethereum 的 [SIWE（EIP-4361）](https://eips.ethereum.org/EIPS/eip-4361) 以帶網域、nonce、期限的簽章登入；Cardano 以 CIP-30 `signData`（CIP-8 COSE_Sign1）實作，格式參考 [CIP-93](https://cips.cardano.org/cip/CIP-0093)（Proposed）。不存憑證，擁有權就是做出承諾的那把鑰匙。
- **B：email／OAuth 帳號。** 主辦者熟悉；代價是保存憑證與 email，多一份個資與帳號復原流程，帳號也與鏈上承諾沒有關聯。
- **C：匿名寫入，只靠 CAPTCHA 與限流。** 實作最少；無法證明擁有者，刪除與延長保存沒有授權依據。

保存子題：

| 選項 | 取捨 |
|---|---|
| 永久保存（如 Arweave） | 連結永不失效；無法履行刪除請求，不適合可能含個資的標籤 |
| 限期保存＋擁有者可刪除、可延長（選用） | 符合保存期限；連結會在期限後失效，靠下載副本維持 I4 |
| 開獎後立即刪除 | 個資最少；驗證連結幾乎立刻失效，失去代管的意義 |

## Decision

- **不做帳號（A）。** 擁有者操作（刪除、延長）簽一段 payload，內容含網域、操作、bundleHash、network、伺服器發的一次性 nonce，5 分鐘內有效；驗章時確認簽章 key 屬於 owner 地址。owner 取自承諾交易，不取錢包目前的 change address。
- **上傳門檻：** 只收 canonical bundle bytes，須同時滿足 `sha256(bytes)` 等於某筆已上鏈承諾的 bundleHash、通過 `validateBundle`、大小在協定上限內。第一筆被接受的（bundleHash, txHash, owner）綁定擁有權；刪除後留下 tombstone，同一份 bytes 不得再上傳。
- **代管格式：** 代管 bundle 而非 proof；驗證連結帶 `txHash` 與 bundleHash，beacon 與得獎者由 verifier 重算。
- **濫用防護：** edge 依 IP 與 owner 限流、每個 owner 的保存額度、Koios key 的全域請求預算、以（address, offset）快取、每次請求只查一個地址；CORS 只開放自家網域；簽好的 payload 放在 `Authorization` header，不用 cookie（見 Amendment）；讀取端點不加 CAPTCHA；提供檢舉與下架管道。
- **保存期限：** bundle 預設保存到 round 後 12 個月，擁有者可隨時刪除或延長。伺服器草稿需錢包簽章存取，保存 30 天。草稿另一律存本機 IndexedDB 並可匯出。
- **刪除：** 參加者的刪除請求以整份 bundle 下架處理（只改部分會使 hash 不符）；鏈上只有 hash，不受影響。介面提醒主辦者保留下載副本。
- **紀錄：** 不記錄請求內容；IP 只保留到限流所需時間；隱私說明寫明我們是營運資料的 controller。

## Rationale

- 相較 B，A 不保存任何憑證或 email，擁有權直接等於鏈上承諾者，帳號被盜或復原的流程都不存在；代價是硬體錢包對 `signData` 的支援與 5 分鐘時窗尚未驗證，私鑰遺失時無法刪除，只能等期限到期。
- 相較 C，A 讓刪除與延長有授權依據；C 的 CAPTCHA 會擋到驗證者，也擋不住付得起手續費的濫用者。
- 以鏈上承諾當上傳門檻，讓每份代管檔都要付一筆手續費，且內容由 hash 自行驗證；不加 `validateBundle` 時，付一筆手續費就能寄放任意檔案，所以兩者都要。preprod 上手續費無效，限流與額度在兩個網路都要有。
- 限期保存相較永久保存能履行刪除權；代價是連結期限後失效，靠下載副本與 CLI 維持 I4。12 個月與 30 天是預設值（SELF-IMPOSED），草稿較短是因為未公開名單比已公開 bundle 敏感。
- 代管 bundle 而非 proof，是因為只有 bundleHash 在鏈上；proof 的其餘欄位都能重算，不需要信任代管者。

## Expected Outcome

- 後端不保存任何密碼、email 或 OAuth token。
- 每份代管 bundle 都對應一筆鏈上承諾與一個擁有者，且可在期限內被擁有者刪除。
- 單一使用者或單一地址無法耗盡 Koios 額度或保存空間。

## Followup

- 量測萬筆名單在 Workers 上做 hash 與 `validateBundle` 的 CPU 時間，據此選 Free 或付費方案。
- 驗證 Ledger、Trezor 對 CIP-30 `signData` 的支援與 5 分鐘時窗。
- 撰寫隱私說明與檢舉、下架流程。
- 改驗證連結格式（`txHash`＋bundleHash），並更新 `docs/protocol-development.md` 的 Sharing 段。

## Revocation Triggers

- 硬體錢包普遍不支援 `signData` → 重評擁有者驗證方式，仍不採密碼帳號。
- 刪除請求或濫用處理量超過單人能力 → 依便利層後端 ADR 縮回只做 proxy。
- 法律意見認定保存期限或角色定位不符 → 先調整保存與隱私說明，再上線。

## Amendment (2026-10-18)

Will 回覆「都照建議走」，定下階段計畫 PD4。原決定（不做帳號、以 `signData` 證明擁有權）不變，細化如下：

- **驗證形式：每次操作都簽章，不發 session。** 簽好的 payload 放在 `Authorization` header，後端只存一次性 nonce 的使用紀錄，不存任何 token。對照的選項是「簽一次換短效 session token」（SIWE 常見做法）：操作較順，但要保存、過期與撤銷 token，後端多一類憑證。本產品的擁有者操作（刪除、延長、存取草稿）頻率很低，每次多按一次錢包確認的代價小於多保存一類憑證。
- **草稿身分：** 簽章錢包的身分，規則同[唯一性 ADR](./2026-10-18-uniqueness-by-interval-overlap.md) 的身分子題；草稿在上鏈前就存在，無法取自承諾交易。
- **額度（SELF-IMPOSED 預設）：** 每個身分最多 5 份伺服器草稿；每個 owner 最多 20 份代管中的 bundle；每次延長 12 個月，總保存不超過 round 後 36 個月。
- 撤銷條件：實際使用顯示擁有者一次要連做多個操作、逐次簽章明顯妨礙使用 → 重評短效 session。

## Amendment 2 (2026-10-18)：代管紀錄以 txHash 為主鍵

design-review 指出 Decision 的「第一筆被接受的（bundleHash, txHash, owner）綁定擁有權；刪除後留 tombstone，同一份 bytes 不得再上傳」可被搶佔：任何人都能把同一個 bundleHash 寫進自己的交易（round 前公告本來就公開完整 bundle），搶先上傳後刪除，正主就永遠傳不上去。改為：

- 代管紀錄以 `txHash` 為主鍵，owner 由該筆交易推導；同一份 bytes 可對應多筆紀錄。
- bytes 以 bundleHash 定址存放，以參照計數決定何時真正刪除。
- 擁有者刪除只移除自己的紀錄；以 bundleHash 為鍵的 tombstone 只用於營運端下架（檢舉或參加者刪除請求），下架後任何人都不得重傳。
- 這是對原 Decision 的修正而非新取捨：原意是「擁有者能刪自己的代管、下架後不再出現」，新結構兩者都保住，且不讓他人搶佔。

## Review Notes

## Related

- 前一決定：[TypeScript 便利層後端](./2026-10-18-typescript-convenience-backend.md)。
- [MVP 架構與資料責任](./2026-10-01-mvp-architecture-and-data-ownership.md)（D4-A、D5-C）。
- Provenance：2026-10-18 Will 在 coding agent 對話中回覆「按照建議」；建議經獨立 subagent 審查，審查指出的上傳驗證、代管格式、擁有權綁定與 proxy 放大問題已寫入 Decision。
