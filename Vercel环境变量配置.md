# Vercel 环境变量配置（海风看球 · 赛程数据）

> ⚠️ 本文件含**明文 API Key**。配置完成后请删掉，或至少不要上传到 Vercel、
> 不要提交到 git、**不要放进要拖上去部署的文件夹**（Vercel 会把里面所有文件当公开静态资源）。

---

## 一、要配什么（最少 2 个）

### 必配（缺了函数就取不到任何数据）

| 变量名 | 值 | 类型 | 勾选的环境 |
|---|---|---|---|
| `FOOTBALL_DATA_KEY` | `2fc0d93ac1c94f94bbc9f90ed5375204` | Secret | Production + Preview + Development |
| `PANDASCORE_KEY` | `2HpeoWA0uJSk6VeDrhyXVzg0kf8PqUr3370WRJZF6UN5TFN4wQ0` | Secret | 同上 |

> `FOOTBALL_DATA_KEY` 这个值刚在本机实测有效（拉回 112 场足球赛程）；
> 如果你手上还有另一个 football key，以这个为准。

### 建议加（让足球多拉 2 个联赛）

| 变量名 | 值 | 类型 |
|---|---|---|
| `FB_COMPETITIONS` | `PL,PD,SA,BL1,FL1,CL,BSA,ELC` | Config |

代码默认只拉 6 个联赛（`PL,PD,SA,BL1,FL1,CL`），配成 8 个能多拿到巴西联赛的数据。
注意免费版限流是 **10 次/分钟**，8 个联赛刚好安全，**不要再加**。

### 不用配（代码默认值已经一致）

`FB_LOOKAHEAD_DAYS=15`、`RESULT_LOOKBACK_DAYS=15`、`RESULT_MAX=420`、
`PS_GAMES=lol,valorant,dota2`、`PS_MAX_PER_DAY=12`、`PS_RESULT_PER_DAY=3`、
`PS_MAX_PAGES=3`、`PS_MAX_PAGES_PAST=8`、
`BWF_ON=1`、`BWF_CONCURRENCY=4`、`BWF_MAX_TOURNAMENTS=30`、`BWF_MAX_MATCHES=300`、
`BWF_RESULT_MAX=120` —— 这些**线上不配也是这个值**。
（`CACHE_TTL_MS` / `PORT` 只对本地 `server.js` 有意义，线上用 CDN 缓存，不用管。）

> `RESULT_MAX` 已从 260 提到 **420**：羽毛球赛果单独设了 `BWF_RESULT_MAX=120` 的配额，
> 但足球（112）+ 电竞（124）+ 欧国联（52）+ 羽毛球（120）合计约 400 场，260 会把足球挤掉。

> 唯一要留意 `PS_GAMES`：代码默认已经排除了 CS2。但如果你**以前在 Vercel 后台设过一个旧值**
> （里面含 `csgo`），那个旧值会覆盖默认，需要改成 `lol,valorant,dota2`。

### ⚠️ 羽毛球（BWF）依赖系统 `curl`，不需要 Key 但要留意

BWF 内部接口有 Cloudflare **TLS 指纹拦截**：Node 自带的 `fetch` / `node:https` 一律 403，
只能 `execFile('curl', …)` 绕过去。所以：

- **不需要任何环境变量**（零 Key、零注册），`BWF_ON` 默认就是开
- 但函数运行环境里**必须有 `curl` 可执行文件** —— Vercel 的 Amazon Linux 一般自带，
  若某天报 `sources.bwf_error: "no-curl"`，就是这个原因（临时关掉用 `BWF_ON=0`）
- 想临时关掉羽毛球：加 `BWF_ON=0` 再 Redeploy
- `bwf_error` 出现 `rate_limited` 是**上游短时限流**（冷却 30~60 秒自愈），不是配置问题；
  出现 `timeout` 说明这一轮 25 秒内没拉完，已按「先放弃、别拖死整个接口」处理，
  只是羽毛球段落为空，足球/电竞不受影响

---

## 二、网页配置（最直观，推荐）

1. 打开 <https://vercel.com/dashboard>
2. 点进你的项目（名字类似 `watch-schedule`）
3. 顶部菜单 **Settings** → 左侧 **Environment Variables**
4. 在输入区填：
   - **Key**：`FOOTBALL_DATA_KEY`
   - **Value**：粘贴上面表格里的值
   - **Environments**：`Production`、`Preview`、`Development` **三个都勾**
   - 类型选 **Secret**（保存后不可再读取，更安全）
5. 点 **Save**，然后同样方式加 `PANDASCORE_KEY`（和 `FB_COMPETITIONS` 如果要用）

粘贴小提示：**不要带引号、不要带空格或换行** —— Vercel 会原样存进去，
多一个空格就会变成无效 Key，而报错信息会误导你以为 Key 本身是坏的。

---

## 三、命令行配置（快一些）

```bash
npm i -g vercel
cd "D:/桌面/飞书下载/观赛预告"
vercel login
vercel link                      # 首次：关联到已有项目（选已有项目，不要新建）

# 逐个加：回车后会提示你粘贴值，粘贴完再回车
vercel env add FOOTBALL_DATA_KEY production
vercel env add FOOTBALL_DATA_KEY preview
vercel env add FOOTBALL_DATA_KEY development
vercel env add PANDASCORE_KEY production
vercel env add PANDASCORE_KEY preview
vercel env add PANDASCORE_KEY development

vercel env ls                    # 核对是否都加上了
vercel --prod                    # 重新部署
```

> 用管道也行（Git Bash）：`printf '%s' '你的key' | vercel env add FOOTBALL_DATA_KEY production`
> —— 用 `printf` 而不是 `echo`，`echo` 会多带一个换行符。

---

## 四、配完必须重新部署 ⭐ 最容易漏的一步

Vercel 官方文档原话：**「对环境变量的任何修改都不会应用到已有的部署，只对新部署生效。」**

环境变量是**构建时**注入函数的字节码里的，所以：

**Deployments 标签 → 找到最上面那条 → 右侧「⋯」→ Redeploy → 确认**

（弹窗里的 `Use existing Build Cache` 可以取消勾选，让构建更干净。）

**只保存环境变量、不重新部署 = 完全没生效。** 这是「配了 Key 还是显示演示数据」的头号原因。

---

## 五、怎么确认配好了

浏览器打开 `https://你的域名/api/matches`，看返回里的 `sources`：

```json
"sources": {
  "build": "zh-bwf-20260930b",
  "football": 112,
  "esports": 55,
  "uefa_nations_league": 52,
  "badminton": 120,
  "badminton_pending": 12,
  "results": 377,
  "keys": { "football": true, "esports": true },
  "bwf_error": null
}
```

| 字段 | 含义 |
|---|---|
| `build` | **函数版本号**。缺失 / 明显偏旧 = 部署包不是最新的（前端 Hero 徽章也会提示「接口未报版本·疑旧版」） |
| `uefa_nations_league` | 欧国联场次（UEFA 官方接口，免费无需 Key）。**8/9 月淡季为 0 是正常的** |
| `badminton` | 羽毛球赛程场次（BWF 内部接口，免费无需 Key） |
| `badminton_pending` | 其中「抽签未出、只给赛事名+日期」的赛事级卡片数 |
| `bwf_error` | `null` = 羽毛球正常；`no-curl` / `rate_limited` / `timeout` / `partial-fail` = 该轮没取全 |

| 看到什么 | 含义 |
|---|---|
| `missing_keys: []` 或 `keys` 两项都 `true` | 两个 Key 都配好了 ✅ |
| `missing_keys: ["FOOTBALL_DATA_KEY"]` | 这个变量没配上，或**配上但没 Redeploy** |
| `football: 0` 且 `football_rate_limited > 0` | 被限流了（不是 Key 的问题），等 1 分钟再刷新 |
| `channels_table: "fallback"` | `channels.json` 没随函数打包，用了内置兜底表（不影响赛事数据） |

也可以直接跑一条命令体检：

```bash
node tools/diagnose-online.mjs 你的域名.vercel.app
```

---

## 六、常见坑

| 现象 | 原因 |
|---|---|
| 配完还是演示数据 | **没 Redeploy**（最常见）；或只勾了 Production，而你看的是 Preview 域名 |
| Key 明明是对的却不生效 | 粘贴时混进了引号 / 空格 / 换行 |
| 刚换的 Key 没立刻生效 | CDN 缓存 10 分钟，刷新几次或等等 |
| 足球场次偏少 | 免费版限流 10 次/分钟 —— 是限流不是 Key 问题（看 `football_rate_limited`） |
| 删了变量但还在用 | 同样要 Redeploy 才停用 |

---

## 七、直播源：**不需要任何环境变量**

2026-10 新增的 `/api/streams`、`/api/stream` 两个函数，以及 `lib/stream.js` 里的频道目录，
**全部零 Key、零注册**，不用在 Vercel 后台加任何变量：

| 端点 | 依赖 |
|---|---|
| `/api/streams` | 无。频道目录写死在 `lib/stream.js`，服务端自己探活 |
| `/api/stream?c=xxx` | 无。同源代理，上游地址也来自那份目录 |

唯一要保证的是：**`lib/stream.js` 要跟着提交进仓库**（`vercel.json` 已声明 `includeFiles: "lib/**"`），
以及 `assets/hls.light.min.js` 这个静态播放器文件在仓库里存在。

> 线上探测全部 `playable:false` 是正常的 —— Vercel 跑在海外，国内地方台几乎全 geo-block。
> 想看准不准，用本机 `node server.js` 打 `http://localhost:8787/api/streams`。
