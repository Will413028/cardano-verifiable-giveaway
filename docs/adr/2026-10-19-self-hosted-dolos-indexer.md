---
title: indexer 改為 Blockfrost 形狀介面卡＋自架 Dolos，CLI 不設專案預設
date: 2026-10-19
status: active
tags: [cardano-verifiable-giveaway, decision, architecture, indexer]
supersedes-partially: 2026-10-18-typescript-convenience-backend.md（proxy 只放行 Koios 端點、CLI 預設直連）
---

# indexer 改為 Blockfrost 形狀介面卡＋自架 Dolos，CLI 不設專案預設

## Context

階段計畫步驟 9 開工時重查 koios.rest 條款（2026-10-19，「Last updated June 3, 2026」），字面上禁止系統性擷取、自動化使用與轉發，未區分網站與 API；步驟 9 依停止條件停下。2026-10-19 Will 決定不向 Koios 取得同意，改用其他 indexer；本 ADR 決定換成哪個、CLI 怎麼接。事實由調查與一輪獨立審查核對（審查指出的 `max_scan_items`、儲存模式、B1 退步與請求數都已併入）。

- `external` koios.rest 條款字面禁止「Systematically retrieve data」「Make any automated use of the system」與未經書面同意的轉發（[Terms](https://koios.rest/terms.html)）；Will 決定不取得同意，所以這是第三方契約加上已拍板的決定。
- `external` 託管 Blockfrost 的條款是同一範本，範圍寫「the https://blockfrost.io website」，全文沒有提到 API，付費方案賣的本來就是程式存取（[Blockfrost terms](https://blockfrost.io/terms)）。排除它的依據是「沿用 Will 對 Koios 的同一字面標準」，不是條款明文禁止 API。
- `external` 託管 API 的 key 不能放進瀏覽器或公開的 CLI；Blockfrost 建議由自己的後端保管 `project_id`（[Blockfrost getting started](https://blockfrost.dev/overview/getting-started)）。
- `external` Maestro 的 API 主機已無法解析（2026-10-19 DNS 實測），Cardanoscan 不提供交易 CBOR 與依身分列舉；兩者不是候選。
- `external` Dolos 的 MiniBF（Blockfrost 相容 API）：`permissive_cors` 預設 true；`/addresses/{a}/transactions` 接受 `addr_vkh`；有 `/accounts/{stake}/transactions`（2026-10-19 更正：只有 pre-release 有，穩定版 1.6.1 沒有，見下方 Amendment）；不需要 API key。分頁以 page×count 計，超過 `max_scan_items`（預設 3000）就拒絕（`crates/minibf/src/pagination.rs` 的 `enforce_max_scan_limit`），營運者可調高。現行實作的列舉上限是 5,000 筆。來源：Dolos 原始碼與 `minibf.mdx`，2026-10-19 讀碼，未在本機實跑。
- `external` Dolos 有 Ledger-only、Sliding history、Full archive 三種儲存模式（Dolos README）。指到非 full archive 的節點時，舊承諾列舉不出來，verifier 察覺不到。
- `external` Dolos 是有狀態的長駐程式，不能跑在 Cloudflare Workers，需要一台 VM；這是部署形態的變更（MVP 計畫步驟 10、D9）。
- `external` Mithril 交易證明只證明「某筆交易已收錄」，不證明「某身分的交易全部列出」；WASM 客戶端仍需 `unstable: true`。唯一性永遠要信任 indexer 的列舉。
- `external` db-sync 的 64 GB RAM／700 GB／60k IOPS 是主網數字（db-sync README）；本計畫不做主網，preprod 規模未查。
- `inherited` I4／B1（驗證不依賴本產品伺服器，後端停擺時 CLI 直連仍能 PASS）：仍成立，是產品主張本身。
- `inherited` 現有程式是 Koios 形狀（每頁 1,000 筆、`tx_metadata` 批次查詢、`tx_cbor`、`tx_info`）：理由是當時選了 Koios，已不成立。
- `inherited` 階段計畫步驟 5、7 的驗收數字以 Koios 量測：屬自己的計畫，重量即可。

注記：公開部署 Dolos 與後端需要 Will 授權（MVP 計畫步驟 10）；只擋公開部分，不擋本機開發，也不影響選項比較。

## Options Considered

業界基準：
- SDK 把 indexer 做成可替換的 provider（Evolution SDK、Mesh、Lucid），Blockfrost 的 API 形狀是事實上的通用介面，Dolos、Yaci Store、Blockfrost RYO 都相容（[Dolos MiniBF](https://github.com/txpipe/dolos)、[Blockfrost RYO](https://github.com/blockfrost/blockfrost-backend-ryo)）。
- 需要完整歷史的服務自己跑索引：explorer 跑 db-sync；Dolos 主打輕量、以 Mithril 快照啟動。
- 驗證工具（cardano-cli、Mithril client）讓使用者指定自己的節點或來源，不綁營運者。

選項：
- **A：Blockfrost 形狀介面卡＋自架 Dolos，CLI 預設也指向它。** 網頁、後端、CLI 預設都用專案的 full-archive Dolos，`--indexer` 可換。CLI 開箱即用；但 CLI 預設和網頁、後端同一個營運者，專案停擺時 CLI 預設路徑也一起失效。
- **A′：同 A，但 CLI 不設專案預設，必須以 `--indexer` 指定使用者自備的 full-archive Blockfrost 相容節點。** 網頁與後端用專案 Dolos；CLI 的獨立性是明說的。代價是 CLI 不能開箱即用。
- **B：自架 Koios（gRest＋db-sync）。** 程式幾乎不改；維運最重，硬體需求只查到主網數字，koios-artifacts 為 CC-BY-4.0 需標示。
- **C：託管 Blockfrost＋自帶 key。** 條款是同一範本，沒有解決這次要避開的問題；key 不能放瀏覽器。
- **E：代管 Dolos（Demeter.run 等）。** 省掉 VM 維運，但需要 key、有第三方條款，問題同 C；條款原文未查。
- **F：預設交叉比對（專案 Dolos＋第二來源）。** Mithril 之前唯一能降低列舉不完整風險的做法；Koios、託管 Blockfrost 出局後，第二來源只剩使用者節點或另一個 Dolos。可與 A、A′ 疊加。

## Decision

- 採 **A′**：`packages/chain` 的 Koios 介面卡換成 Blockfrost 形狀的介面卡；網頁與後端讀鏈上資料用專案自架的 Dolos（full archive、調高 `max_scan_items`）。
- CLI 沒有專案預設 indexer：必須以 `--indexer` 指定使用者自備的 full-archive Blockfrost 相容節點，沒給時明確報錯並說明節點要求。網頁驗證頁也可改填使用者自己的 indexer。
- 不向 Koios 取得同意；程式與文件不再把 Koios 當成目前的依賴。
- 開發期在本機跑 preprod Dolos，所有 indexer 相關驗收改對它跑；公開部署等 Will 授權（MVP 計畫步驟 10）。
- 後端唯讀 proxy 是否還需要另行決定（階段計畫 PD8）：它原本的理由（繞過 Koios 擋 CORS、藏 key、Koios 日額度的全域預算、依 Koios offset 分頁的快取）要對 Dolos 逐條重檢。

## Rationale

- 選 A′ 而非 A：A 讓 CLI 預設和網頁、後端由同一個營運者執行，專案停擺時 CLI 預設路徑也失效，牴觸「後端停擺時 CLI 直連仍能 PASS」，而且是相對今天（CLI 直連第三方）的退步。代價：CLI 不能開箱即用，使用者要先有自己的節點（Dolos 最輕），文件要寫明節點必須是 full archive、`max_scan_items` 要調高。
- 選 Dolos 而非 B（自架 Koios）：B 程式改最少，但 db-sync 是最重的維運；排除 B 的硬體數字是主網的，preprod 規模未查，所以這個理由只到「維運較重」為止，不是「跑不動」。代價：要改介面卡與兩步的驗收數字。
- 選自架而非 C、E：C 與 E 都要 key 且受第三方條款約束，正是這次要避開的問題；key 也不能放進瀏覽器或公開 CLI。代價：要自己維運一台有狀態的 VM，部署形態從純 Workers 變成 Workers＋VM。
- Blockfrost 形狀而非 Dolos 專屬 API：同一個介面卡能接 Dolos、Yaci Store、Blockfrost RYO 與使用者自己的節點，符合「驗證工具讓使用者指定來源」的基準。代價：Blockfrost 形狀沒有批次 metadata，請求數上升（見下）。
- F 不在本次預設化：第二來源只剩使用者節點或另一個 Dolos，預設要比對誰還沒有答案；觸發條件見 Followup。

已知退步（接受）：
- Mithril 不能證明列舉完整，唯一性永遠信任 indexer 的列舉；換 indexer 不改變這點，但第二來源的候選變少了。
- 使用者自備的節點若不是 full archive，舊承諾列舉不出來，verifier 察覺不到；只能靠文件要求與節點自報的設定，偵測方法列為未知。
- 請求數上升：以步驟 5 實測的 1,171 筆 payment credential 為例，Koios 26 次；Blockfrost 形狀列舉約 ⌈1172/100⌉ 頁，再加每筆交易一次 metadata，約 1,183 次（推論，步驟 8b 重量）。自架 Dolos 可接受；自帶 key 打託管 Blockfrost 會撞到額度。

## Expected Outcome

- 程式與文件不再依賴 koios.rest；`rg -i koios packages apps tools tests` 為 0 筆（spike 與歷史紀錄除外）。
- 網頁 preprod 流程在本機對 preprod Dolos 跑通，不受 CORS 與第三方額度限制。
- CLI 沒給 `--indexer` 時明確報錯；給了使用者自己的 full-archive 節點時，後端與專案 Dolos 都停擺仍能 PASS。

## Followup

- 階段計畫步驟 8b：開工先量 Dolos preprod 的磁碟與同步時間、`addr_vkh` 與 stake 帳戶列舉的分頁與排序穩定性、剛上鏈交易的 `/txs/{h}/cbor` 行為、主網 RAM（調查寫 < 2 GB，沒有出處）；換介面卡、重量步驟 5、7 的請求數。
- 重評後端唯讀 proxy（階段計畫 PD8，交 Will）：Dolos 免 key、預設開 CORS、沒有第三方日額度、分頁是 page/count；BR-01、BR-02、BR-03 與 B6 快取逐條處置。
- 研究 verifier 如何偵測使用者節點的歷史不完整（儲存模式自報、最早可查區塊）。
- 預設交叉比對（F）的觸發條件改為「選定公開預設 indexer 時」。
- Mithril 交易收錄證明的觸發條件不變：`mithril-client-wasm` 的交易證明 API 不再需要 `unstable: true`，且 preprod 與主網都已啟用交易認證；屆時收錄改由 Mithril 驗，列舉仍信任 indexer。
- 步驟 13 改寫 `AGENTS.md`、README 與 `docs/protocol-development.md` 的 indexer 描述；MVP 計畫 `external-interfaces.md` E5 改寫。

## Revocation Triggers

- 本機實測 Dolos 無法依 payment credential 或 stake 帳戶以穩定排序列舉，或 full archive 在可用硬體上跑不起來 → 重評 B（先查 preprod 規模的 db-sync 需求）。
- Koios 以書面明確允許伺服器端與自動化使用，且 Will 改變不取得同意的決定 → 重評回到 Koios 或把它列為 F 的第二來源。
- 使用者普遍無法自備 full-archive 節點，CLI 沒人能用 → 重評 A（CLI 預設專案 Dolos），並在驗證邊界文字寫明 CLI 預設與網頁同一營運者。
- 出現免 key、條款允許自動化使用的公開 Blockfrost 相容 indexer → 評估作為 F 的第二來源或 CLI 的建議來源。

## Amendment (2026-10-19)：開發期本機不跑 preprod Dolos

- Will 2026-10-19 決定本機不佔 preprod full archive 的空間：TxPipe 的 preprod full 快照壓縮後 10.17 GB（實測 HTTP `content-length`，最後更新 2026-06-11），Mithril 的 preprod 節點資料解壓後 20.04 GB（查 Mithril aggregator）；本機可用約 32 GiB。
- Decision 第三點「開發期在本機跑 preprod Dolos」改為：本機跑 Dolos 的 emulator 模式開發鏈（沒有既有鏈歷史，交易由測試金鑰送出），Dolos 程式本身的分頁、排序與 CBOR 行為在開發鏈上量（階段計畫步驟 8b）；preprod 規模的磁碟、同步時間、RAM 與真實地址的列舉，改在 VM 上量（步驟 8c，開 VM 需要 Will 授權），VM 可沿用為公開部署的專案 Dolos。Expected Outcome「網頁 preprod 流程在本機對 preprod Dolos 跑通」改讀為「對本機開發鏈跑通，preprod 版本在步驟 8c」。
- 代價：preprod 規模的列舉排序要到步驟 8c 才實測；若 preprod 上排序不穩定而開發鏈上穩定，唯一性列舉要回頭改。觸發重評：步驟 8c 的排序結果與步驟 8b 不同。

## Amendment (2026-10-19)：Dolos 穩定版沒有帳戶交易端點，stake 列舉改兩段

- 步驟 8b 實測：Dolos 1.6.1 的 `/accounts/{stake}/transactions` 回 404（路由不存在），只有 pre-release 1.7.0-alpha.1、2.0.0-alpha.0 與 main 有；Context 的「有 `/accounts/{stake}/transactions`」對穩定版不成立。
- Will 2026-10-19 選 PD9 的 B：stake 身分用 `/accounts/{stake}/addresses`＋逐址 `/addresses/{a}/transactions`，留在穩定版。使用者節點要求加上「帳戶地址列表包含歷史地址」。理由與審查見階段計畫 PD9。
- 觸發重評：Dolos 2.x 穩定版釋出或 lts/v1 backport 帳戶交易端點。

## Amendment (2026-10-19)：唯一性改讀 `/accounts/{stake}/withdrawals`（PD10，步驟 9b）

- 上一則 Amendment 的 PD9 列舉（地址列表＋逐址）被 PD10 的 withdrawal 列表取代：每筆承諾附身分 stake 的 reward withdrawal，verifier 讀 `/accounts/{stake}/withdrawals?order=asc`，讀到 round 就停。理由、實測與代價見 [唯一性 ADR](./2026-10-18-uniqueness-by-interval-overlap.md) 的同日 Amendment。
- 使用者節點要求改為：full archive、記錄 0 ADA withdrawal 且 withdrawal 列表遵守 `order=asc`（Dolos 1.6.1 實測兩者皆是；db-sync 要開 `ioShelley`）、`max_scan_items` 至少 3,000；「帳戶地址列表包含歷史地址」不再需要。reverse proxy 的 allowlist 拿掉 `/accounts/{stake}/addresses` 與 `/addresses/{a}/transactions`，加入 `/accounts/{stake}`（建立頁讀註冊與 DRep 委託）與 `/accounts/{stake}/withdrawals`。
- enterprise（payment credential）身分拿掉，`/addresses/{addr_vkh}/transactions` 不再使用；Context 對 `addr_vkh` 的描述只是當時的事實紀錄。

## Review Notes

- 2026-10-19 獨立審查（v1 退回）：補上 `max_scan_items` 預設 3000、儲存模式造成的唯一性誤判 PASS、A 對 B1 的退步、請求數量化、db-sync 數字屬主網、Blockfrost 條款範圍；新增 A′、E、F 三個選項。v2 已處理全部發現後交 Will 拍板。

## Related

- 部分取代：[TypeScript 便利層後端](./2026-10-18-typescript-convenience-backend.md) 的「proxy 只放行 Koios 唯讀端點」「CLI 預設直連」；後端本身（bundle 代管、草稿）不受影響。
- [錢包簽章與限期保存](./2026-10-18-wallet-auth-and-bounded-retention.md) 的 Koios key 全域預算與（address, offset）快取：存廢依 PD8。
- [唯一性改以時間區間重疊判定](./2026-10-18-uniqueness-by-interval-overlap.md)：列舉端點改由步驟 8b 對 Dolos 確認。
- 階段計畫：`docs/plans/2026-10-18-hardening-and-backend.md` PD7、PD8、步驟 8b、8c、步驟 9。
- Provenance：2026-10-19 Will 在 coding agent 對話中決定不向 Koios 取得同意、改用其他 indexer，並在選項簡報 v2（經獨立審查修正）中選 A′。
