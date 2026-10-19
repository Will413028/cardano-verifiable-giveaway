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
| 身分 key 列在 `required_signers` 並附 witness；有 stake 部分用 stake key，否則 payment key；至少一個 input 來自帶此 credential 的地址（選用） | ledger 強制簽章，第三方送不出算數的承諾；同一 HD 錢包換地址仍是同一身分；不必回溯前一筆交易。錢包是否會替 stake key 簽章未驗證 |
| payment key 列在 `required_signers` | 錢包支援度高；換收款地址就是不同身分，能繞過 |
| stake credential 直接取自 input 地址 | 地址的 stake 部分不需持有者簽章即可放入（[CIP-19](https://cips.cardano.org/cip/CIP-0019)），第三方可製造衝突讓任何主辦者的抽獎作廢 |

## Decision

- 規則採 A：同一身分的兩筆承諾，〔收錄時間, round 時間〕區間重疊就兩筆都 FAIL；收錄時間晚於 round 時間的承諾本身 FAIL，且不影響其他承諾。
- 身分：承諾交易把身分 key 列在 `required_signers` 並附 witness，verifier 驗 witness 對 tx hash 的簽章；有 stake 部分時用 stake key，否則用 payment key；且至少一個 input 來自帶此 credential 的地址，讓依身分的列舉看得到它。沒有身分 key 簽章的交易不算任何身分的承諾。
- 驗證頁與 CLI 列出衝突的承諾；MVP 計畫 I5、I7 與 `BOUNDARY` 常數由階段計畫步驟 5 改寫。

## Rationale

- 相較 B，A 同時擋住換 drawId、換相鄰 round、開獎後補送三種劇本；代價是同一錢包不能同時進行兩場時間重疊的抽獎，要同時辦得用不同錢包。這個代價可以接受，因為跨錢包本來就無法判定，A 沒有比 B 少擋任何劇本。
- 相較 C，C 不修 F1；保留它只是因為程式已寫好，而協定尚未有使用者，不構成成本。
- 身分要靠簽章而非地址，因為地址的 stake 部分誰都能放；要求 input 帶此 credential，是因為列舉只能依地址查，不加這條主辦者可以從別的地址送出簽了同一 key 的承諾而不被列出。相較只用 payment key，stake key 擋住「同錢包換地址」；代價是錢包支援度未驗證。
- 收錄時間晚於 round 的承諾一律 FAIL 而不是忽略，是因為 randomness 已公開，這筆承諾沒有不可預測性可言；不讓它影響其他承諾，是為了不給主辦者事後作廢的手段。

## Expected Outcome

- 同一錢包換 drawId 或換相鄰 round 送兩筆時間重疊的承諾，兩筆都 FAIL。
- 開獎後補送的承諾無法讓已完成的抽獎變成 FAIL。
- 驗證邊界文字明說：跨錢包的唯一性不在驗證範圍內。
- 第三方用帶主辦者 stake 部分的地址送出的承諾，不影響主辦者的抽獎。

## Followup

- 階段計畫步驟 5：確認 Koios 列舉端點、分頁與請求數；實作規則與四個回歸劇本；改寫 I5、I7、`BOUNDARY` 與 `docs/protocol-development.md`。

## Revocation Triggers

- Koios 或其他可用 indexer 沒有依 stake credential 列舉的端點 → 重議身分子題。
- 真錢包驗收顯示主流 CIP-30 錢包不替 `required_signers` 裡的 stake key 簽章 → 退回 payment key，並在驗證邊界文字寫明換地址可繞過。
- 實際主辦者普遍需要同一錢包同時辦多場抽獎 → 評估在 bundle 內宣告互斥群組，仍不放寬到 B。

## Amendment (2026-10-19)：唯一性計數不再要求 input 帶身分 credential

- Will 2026-10-19 拍板（步驟 7 實作後提出）：列舉到、metadata label 相符的交易，只要交易有效、身分 key 列在 `required_signers` 且 witness 對 tx hash 驗章通過，就算該身分的承諾，不再要求「至少一個 input 來自帶此 credential 的地址」。被驗的那筆承諾仍要求 input 是主辦者地址本身（比原 Decision 嚴）。
- 理由：input 條件只決定「列舉看不看得到」，放在計數上反而漏算。主辦者從別的地址花費、輸出給帶自己 stake 的地址並以身分 key 簽章時，交易會被列舉到，原規則卻不計入。拿掉後，計數只會比原規則多，多出的都是主辦者自己簽過、本來就無法拿來發布的交易；第三方仍送不出算數的承諾，因為計入必須有身分 key 對該交易 body hash 的有效簽章。步驟 7 的獨立對抗式 review 對三種交易形狀逐一推演，結論相同。
- 不變的部分：input 與 output 都不碰身分 credential 的交易，依身分的列舉看不到；這屬於 indexer 信任面，寫在 `docs/protocol-development.md`「What the indexer is still trusted for」。Rationale 第二點描述的原理由仍然成立，只是改由「被驗承諾要求 input」與「列舉語意」分別承擔，不再放在計數條件上。
- 代價：主辦者替別人組的交易簽名時，可能多出自己造成的衝突。觸發重評：真錢包驗收發現錢包會在使用者不知情時替 `required_signers` 裡的 stake key 簽章。

## Amendment (2026-10-19)：列舉端點改由 Dolos 確認

- indexer 改為自架 Dolos（[自架 Dolos indexer](./2026-10-19-self-hosted-dolos-indexer.md)）。Followup 的「確認 Koios 列舉端點」已在步驟 5 對 Koios 完成，改由階段計畫步驟 8b 對 Dolos 的 `/accounts/{stake}/transactions` 與 `/addresses/{addr_vkh}/transactions` 重新確認排序與分頁；Revocation Triggers 第一條的「Koios 或其他可用 indexer」改讀為「Dolos 或使用者自備的 Blockfrost 相容 indexer」。規則與身分不變。

## Review Notes

- 2026-10-18 design-review：地址的 stake 部分不需要持有者簽章即可放入（[CIP-19](https://cips.cardano.org/cip/CIP-0019)：「it is possible to construct addresses where both parts are owned and managed by separate entities」）。若身分取自地址，第三方可用帶主辦者 stake 部分的地址送一筆區間重疊的承諾，讓主辦者的抽獎被判 FAIL。同日 Will 回覆「都照建議走」，身分改為 `required_signers`＋witness（見 Decision）。

## Related

- 階段計畫：`docs/plans/2026-10-18-hardening-and-backend.md` PD3、步驟 5；附件 `inventory.md` F1。
- [MVP 架構與資料責任](./2026-10-01-mvp-architecture-and-data-ownership.md)；[本機優先的協定預設](./2026-10-01-local-first-protocol-defaults.md)（當時已記下「不能強制跨地址／不同 drawId 唯一」）。
- Provenance：建議規則原為（身分, round），2026-10-18 獨立 subagent 壓力測試指出相鄰 round 與事後補送兩個劇本後改為 A；Will 於 coding agent 對話中回覆「都照建議走」。
