# 海风看球 · 接入真实赛程数据

## 这套东西是什么

```
观赛预告/
├── index.html        前端页面（已改造为接口取数，接口挂了自动回退演示数据）
├── server.js         本地开发用的代理层（零依赖，Node 18+ 直接跑）
├── api/matches.js    Vercel Serverless 版本（部署上线用）
├── channels.json     观赛渠道映射表（人工维护，见下文）
├── package.json      ⚠️ 必须存在且含 "type": "module"，缺了 Vercel 上函数会 500
├── vercel.json       Vercel 配置
├── tools/verify-fn.mjs  离线验证函数（不用部署就能测）
└── VERCEL-部署说明.md   ← 部署 / 改环境变量 / 排障，看这份
```

---

## 一、为什么必须有代理层

**不能在前端直接 fetch 第三方体育 API**，三个硬原因：

1. **API Key 会泄露** —— 前端代码用户按 F12 就能看到
2. **CORS 拦截** —— PandaScore、football-data.org 都不允许浏览器跨域直连
3. **免费额度会被打爆** —— 额度按「请求次数」算，100 个用户打开页面 = 100 次请求

代理层的作用：Key 留在服务端、缓存后所有用户共享一次请求、顺便把 N 个数据源归一化成同一个格式。

---

## 二、申请 API Key（都免费，5 分钟）

| 数据源 | 覆盖 | 免费额度 | 地址 |
|---|---|---|---|
| **football-data.org** | 足球：英超/西甲/德甲/意甲/法甲/欧冠等 13 项 | **10 次/分钟**，永久免费 | https://www.football-data.org/client/register |
| **PandaScore** | 电竞：LoL/DOTA2/Valorant（已排除 CS2） | 1000 次/小时 | https://app.pandascore.co/signup |
| **UEFA 官方接口** | 欧国联（Nations League）—— football-data.org 免费版拿不到 | **无需 Key、无需注册** | 直接用，见下方「三-E」 |

前两个都注册完拿到 key，**不需要信用卡**。第三个什么都不用申请。

> **Key 格式区分**：football-data.org 是 32 位十六进制（如 `「见 .env 的 FOOTBALL_DATA_KEY」`）；
> PandaScore 是一长串字母数字。**`api.pandascore.co` 是接口域名，不是 Key** —— 别搞混。

配置方式：填进同目录的 `.env` 文件（已有模板）：

```ini
FOOTBALL_DATA_KEY=你的key
PANDASCORE_KEY=你的key
```

---

## 三、本地跑起来（已配好，双击即可）

**最简单的方式：双击 `启动.bat`** —— 会自动打开浏览器。

Key 已经写进同目录的 `.env` 文件，服务启动时自动读取，不用每次设环境变量。

### 手动方式（PowerShell）

```powershell
cd "D:\桌面\飞书下载\观赛预告"
node server.js
```

浏览器打开 `http://localhost:8787` —— Hero 区域的徽章会显示「实时数据 · 共 N 场」。

### 调试接口

```bash
curl http://localhost:8787/api/matches     # 看返回的 JSON（含 matches + results）
curl http://localhost:8787/api/refresh     # 强制忽略缓存重新拉
```

返回结构：

```json
{
  "updatedAt": "2026-09-30T02:26:11.885Z",
  "matches": [ /* 今天 ~ 未来 15 天，按开赛时间升序 */ ],
  "results": [ /* 过去 15 天已结束的比赛，按结束时间倒序 */ ]
}
```

> 时间跨度 = **半个月**：往前 15 天赛果 + 往后 15 天预告，页面上是一条连续的时间轴。

---

## 三-A、赛果回顾（results）怎么来的

| 数据源 | 取法 | 额外请求 |
|---|---|---|
| football-data.org | **复用**已拉取的整季数据，取 `status=FINISHED` 且结束时间在最近 15 天内的场次 | **0 次**（同一次响应里就有） |
| PandaScore | 额外调 `/<game>/matches/past`，**按 `range[begin_at]` + 翻页**取满 15 天 | 每个游戏 1~2 页（额度 1000/小时，无压力） |
| UEFA 官方（欧国联） | 额外调一次 `&status=FINISHED`（**不加这个参数就没有比分**） | **1 次**（与赛程请求并发） |

赛果窗口与条数由 `.env` 控制：

```ini
RESULT_LOOKBACK_DAYS=15  # 往前回溯几天（半个月）
RESULT_MAX=260           # 全局上限
PS_RESULT_PER_DAY=3      # 每个电竞项目「每天」最多留几场赛果
```

### 为什么赛果必须「按天采样截断」

实测过去 15 天的电竞赛果有 **778+ 场**（csgo 单项目就 400+，现已整体排除），
足球另有 81 场 —— 全量返回会把前端页面撑成无底洞，用户也看不到重点。

处理方式（`sampleResults()`）：

1. 过滤掉 `canceled` / 无比分 / `TBD vs TBD` 的场次
2. 按「**相对天 × 电竞项目**」分桶，每天每项目只留 `PS_RESULT_PER_DAY` 场
3. 桶内**知名赛事优先**（`TOP_LEAGUE_RE` 命中 LPL/LCK/Worlds/VCT/五大联赛…），再按时间新→旧

最终量级：足球 81 + 电竞 124 ≈ **205 场，均匀铺满 16 天**。
前端按日期分组、每组默认只露 6 场（可展开），所以数据量对用户是透明的。

**实测坑 1**：PandaScore 的 `past` 接口**不能加 `sort=-begin_at`** —— 会把 `begin_at` 为 `null`
的 `canceled` 场次排到最前面（一次 30 条全是取消的），真赛果全被挤掉，表现为「赛果永远是 0 场」。
默认返回顺序本身就是最近优先。

**实测坑 2**：`/matches/past` 单页上限 `per_page=100`，半个月窗口下**远远不够**
（csgo 需要翻 8 页）。必须配合 `range[begin_at]=起始,结束` + `page` 翻页，翻到「不满一页」为止。

---

## 三-B、⚠️ football-data.org 免费版的两个大坑（实测踩到）

### 坑 1：`dateFrom` / `dateTo` 参数**被忽略**

免费版（TIER_ONE）不认这两个参数。传 3 天窗口 → 返回**空数组**；不传参数 → 返回整季数据。

**正确做法**：拉整季，再在**本地**按日期过滤（`server.js` 已这么处理）。

```js
// ❌ 错误：免费版会返回 0 场
`.../matches?dateFrom=${today}&dateTo=${+5d}`
// ✅ 正确：拉全季，本地过滤
`.../matches`  → 然后 matches.filter(m => 时间在窗口内)
```

### 坑 2：限流 **10 次/分钟**，极易触发 429

一次同步要拉 8 个赛事 = 8 次请求，如果并发发出去会**瞬间打满**，后面全部返回 `429 Too Many Requests`。

**正确做法**（`server.js` 已实现）：
1. **串行**请求，不要 `Promise.all`
2. 每次请求之间**间隔 6.5 秒**（`SEND_GAP_MS`），保证 < 10 次/分钟
3. 遇到 429 做**指数退避重试**（15s / 30s / 45s）

代价是一次完整同步约 50 秒。所以**缓存必须拉长**（默认 10 分钟），不要频繁 `--refresh`。

### 坑 3：赛事 code 短，容易误伤渠道匹配

`BSA`（巴西联赛）里**含有** `SA`（意甲），如果用「关键词包含」匹配，巴西联赛会被误判成意甲。

**正确做法**：长度 ≤ 4 的短 code 走**精确匹配**，长 key 才允许包含匹配（`server.js` 的 `pickChannels` 已处理）。

---

## 三-C、关于「取到几场」

现在是国际比赛日（9 月底-10 月初），欧洲五大联赛休赛，所以足球只有 110 场左右，
**这是正常现象，不是 bug**（欧国联正好在这个窗口，由 UEFA 官方源补上，见「三-E」）。
电竞数据充足（PandaScore 过滤「对阵未定」后约 55 场），羽毛球约 120 场（见「三-H」）。

当前实测拆分（2026-10-24，半个月窗口）：

| 来源 | 赛程 | 赛果 |
|---|---|---|
| 足球（football-data.org） | 221 | 196 |
| 欧国联（UEFA 官方） | 0（本期无赛事） | 0 |
| 电竞（PandaScore） | 50 | 103 |
| 羽毛球（BWF） | 88（其中 8 张赛事级卡片） | 120 |
| **合计** | **359** | **419** |

> 欧国联只在 9/10/11 三个国际比赛窗口进行，窗口外为 0 属正常。
> 2026-09-30 那次实测是 339 / 377（足球 112、欧国联 52、电竞 55、羽毛球 120），
> 量级会随赛历波动，不必对数字本身紧张。

赛程窗口默认「今天 0 点 ~ 后 15 天」，可通过 `.env` 调整：

```ini
FB_LOOKAHEAD_DAYS=15     # 往后看几天（半个月）
FB_COMPETITIONS=PL,PD,SA,BL1,FL1,CL,BSA,ELC   # 只拉关心的联赛（减少请求数 = 同步更快）
PS_GAMES=lol,valorant,dota2   # 电竞项目（csgo 已按需求排除，见下）
PS_MAX_PER_DAY=12        # 每个电竞项目每天最多保留几场赛程
PS_MAX_PAGES=3           # 赛程翻页上限（单页 100 条）
PS_MAX_PAGES_PAST=8      # 赛果翻页上限
RESULT_LOOKBACK_DAYS=15  # 赛果往前回溯几天
RESULT_MAX=420           # 赛果全局上限（含羽毛球）

BWF_ON=1                 # 羽毛球总开关
BWF_CONCURRENCY=4        # 羽毛球赛事详情并发数（太高会触发上游限流）
BWF_MAX_TOURNAMENTS=30   # 最多看多少个赛事
BWF_MAX_MATCHES=300      # 羽毛球赛程上限（一个赛事动辄上百场，必须截断）
BWF_RESULT_MAX=120       # 羽毛球赛果的独立配额
```

> **赛程下界是「今天 0 点（本地）」而不是「N 天前」**：往前留已过去的场次没意义，
> 只会让昨天踢完的比赛混进「今天」列表（前端还得再过滤一次）。
> 「进行中」的场次单独放行 —— 电竞比赛可能昨晚开打、现在还在打。

### 为什么排除了 CS2(csgo)

PandaScore 的 csgo 数据量是其他项目的数倍：**过去 15 天 800+ 场 finished、未来 15 天 187 场**，
且绝大多数是低级别线上赛。留着它只会：① 让同步多翻 6~8 页；② 把赛果采样挤掉真正的重点赛事。
现已从 `PS_GAMES` 移除，如需恢复只需在 `.env` 加回 `csgo`。

---

## 三-D、PandaScore 侧实测发现（已处理）

| 问题 | 现象 | 处理 |
|---|---|---|
| **返回量巨大** | LoL `upcoming` 默认 167 场，CS2 更多 | 本地按日期窗口过滤 |
| **单页 100 条上限** | csgo 未来 15 天 187 条、过去 15 天 800+ 条 | `range[begin_at]` + `page` 翻页，翻到「不满一页」为止 |
| **TBD 垃圾数据** | 大量 "TBD vs TBD"（对阵未定） | 过滤掉双方都拿不到队名的场次 |
| **低级别赛事淹没页面** | 半个月过滤后仍有几百场，一天几十场没法看 | 赛程按「项目+天」截断（`PS_MAX_PER_DAY`）；赛果按「项目+天」采样（`PS_RESULT_PER_DAY`） |
| **二级联赛无渠道** | `CCT`/`United21`/`EMEA Masters` 等未覆盖 | 补进 `channels.json`，覆盖率 51% → **92%** |

**最终效果（半个月窗口）**：赛程 **339 场**铺满 D+0 ~ D+15、赛果 **377 场**铺满 D-15 ~ D+0，
无 TBD、无 CS2，足球赛事名/队名全中文。

另外做了「知名赛事优先」：同一时间段里 `LPL/LCK/VCT/Worlds/Major/IEM/ESL` 等会排在前面
（数据里带 `top: 1` 标记），赛果采样时同样优先保留这些赛事。

---

## 三-E、欧国联（UEFA Nations League）—— 数据源 3

football-data.org 免费版**拿不到欧国联**（实测 `/v4/competitions/UNL/matches` 直接返回 403），
所以单独接了一个源：**UEFA.com 自己前端在用的接口**，免费、无需注册、无需 Key。

```
# 赛程（带状态，但不含比分）
https://match.uefa.com/v5/matches?competitionId=2014&offset=0&limit=100&seasonYear=2027
# 赛果（只有加了 status=FINISHED 才返回 score 字段）
https://match.uefa.com/v5/matches?competitionId=2014&offset=0&limit=100&seasonYear=2027&status=FINISHED
```

| 参数 | 说明 |
|---|---|
| `competitionId=2014` | UEFA Nations League。这个 ID 不好猜：1=欧冠、3=欧洲杯、9=超级杯、**19=友谊赛** |
| `seasonYear=2027` | 2026-27 赛季。UEFA 用「赛季结束年」表示赛季，下赛季要改成 2029 |
| `offset` / `limit` | **两个都是必需参数**，缺一个就 404，报 `"null is not valid for offset"` |
| `status=FINISHED` | 加上才返回 `score` 字段。**不加则完全没有比分** —— 最容易踩的坑 |

整个赛季只用 **2 次请求**就拿全（赛程 156 场 + 带比分的赛果 52 场），配额毫无压力。

> 想要官方**中文队名**？在 `homeTeam.translations.displayName.ZH` 里（如「爱尔兰」）。
> 目前欧国联队名走的是 `lib/zh.js` 映射表（保证和英超/西甲那些源译名一致），
> 映射表查不到时才回退到 UEFA 官方中文。

完整方案对比与调研过程见 **`欧国联数据源调研.md`**。

---

## 三-F、足球赛事中文化（`lib/zh.js`）

**所有足球赛事的联赛名、球队名、赛制阶段都已中文化**（电竞保持英文，按需求只改足球）。

映射表在 **`lib/zh.js`**，`server.js`（本地）与 `api/matches.js`（Vercel）共用同一份，
不各写一套 —— 否则两边迟早不一致。这是**唯一需要维护的文件**，加新球队/联赛只改它。

### 三层能力

| 函数 | 作用 | 例子 |
|---|---|---|
| `zhLeague()` | 联赛名 → 中文，只匹配**开头**且长 key 优先 | `Premier League · 第 5 轮` → `英超 · 第 5 轮` |
| `zhStage()` | 赛制阶段 → 中文 | `League A` → `A级`、`GROUP_STAGE` → `小组赛` |
| `zhTeamDeep()` | 球队名 → 中文（推荐入口） | `Bayern` → `拜仁慕尼黑`、`Bayern München` → `拜仁慕尼黑` |

### 设计要点（每条都对应一个真实的坑）

1. **查表前先归一化**（`norm()`）：去重音符号 + 小写 + 去标点。
   UEFA 返回的 `Türki̇ye` 带组合上点 `U+0307`、`Málaga`、`São Paulo`、`Bodø/Glimt` ——
   不做归一化这些名字**永远查不到**。
2. **联赛名只做开头匹配 + 长 key 优先**：否则 `Championship`（英冠）会去命中
   `UEFA Champions League`（欧冠）。
3. **中文联赛名要同步加进 `TOP_LEAGUE_RE`**：`top` 标记（知名赛事优先排序）是按联赛名
   正则匹配的。联赛名改成中文后，正则里若只有英文，`top` 会**静默全部失配**，排序悄悄退化。
4. **`stripSuffix()` 必须要求后缀前有分隔符**：原写法 `/\s*(FC|CF|...|SV)$/` 会把
   `HSV` 砍成 `H`、`PSV` 砍成 `P` —— 前端直接显示「霍芬海姆 vs H」这种脏数据（已修）。
5. **必须精确匹配优先于去后缀**：`Paris FC`（巴黎足球俱乐部）和 `Paris`（巴黎圣日耳曼）
   是**两支不同球队**。先查全名的表，再退回去后缀形式，否则会张冠李戴。
6. **中文保护只判「开头」**：`/^[\u3400-\u9fff]/` 而不是整串判断 ——
   因为 `Bundesliga · 第 5 轮` 里也有中文（第/轮），整串判断会让所有联赛都漏翻。

### 映射表覆盖不到时

未收录的球队会**原样保留英文**（不猜、不误译），并在 `cache/matches.json` 里可见。
用下面两个脚本兜底排查：

```bash
node tools/test-zh.mjs      # 拿 cache 备份当测试集，算命中率、列出漏网队名
node tools/dump-teams.mjs   # 拉全部 8 个联赛的**所有**球队，一次列全缺口
```

> `dump-teams.mjs` 会真实请求上游（8 次，串行约 50 秒），且免费版限流 10 次/分钟 ——
> 刚跑完同步不要马上跑它，会 429。

---

## 三-G、零外部依赖：Tailwind 改成本地编译内联

页面原本用 `https://cdn.tailwindcss.com` —— 约 400KB 的 JS，**在浏览器里现场生成 CSS**。
国内访问它经常超时，症状是 HTML 出来了但**一点样式都没有**（白屏），看着像网站挂了。

现在改成预先编译好、把 **16KB 的 CSS 直接内联进 `index.html`**，整页零外链：

```bash
node build/tw/build.mjs     # 编译 + 内联（幂等，可重复跑）
```

- 配置：`build/tw/tailwind.config.cjs`（配色与原来 `<head>` 里的 `tailwind.config` 一致）
- 插入位置必须在页面自带 `<style>` **之后** —— CDN 是运行时注入的，天然靠后；
  顺序变了会让 `.card:hover` 这类自定义样式反过来盖掉 Tailwind
- **⚠️ 动态类名要小心**：CDN 会监听 DOM，JS 后来加的类也能生成样式；编译版只认源码文本。
  本项目动态类名都是三元里的字面量（`${on?'bg-sea-500':'bg-sea-50'}`），静态扫描抓得到；
  但如果以后写成字符串拼接（`` `bg-${c}-500` ``），样式会**静默丢失**，得补 `safelist`

验证工具（都写好了）：

```bash
node tools/dump-css.mjs        # dump CDN 真正生成的 CSS 当基线（只在没去 CDN 的版本上跑一次）
node tools/check-css.mjs       # 逐类比对：CDN 有的类，编译产物必须有（实测 195 → 213，零缺失）
node tools/verify-offline.mjs  # 掐断所有境外 CDN 后仍样式完好 + 零外域请求
```

---

## 三-H、羽毛球（BWF）—— 数据源 4

羽毛球球没有公开 API。经抓包确认，**BWF 官网前端在调自己的内部接口**，可直接访问：
免费、零 Key、零注册。

```
https://extranet-lv.bwfbadminton.com/api/vue-tournaments-search   # 按日期区间列赛事
https://extranet-lv.bwfbadminton.com/api/tournaments/day-matches  # 某赛事某天的对阵（结构最干净）
https://extranet-lv.bwfbadminton.com/api/vue-tournament-matches   # 某赛事全部对阵（含比分）
```

| 坑 | 说明 |
|---|---|
| ⚠️ **必须走 `curl` 子进程** | Cloudflare 按 **TLS 指纹**拦截：Node 的 `fetch` / `node:https` **一律 403**（正文是「Attention Required!」）。加全套浏览器头、加 Referer 都无效；冷却后 curl 200 而 Node 仍 403。→ `execFile('curl', …)` |
| ⚠️ **不要加 `--compressed`** | Windows 自带 curl 8.0.1(Schannel) 不支持该选项，会直接报错退出 |
| **短时 IP 限流** | 连刷几十次后 403，**冷却 30~60 秒自愈**。同步时并发 4、限速 ~1.2s/次 |
| **时间只精确到天** | `start_time` 是当天 00:00 UTC，**具体时刻只在 `oop_text` 文本里**（还是场馆当地时间、无时区）。所以赛程卡统一显示「待定」，把当地时间塞进详情 |
| **抽签未出** | 未来赛事大多返回 `{"results":null}`（不是报错）。这些降级成「赛事级卡片」：只有赛事名 + 日期 + 地点，**无对手**（前端不显示 `vs`） |
| **两套 ID 别混** | `tmtId`（数字，`vue-*` 用）与 `tournamentCode`（UUID，`/api/tournaments/*` 用），都从列表接口取 |
| **没有中文球员名** | 不像 UEFA 有 `displayName.ZH`。要中文球员名只能自建映射表（**本次未做**） |
| 只覆盖 BWF 体系 | 国内羽超联赛这类没有 |

已过滤掉 Junior / Youth / U19 / Veteran / Future Series / **AirBadminton** / Cancelled 之类的赛事。
赛事级别、单项、轮次都做了中文化（如 `Super 500` → `世界巡回赛 Super 500`、`男双`、`资格赛64强`）。

完整调研见 **`羽毛球数据源调研.md`**，抓包工具 `tools/capture-bwf.mjs` / `tools/probe-bwf.mjs`。

---

## 三-I、直播源（免费公开信号）—— 数据源 5

`channels.json` 解决「哪个平台有转播」，这一层解决「点了就能看」。
频道目录在 `lib/stream.js` 的 `CHANNELS`（单一数据源，本地与线上共用），三种播放方式：

| kind | 覆盖频道 | 说明 |
|---|---|---|
| `hls` | CCTV-5 / CCTV-5+ / CCTV-16 / 风云足球 / 山东体育 / 江苏体育 / Red Bull TV | 公开 m3u8，**必须走同源代理** |
| `twitch` | Riot Games / VALORANT / DOTA2 官方频道 | `player.twitch.tv` 内嵌，免 Key，需要 `parent` 参数 |
| `page` | BWF TV（YouTube）等 | 只能外链，不硬嵌，避免白框 |

### 为什么非要自己代理 m3u8

两个致命问题会同时出现，缺一个都放不出来：

1. **CORS**：这些源几乎不会返回 `Access-Control-Allow-Origin`，浏览器 `fetch` 直接被拦；
2. **混合内容**：多数还是 `http://`，在 https 页面里被浏览器直接拒绝加载。

所以播放地址一律指向 `/api/stream?c=<channelId>`：服务端取流 → 把清单里所有分片地址
重写成同源代理地址 → 再吐给播放器。子资源用 `?u=<base64url>&s=<sha1>` 签名，
签名不对就 403，避免这个端点被当成任意 URL 转发器（SSRF）。

### 健康探测与降级

公开源极不稳定（限流 / 换 IP / 换签名 token），所以**不写死可用性**：

- 每个频道串行试镜像，取前 1KB 判断是不是 `#EXTM3U`；
- 探测**成功缓存 3 分钟，失败只缓存 25 秒** —— 同步期间网络被占满时会出现「全部超时」的假象，
  缓存久了就会把好源误判成挂掉；
- 播放时如果探测选中的镜像失败，会**继续试其它镜像**，而不是直接报错；
- 前端只给探测通过的频道点亮绿点，全挂就降级成「打开官方页」。

### 播放器

`assets/hls.light.min.js`（约 290KB，**同源**，不走 CDN，符合「零外部依赖」）。
Chrome / Edge 不支持原生 HLS，hls.js 是唯一可行方案；Safari 走原生解码。

> ⚠️ 转分片时必须给 Readable 挂 `error` 监听：
> 上游断流或用户关掉页面会让它 `emit('error')`，没有监听器就是 uncaughtException，
> **整个 node 进程直接退出**（踩过，服务当场挂掉）。

> 版权：这些是各频道公开播出的信号，仅作「在哪看」的导航；页面同时给出官方入口，
> 播放不了时以官方页为准。

---

## 四、部署到 Vercel

1. 把整个 `观赛预告/` 目录推到 GitHub 仓库（**注意要包含 `lib/zh.js`**，见下）
2. Vercel 导入该仓库（框架选 **Other**，不需要 build 命令）
3. 在 **Settings → Environment Variables** 加变量：
   - `FOOTBALL_DATA_KEY`、`PANDASCORE_KEY`（必需）
   - `FB_COMPETITIONS`（建议显式配，否则线上比本地少两个联赛）
4. 部署完成，访问 `https://你的域名/api/matches` 验证接口通了
5. **前端不用改** —— `index.html` 在 http/https 下一律走**同域相对路径** `/api/matches`，
   Vercel 线上和本地 `server.js` 都零配置；只有「双击文件用 file:// 打开」才会指向 `localhost:8787`。

> ⚠️ **中文化（`lib/zh.js`）和欧国联都只在函数层生效。**
> 只更新 `index.html` 是**不会**让足球变中文的 —— 必须把函数层一起传上去并 **Redeploy**。

判断线上到底跑的是哪一版：看 Hero 徽章结尾的 `接口 xxx`，或打开 `/api/selfcheck` 看 `build` 字段。
显示「接口未报版本·疑旧版」= 线上还是旧函数。（页面会在这种情况弹提示横幅，不需要自己去猜。）

> 万一将来接口换了域名，再在 `<head>` 里加一行
> `<script>window.__API_BASE__ = 'https://...'</script>` 覆盖即可。

**记得把 `channels.json`、`lib/`（`zh.js` + `stream.js`）和 `assets/` 一起提交**，Serverless 函数要读前两者，播放器是静态文件。

部署后应该存在 4 个端点：

| 端点 | 作用 |
|---|---|
| `/api/matches` | 赛程 + 赛果 |
| `/api/selfcheck` | 函数层版本与配置自检 |
| `/api/streams` | 直播源目录 + 可用性探测 |
| `/api/stream?c=cctv5` | 直播流同源代理（含分片重写） |

> 直播源的探测在 **Vercel（海外）** 上跑，国内地方台大多会判成不可用（geo-block），
> 线上建议只用它做「目录」，实际可用性以本地 `server.js` 为准。
> `vercel.json` 已给 4 个函数都写上 `includeFiles: lib/**`，新增函数别忘了同步加。

**环境变量除两个 Key 外，建议同时加上 `PS_GAMES=lol,valorant,dota2`** ——
否则 Vercel 侧会沿用旧值把已排除的 CS2 拉回来（旧值或未配置时走代码默认，现已默认不含 csgo）。

---

## 五、渠道映射表（channels.json）—— 这部分没有 API

**所有体育数据源都不提供「哪里能看」的直播渠道信息**，而这是你 PRD 里的差异化核心。只能人工维护：

```json
{
  "Premier League": [
    { "n": "咪咕视频", "free": 1 },
    { "n": "爱奇艺体育", "free": 0 }
  ]
}
```

- **key** = 赛事名关键词。赛程返回的联赛名**包含**这个 key 就命中（所以 `LPL`、`LCK` 这类短词很好用）
- **free: 1** = 免费（绿色徽章），**0** = 付费（蓝色徽章）
- 改这个文件 **不用改代码**，改完重启服务即可

> ⚠️ **key 一律用英文原名**（`Premier League`、`UEFA Nations League`），**不要改成中文**。
> 渠道匹配发生在中文化**之前**：代码里传给 `pickChannels()` 的是上游返回的英文
> `competition.name`，中文化只作用于最后展示给用户的那个字段。
> 把 key 写成「英超」会导致**一条渠道都匹配不上**。

版权归属会变（比如某赛季英超换了转播方），建议每赛季初检查一次。

---

## 六、已知限制（重要）

### 1. 免费源没有赛前情报
`info`（近期战绩、交锋记录、伤停、首发）在免费档全部拿不到。页面已经做了优雅降级 —— 点开情报卡会显示「该场次暂无赛前情报数据」，不会报错。

要这个数据，需升级 **API-Football Pro（$19/月）**，它有 `/fixtures` 的 `lineups`、`injuries`、`statistics` 端点，覆盖 1200+ 联赛含中超。

### 2. 羽毛球：能拿到赛程/赛果，但拿不到「开赛时刻」和中文球员名
已接入 BWF 内部接口（见「三-H」），所以**不再需要人工录入**。但有两处天生拿不到：

- **开赛时刻**：接口只给到天（当天 00:00 UTC），具体时间仅在 `oop_text` 文本里。
  → 赛程卡显示「待定」，场馆当地时间放在详情里，**不做假时刻**（否则会把 00:00 UTC 显示成北京时间 08:00，误导人）
- **中文球员名**：接口里没有（不像 UEFA 有 `displayName.ZH`）→ 球员名仍是英文，要中文得自建映射表
- 未来赛事大多数**抽签还没出**，只能给「赛事名 + 日期 + 地点」的赛事级卡片

### 3. 中超不在 football-data.org 里
免费版 12 项赛事不含中超/亚冠。要国内赛事得走 **纳米数据** 等国内服务商（中文文档、有试用），商业化阶段再上。

### 4. 「去观赛」按钮还不能真跳转
各大平台没有开放直播深链。目前是 toast 提示。要真跳转只能跳到平台首页/搜索页，或者攒一批固定直播间的 URL 人工映射。

### 5. 昨日赛果还是本地数据
`RESULTS` 数组仍是写死的。要接真实赛果，需要在代理层加一个 `/api/results`（football-data.org 的 `status=FINISHED` 查询）。

---

## 七、成本核算

| 源 | 拉取频率 | 日请求数 | 免费额度 | 够不够 |
|---|---|---|---|---|
| football-data.org | 10 分钟 1 次（缓存） | ~144 | 10/分钟 | ✅ 绰绰有余 |
| PandaScore | 10 分钟 1 次 × 4 游戏 | ~576 | 1000/小时 | ✅ 绰绰有余 |
| UEFA 官方 | 10 分钟 1 次 × 2 | ~288 | 无公开限额 | ✅ |
| BWF 内部 | 10 分钟 1 次 × ~25（并发 4） | ~3600 | 无，但**有短时限流** | ⚠️ 靠 30~60s 冷却自愈 |

> BWF 是唯一需要留意的：连刷太猛会 403，冷却 30~60 秒自动恢复。
> 并发已限在 `BWF_CONCURRENCY=4`，缓存 10 分钟一次，正常使用不会触发。

核心原则：**宁可拉长缓存（赛程 10-30 分钟足够新），也不让用户请求直接打到上游。**

---

## 八、下一步建议

1. **本周**：注册两个 key → 本地跑通 → 部署 Vercel → 前端指向线上接口
2. **补渠道表**：把你现在 mock 里那批赛事（英超/西甲/中超/LPL/LCK/CS2/TI/中国公开赛）的渠道录进 `channels.json`
3. **加小程序/App**：如果要做移动端，代理层可以原样复用
4. **数据够了再付费**：用户量起来、确实需要情报卡和比分直播时，再上 API-Football Pro

---

## 九、合规红线

- ❌ **不要爬**懂球帝/直播吧/咪咕/虎牙的接口做产品 —— ToS 明确禁止，且会封 IP
- ⚠️ Sofascore 的非公开端点在社区流传很广，但**无条款保障，只能个人原型，不能商用**
- ⚠️ PandaScore 的 stats 计划禁止博彩用途
- ✅ 正式上线前，把各家 ToS 的「redistribution / 展示」条款看一遍
