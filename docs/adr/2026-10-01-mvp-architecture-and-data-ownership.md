---
title: MVP 採靜態網站、自持錢包與主辦者公開驗證資料
date: 2026-10-01
status: active
tags: [cardano-verifiable-giveaway, decision, architecture]
---

# MVP 採靜態網站、自持錢包與主辦者公開驗證資料

## Context

2026-10-01 Will 逐題拍板 MVP。需求尚未驗證；先以可示範的產品與公開試用取得證據。此 ADR 保存已決項，不代表完成公開部署或凍結鏈上協定。

- `external` 非工程背景的創作者與社群主辦者是目標使用者：本次產品討論；建立流程須可在瀏覽器操作。
- `inherited` Cardano 承諾、drand randomness、獨立重算是產品定位：既有構想；仍成立，因本次開發就是驗證此價值。
- `inherited` 免費抽獎，不以付款、下注、NFT 或加密貨幣獎金為核心：既有產品限制；仍成立，未擴大產品範圍。
- `inherited` 驗證只涵蓋承諾名單下的抽選：既有驗證邊界；仍成立，沒有資格、完整性或交付的權威資料。
- `inherited` 公開資料可交給獨立 verifier：既有 I4；仍成立，驗證不應要求產品的寫入服務存活。這不排除另加資料保存後端。

## Options Considered

**基準 A：靜態 dApp＋非託管 wallet connector＋可下載資料。** 瀏覽器建交易、錢包簽署；[CIP-30](https://cips.cardano.org/cip/CIP-0030) 定義此介面，[GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages) 可托管靜態網站。此基準適用可在瀏覽器運算、已有鏈上查詢介面的條件，不宣稱所有抽獎服務都採它。
**B：託管網站＋後端保存＋自持錢包。** 可恢復草稿、自動發布、提供報名；仍能匯出資料獨立驗證，代價是帳號、upload abuse、保存政策與維運。
**C：CLI 建立＋靜態驗證頁。** 建立介面最少，非工程主辦者操作門檻較高。

| 子題 | 已選 | 真實替代方案與取捨 |
|---|---|---|
| D1 開發次序 | 直接建 MVP，以公開試用驗證需求 | 先訪談／手動代辦可較早排除產品風險；只做 spike 可先處理技術風險 |
| D4 簽署付費 | 主辦者 CIP-30 錢包 | 營運方代簽代付降低門檻，增加金鑰、費用與承諾歸屬責任；雙路徑增加測試面 |
| D5 公開名單 | 公開標籤；聯絡資料只留主辦者、不進 bundle | 加鹽 entry commitment＋receipt 降低直接身份揭露，但增加 receipt 發送、保管、得獎映射流程 |
| D6 資料保存 | 主辦者下載自行公開 | 產品保存增加可用性與責任；IPFS／永久儲存增加 pinning／費用與公開資料撤回限制 |
| D8 名單收集 | 貼上／CSV | 內建報名須防灌票與個資處理；社群匯入受平台 API 條款／費用限制 |
| D10 授權 | MIT | Apache-2.0 有明示專利授權條款；AGPL-3.0 以網路使用相關原始碼要求換取回饋 |
| D11 產品分析 | 無 cookie，只保留彙總數字 | 不蒐集不能量測曝光；完整分析增加追蹤與告知負擔 |

## Decision

- **D1-B**：直接建 MVP，需求由公開試用驗證；不執行先驗需求步驟。
- **D2-A**：靜態主辦者頁與驗證頁＋Node CLI verifier，無產品後端；托管選 GitHub Pages。
- **D4-A／D8-A**：主辦者自己簽署付費，自己收集整理名單；只支援貼上／CSV。
- **D5-C／D6-A**：公開必要標籤，聯絡資料不收集、不保存、不強制 hash；主辦者下載 bundle 自行公開，副本以 hash 核對。
- **D10-A／D11-B**：MIT；產品分析無 cookie、只有彙總數字，具體服務尚未選定。
- D3／D7 的 v1 定案與 D9 發布網路不由本 ADR 決定；本次選擇不授權對外登入、部署或註冊。

## Rationale

- 相較先做需求訪談，先做可示範產品符合本次開發次序；代價是 MVP 成本可能在需求不成立時沉沒，不能把已開發當成需求證據。
- 相較 B，A 先縮小帳號、保存、濫用防護與維運範圍；不因「後端破壞可驗證性」拒絕 B。不選 C 是主辦者操作門檻較高。
- 自持錢包保留簽署控制，代價是 wallet／ADA 門檻。代付與代簽是不同維度；未來 sponsorship 不必然交出簽署權，本次不擴充。
- 公開標籤相較 receipt 較容易找自己與重算；代價是標籤與參與關係仍公開，email／phone 格式檢查不能保證所有標籤不敏感。Merkle root 本身不足以重算全體排名。
- 自行公開相較產品保存少一個持久服務；代價是連結可失效。[IPFS pinning](https://docs.ipfs.tech/how-to/pin-files/) 也需有人保存內容，hash／CID 保證一致性，不能恢復遺失資料。
- MIT 相較 Apache-2.0／AGPL 保持本次選擇的寬鬆、簡短授權，不要求衍生服務回饋。彙總分析相較不蒐集可量測曝光，但無法提供完整個人留存分析。
- CLI 與 browser 共用 verifier，獨立性指不依賴產品伺服器；不同語言的 Python vectors 才提供跨實作核對。查鏈仍依賴可取得的相容 indexer。
- 托管平台可換；已公開標籤無法可靠撤回，鏈上承諾不可修改，後續版本須保留既有結果解讀能力。

## Expected Outcome

- 主辦者能用瀏覽器建立並以自己的錢包確認交易，不向產品交出私鑰或聯絡資料。
- 持有完整 bundle 者可在產品下線後，透過相容鏈上查詢與 drand 證據重算。
- 公開試用能提供需求與驗證連結曝光證據；不預設一定有人使用。

## Followup

- 完成真錢包 preprod、Firefox、BLS 效能與已上鏈 bundle 保存／重載恢復驗收。
- 完成 CI 與硬化驗收；另決 D9 發布網路及費用上限，再公開部署。
- 選擇並驗證無 cookie 彙總統計服務；不把托管平台的安全 IP logs 當成產品零蒐集承諾。

## Revocation Triggers

- 目標主辦者因 wallet 或自行發布放棄使用 → 重評非託管後端保存、代付或 onboarding。
- 資料頻繁遺失／需要草稿恢復 → 重評產品保存，維持下載與 verifier。
- 目標社群不能接受公開參與關係 → 重評匿名 entry／receipt 協定。

## Review Notes

## Related

- Provenance：2026-10-01 Will 與 coding agent 當場逐題拍板；本 ADR 即原始決策紀錄，無必要外部來源文件；未壓縮或刪除計畫。
- [MIT 原文](https://opensource.org/license/mit)、[Apache-2.0 原文](https://www.apache.org/licenses/LICENSE-2.0)、[AGPL-3.0 原文](https://www.gnu.org/licenses/agpl-3.0.html)；其他基準來源見 Options／Rationale。
- 通用規則：0；本次是產品範圍與責任分配，未新增跨專案規則。
