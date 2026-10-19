# Runbook：專案 Dolos 前的 reverse proxy

來源：階段計畫 `docs/plans/2026-10-18-hardening-and-backend.md` 步驟 9、PD8（Will 2026-10-19 選 A）；需求 BR-01、BR-03、BR-04、BR-05（`requirements.md`）。設定檔：`deploy/dolos-proxy/nginx.conf`。本檔寫於 2026-10-19；**尚未部署**，公開部署屬 MVP 計畫步驟 10（需要 Will 授權）。

標記：**實測**＝本機在 Dolos 1.6.1 開發鏈前跑真的 nginx 量到的；**讀碼**＝讀 nginx 1.30.6 原始碼或文件；**推論**＝由前兩者推得；**預設**＝自訂的初值（SELF-IMPOSED），部署時可改。

## 它做什麼

網頁直連專案 Dolos（`apps/api` 不再轉發 indexer）。Dolos 前放一個 nginx，負責四件事，Dolos 本身只聽 loopback：

| 需求 | 設定 | 驗證 |
|---|---|---|
| BR-01 只放行唯讀端點 | `map $uri $route`：9 個 Blockfrost 形狀路由（verifier 的 `BlockfrostChain`、網頁的 tip、建立頁 Evolution `BlockfrostProvider` 的協定參數與 UTxO），只收 preprod 識別碼；其他一律 404。查詢字串只收 `count`、`page`、`order`、`from`、`to`。只收 `GET`、`OPTIONS`。轉給 Dolos 的是比對過的正規化路徑（`$uri`），不是原始請求 URI；不轉送 client 的標頭與本文 | `tests/core.test.mjs`「reverse proxy allowlist admits…」（靜態，CI）；`tools/devchain/rproxy-check.mjs` 的 `allowlist`（實測） |
| BR-03 依 IP 限流 | `limit_req_zone $binary_remote_addr … rate=30r/s`、`limit_req … burst=350 delay=300`、`limit_req_status 429` | 靜態測試；`rproxy-check.mjs` 的 `verification`、`flood` |
| BR-04 CORS 網域清單 | `map $http_origin $cors`：清單內的 origin 回 `Access-Control-Allow-Origin: <origin>`（不回 `*`）；清單外的 origin 在碰到 Dolos 前就回 403；沒有 `Origin` 的請求（非跨站網頁）放行、不帶 CORS 標頭。Dolos 自己的 `permissive_cors`（回 `*`）標頭以 `proxy_hide_header` 拿掉 | 靜態測試；`rproxy-check.mjs` 的 `cors`；`tools/devchain/browser-live.mjs`（Chrome 經 proxy，含 Evolution 的 preflight） |
| BR-05 不記錄請求內容 | access log 只有時間、method、路由名、狀態、大小、耗時（`log_format giveaway`），沒有 IP、路徑參數、query、標頭、本文；error log 只寫 `crit` 以上（nginx 在 error 等級的訊息會帶 client 位址與 request line） | 靜態測試；`rproxy-check.mjs` 的 `logs`（帶標記的 query、標頭、本文都不出現在 log） |

`/tx/submit` 不放行：交易由錢包以 CIP-30 `submitTx` 送出（BR-15、F14，步驟 9），錢包走自己的基礎設施；網頁與後端都不送交易。計畫的「預設不放行」因此維持。

## 為什麼是 nginx

業界自架 API 的限流常見做法是 reverse proxy 的請求速率限制（計畫 PD8 列 Caddy／nginx）。nginx 的 `limit_req`（leaky bucket，依 key 計）是內建模組（`ngx_http_limit_req_module`，預設編入）；Caddy 2 的標準發行版沒有限流指令（2026-10-19 查 [Caddyfile directives](https://caddyserver.com/docs/caddyfile/directives)，清單中沒有 `rate_limit`），要用第三方外掛 `mholt/caddy-ratelimit` 並以 xcaddy 自建執行檔。選 nginx，不需要任何外掛或第三方模組。`limit_req` 的 `delay=` 參數需要 nginx 1.15.7 以上（[文件](https://nginx.org/en/docs/http/ngx_http_limit_req_module.html)）。

## 限流初值與推導

輸入（步驟 8b 實測，`spike-dolos.md`；本步重量）：

- 一次完整驗證的請求數＝5＋⌈(A＋1)/100⌉（只有 stake 身分）＋Σ_a⌈(r_a＋1)/100⌉＋n＋k。開發鏈上 stake 身分 n＝265 時 **276 次**（步驟 8b 實測，本步在全新開發鏈上重跑 `acceptance.mjs` 再得 276）；acceptance 加上重疊承諾後 n＝266、k＝2 時 **278 次**（本步實測，`rproxy-nginx-1.30.6-report.json` 的 `direct`）。上限 L＝2,900 列時約 2,940 次（推論）；步驟 5 的 preprod payment 身分 1,171 筆約 1,188＋k 次（推論，步驟 8c 實測）。
- 驗證是循序的：`BlockfrostChain` 每個請求 await 完才發下一個（讀碼 `packages/chain/index.ts`），一次只有一個在途請求。網頁的驗證也走同一個介面卡（E2E 以 mock 計數：n＝1 的 stake 身分一次 9 次＝5＋1＋1＋1＋1）。

nginx 的帳（讀碼／文件）：每個 IP 一個 excess 值，每個請求 +1、每秒扣 `rate`；excess ≤ `delay` 時立即轉發，`delay` < excess ≤ `burst` 時延後到速率允許的時間，excess > `burst` 回 429。

| 參數 | 值 | 推導 |
|---|---|---|
| `delay` | 300 | ≥ 276（n＝265 的一次完整驗證），留約 8% 給 tip、建立頁的讀取與 n 的小幅成長。這個大小的驗證完全不被延遲。 |
| `rate` | 30 r/s | 預設。超過 `delay` 的請求被節流到這個速率：1,188 次的驗證多等約 (1,188−300)/30 ≈ 30 s，L 上限的 2,940 次約 88 s（推論）。單一 IP 長期最多 30 r/s。Dolos 在公開 VM 上的容量未量（屬 MVP 步驟 10），所以這不是由容量推得，是「正常驗證的等待可接受」的上限；部署時依 VM 實測調整。 |
| `burst` | 350 | `delay` 之上再排 50 個：循序的 client 在被延後時一次只有一個在排（下一個請求在前一個回應後才發，excess 停在約 delay＋1），所以**任何大小的循序驗證都不會收到 429**，只會被放慢；只有同時在途超過約 50 個的 client（灌量）才會收到 429。瀏覽器對同一主機的 HTTP/1.1 連線數是個位數（推論，Chrome 為 6），本產品的驗證是 1。 |

為什麼用 `delay` 而不是 `nodelay`（實測，`rproxy-nginx-1.30.6-report.json` 的 `nodelay` 變體）：同樣 300 的額度改成 `burst=300 nodelay` 時，連續兩次完整驗證的第二次在第 164 個請求收到 429，verifier 依規則把任何非 2xx 判 FAIL；`delay` 版本連續兩次 278 次全部 200、判定與直連 Dolos 相同。

停止條件（計畫步驟 9：擋得住灌量卻會擋下一次正常的完整驗證）：未觸發。同一設定下，450 個同時請求收到 429（committed 變體 390 個），而兩次連續的完整驗證 0 個 429（實測）。

不在這層處理的（觸發條件）：

- 多 IP 的分散式灌量與總量上限：BR-03 的全域預算已依 PD8 A 刪除；需要時在部署層（VM 防火牆、上游 CDN）處理——觸發條件：步驟 10 部署後量到 Dolos 被多來源壓滿。
- 「單一地址」的負載（非功能需求「公開讀取路徑的負載」）：每次驗證的請求數由協定的 L＝2,900 列封頂（約 2,940 次），頻率由 IP 限流封頂；不另依查詢的地址限流。灌列數讓某身分每次驗證都接近 L 屬 PD10（未決）。
- 前面若再加 CDN 或負載平衡，`$binary_remote_addr` 會變成 CDN 的位址，要改用 `real_ip` 模組並只信任該 CDN 的位址段——觸發條件：步驟 10 選定前置 CDN。

## IP 的保存（BR-05「IP 只保留到限流所需時間」）

- IP 只存在 `limit_req_zone` 的共享記憶體（10 MB），不寫入任何 log 或磁碟。
- 清除時機（讀碼 nginx 1.30.6 `src/http/modules/ngx_http_limit_req_module.c` 的 `ngx_http_limit_req_expire`）：之後有請求進來時，順便移除最舊的一到兩筆「閒置至少 60 秒且 excess 已扣完」的紀錄；zone 滿了時強制移除最舊的一筆；nginx 重啟時全部消失。
- 偏離字面之處：沒有任何新請求時，閒置的紀錄會留在記憶體裡直到下一批請求或重啟，不是剛好在限流不再需要時刪除。

## 版本、下載與驗證（本機測試用）

本機沒有 nginx，從原始碼建在 repo 外的 `…/cardano-verifiable-giveaway-wt/tools-rproxy/`（以下 `$R`），只為了在開發鏈前實跑；部署機器可用發行版或 nginx.org 套件（≥ 1.15.7，需含 `http_ssl_module`）。

| 項目 | 版本與驗證 |
|---|---|
| nginx | 1.30.6（2026-10-19 nginx.org 的 Stable version）。`nginx-1.30.6.tar.gz` sha256 `3cf46f5ed7504d460125866b7bea99fb357f31d887e2e63b35503310e9b8b6c8`；`.asc` 以 [nginx.org/en/pgp_keys.html](https://nginx.org/en/pgp_keys.html) 列出的金鑰驗證：Good signature，Sergey Kandaurov，主金鑰指紋 `D678 6CE3 03D9 A902 2998 DC6C C846 4D54 9AF7 5C0A`（金鑰未經 web of trust 認證，信任依據是 nginx.org 的 HTTPS 頁面） |
| PCRE2（nginx 的 regex `map` 需要） | 10.49（GitHub release，2026-09-28，Latest）。`pcre2-10.49.tar.gz` sha256 `929f0b20e62879252a15886b06c89f1edef61a363cbd5826fb041080a5e557ae`；`gh attestation verify … -R PCRE2Project/pcre2` exit 0，attestation 的 subject digest 與此相同，來源 `refs/heads/release/pcre2-10.49` |
| 編譯 | Apple clang 17.0.0；執行檔 sha256 `159e51ff572c6d0c2a183b45c9f55467c35cd10b0d80d17c785afc631a973161` |

```sh
R=/Users/will/second-brain/.projects/personal/cardano-verifiable-giveaway-wt/tools-rproxy
mkdir -p $R/download $R/gnupg $R/src && chmod 700 $R/gnupg && cd $R/download
curl -sSfO https://nginx.org/download/nginx-1.30.6.tar.gz
curl -sSfO https://nginx.org/download/nginx-1.30.6.tar.gz.asc
for k in arut pluknet sb thresh nginx_signing; do curl -sSfO https://nginx.org/keys/$k.key; done
GNUPGHOME=$R/gnupg gpg --batch --import *.key && GNUPGHOME=$R/gnupg gpg --batch --verify nginx-1.30.6.tar.gz.asc nginx-1.30.6.tar.gz
gh release download pcre2-10.49 -R PCRE2Project/pcre2 -p 'pcre2-10.49.tar.gz*'
gh attestation verify pcre2-10.49.tar.gz -R PCRE2Project/pcre2
tar -xzf nginx-1.30.6.tar.gz -C $R/src && tar -xzf pcre2-10.49.tar.gz -C $R/src
cd $R/src/nginx-1.30.6 && ./configure --prefix=$R/nginx --with-pcre=$R/src/pcre2-10.49 \
  --without-http_gzip_module --without-http_ssi_module --without-http_userid_module \
  --without-http_autoindex_module --without-http_fastcgi_module --without-http_uwsgi_module \
  --without-http_scgi_module --without-http_grpc_module --without-http_memcached_module \
  --without-mail_pop3_module --without-mail_imap_module --without-mail_smtp_module
make -j8 && make install
```

## 本機驗證（每次改設定都跑）

```sh
# 1. 開發鏈：spike-dolos.md「重現指令」起一條全新的 Dolos（127.0.0.1:3010），make build，再
node tools/devchain/acceptance.mjs <out>
# 2. 設定本身在真的 nginx 前跑，並一次拿掉一個防護（allowlist、限流、origin 清單、log 格式）各自要失敗
GIVEAWAY_NGINX=$R/nginx/sbin/nginx node tools/devchain/rproxy-check.mjs <out> <run dir>
# 3. 網頁經 proxy（Chrome，只 mock 錢包）
$R/nginx/sbin/nginx -p <prefix> -c <repo>/deploy/dolos-proxy/nginx.conf   # 停止：kill -QUIT $(cat <prefix>/logs/nginx.pid)
GIVEAWAY_INDEXER_URL=http://127.0.0.1:3020 make dev &
GIVEAWAY_INDEXER_URL=http://127.0.0.1:3020 GIVEAWAY_PLAYWRIGHT_MODULE=… GIVEAWAY_CHROME_PATH=… \
  node tools/devchain/browser-live.mjs <out>
```

`make check` 另以靜態測試檢查同一份設定（allowlist 涵蓋 verifier 實際發出的每個請求、log 格式、限流位置、origin 清單），`tools/mutation-check.mjs` 對它做同樣四個 mutation。

## 部署（MVP 計畫步驟 10，需要 Will 授權；本步未做）

1. VM 上的 Dolos：full archive；`[serve.minibf] listen_address = "127.0.0.1:3010"`（只聽 loopback，外界只能經 nginx）；`max_scan_items` 維持預設 3,000 即可（L＝2,900 的推導就是讓預設節點讀得完，`docs/protocol-development.md`），不要照開發鏈設成 100,000，否則單一請求可要求掃描更深的頁。
2. nginx（≥ 1.15.7，含 `http_ssl_module`）用 `deploy/dolos-proxy/nginx.conf`，只改標 `DEPLOY` 的行：
   - `listen 127.0.0.1:3020;` → `listen 443 ssl;`，並在同一個 `server` 加 `ssl_certificate`、`ssl_certificate_key`（憑證取得方式在步驟 10 決定）。
   - origin 清單 → 正式網頁的 origin（MVP 計畫 D9 的網域），一行一個，不用萬用字元。
   - upstream → Dolos 的 loopback 位址（同上則不變）。
3. 網頁以 `GIVEAWAY_INDEXER_URL=https://<proxy 網域>` 建置。
4. log：access log 已不含 IP 與請求內容；輪替與保存期間在步驟 10 定，並寫進隱私說明（步驟 13）。
5. 部署後的驗收（步驟 10）：從外部對公開網址重跑 `rproxy-check.mjs` 的同類檢查（allowlist 外 404、外站 origin 403、超量 429、log 無內容），並以 VM 實測容量重訂 `rate`。
