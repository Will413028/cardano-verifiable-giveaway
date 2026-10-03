---
title: 先完成本機功能，鏈上協定採未凍結開發預設
date: 2026-10-01
status: active
tags: [cardano-verifiable-giveaway, decision, development]
---

# 先完成本機功能，鏈上協定採未凍結開發預設

## Context

真錢包設定中斷 Spike A。Will 要求先跳過錢包與地址設定、完成功能，並明確同意「採用建議預設，實測後再定案」。本 ADR 選擇開發次序與試驗值，不宣告 D3／D7 的協定 v1 已定案。

- `external` Will 要求先完成功能：2026-10-01 當場指示；本次不依賴他先安裝瀏覽器錢包。
- `inherited` 原計畫以 preprod 確認延遲、BLS 可行性與唯一性攻擊劇本決定協定：仍成立，mock 無法代替這些證據。
- `inherited` 產品驗證限於承諾名單下抽選：仍成立，Demo 與 metadata 都不新增外部事實保證。
- `inherited` 發布後演算法版本不可悄悄改義：仍成立，使用者須能重算舊結果；目前尚未公開凍結 v1。

## Options Considered

- **基準 A：保持鏈上 spike → 協定拍板 → 產品開發。** 先處理確認延遲與唯一性，再固化跨客戶端契約，返工較少；[Agile Alliance 的 spike 說明](https://agilealliance.org/the-practice-of-sizing-spikes-with-story-points/) 將實作前研究技術問題列為用途。原計畫採此順序，現在需要等待人工錢包設定。
- **B：先完成功能＋明確標示假鏈，採未凍結開發預設（選用）。** 可完成 UI、CLI、資料公開與真正 BLS 驗證；代價是不能據此宣布真鏈驗收或 v1 完成，實測後仍可能改。
- **C：先凍結建議值，再補測。** 產品契約早固定；確認延遲或攻擊劇本若不符，會提前承擔版本遷移成本。

試驗值也存在真實替代方案：

| 子題 | 本次開發預設 | 保留的替代方案 |
|---|---|---|
| D3 承諾 | transaction metadata | Aiken validator＋一次性 state token；metadata＋第二錨點 |
| D7 beacon | quicknet | default chained network；其適用性另依官方現況驗證 |
| D7 抽選 | SHA-256 score 排序，前 k 名、同值名單序號決勝 | Fisher–Yates＋rejection sampling；HMAC-DRBG |
| D7 時間 | 承諾與第 15 個確認都早於 round | 依實測選擇其他確認門檻／最短 round 間隔 |
| D7 標籤 | NFC、拒絕重複 | NFKC／不正規化；自動去重／明示加權多次參加 |

## Decision

- 先完成本機建立、承諾、確認、開獎、分享／下載、驗證頁與 CLI，真錢包設定及人工鏈上驗收延後。
- 使用上述開發預設；metadata label 674 是實作暫用值，不視為註冊或 D7 label 子題定案。
- 使用真實歷史 quicknet beacon 並驗 BLS；假鏈承諾與確認時間只能回報 **DEMO PASS**，不得當成鏈上證據。
- D3／D7 實測後再定案。開發網路目前 preprod only，D9 的公開發布網路仍未決；不由此推定主網或發布授權。

## Rationale

- 相較 A，B 讓人工環境設定不再擋住可獨立完成的功能；不選 C，因尚無確認延遲及唯一性實測足以凍結協定。
- metadata 相較 validator／第二錨點較小，適合先接通承諾查詢；代價是不能強制跨地址／不同 drawId 唯一。公開連結是公告，不是發布時間的獨立證據。
- [quicknet 官方說明](https://docs.drand.love/blog/2023/10/16/quicknet-is-live/) 提供 3 秒、unchained 與固定驗證參數，適合作為開發來源；仍需效能與 relay 故障測試。
- hash 排序相較 shuffle／DRBG 容易用其他語言重寫；代價是 O(n log n)。15 確認是待測門檻，不把估計分鐘數當成已量測結果。
- NFC 相較 NFKC 保留相容字元差異，拒絕重複避免隱含權重；這些會影響既有 bundle 解讀，須在 v1 凍結前一起拍板。
- restricted [RFC 8785 JCS](https://www.rfc-editor.org/rfc/rfc8785) 與獨立 Python vectors 驗證跨語言一致；它們不代替真錢包、鏈上時間或資格證據。

## Expected Outcome

- 不安裝錢包也能操作完整 Demo；下載與分享後可重新驗 BLS、commitment hash 與得獎者。
- 後續實測只補真鏈證據與協定定案，不把已跑過的本機功能當成正式 MVP 全數驗收。
- 開發值若需修改，在公開 v1 前修改；凍結後走新版本，不覆寫舊結果。

## Followup

- 完成 preprod 確認延遲、列舉查詢、真錢包流程與唯一性攻擊劇本。
- 完成 BLS 瀏覽器效能／relay fallback、完整協定 mutation 及跨 browser 驗收。
- (決策) 依實測凍結 D3／D7，含 metadata label 與時間參數；維持完整歷史版本驗證能力。

## Revocation Triggers

- 確認延遲讓選定 round 前大多數交易無法達標 → 重評確認門檻與最短間隔。
- BLS 效能或 SDK／indexer 無法支援實際流程 → 重評相關工具與產品形態。
- 攻擊劇本顯示目前驗證文字強於機制 → 先修保證範圍，再定案。

## Review Notes

## Related

- Provenance：2026-10-01 Will 明確要求跳過錢包設定，並回覆「採用建議預設，實測後再定案」；本 ADR 即原始紀錄，無必要外部來源文件。
- [MVP 架構與資料責任](./2026-10-01-mvp-architecture-and-data-ownership.md)。
- 未壓縮或刪除計畫；未新增跨專案 Lessons Rule，本專案開發順序與試驗值不抽成通用規則。
