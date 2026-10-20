# Runbook：營運端下架代管的 bundle

來源：階段計畫 `docs/plans/2026-10-18-hardening-and-backend.md` 步驟 13；需求 BR-13、BR-14（`requirements.md`）；ADR `docs/adr/2026-10-18-wallet-auth-and-bounded-retention.md`（Decision「刪除」、Amendment 2、Amendment 5）。程式對應：`apps/api/src/bundles.ts` 的 `takedown`。本檔寫於 2026-10-20；後端**尚未部署**（MVP 計畫步驟 10），所以只在本機 Miniflare 照做過一次（見文末），`--remote` 的指令未跑過。

## 什麼時候用

- 檢舉從 GitHub issues 進來（[Will413028/cardano-verifiable-giveaway/issues](https://github.com/Will413028/cardano-verifiable-giveaway/issues)，隱私說明 `apps/web/privacy.html` 與頁尾連到這裡）：參加者要求移除自己的 label、內容違法或濫用。
- 參加者的刪除請求一律以**整份 bundle** 下架（BR-13）：改掉其中一個 label 會讓 hash 對不上鏈上承諾，部分刪除不存在。
- 不適用：主辦者刪自己的代管（頁面上「Delete hosted bundle」，簽章路由 `DELETE /bundles/{tx}`，不留 tombstone）；伺服器草稿（只有簽章者讀得到，不公開，沒有可檢舉的對象）；鏈上的 hash 與別處的副本（營運端無法移除，請檢舉人找該主機）。

## 下架做什麼（與 `takedown()` 相同）

1. 在 `tombstones` 寫入 bundle hash 與時間：之後任何上傳這份 bytes 都在讀鏈之前回 410，且寫入敘述本身也以 `NOT EXISTS tombstone` 擋住。
2. 刪掉 `hosted` 裡**所有**指向這個 bundle hash 的紀錄（同一份 bytes 可能被不同交易各自承諾、各自代管，B4）。
3. 刪 R2 物件 `bundles/<bundle hash>`。

順序有意義：tombstone 先寫，第 2 步之後就不可能再有紀錄指向它，所以刪 bytes 不需要 `collecting` claim；第 3 步若失敗，Cron reconciliation 會刪掉沒有紀錄指向的 bytes。兩條 SQL 放在同一個 `--command`，中途失敗時整段重跑即可（`INSERT OR IGNORE`、`DELETE` 都可重跑）。

**不能動：**

- `first_hosting`：它在下架後仍保留第一次代管時間與延長次數；刪掉會讓同一筆承諾日後被當成第一次代管、重新拿到 12 個月（ADR Amendment 5）。tombstone 擋的是同一份 bytes，`first_hosting` 擋的是同一筆承諾。
- `tombstones` 沒有刪除路徑；誤下架要撤回時，刪 tombstone 的那一列只會讓 bytes 可以重新上傳（擁有者以簽章重新代管），保存期限仍由 `first_hosting` 決定。

## 步驟

在 `apps/api/` 目錄執行（Wrangler 鎖在 `package.json`）。`TARGET` 在部署環境是 `--remote`（需要 Cloudflare 帳號登入，只由營運者本人執行），本機驗證是 `--local`（`make api` 的狀態在 `apps/api/.wrangler/state`）。資料庫名稱 `giveaway`、bucket `giveaway-bundles` 取自 `wrangler.jsonc`。

```sh
cd apps/api
TARGET=--local            # 部署環境：--remote
API=http://127.0.0.1:8787 # 部署環境：後端的公開網址
TX=<檢舉裡的承諾交易 hash>   # 或直接給 BUNDLE=<驗證連結裡的 bundle=>
```

**0. 先驗格式。** hash 會被拼進 SQL，只接受 64 個小寫十六進位字元；不符就停：

```sh
[[ $TX =~ ^[0-9a-f]{64}$ ]] || echo "not a transaction hash"
```

**1. 找出 bundle hash 與範圍。**

```sh
pnpm exec wrangler d1 execute giveaway $TARGET --json --command \
  "SELECT tx_hash, bundle_hash, owner, expires_at FROM hosted WHERE tx_hash = '$TX'"
BUNDLE=<上一步的 bundle_hash>
[[ $BUNDLE =~ ^[0-9a-f]{64}$ ]] || echo "not a bundle hash"
pnpm exec wrangler d1 execute giveaway $TARGET --json --command \
  "SELECT tx_hash, owner FROM hosted WHERE bundle_hash = '$BUNDLE'"
curl -s -o /dev/null -w '%{http_code}\n' "$API/bundles/$TX"   # 200：仍在代管
```

第二個查詢列出的每一筆都會一起下架；issue 是公開的，回覆只寫 hash，不寫 owner 或 label。決定是否下架時可用 `curl "$API/bundles/$TX"` 讀內容。

**2. tombstone 與紀錄。**

```sh
pnpm exec wrangler d1 execute giveaway $TARGET --json --command \
  "INSERT OR IGNORE INTO tombstones (bundle_hash, removed_at) VALUES ('$BUNDLE', unixepoch()); DELETE FROM hosted WHERE bundle_hash = '$BUNDLE'"
```

**3. bytes。**

```sh
pnpm exec wrangler r2 object delete "giveaway-bundles/bundles/$BUNDLE" $TARGET
```

**4. 確認。**

```sh
pnpm exec wrangler d1 execute giveaway $TARGET --json --command \
  "SELECT bundle_hash, removed_at FROM tombstones WHERE bundle_hash = '$BUNDLE'"   # 一列
pnpm exec wrangler d1 execute giveaway $TARGET --json --command \
  "SELECT count(*) AS records FROM hosted WHERE bundle_hash = '$BUNDLE'"           # 0
pnpm exec wrangler r2 object get "giveaway-bundles/bundles/$BUNDLE" $TARGET --pipe # The specified key does not exist.
curl -s -w ' %{http_code}\n' "$API/bundles/$TX"                                    # 404
```

`GET /bundles/{tx}` 在下架後回 **404**（「No bundle is hosted for this commitment」），不是 410：紀錄已刪，`read()` 只在紀錄還在、bytes 被下架時回 410（下架與讀取交錯的瞬間）。之後任何人（含擁有者）以簽章重新上傳同一份 bytes 回 **410**「This bundle was taken down and cannot be hosted again」（`apps/api/test/bundles.test.ts` 的 takedown 測試斷言兩者）。

**5. 回覆檢舉。** 在 issue 回覆已下架的 hash 與時間後關閉；檢舉人若貼了個人資料，刪除整則留言（只編輯的話，舊內容仍留在留言的編輯紀錄裡）。

## 本機驗證（2026-10-20，Wrangler 4.151.1，Miniflare 本機 D1／R2）

做法：`wrangler d1 migrations apply giveaway --local` 後以 `wrangler dev`（另一個 `--persist-to` 目錄與埠 8798，不碰 `make api` 的狀態）啟動後端；以 `wrangler d1 execute --file`（一列 `hosted`，owner 為假的 `stake_test1…`）與 `wrangler r2 object put` 放入一份 canonical 測試 bundle（drawId `takedown-runbook-test`，3 個 label），**沒有經過上傳門檻**（門檻要讀本機 Dolos 開發鏈上的真承諾，屬 `tools/devchain/hosting-live.mjs`），所以這次驗的是下架指令本身。重新上傳的探針用測試金鑰（`tests/cardano.mjs` 的 `testKey(2)`）對 `host` 操作簽章；tombstone 的檢查在讀鏈與 owner 比對之前，所以任何人的有效簽章都會得到 410。指令與輸出逐字在附件 `docs/plans/2026-10-18-hardening-and-backend/takedown-wrangler-4.151.1-local.log`。摘要：

| 步驟 | 結果（實測） |
|---|---|
| 下架前 `GET /bundles/abab…ab` | 200，回傳測試 bundle |
| 1 範圍 | `hosted` 一列（`tx_hash` `abab…ab`，`bundle_hash` `8f63772f…ab15`） |
| 2 tombstone＋紀錄 | 兩條敘述都成功 |
| 3 `r2 object delete` | `Delete complete.` |
| 4 確認 | tombstone 一列（`removed_at` 1792485120）；`hosted` 0 列；`r2 object get` 「The specified key does not exist.」exit 1；`GET` 404；簽章重新上傳 410 |
| 重跑第 2 步 | 成功，tombstone 仍是 1 列（可重跑） |

未驗：`--remote`（沒有部署）；部署後的 `GET`／`PUT` 經公開網址。
