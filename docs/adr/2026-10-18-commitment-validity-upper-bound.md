---
title: 承諾交易以 validity interval 上限證明在 round 之前收錄
date: 2026-10-18
status: active
tags: [cardano-verifiable-giveaway, decision, protocol]
---

# 承諾交易以 validity interval 上限證明在 round 之前收錄

## Context

承諾必須在 drand round 公開前上鏈，否則主辦者可以先看 randomness 再承諾。現行 verifier 判斷「在 round 之前收錄」完全採信 indexer 回報的 `tx_timestamp`，承諾交易也沒有設上限（`apps/web/cardano.ts:19-22`，commit `2020d29`；階段計畫附件 `inventory.md` F17）。2026-10-18 design-review 提出，Will 回覆「都照建議走」。

- `external` Cardano 交易可帶 validity interval；有 `invalid_hereafter` 時，只能被收錄在 slot 小於該值的區塊，ledger 強制（[Cardano developer docs: Transactions](https://developers.cardano.org/docs/build/smart-contracts/lessons/theory/transactions/)；ledger 型別 `ValidityInterval`，[Allegra ledger](https://cardano-ledger.cardano.intersectmbo.org/cardano-ledger-allegra/Cardano-Ledger-Allegra-Core.html)）。
- `external` slot 與時間的換算由各網路的 genesis 與 era 參數決定，可釘死在程式裡。
- `external` 交易 body 的 bytes 決定 tx hash；verifier 從 CBOR 自驗後讀出的上限不需要信任 indexer（階段計畫步驟 7）。
- `external` 協定仍是未凍結的開發版本，鏈上沒有人依賴的承諾。
- `inherited` 15 個確認的時間判定仍依賴 indexer（MVP 計畫 D7 延後）：仍成立，本決定不處理。

## Options Considered

- **基準 A：`invalid_hereafter` 必須早於 round 對應的 slot。** 以 ledger 規則證明時間上界，是 Cardano 應用處理時間的標準手段（上列 developer docs）。verifier 從 CBOR 讀出並換算，晚於 round 或缺少時 FAIL。
- **B：維持採信 indexer 的收錄時間。** 不改交易；indexer 謊報時間就能讓事後承諾通過。

## Decision

- 採 A，納入 `development-2`：網頁組交易時設 `invalid_hereafter`，其對應時間早於 round 時間；verifier 從自驗過的 CBOR 讀出並以釘死的網路參數換算，晚於 round 或缺少都 FAIL。
- 唯一性區間的起點（收錄時間）仍取自 indexer，屬已記錄的信任面。

## Rationale

- 相較 B，A 把「承諾在 round 之前」從信任 indexer 變成 ledger 保證，正面擋住承諾協定最核心的攻擊；代價是主辦者要預留上鏈時間，交易逾期未收錄就要改用更晚的 round 重送，網頁要提示這件事。
- 釘死網路參數而不是每次向 indexer 查，是為了不把剛移除的信任又加回來；代價是網路硬分叉改變時間參數時要更新程式。

## Expected Outcome

- indexer 謊報收錄時間，也無法讓 round 之後才上鏈的承諾通過。
- `invalid_hereafter` 晚於 round 或缺少的承諾，網頁與 CLI 都判 FAIL。

## Followup

- 階段計畫步驟 2：確認選定 SDK 能設 `invalid_hereafter`。
- 階段計畫步驟 7：實作、F17 回歸測試與 mutation，網頁提示逾期重送。

## Revocation Triggers

- 網路參數變更使釘死的換算失準 → 更新參數並補 vectors，不改回採信 indexer。

## Review Notes

## Related

- 階段計畫：`docs/plans/2026-10-18-hardening-and-backend.md` PD5、步驟 7；附件 `inventory.md` F17。
- [唯一性以時間區間重疊判定](./2026-10-18-uniqueness-by-interval-overlap.md)。
- Provenance：2026-10-18 獨立 design-review 提出；Will 於 coding agent 對話中回覆「都照建議走」。
