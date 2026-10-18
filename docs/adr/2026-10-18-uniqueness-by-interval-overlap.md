---
title: 唯一性改以同一身分的承諾時間區間重疊判定
date: 2026-10-18
status: active
tags: [cardano-verifiable-giveaway, decision, protocol]
---

# 唯一性改以同一身分的承諾時間區間重疊判定

## Context

唯一性檢查要擋的攻擊：主辦者對同一場抽獎送多筆承諾，開獎後只公布結果有利的那筆。現行實作只比對（地址, drawId）（`packages/protocol/index.ts:83-89`，commit `37a9402`），換 drawId 或換地址就能繞過（計畫附件 `inventory.md` F1）。2026-10-18 Will 回覆「都照建議走」。

- `external` 鏈上只能看到交易與地址，無法判定兩個不同錢包屬於同一人；跨錢包的唯一性在任何規則下都無法判定。
- `external` drand quicknet 每 3 秒一個 round，主辦者可自由選擇 round；只要求「同一 round 唯一」時，換到相鄰的 round 就能繞過。
- `external` 交易在 round 之後仍可上鏈；若「多筆即 FAIL」不看時間，主辦者可在開獎後補送一筆，讓不滿意的抽獎失效，等於取得重抽權。
- `external` 鏈上沒有人依賴的承諾（README「Status」：No public deployment），協定版本仍為開發期，可修改。
- `inherited` MVP 計畫 I5、I7 與 `BOUNDARY` 文字以（地址, drawId）描述唯一性：理由是當時尚未做攻擊劇本，已不成立，由本 ADR 改寫。

## Options Considered

- **基準 A：承諾時間區間重疊即衝突。** 每筆承諾的區間是〔收錄時間, round 時間〕；同一身分的兩筆承諾區間重疊，兩筆都 FAIL；round 之後才收錄的承諾不影響已完成的抽獎。這是 commit–reveal 的標準要求：承諾在 randomness 公開前完成，且承諾者沒有「多個候選、事後挑一個公布」的空間；Ethereum RANDAO 的分析把「可選擇不公布」（withholding）列為偏置來源（[Upgrading Ethereum: Randomness](https://eth2book.info/capella/part2/building_blocks/randomness/)）。
- **B：（身分, round）唯一。** 規則最簡單；換相鄰 round 就能繞過。
- **C：維持（地址, drawId），以最早一筆為準。** 不改程式；換 drawId 就能繞過，等於沒修 F1。

身分子題：

| 選項 | 取捨 |
|---|---|
| stake credential，地址無 stake 部分時用 payment credential（選用） | 同一 HD 錢包換收款地址仍被算進同一身分；需要 indexer 能依 stake credential 列舉交易 |
| payment credential | 列舉最簡單；換地址就能繞過 |

## Decision

- 規則採 A：同一身分的兩筆承諾，〔收錄時間, round 時間〕區間重疊就兩筆都 FAIL；收錄時間晚於 round 時間的承諾本身 FAIL，且不影響其他承諾。
- 身分採 stake credential，地址沒有 stake 部分時用 payment credential。前提是 Koios 有依 stake credential 列舉交易的端點，於階段計畫步驟 5 開工時確認；不成立時停下重議身分子題，規則子題不受影響。
- 驗證頁與 CLI 列出衝突的承諾；MVP 計畫 I5、I7 與 `BOUNDARY` 常數由階段計畫步驟 5 改寫。

## Rationale

- 相較 B，A 同時擋住換 drawId、換相鄰 round、開獎後補送三種劇本；代價是同一錢包不能同時進行兩場時間重疊的抽獎，要同時辦得用不同錢包。這個代價可以接受，因為跨錢包本來就無法判定，A 沒有比 B 少擋任何劇本。
- 相較 C，C 不修 F1；保留它只是因為程式已寫好，而協定尚未有使用者，不構成成本。
- 收錄時間晚於 round 的承諾一律 FAIL 而不是忽略，是因為 randomness 已公開，這筆承諾沒有不可預測性可言；不讓它影響其他承諾，是為了不給主辦者事後作廢的手段。

## Expected Outcome

- 同一錢包換 drawId 或換相鄰 round 送兩筆時間重疊的承諾，兩筆都 FAIL。
- 開獎後補送的承諾無法讓已完成的抽獎變成 FAIL。
- 驗證邊界文字明說：跨錢包的唯一性不在驗證範圍內。

## Followup

- 階段計畫步驟 5：確認 Koios 列舉端點、分頁與請求數；實作規則與四個回歸劇本；改寫 I5、I7、`BOUNDARY` 與 `docs/protocol-development.md`。

## Revocation Triggers

- Koios 或其他可用 indexer 沒有依 stake credential 列舉的端點 → 重議身分子題。
- 實際主辦者普遍需要同一錢包同時辦多場抽獎 → 評估在 bundle 內宣告互斥群組，仍不放寬到 B。

## Review Notes

## Related

- 階段計畫：`docs/plans/2026-10-18-hardening-and-backend.md` PD3、步驟 5；附件 `inventory.md` F1。
- [MVP 架構與資料責任](./2026-10-01-mvp-architecture-and-data-ownership.md)；[本機優先的協定預設](./2026-10-01-local-first-protocol-defaults.md)（當時已記下「不能強制跨地址／不同 drawId 唯一」）。
- Provenance：建議規則原為（身分, round），2026-10-18 獨立 subagent 壓力測試指出相鄰 round 與事後補送兩個劇本後改為 A；Will 於 coding agent 對話中回覆「都照建議走」。
