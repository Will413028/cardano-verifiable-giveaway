---
title: 新增 TypeScript 便利層後端，驗證仍不依賴後端
date: 2026-10-18
status: active
tags: [cardano-verifiable-giveaway, decision, architecture]
supersedes-partially: 2026-10-01-mvp-architecture-and-data-ownership.md（D2-A 無後端、D6-A 主辦者自行公開 bundle）
---

# 新增 TypeScript 便利層後端，驗證仍不依賴後端

## Context

2026-10-18 Will 拍板：新增產品後端，全端使用 TypeScript；兩份獨立草稿建議只做無狀態 proxy，Will 檢視後仍選便利層後端。本 ADR 取代原 ADR 的 D2-A（無產品後端）與 D6-A（主辦者自行公開 bundle），其餘 D 項不變。

- `external` Koios 免 key 公開層的實際回應不帶 `Access-Control-Allow-Origin`（2026-10-18 以 curl 量測 `/tip`、`/blocks`、`/tx_metadata`，Origin 含 `127.0.0.1:4320`、`github.io`；只有 OPTIONS 預檢回 `*`）。[Koios tiers](https://koios.rest/tiers.html) 標示 Public 層「CORS: Restricted」、Free 層需要 key。同日以 Playwright 驅動 Chrome（暫用 profile）從 `http://127.0.0.1:4320` 實測：`/tip`、`/blocks`、`/epoch_params`、`/tx_metadata`、`/address_txs` 全部 `Failed to fetch`，console 為「No 'Access-Control-Allow-Origin' header is present」；對照組 drand relay 回 200。正式網域的 origin 只有 curl 證據。瀏覽器 E2E 以 mock 取代 Koios，因此先前沒有發現。
- `external` 前端內嵌的 key 等於公開；[Blockfrost](https://blockfrost.dev/overview/getting-started) 建議由自己的後端保管 `project_id`。
- `external` 目標使用者是非工程背景的主辦者（原 ADR Context）；自行託管 bundle 與處理 CORS 是操作門檻。
- `external` 參加者標籤可能屬於個人資料：保存它就要有保存期限、刪除流程與濫用處理。已上鏈承諾與已公開標籤無法撤回。
- `external` Cloudflare Workers 單次請求有 CPU 時間與 subrequest 上限（Free 方案 10 ms、50 個）。
- `external` 尚無使用者需求證據；原 ADR 的撤銷條件（主辦者因自架放棄、資料遺失）尚未觸發。
- `inherited` I4（驗證不需要本產品伺服器）：仍成立，這是產品主張本身（README Planned experience 3）。
- `inherited` I6（不持有主辦者私鑰）：仍成立，主辦者以 CIP-30 簽署並送出。

## Options Considered

- **基準 A：靜態 dApp＋公開 indexer，需要密鑰或保存時才加後端。** Blockfrost 的建議與原 ADR D2-A 即此路線。遇到 Koios CORS 時，網頁的 preprod 流程不可用。
- **B：只加無狀態、帶 key 的唯讀 indexer proxy。** 解決 CORS 並保管 key，不保存任何資料；維運與法遵面最小。主辦者仍須自行託管 bundle，也無法恢復草稿。兩份獨立草稿皆選此項。
- **C：便利層後端（選用）。** B 再加上 bundle 代管、草稿保存與彙總統計；簽署、亂數與抽選判定留在客戶端。代價是保存政策、濫用防護與可用性責任。
- **D：以後端為中心的託管服務。** [ProofDraw](https://proofdraw.com/) 這類服務由 API 建立抽獎並保存資料；主辦者門檻最低，但伺服器成為信任根，與 I4 衝突。

| 語言子題 | 取捨 |
|---|---|
| TypeScript on Workers（選用） | 一套工具鏈；bundle 代管需要的 `validateBundle` 與 hash 直接共用 `packages/protocol`；綁 Workers runtime 限制 |
| Go／Node on VPS | 沒有 runtime 限制、可攜；要自管主機與 TLS；Go 需另寫協定實作並以 vectors 維持一致 |

## Decision

- 採 **C**，全端 TypeScript，後端與網頁、CLI 共用 `packages/`。
- 後端範圍：唯讀 indexer proxy、bundle 代管、草稿保存、彙總統計。
- 後端**不得**：簽署或送出交易（交易改由錢包 CIP-30 `submitTx` 送出）、持有主辦者私鑰、產生或替換 randomness、判定 PASS／FAIL、成為驗證的必要條件、轉送任意網址、改寫 indexer 回應。
- proxy 只放行驗證與建交易所需的 Koios 唯讀端點，依 IP 限流，不記錄請求內容。verifier 把它當成不可信的 indexer：驗證頁顯示鏈上證據來源並可改用其他 indexer；CLI 預設直連。
- 代管的 bundle 以原始檔 bytes 的 SHA-256 定址；後端只對 bytes 算 hash，不在請求內做大型 canonicalization。下載副本仍可完整驗證。

## Rationale

- 相較 B，C 一併移除非工程主辦者自行託管 bundle 的門檻與草稿遺失。代價是保存資料的法遵與濫用責任，而且目前沒有需求證據；Will 明確接受這些成本，以保存期限、刪除流程與限流處理，不是原撤銷條件被觸發。
- 相較 A，C 與 B 都解決已量到的 CORS 限制；A 只有在 Koios 實測不擋時才成立（見 Revocation Triggers）。
- 不選 D：伺服器成為建立與判定的權威，會使「不需信任營運者」的主張失效。C 把後端排除在驗證路徑外，後端停擺只影響便利功能。
- 自建 proxy 是新的信任點，經過它的鏈上證據可能被竄改；以交易 CBOR 自行驗證 metadata 可把信任面縮到收錄與時間（見 Followup）。
- TypeScript 相較 Go 少一份協定實作與一套工具鏈。只做 proxy 時共用協定核心沒有好處，但 bundle 代管要驗格式，共用才成立；跨實作核對由 Python 參考實作提供。
- 以 bytes hash 定址而非在 Worker 內重算 canonical JSON，是為了配合 CPU 上限；正確性由客戶端 verifier 重算保證。

## Expected Outcome

- 網頁的 preprod 流程不再受 Koios CORS 阻擋；後端停擺時，持有 bundle 者仍可用 CLI 與直連 indexer 驗證。
- 主辦者不必自行託管 bundle 即可分享驗證連結，也能恢復草稿。
- 協定只有一份 TypeScript 實作，由 vectors 與 Python 參考實作核對。

## Followup

- 加一條不 mock indexer 的 E2E 路徑（真瀏覽器 CORS 阻擋已於 2026-10-18 確認，見 Context）。
- 查證 Koios 條款是否允許代理轉發與快取；`external-interfaces.md` E5 的 pricing 連結已 404，改指 tiers 頁。
- 帳號、濫用防護與保存期限已於 2026-10-18 決定，見 [錢包簽章與限期保存](./2026-10-18-wallet-auth-and-bounded-retention.md)。
- 申請 indexer API key（碰憑證，由 Will 處理）。
- 量測一次完整驗證的 Koios 請求數，據此設定限流值。
- 以交易 CBOR 驗證 metadata，讓 indexer 只負責收錄與時間證據。
- 更新 `AGENTS.md`、README 與 `docs/protocol-development.md` 的架構描述。

## Revocation Triggers

- Koios 公開層改為開放 CORS，或找到免 key、開放 CORS 的 indexer，且主辦者不需要託管 → 重評 A 或 B。
- 保存責任（刪除請求、濫用、成本）超過單人維運能力 → 縮回 B，bundle 回到下載與自行託管。
- 後端功能需要進入驗證路徑才能運作 → 停止並另開決策，不得默默改變 I4。

## Amendment (2026-10-19)：indexer 改為自架 Dolos

- Will 2026-10-19 決定不向 Koios 取得同意，indexer 改為 Blockfrost 形狀介面卡＋自架 Dolos，CLI 不設專案預設；見 [自架 Dolos indexer](./2026-10-19-self-hosted-dolos-indexer.md)。本 ADR 中「proxy 只放行 Koios 唯讀端點」「CLI 預設直連」由該 ADR 取代；Context 的 Koios CORS 量測保留為當時的事實。
- Revocation Triggers 第一條的前半（免 key、開放 CORS 的 indexer）已由自架 Dolos 滿足，後半（主辦者不需要託管）未滿足，所以後端本身不撤；唯讀 proxy 的存廢另交階段計畫 PD8。Followup 的「Koios 條款查證」「申請 indexer API key」「量測 Koios 請求數」由該 ADR 的 Followup 取代。

## Review Notes

## Related

- 部分取代：[MVP 架構與資料責任](./2026-10-01-mvp-architecture-and-data-ownership.md) 的 D2-A、D6-A。
- [本機先行與未凍結協定預設](./2026-10-01-local-first-protocol-defaults.md)。
- Provenance：2026-10-18 Will 在 coding agent 對話中拍板（「完整後端是不是比較好」「那就全 ts」「B：維持完整後端」）；Koios CORS 量測與兩份獨立草稿的論點已寫入 Context 與 Rationale。
