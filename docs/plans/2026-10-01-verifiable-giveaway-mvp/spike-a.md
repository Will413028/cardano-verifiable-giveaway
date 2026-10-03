# Spike A：preprod 承諾交易

狀態：進行中，尚未完成鏈上與真錢包驗收。日期：2026-10-01。

## 已跑的本機檢查

- Node v26.10.0、pnpm 11.2.2。Node 為本機既有版本，並非計畫預設的 LTS；結果只代表這個環境。
- 鎖定套件：`@meshsdk/core` 1.9.1、`@lucid-evolution/lucid` 0.6.5、`esbuild` 0.28.2，見 spike 的 package.json 與 pnpm-lock.yaml。
- 首次安裝因未設定 cbor-extract、chacha-native、esbuild 的 install scripts 政策回傳 exit 1；明確設為不執行後，offline frozen-lockfile 安裝通過。兩套 SDK 的 Node import 與 esbuild 執行已成功。
- 模擬 UTxO 的 Mesh 未簽交易：445 bytes、SDK 計算的費用 180,857 lovelace，樣本 1。未簽署、未送出，不能視為實測費用。metadata 經 CBOR 編解碼後相符；改一個 hash byte 被拒絕。
- 3 個行為測試通過：UTF-8 64-byte 切分、metadata 竄改、確認數計算。實際 mutation：改成字元數切分、略過欄位比較、拿掉 inclusion block 的 +1，三個都被 assertion 抓到。
- Chrome 154.0.8037.58 的乾淨 headless 環境：7 項檢查通過（頁面載入、空名單禁用連線、延遲注入後重新偵測、Mesh 模擬未簽交易、mock 主網錢包拒絕、mock preprod 連線與 UI 建構、Lucid WASM 初始化）。mock UI 交易為 478 bytes、fee 182,309 lovelace；這不等於真錢包簽署已驗證。
- 真實操作回報 enable 錯誤 `{}`：SDK 將 Error 以 JSON.stringify 包裝會隱藏 message；原頁面也允許空選單呼叫 enable。已加入空選單保護、Refresh wallets 與連線失敗的錢包名稱；拿掉空名單禁用保護後，Chrome 回歸測試確實失敗。使用者此次的實際 extension／瀏覽器原因仍待確認，不寫成已修復真錢包連線。
- Koios preprod 公開 `GET /api/v1/tip`：HTTP 200，樣本 1，block_no 5240966。未取得或使用 API key。
- Koios preprod `epoch_params` 最新列：epoch 316，min_fee_a = 44、min_fee_b = 155381、max_tx_size = 16384，樣本 1。wallet 建構時重新查當下的 protocol parameters，簽署後、送出前套用 2 倍費用停止條件。

重現（在 repo 根目錄執行）：

```sh
node --test spikes/a-commit-tx/metadata.test.mjs
node spikes/a-commit-tx/offline.mjs
node spikes/a-commit-tx/compare.mjs
```

## 瀏覽器 bundle 比較

設定：esbuild、browser ESM、ES2022、minify；標準 Node browser polyfill（五個套件的精確版本見 lockfile）、global 解析為 globalThis；WASM 由 bridge 實際初始化並輸出獨立 binary。Mesh entry 匯出 BrowserWallet、MeshTxBuilder、KoiosProvider、cst；Lucid entry 匯出 Lucid、CML。數字計入所有輸出檔與各檔 gzip 大小，保留 metafile 供檢查；這是 API entry 比較，不是相同完整應用的比較，也不是最小 bundle 的比較。

| SDK | 樣本數 | 結果 | raw／gzip bytes |
|---|---|---|---|
| Mesh 1.9.1 | 最終設定 1 | build 與 Chrome 模擬交易通過 | 6,071,200／1,576,432 |
| Lucid Evolution 0.6.5 | 最終設定 1 | build 與 Chrome WASM 初始化通過 | 6,520,964／1,880,426（含三個 WASM） |

重現指令同上 `compare.mjs`；診斷輸出在忽略的 `dist/comparison.json` 與 `dist/browser-check.json`。初輪失敗：兩套 SDK 缺 Node built-ins；加入 polyfill 後 Mesh 還需 globalThis resolution，Lucid 還需正確 WASM bridge。以上已修正並以 Chrome 實測；不能把編譯通過當成 runtime 通過。

Browser 檢查：先執行 `node spikes/a-commit-tx/serve.mjs`，將 `SPIKE_PLAYWRIGHT_MODULE`、`SPIKE_CHROME_PATH` 設為本機既有安裝，再執行 `node spikes/a-commit-tx/browser-check.mjs`；mock protocol parameters 的公開資料快照由以下指令準備：

```sh
curl -fsS 'https://preprod.koios.rest/api/v1/epoch_params?order=epoch_no.desc&limit=1' -o spikes/a-commit-tx/dist/epoch-params.json
```

## 已準備、尚未驗收的工具

- `wallet.js`：CIP-30 連線、拒絕 mainnet、以 preprod Koios 核對所選 UTxO、建立自轉帳的 metadata 交易、使用者按鈕觸發簽署、固定送至 preprod、下載量測 sample。瀏覽器 bundle 已可載入；未以真錢包簽署或送出。
- `monitor.mjs`：讀取下載的 sample，以 Koios 查回 metadata、交易大小、費用與 inclusion block；每 30 秒取樣 1／5／15 個確認，最多一小時。未以真交易驗證；時間包含 indexer 與 polling 延遲，不是精確的鏈上達標時刻。
- metadata label 674 與 `spike-a-0` 只供實驗，不代表 D7 已拍板；`utf8Probe` 的 23 個「測」字用來實測超過 64 bytes 的切分。

## 未跑的量測

| 量測項 | 狀態／缺少的證據 |
|---|---|
| 鏈上 signed bytes 與手續費 | 尚無簽署交易，樣本 0 |
| 送出到 1／5／15 個確認，各至少 5 次 | 尚無簽署交易，樣本 0 |
| Koios 查回 bundle hash、Unicode 切分 | 只有本機 CBOR roundtrip；鏈上樣本 0 |
| Chrome、Firefox 真實 CIP-30 | Chrome 模擬測試通過；真錢包與 Firefox 驗收未跑 |
| tx_by_metalabel 與主辦者地址列舉的分頁／請求數 | 尚無自身承諾，未量測 |
| live protocol parameters 與實際費用上限比較 | 公開參數已查回；尚無真實 signed transaction 可比較 |

## 下一步

確認使用者的 preprod 瀏覽器錢包與測試 ADA 狀態後，進行真實連線與至少 5 次簽署量測、metadata 查回、列舉查詢與兩個瀏覽器驗收。步驟 2 尚未完成，D3、D7 尚無足夠實測證據；步驟 4 仍被步驟 2 擋住。

資料來源：[CIP-30](https://cips.cardano.org/cip/CIP-30)、[Mesh Koios 文件](https://meshjs.dev/providers/koios)、[Koios transactions endpoints](https://github.com/cardano-community/koios-artifacts/blob/main/specs/fragments/paths/transactions.yaml)、[Koios transaction schemas](https://github.com/cardano-community/koios-artifacts/blob/main/specs/fragments/schemas/transactions.yaml)。
