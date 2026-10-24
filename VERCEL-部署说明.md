# 在 Vercel 上部署 / 修改（Operation Guide）

> 核心：**前端页面 + `/api/matches` 函数必须一起部署，API Key 配在 Vercel 后台，不在代码里。**

---

## 零、网页还是「演示数据」？先看这一节（最高频问题）

部署后页面能打开、但顶部徽章显示 **「演示数据 · 接口 …」**，几乎只有两个原因。

### 先看页面自己怎么说（v2 新增）

现在**不用猜**了，接口一旦失败，页面会在徽章下方自动弹出一块诊断横幅，直接写出三件事：
**HTTP 状态码 → 最可能的根因 → 具体怎么修**。同时徽章会带上状态码，例如：

```
演示数据 · 接口 404（HTTP 404） · 13 场示例
演示数据 · 接口 403（HTTP 403） · 13 场示例
演示数据 · 接口 未响应（Failed to fetch） · 13 场示例
```

各状态码对应的含义：

| 状态码 | 含义 | 怎么修 |
|---|---|---|
| **404** | `api/matches.js` 没部署 —— 页面只是个静态网页 | 把 `api/` 目录一起传上去，再 Redeploy |
| **403 / 401** | Vercel 开了 Deployment Protection（登录保护），匿名请求被挡 | Settings → Deployment Protection → 关掉 Vercel Authentication |
| **5xx** | 函数部署了，但运行时报错或超时 | 打开 `/api/selfcheck` 确认函数层，再看 Functions 日志 |
| **200 但 0 场** | 函数在跑，环境变量缺失或没 Redeploy | 打开 `/api/matches`，看 `sources.missing_keys` |
| **未响应** | 请求根本没发出去（网络层） | 多为 `*.vercel.app` 被 DNS 污染，绑定自有域名可绕过 |

### 再用 `/api/selfcheck` 把「函数层」和「上游」彻底分开（v2 新增）

这是新增的自检端点，**不依赖任何上游**，专门回答「我的函数到底有没有部署上去」：

```
https://你的域名/api/selfcheck            只看函数层（零上游请求，不耗额度）
https://你的域名/api/selfcheck?probe=1    额外真实探测两个上游 Key 是否有效
```

返回示例（关键字段）：

```json
{
  "ok": true,
  "runtime": "vercel-serverless",
  "env": {
    "FOOTBALL_DATA_KEY": "已配置（32 字符）",
    "PANDASCORE_KEY": "已配置（51 字符）"
  },
  "channels": { "ok": true, "entries": 26 },
  "probe": { "football": { "ok": true, "status": 200 }, "pandascore": { "ok": true, "status": 200 } }
}
```

- **`/api/selfcheck` 打不开（404）** → 函数层就没通，跟 Key 完全无关，别再去折腾环境变量了。
- **能打开但 `env` 里显示「❌ 缺失」** → 环境变量没配到当前环境，或配了没 Redeploy。
- **`probe` 里 football 返回 403** → Key 无效/过期；返回 429 → 只是限流，稍后自愈。

### 原因 1：只上传了 `index.html`，`api/` 函数没上去 ⭐ 最常见

Vercel 会把「你拖上去的内容」当作项目根。**只传一个 html，它就只是个静态网页**，
`/api/matches` 这个地址根本不存在 → 前端请求 404 → 按设计自动回退演示数据（页面不白屏，
所以看起来"像是没接入"，而不是"报错"）。

**判断方法**：浏览器直接打开 `https://你的域名/api/matches`

| 你看到什么 | 说明 | 怎么办 |
|---|---|---|
| Vercel 的 404 页面（`404: NOT_FOUND`） | 函数没部署 | 把 `api/` 目录一起上传，见下方「一、必需文件」 |
| JSON，但 `matches` 是空数组 `[]` | 函数在跑，但上游没返回数据 | 看「原因 2」 |
| JSON，`matches` 有上百条 | 接口正常 | 是浏览器缓存，按 `Ctrl + F5` 强刷 |
| 500 / 502 / 504 | 函数报错或超时 | 到 Vercel 后台 Functions 标签页看实时日志 |

### 原因 2：Vercel 后台没配 API Key

`.env` 是**故意不上传**的（Key 不能进仓库）。Vercel 上必须单独配环境变量，
没配时函数**不报错**，只是静默返回空数组 → 前端同样回退演示数据。

配好后**必须重新部署（Redeploy）才生效**——只改环境变量、不重新部署，函数用的还是旧配置。

> 新版本的接口会显式回传 `sources.missing_keys`，打开 `/api/matches` 就能直接看到缺哪个变量。

### 一键诊断

不想逐个对照？直接跑（会只读探测你的线上地址，不改动任何东西）：

```bash
node tools/diagnose-online.mjs 你的域名.vercel.app
```

它会依次检查首页、前端请求的接口地址、`/api/matches` 的真实返回，然后直接告诉你是哪种情况、该怎么修。

---

## 一、Vercel 上需要存在的文件（必需 11 个）

```
你的项目/
├── index.html            ← 前端页面（深色监控台版，纯手写 CSS，无任何外链）
├── api/
│   ├── matches.js        ← Serverless 函数，自动映射到 /api/matches
│   ├── selfcheck.js      ← 自检端点，映射到 /api/selfcheck（排障用，建议一起传）
│   ├── streams.js        ← 直播源目录，映射到 /api/streams
│   └── stream.js         ← 直播流同源代理，映射到 /api/stream（播放靠它）
├── lib/
│   ├── zh.js             ← ⚠️ 足球赛事中文映射表（matches.js 要 import，少它就 500）
│   └── stream.js         ← 直播源频道目录 + 代理逻辑（streams.js / stream.js 共用）
├── assets/
│   └── hls.light.min.js  ← 本地播放器（290KB，同源加载，不用 CDN）
├── channels.json         ← 观赛渠道映射表（函数要读）
├── package.json          ← ⚠️ 必须有！且必须含 "type": "module"
└── vercel.json           ← 声明 lib/ 要打进函数包
```

> 判断函数有没有真正部署上去，最快的办法是打开 `/api/selfcheck`：
> 打得开 = 函数层没问题；404 = `/api/` 目录没传上去。

**上传时最容易漏的就是 `api/` 和 `lib/` 这两个目录** —— 它们不在视觉上"显眼"，
但少了 `api/` 整个接口不存在，少了 `lib/` 足球赛事会直接报 500（模块找不到）。

> ⚠️ **先确认你的项目是「拖拽上传」还是「Git 连接」的——这决定你怎么补文件。**
> 判断方法：Vercel 项目 Deployments 里能看到 commit / 分支信息，或域名里出现过 `xxx-git-main-<team>.vercel.app`，
> 那就是 **Git 连接**。这种情况下**拖拽上传完全不生效**，部署源是 Git 仓库：
> 必须把 `api/` 提交进仓库（GitHub 网页「Add file → Upload files」也行），
> 再等自动构建，或在 Deployments 里点 Redeploy。这也解释了「明明传了文件夹却还是没接口」。

> 本目录已经整备好一份**可直接拖拽上传**的副本：`E:\下载\观赛预告-deploy\`
> （只含上述文件，不含 `server.js` / `tools/` / `cache/` / `.env`，拖它上传即可。）


**两个必须记住的点：**

| 文件 | 为什么不能少 |
|---|---|
| `package.json` 里的 `"type": "module"` | `api/matches.js` 用的是 ESM 语法。没有这一行，Vercel 按 CommonJS 解析，函数直接报 `Cannot use import statement outside a module` → **接口 500** |
| `channels.json` | 观赛渠道只能人工维护（没有任何 API 提供）。读不到它 → 所有比赛都没有「在哪里看」 |
| `lib/zh.js` | 足球赛事中文化映射表（联赛名 + 球队名 + 赛制阶段），`api/matches.js` 用 `import ... from '../lib/zh.js'` 引入。少了它函数启动即抛 `ERR_MODULE_NOT_FOUND` → **接口 500**。`vercel.json` 里已用 `includeFiles: "lib/**"` 声明要打包，但仓库里**必须真的存在这个目录** |

本目录已经把这两个文件都补好了。

---

## 二、部署方式（三选一）

### 方式 A：Vercel CLI（推荐，最不容易出错）

```bash
npm i -g vercel
cd "D:\桌面\飞书下载\观赛预告"
vercel login
vercel            # 首次：创建项目（Preview 部署）
vercel --prod     # 正式发布
```

CLI 会**自动遵守 `.vercelignore`**，所以 `.env`（含 Key）和本地用的 `server.js`、`cache/` 都不会被上传。

### 方式 B：GitHub 连接（适合长期维护）

```bash
cd "D:\桌面\飞书下载\观赛预告"
git init && git add . && git commit -m "init"
git remote add origin <你的仓库地址>
git push -u origin main
```

然后在 Vercel 里 **Add New → Project → Import** 这个仓库。
`.gitignore` 已排除 `.env`，Key 不会进仓库。

### 方式 C：网页拖拽

Vercel 控制台 → **Add New → Project** → 把**整个「观赛预告」文件夹**拖进去。

> ⚠️ 拖拽时要注意两点：
> 1. **必须拖整个文件夹**，只拖一个 `index.html` 是不会有 `/api/matches` 的
> 2. 拖之前确认文件夹里**没有 `.env`**（拖拽上传同样遵守 `.vercelignore`，但多确认一次不亏）

---

## 三、配环境变量（**这一步是「在 Vercel 里改」的核心**）

### 操作路径

```
Vercel 控制台 → 选中你的项目 → Settings → Environment Variables → 添加两条
```

### 要加的两条

| Name | Value | Environments |
|---|---|---|
| `FOOTBALL_DATA_KEY` | `「见 .env 的 FOOTBALL_DATA_KEY」` | Production / Preview / Development **全勾** |
| `PANDASCORE_KEY` | `「见 .env 的 PANDASCORE_KEY」` | Production / Preview / Development **全勾** |

**空格和不带引号**不要加，直接粘贴。Vercel 的输入框里就是纯字符。

### 可选（想调行为再加）

| Name | 默认 | 说明 |
|---|---|---|
| `FB_COMPETITIONS` | `PL,PD,SA,BL1,FL1,CL` | 要拉哪些足球联赛。**不要超过 6 个**，见下方「足球 0 场」 |
| `PS_GAMES` | `lol,valorant,dota2` | 要拉哪些电竞项目。**已排除 csgo（CS2）**，见下方说明 |
| `FB_LOOKAHEAD_DAYS` | `15` | 赛程往后看几天（半个月） |
| `PS_MAX_PER_DAY` | `12` | 每个电竞项目每天最多保留几场赛程 |
| `PS_MAX_PAGES` | `3` | 赛程翻页上限（PandaScore 单页 100 条，半个月窗口需要翻页） |
| `PS_MAX_PAGES_PAST` | `8` | 赛果翻页上限 |
| `PS_RESULT_PER_DAY` | `3` | 每个电竞项目每天最多保留几场赛果（半个月电竞赛果 700+ 场，必须采样） |
| `RESULT_LOOKBACK_DAYS` | `15` | 赛果往前回溯几天（半个月） |
| `RESULT_MAX` | `420` | 赛果全局上限（含羽毛球） |
| `BWF_ON` | `1` | 羽毛球总开关。**不需要 Key**，但函数环境里得有 `curl`（见下） |
| `BWF_CONCURRENCY` | `4` | 羽毛球赛事详情的并发数。调高会触发上游短时限流 |
| `BWF_MAX_MATCHES` | `300` | 羽毛球赛程上限（一个赛事动辄上百场） |
| `BWF_RESULT_MAX` | `120` | 羽毛球赛果的**独立配额**（不与足球/电竞抢） |

> **为什么默认不拉 csgo**：CS2 半个月窗口下 `past` 有 800+ 场、`upcoming` 187 场，
> 且绝大多数是低级别线上赛 —— 既拖慢同步，又会把赛果采样挤掉真正的重点赛事。
> 想在线上恢复，把 `PS_GAMES` 设成 `lol,csgo,valorant,dota2` 即可。

### ⚠️ 羽毛球（BWF）在 Vercel 上依赖系统 `curl`

羽毛球数据源**不需要任何环境变量**（零 Key、零注册），但它有个特殊要求：

Cloudflare 会按 **TLS 指纹**拦 Node 的 `fetch` / `node:https`（一律 403），
所以代码只能 `execFile('curl', …)` 绕过去。这意味着**函数运行环境里必须有 `curl` 可执行文件**。

| 现象 | 含义 | 处理 |
|---|---|---|
| `sources.bwf_error: null` | 正常 ✅ | — |
| `sources.bwf_error: "no-curl"` | 环境里没有 curl | Vercel 的 Amazon Linux 一般自带；也可临时 `BWF_ON=0` 关掉羽毛球 |
| `sources.bwf_error: "rate_limited"` | 上游短时限流 | **不是配置问题**，30~60 秒后自愈 |
| `sources.bwf_error: "timeout"` | 本轮 50 秒（`BWF_DEADLINE_MS`）没拉完 | 已按「先放弃，别拖死整个接口」处理 —— 只有羽毛球为空，足球/电竞不受影响 |
| `sources.bwf_error: "partial-fail"` | 大面积失败（>40%） | 过一会儿再看，多为限流 |

### ⚠️ 改完必须重新部署

**环境变量的修改不会自动生效到已有部署上。** 加完变量后必须：

```
Deployments → 最新那条右边的 "..." → Redeploy
```

（Vercel 有时会提示 "Environment variables changed, redeploy?"，点那个按钮就行。）

---

## 四、部署完立刻自检

### 1. 接口通不通

浏览器直接打开：`https://你的域名.vercel.app/api/matches`

正常应该返回 JSON，开头长这样：

```json
{
  "updatedAt": "2026-10-24T14:xx:xx.xxxZ",
  "build": "zh-bwf-20260930b",
  "sources": {
    "football": 221,
    "esports": 50,
    "uefa_nations_league": 0,
    "uefa_error": null,
    "badminton": 88,
    "badminton_pending": 8,
    "results": 419,
    "football_rate_limited": 0,
    "bwf_error": null
  },
  "matches": [ ... ],
  "results": [ ... ]
}
```

**`sources` 是专门为线上排障加的**，它直接告诉你每个数据源取到多少场：

| 字段 | 含义 |
|---|---|
| `build` | **函数版本号**（当前 `zh-bwf-20260930b`）。最有用的一行 —— 跟本地比一下，就知道线上是不是旧版 |
| `football` | 足球赛程取到几场（半年窗口正常 100~120） |
| `esports` | 电竞赛程取到几场（过滤「对阵未定」后正常 50~60） |
| `uefa_nations_league` | 欧国联取到几场（免费无 Key。只有 9/10/11 月的国际比赛日才有，其它月份 0 属正常） |
| `badminton` | 羽毛球赛程取到几场（BWF，正常 80~130） |
| `badminton_pending` | 其中「抽签未出」的赛事级卡片有几张（正常 5~15） |
| `uefa_error` | `null` 才正常。用来区分「窗口内确实没有欧国联比赛」和「UEFA 接口 403/超时」—— 两者都表现为 `uefa_nations_league: 0` |
| `bwf_error` | `null` 才正常；`no-curl` / `rate_limited` / `timeout` / `partial-fail` 见第五节 |
| `results` | 赛果取到几条（过去 15 天、合并四个源、按结束时间倒序，上限 `RESULT_MAX=420`，正常 350~450） |
| `football_rate_limited` | 本次被 football-data.org 限流（429）的请求数 |

> `results` 为 0 通常是正常的（这个时间段确实没有已结束的比赛）；
> 但如果是**长期**为 0，先检查 page 上「赛果回顾」区块是否显示示例数据 —— 那说明前端没拿到 `results` 字段。

对照处理：

- `football: 0` 且 `football_rate_limited: 0` → 这个时间段本来就没比赛（国际比赛日常见），或者 Key 没配
- `football: 0` 且 `football_rate_limited > 0` → **被限流了**。函数已内置 2 次退避重试，仍超限就说明请求太密，把 `FB_COMPETITIONS` 减到 5 个以内
- `esports: 0` → PandaScore Key 的问题
- 两个都是 0、`rate_limited` 也是 0 → 环境变量没生效，**去 Redeploy**

> 注意：**football-data.org 免费版每分钟只允许 10 次请求**，这是硬限制，跟 Key 有效无效无关。Key 本身是好的（已验证返回 HTTP 200）。

### 2. 页面通不通

打开 `https://你的域名.vercel.app`，Hero 区域的徽章应该显示 **「实时数据 · 未来 15 天 N 场 · 赛果 M 场 · HH:MM 更新 · 接口 zh-20260930」**，而不是「演示数据」。

> 徽章结尾那串 `接口 xxx` 就是函数版本号。它是判断「部署到底生效了没」最快的方式 ——
> 只要它显示「接口未报版本·疑旧版」，就说明线上跑的还是旧函数（中文化那版没传上去），
> 页面会同时弹出提示横幅，并直接告诉你要传哪个文件夹。
>
> 如果显示「演示数据」→ 说明前端没请求到接口。按 F12 打开 Console 看报错，大概率是接口返回了 500（即 `package.json` 没上传）。

### 3. 直播源通不通

两个端点分开看：

```bash
# ① 目录与可用性（看 playable 字段）
curl https://你的域名.vercel.app/api/streams

# ② 直接拉一个频道，正常会返回 #EXTM3U 开头的清单
curl -I "https://你的域名.vercel.app/api/stream?c=cctv5"
```

- `/api/streams` 全部 `playable:false` → **线上是海外节点，国内地方台基本拉不到**，这是预期的。
  判断「本地能不能看」以本机 `server.js` 为准；线上只把它当目录用。
- `/api/stream?c=xxx` 返回 `{"error":"upstream-fetch-failed"}` → 上游挂了/限流，换频道即可。
- 返回 404 且页面提示 `Hls is not defined` → `assets/hls.light.min.js` 没上传。

---

## 五、常见错误对照表

| 现象 | 原因 | 解决 |
|---|---|---|
| 根路径 **404** | 首页文件名不是 `index.html` | 重命名为 `index.html` |
| 接口 **500** | 缺 `package.json` 或其中没有 `"type": "module"` | 补上这个文件，重新部署 |
| 页面显示「演示数据」 | ① 接口 500 ② 环境变量没配 ③ 没 Redeploy | 先打开 `/api/matches` 定位 |
| `/api/matches` **404** | `api/` 目录没上传（只拖了 html） | 重新部署整个文件夹 |
| **足球 0 场** | football-data.org 免费版**每分钟只允许 10 次请求**，联赛数多了就 429 | 把 `FB_COMPETITIONS` 降到 5～6 个 |
| 所有比赛**都没有观赛渠道** | `channels.json` 没上传 | 补上，重新部署 |
| 国内打开**白屏 / 无样式** | Tailwind 用的是 `cdn.tailwindcss.com`（国外 CDN） | 已修复：Tailwind 已编译成本地 CSS 内联进 `index.html`，零外链（见第七节） |
| 页面能打开、数据也有，但**足球联赛名/队名还是英文** | **函数层还是旧版** —— 中文化只在 `api/matches.js` + `lib/zh.js` 里做，前端不含映射表，所以光换 `index.html` 永远不会变中文 | 看徽章结尾有没有 `接口 zh-bwf-20260930b`；或打开 `/api/selfcheck` 看 `build` 与 `zh.ok`。没有 build 字段 = 这版没传上去 → 把「观赛预告-deploy」**整个**重传后 Redeploy |
| **羽毛球一场都没有** | ① 函数是旧版（不含 BWF 代码）② 环境里没 `curl` ③ 上游限流 | 看 `sources.bwf_error`：`null` 才是正常；`no-curl` / `rate_limited` / `timeout` / `partial-fail` 见下节说明 |
| 羽毛球卡片只有**赛事名没有对阵** | 未来赛事**抽签还没公布**，接口返回 `{"results":null}` | 不是 bug，属预期。降级成「赛事级卡片」（赛事名 + 日期 + 地点） |
| 羽毛球卡片**不显示具体开赛时间**（写「待定」） | BWF 接口**只精确到天**，具体时刻只在 `oop_text` 文本里且无时区 | 有意为之：显示 00:00 UTC 会误导成北京时间 08:00 |
| 右侧「正在直播」**一直转圈 / 黑屏** | 公开源被限流、换 IP 或换签名 token（很常见） | 打开 `/api/stream?c=cctv5` 看返回：`502 upstream-fetch-failed` 就是上游挂了。点频道列表换一个源，或点「打开官方页」 |
| 频道列表**全是灰点 / 显示「暂无可用直播源」** | `/api/streams` 全部探测失败 | Vercel 在海外，**国内地方台几乎全是 geo-block**，线上全灰是正常的；本地 `server.js` 才会判准。也可看 `timeout` 是不是同步刚好在跑（那 70 秒网络被占满） |
| 播放器**完全没加载出来**（白框/无控件） | `assets/hls.light.min.js` 没上传 | 补 `assets/` 目录重新部署；浏览器 Console 会报 `Hls is not defined` |
| 页面样式**整体变成浅色/错乱** | 有人跑了 `build/tw/build.mjs` 把 Tailwind preflight 注进去了 | 从 Git 还原 `index.html`（新版是纯手写 CSS，见第七节） |

---

## 六、如果你之前已经部署过旧版本

按这个顺序改（缺一不可）：

1. **补 `package.json`** —— 内容 `{ "type": "module" }`，否则新函数起不来
2. **补 `api/matches.js`** —— 放到 `api/` 目录下
3. **补 `lib/zh.js`** —— 新建 `lib/` 目录放进去（足球中文化映射表，`matches.js` 会 import 它；缺了会 500）
4. **补 `channels.json`** —— 和 `index.html` 同级
5. **替换 `index.html`** —— 旧版线上会算成 `USE_MOCK = true`，**永远显示演示数据**。新版已改成「http/https 下一律走同域 `/api/matches`」，无需再配 `window.__API_BASE__`；同时「昨日赛果」也改为读接口的 `results` 字段（接口没给才回退示例数据）
6. **替换 `vercel.json`** —— 里面声明了 `"functions": { "api/matches.js": {...}, "api/selfcheck.js": {...} }`，都带 `includeFiles: "lib/**"`，保证 `lib/` 被打进函数包
7. **配两条环境变量** → **Redeploy**

> ⚠️ 第 3 步的服务端改动（`api/matches.js` / `lib/zh.js` / `vercel.json`）**必须 Redeploy 才生效**。
> 这一版的中文化全部在函数里完成，前端 `index.html` 不含任何映射表 —— 也就是说
> **只更新前端是不会让足球变中文的**，一定要重新部署函数。

> 第 4 点是最容易漏的：旧版逻辑是「非 localhost 就走 mock」，所以即使你后端接对了，页面也还是演示数据 —— 会被误判成「接口没通」。新版已修掉。

---

## 七、国内访问体验（已做掉）

**问题**：页面原本依赖 `cdn.tailwindcss.com` —— 一个约 400KB 的 JS，下载后**在浏览器里现场生成 CSS**。
国内访问这个域名经常超时，结果就是**白屏 / 完全没有样式**，看起来像「网站挂了」。

**现状（2026-10 改版后）**：页面已经改成**纯手写 CSS**，连 Tailwind 都不用编译了。

```
index.html   单文件 · 自带 <style> · 零外链
外部请求只剩同域：/api/matches、/api/streams、/api/stream
播放器 assets/hls.light.min.js 也是同源静态文件，不走 CDN
```

从此也不存在「编译产物与源码不一致」的问题 —— 改样式直接改 `<style>` 里的规则，刷新即生效。

> `build/tw/build.mjs` 还留着，但会检测到「纯手写 CSS 版本」并**主动跳过**，
> 避免有人误跑一次把 Tailwind 的 preflight 注入进来、把深色样式悄悄改掉。
> `tools/check-css.mjs` 同理，只对 Tailwind 版有意义。

### 改样式后的验证方式

```bash
node tools/check-frontend.mjs                    # 语法 + 结构体检
node tools/shot.mjs E:/下载/a.png 1600 1150      # 截图看真实渲染
```

### 还有一个坑：`*.vercel.app` 本身

页面没外链了，但**域名本身**在部分网络下会被 DNS 污染（表现为请求根本发不出去，徽章显示「接口未响应」）。
解决办法是 **Vercel → Settings → Domains 绑一个自有域名**。前端会识别这种情况并在页面上提示。

---

## 八、本地验证函数（不用部署就能测）

项目里放了 `tools/verify-fn.mjs`，它会模拟 Vercel 的调用方式，直接跑一遍函数：

```bash
cd "D:\桌面\飞书下载\观赛预告"
node tools/verify-fn.mjs
```

输出会逐项断言：HTTP 200 / 有数据 / 无 TBD / 渠道表可读 / CORS 头 / CDN 缓存头 /
`results` 是数组 / 赛果字段完整 / 赛果按时间倒序。
**改完 `api/matches.js` 后先跑这个，比部署上去再 debug 快得多。**

> 注意：football-data.org 免费版**每分钟只有 10 次请求**，连续跑这个脚本很容易 429
> （输出里 `football: 0` + `football_rate_limited` > 0 就是被限流了）。
> 被限流不代表代码有问题，等 1 分钟再跑即可。
