/**
 * 海风看球 · 赛程数据代理层
 * ------------------------------------------------------------
 * 作用：把 football-data.org（足球）与 PandaScore（电竞）的原始数据，
 *       归一化成前端页面直接可用的 schema，并带缓存。
 *
 * 为什么必须有这一层：
 *   1. API Key 必须留在服务端 —— 前端直连等于把 Key 公开出去
 *   2. 浏览器直连第三方 API 会被 CORS 拦（PandaScore 尤其严格）
 *   3. 免费额度按「拉取次数」算，缓存后所有用户共享一次拉取，不会被打爆
 *
 * 运行：node server.js
 * 依赖：无（Node 18+ 自带 fetch）
 */

import http from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
// 羽毛球（BWF）必须走 curl 子进程取数 —— Node 的 fetch/https 会被 Cloudflare 按 TLS 指纹 403
import { execFile } from 'node:child_process';
// 足球赛事中文化：联赛名 / 球队名 / 赛制阶段（映射表见 lib/zh.js，与 api/matches.js 共用同一份）
import { zhLeague, zhTeam, zhTeamDeep, zhStage } from './lib/zh.js';
import { listChannels, serveStream } from './lib/stream.js';

// 版本标记（与 api/matches.js 保持同一个值）—— 本地/线上同名字段，肉眼对一下就知谁是旧版
// bwf = 已接入羽毛球（BWF）数据源
const BUILD = 'zh-bwf-20260930b';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, 'cache');
const CACHE_FILE = join(CACHE_DIR, 'matches.json');
const CHANNEL_FILE = join(__dirname, 'channels.json');
const ENV_FILE = join(__dirname, '.env');

// ============ 读取 .env（无需任何依赖，自己解析）============
// 优先级：真实环境变量 > .env 文件
function loadDotEnv() {
  if (!existsSync(ENV_FILE)) return;
  try {
    for (const line of readFileSync(ENV_FILE, 'utf-8').split(/\r?\n/)) {
      const s = line.trim();
      if (!s || s.startsWith('#')) continue;
      const eq = s.indexOf('=');
      if (eq < 0) continue;
      const k = s.slice(0, eq).trim();
      let v = s.slice(eq + 1).trim();
      // 去掉可能包裹的引号
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (!(k in process.env)) process.env[k] = v;
    }
    console.log('[env] 已加载 .env');
  } catch (e) {
    console.warn('[env] .env 解析失败:', e.message);
  }
}
loadDotEnv();

// ============ 配置 ============
const PORT = process.env.PORT || 8787;
const FB_KEY = process.env.FOOTBALL_DATA_KEY || '';   // football-data.org
const PS_KEY = process.env.PANDASCORE_KEY || '';      // pandascore.co
const TTL = Number(process.env.CACHE_TTL_MS || 10 * 60 * 1000); // 缓存 10 分钟

// 要拉的足球赛事
// ⚠️ 免费版限流极严：**每分钟 10 次请求**。所以赛事数不要超过 8 个，
//    并且必须串行 + 间隔发送（见 SEND_GAP_MS），否则会 429。
const FB_COMPETITIONS = (process.env.FB_COMPETITIONS || 'PL,PD,SA,BL1,FL1,CL,BSA,ELC')
  .split(',').map(s => s.trim()).filter(Boolean);
// 要拉的电竞项目（PandaScore 限流宽松，每小时 1000 次，可放开）
// ⚠️ 不含 csgo：CS2 半个月窗口下 past 有 800+ 场，且多为低级别线上赛，按需求排除
const PS_GAMES = (process.env.PS_GAMES || 'lol,valorant,dota2')
  .split(',').map(s => s.trim()).filter(Boolean);

// 免费版限流保护参数
const SEND_GAP_MS = Number(process.env.SEND_GAP_MS || 6500);  // 每次请求间隔 6.5s（<10次/分钟）

// ============ 数据源 3：UEFA 官方接口（免费、无需注册、无需 Key）============
// 用途：补 football-data.org 免费版拿不到的赛事 —— 目前是欧国联（UEFA Nations League）。
// 这是 UEFA.com 自己前端在用的接口，实测可直接访问。
// ⚠️ 三个实测要点（都踩过）：
//   1. `offset` 和 `limit` 是**必需参数**，缺任一个都直接 404，
//      报错是 `{"message":"null is not valid for offset"}` —— 极易被误判成「接口不存在」。
//   2. 不加 `status=FINISHED` 时**返回体里根本没有 `score` 字段**，
//      只有带这个参数才返回比分 → 赛果必须单独拉一次，不能复用赛程列表。
//   3. `seasonYear` 有效，UEFA 用的是「赛季结束年」：2026-27 赛季 = **2027**。
const UEFA_API = 'https://match.uefa.com/v5/matches';
const UEFA_COMP_ID = process.env.UEFA_COMP_ID || '2014';        // 2014 = UEFA Nations League
const UEFA_SEASON = Number(process.env.UEFA_SEASON || 2027);    // 2027 = 2026-27 赛季
const UEFA_PAGE = 100;                                          // 单页条数
const UEFA_MAX_PAGES = Number(process.env.UEFA_MAX_PAGES || 3); // 翻页上限（该赛季 156 场，2 页足矣）
// 本次同步里 UEFA 官方接口的失败原因（null = 正常）。
// ⚠️ 欧国联只在国际比赛窗口才有比赛，「0 场」既可能是窗口内真没有、也可能是接口挂了 ——
//    不区分就只能靠猜（和 bwf_error 同一个理由）。
let uefaErr = null;

// ============ 数据源 4：BWF 官方内部接口（羽毛球）============
// BWF 从没发布过开发者 API（官网明说没有），但这套是它自己前端在调的：
//   https://extranet-lv.bwfbadminton.com/api/*
// 零 Key、零注册，只要带官网 Referer。接口清单是从 bwfbadminton.com 页面
// 内联的 Vue 代码里读出来的（抓包脚本 tools/capture-bwf.mjs，改版时重扒即可）。
//
// ⚠️ 三个实测坑（都踩过，详见 tools/probe-bwf.mjs 头部注释）：
//   1. **必须走 curl**：Cloudflare 按 TLS 指纹拦截 —— 同一 URL、同一套请求头，
//      curl(Windows Schannel) 200 / Node fetch(OpenSSL) 一律 403「Attention Required!」。
//      补齐 sec-ch-ua / Sec-Fetch-* 全无效，冷却后 Node 仍 403 = 指纹级，改头绕不过去。
//   2. 有**短时 IP 限流**（连刷几十次 → 403，冷却 30~60 秒自愈）。
//      实测并发 4 连拉 41 个赛事：零失败、墙钟 23.5s → 这个并发度是安全的。
//   3. 未来赛事在**抽签公布前** `by_court` 为 null（是 `results:null`，不是报错）。
//      这类赛事降级成「赛事级卡片」：只有赛事名 + 日期 + 地点。
//      实测同一天：已开赛 117 场 / +7 天 84 场 / +6 天 0 场 / +13 天 0 场。
const BWF_API = process.env.BWF_API || 'https://extranet-lv.bwfbadminton.com/api';
const BWF_ON = String(process.env.BWF_ON || '1') !== '0';
const BWF_CONCURRENCY = Number(process.env.BWF_CONCURRENCY || 5);           // 并发度（实测 4~5 安全）
const BWF_MAX_TOURNAMENTS = Number(process.env.BWF_MAX_TOURNAMENTS || 30);  // 单次最多拉几个赛事
const BWF_MAX_MATCHES = Number(process.env.BWF_MAX_MATCHES || 300);         // 窗口内场次上限，防页面被填满
// ⚠️ 赛果要**单独**设上限：过去半月的羽毛球实测 989 场，共用一个 RESULT_MAX 会把足球/电竞挤没
//    （320 的池子里羽毛球占 300，足球只剩 20 场）。这里按「赛事级别优先 → 时间倒序」取前 N。
const BWF_RESULT_MAX = Number(process.env.BWF_RESULT_MAX || 120);
// 羽毛球是整个同步里最慢的一环（要拉二十多个赛事的对阵）。给它单独设个截止时间：
// 超时就当这个源没数据，别把整个接口一起拖死（本地没有函数超时，给得宽裕些）。
const BWF_DEADLINE_MS = Number(process.env.BWF_DEADLINE_MS || 60000);
const BWF_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
// 低价值赛事过滤：青少年组 / 未来系列 / AirBadminton（非标准羽毛球，是户外玩法）/ 已取消
const BWF_SKIP_RE = new RegExp(process.env.BWF_SKIP_RE ||
  'Junior|Youth|U1[0-9]|U2[0-9]|Veteran|Future Series|AirBadminton|Cancelled', 'i');
// 白名单优先于上面：这些名字里可能带 Junior 等词，但确实有关注度
const BWF_KEEP_RE = /World Junior|World Championships|Asian Games|Olympic|Thomas Cup|Uber Cup|Sudirman|Super (1000|750|500|300|100)|World Tour|Continental Championships/i;
// 赞助商前缀（赛事名拿去当「联赛名」用，带着赞助商太长）
const BWF_PREFIX_RE = /^(?:VICTOR|YONEX|LI-NING|LI NING|HSBC|TOYOTA|DAIHATSU|ALLIANZ|NAVEK|ROKETTO|CLASH OF CLAHS|CLASH OF CLANS|BARFOOT|PETRONAS|MITSUBISHI|DAIKIN|KIA|PIONEER|SATHIO|PERODUA|CELCOM|AIRASIA|CLASH)\s+/i;

// 赛事级别 → 中文（枚举值翻译，成本极低；与「球员名中文化」是两回事）
const BWF_CAT = {
  'International Challenge': '国际挑战赛',
  'International Series': '国际系列赛',
  'Future Series': '未来系列赛',
  'Junior International Series': '青年国际系列赛',
  'Junior Future Series': '青年未来系列赛',
  'BWF Tour Super 100': '世界巡回赛 Super 100',
  'HSBC BWF World Tour Super 300': '世界巡回赛 Super 300',
  'HSBC BWF World Tour Super 500': '世界巡回赛 Super 500',
  'HSBC BWF World Tour Super 750': '世界巡回赛 Super 750',
  'HSBC BWF World Tour Super 1000': '世界巡回赛 Super 1000',
  'Multi-Sport Games': '综合运动会',
  'Multi-Sport Games - Team Tournaments': '综合运动会 · 团体',
  'Grade 1 – Individual Junior Tournaments': '世青赛 · 单项',
  'Grade 1 – Junior Team Tournaments': '世青赛 · 团体',
  'Continental Championships': '洲际锦标赛',
};
const bwfCat = (c) => BWF_CAT[String(c || '').trim()] || String(c || '').trim() || '世界羽联巡回赛';
// 高关注度赛事 → 排同一时间段前面（Super 300 及以下不算「知名」）
const BWF_TOP_RE = /Super (1000|750|500)|World Championships|Asian Games|Olympic|Thomas Cup|Uber Cup|Sudirman/i;


// ============ 时间窗口（半个月：过去 15 天 ～ 未来 15 天）============
// 赛程下界固定为「今天 0 点（本地）」，由各 fetch 函数内部计算，不再需要配置项
const FB_LOOKAHEAD_DAYS = Number(process.env.FB_LOOKAHEAD_DAYS || 15); // 赛程往后看几天
const RESULT_LOOKBACK_DAYS = Number(process.env.RESULT_LOOKBACK_DAYS || 15); // 赛果往前回溯几天
const RESULT_MAX = Number(process.env.RESULT_MAX || 420);                    // 赛果总量上限

// PandaScore 翻页参数
// ⚠️ 单页上限 100 条，半个月窗口必然溢出：
//    实测 csgo 未来 15 天 187 条（需 2 页）、过去 15 天 800+ 条。不翻页会丢掉后面几天。
const PS_MAX_PAGES = Number(process.env.PS_MAX_PAGES || 3);              // 赛程翻页上限
const PS_MAX_PAGES_PAST = Number(process.env.PS_MAX_PAGES_PAST || 8);    // 赛果翻页上限

// 知名赛事优先级：同一时间段里，让用户更可能想看的比赛排在前面；
// 赛果采样时也优先保留知名赛事，避免半个月的时间轴被低级别预选赛填满
// ⚠️ 足球联赛名已全部中文化（见 lib/zh.js），所以这里**必须同时列出中文别名**，
//    否则 top 标记会全部失配，知名赛事优先排序会静默失效。
const TOP_LEAGUE_RE = /LPL|LCK|LEC|LCS|EMEA Masters|Worlds|MSI|VCT|Champions|Major|The International|BLAST|IEM|ESL|英超|英冠|西甲|意甲|德甲|法甲|欧冠|欧联杯|欧协联|巴甲|欧国联|中超|Premier League|Champions League|Serie A|Bundesliga|Ligue 1|Primera|Brasileiro|Nations League/i;

if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });

// ============ 观赛渠道映射（无 API，人工维护，见 channels.json）============
let CHANNELS = {};
function loadChannels() {
  try {
    CHANNELS = JSON.parse(readFileSync(CHANNEL_FILE, 'utf-8'));
  } catch {
    console.warn('[warn] 未找到 channels.json，渠道列将为空');
    CHANNELS = {};
  }
}

/** 按赛事名匹配渠道：支持精确匹配 + 关键词包含匹配
 *  ⚠️ 防误伤：长度 <= 4 的 key（多为联赛 code，如 SA/CL/PD）只做**精确匹配**，
 *     否则 'BSA'.includes('SA') 会把巴西联赛误判成意甲。长 key 才允许包含匹配。 */
function pickChannels(keys) {
  const out = [];
  const seen = new Set();
  for (const key of keys.filter(Boolean)) {
    for (const [pattern, list] of Object.entries(CHANNELS)) {
      if (pattern.startsWith('_')) continue; // _comment 之类的元字段
      const isShortCode = pattern.length <= 4;
      const hit = isShortCode ? key === pattern : (key === pattern || key.includes(pattern));
      if (!hit) continue;
      for (const ch of list) {
        if (!seen.has(ch.n)) { seen.add(ch.n); out.push(ch); }
      }
    }
  }
  return out;
}

// ============ 工具 ============
const isoDate = (d) => d.toISOString().slice(0, 10);
const dayOffset = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return isoDate(d); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// ⚠️ 足球球队名/联赛名/赛制的中文化统一走 lib/zh.js（zhTeamDeep / zhLeague / zhStage），
//    与 api/matches.js 共用同一份映射表 —— 这里不再自己写 short() 之类的缩短逻辑。

// ============ 数据源 1：football-data.org ============
// ⚠️ 免费版两个大坑（都已处理）：
//   1. dateFrom/dateTo 参数被忽略 → 只能拉整季，本地按日期过滤
//   2. 限流 10 次/分钟 → 必须串行 + 间隔发送，并处理 429
async function fetchFootball() {
  if (!FB_KEY) { console.warn('[skip] 未配置 FOOTBALL_DATA_KEY'); return { upcoming: [], results: [] }; }
  const out = [];        // 未开赛 / 进行中
  const results = [];    // 已结束 → 赛果
  const now = Date.now();
  // 赛程下界 = 今天 0 点（本地）。往前不留：否则昨天踢完的比赛会混进「今天」列表，
  // 前端还得再过滤一次（前端的 normalize 里确实有这么一道兜底）。
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const lo = dayStart.getTime();
  const hi = now + FB_LOOKAHEAD_DAYS * 86400000;
  const resLo = now - RESULT_LOOKBACK_DAYS * 86400000;

  for (let i = 0; i < FB_COMPETITIONS.length; i++) {
    const comp = FB_COMPETITIONS[i];
    // 限流保护：请求之间强制间隔，保证不超 10 次/分钟
    if (i > 0) await sleep(SEND_GAP_MS);

    let ok = false;
    for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
      try {
        const url = `https://api.football-data.org/v4/competitions/${comp}/matches`;
        const res = await fetch(url, { headers: { 'X-Auth-Token': FB_KEY } });

        if (res.status === 429) {
          const wait = attempt * 15000;
          console.warn(`[fb] ${comp} 429 限流，等 ${wait / 1000}s 重试 (${attempt}/3)`);
          await sleep(wait);
          continue;
        }
        if (!res.ok) { console.warn(`[fb] ${comp} HTTP ${res.status}`); break; }

        const { matches = [] } = await res.json();
        let hit = 0, done = 0;
        for (const m of matches) {
          const ts = new Date(m.utcDate).getTime();
          const compName = m.competition?.name || comp;   // 保留英文原名：渠道映射（channels.json）按英文 key 匹配
          const ft = m.score?.fullTime;
          // 展示用赛事名 = 中文联赛名 + 轮次/阶段，如「英超 · 第 5 轮」「欧冠 · 小组赛」
          const stageLabel = m.matchday ? `第 ${m.matchday} 轮` : (zhStage(m.stage) || m.stage || '');
          const league = [zhLeague(compName), stageLabel].filter(Boolean).join(' · ');

          // ① 已结束 → 收进赛果（只留最近 N 天，且必须有最终比分）
          if (m.status === 'FINISHED' || m.status === 'AWARDED') {
            if (ts < resLo || ts > now || ft?.home == null) continue;
            done++;
            results.push({
              id: `fb-${m.id}`,
              sport: 'football',
              league,
              home: zhTeamDeep(m.homeTeam),
              away: zhTeamDeep(m.awayTeam),
              utcDate: m.utcDate,
              status: 'FINISHED',
              score: `${ft.home} : ${ft.away}`,
              channels: [],
              info: null,
            });
            continue;
          }

          // ② 进行中 / 未开赛 → 收进赛程（进行中的不受「往前 1 天」窗口限制）
          const live = m.status === 'IN_PLAY' || m.status === 'PAUSED';
          if (!live && !(ts >= lo && ts <= hi)) continue;      // 本地按日期过滤
          hit++;
          out.push({
            id: `fb-${m.id}`,
            sport: 'football',
            league,
            home: zhTeamDeep(m.homeTeam),
            away: zhTeamDeep(m.awayTeam),
            utcDate: m.utcDate,                                   // ISO UTC，前端转本地
            status: m.status,                                     // SCHEDULED / IN_PLAY / FINISHED ...
            score: ft?.home != null ? `${ft.home} : ${ft.away}` : null,
            channels: pickChannels([compName, m.competition?.code, comp]),
            info: null,                                           // 免费版无阵容/伤停，留空
          });
        }
        console.log(`[fb] ${comp} 命中 ${hit} 场赛程 / ${done} 场赛果`);
        ok = true;
      } catch (e) {
        console.warn(`[fb] ${comp} 失败:`, e.message);
        await sleep(2000);
      }
    }
  }
  console.log(`[fb] 合计取到 ${out.length} 场赛程 / ${results.length} 场赛果`);
  return { upcoming: out, results };
}

// 每个电竞项目每天最多保留多少场赛程（按开赛时间取最近的，避免页面被低级别赛事淹没）
const PS_MAX_PER_DAY = Number(process.env.PS_MAX_PER_DAY || 12);
// 每个电竞项目每天最多保留多少场赛果
// ⚠️ 半个月的电竞赛果实测 778+ 场（csgo 单项目 400+），不采样会把前端灌爆
const PS_RESULT_PER_DAY = Number(process.env.PS_RESULT_PER_DAY || 3);

// ============ 数据源 2：PandaScore ============
// PandaScore 限流宽松（1000 次/小时），可以并发；但 4 个项目要各发多次请求。
// ⚠️ 四个实测坑：
//   1. 单页上限 per_page=100，半个月窗口必然溢出
//      （实测 csgo 未来 15 天 187 条 / 过去 15 天 800+ 条）→ 必须 range[begin_at] + 翻页
//   2. 大量 "TBD vs TBD"（对阵未定）属于垃圾数据，必须过滤
//   3. 低级别预选赛极多，必须按「每天上限」截断，否则页面无法浏览
//   4. past 接口不能加 sort=-begin_at（会把 begin_at=null 的 canceled 排到最前）

/** 按 begin_at 窗口翻页拉取原始场次（自动按 id 去重，最多 maxPages 页） */
async function psFetch(game, kind, from, to, maxPages, extraQuery = '') {
  const out = [], seen = new Set();
  const t0 = new Date(from).toISOString().slice(0, 16);
  const t1 = new Date(to).toISOString().slice(0, 16);
  for (let page = 1; page <= maxPages; page++) {
    const url = `https://api.pandascore.co/${game}/matches/${kind}` +
                `?per_page=100&page=${page}&range[begin_at]=${t0},${t1}${extraQuery}&token=${PS_KEY}`;
    try {
      const res = await fetch(url);
      if (!res.ok) { console.warn(`[ps] ${game} ${kind} p${page} HTTP ${res.status}`); break; }
      const arr = await res.json();
      if (!Array.isArray(arr) || !arr.length) break;
      for (const m of arr) if (!seen.has(m.id)) { seen.add(m.id); out.push(m); }
      if (arr.length < 100) break;                     // 不满一页 = 已到末尾
    } catch (e) { console.warn(`[ps] ${game} ${kind} p${page} 失败:`, e.message); break; }
  }
  return out;
}

/** 把一场 PandaScore 原始数据转成内部结构；对阵未定 / 拿不到队名返回 null */
function psNormalize(m, game, status) {
  const home = m.opponents?.[0]?.opponent?.name || m.opponents?.[0]?.opponent?.acronym;
  const away = m.opponents?.[1]?.opponent?.name || m.opponents?.[1]?.opponent?.acronym;
  if (!home || !away) return null;                        // 对阵未定 → 丢弃
  if (/^tbd$/i.test(home) && /^tbd$/i.test(away)) return null;
  const score = (m.results || []).map(r => r.score).join(' : ');
  if (status === 'FINISHED' && !score) return null;       // 没有比分的不算赛果

  const lgName = m.league?.name || '';
  const serieName = m.serie?.full_name || m.serie?.name || '';
  return {
    id: `ps-${m.id}`,
    sport: 'esports',
    league: [lgName, serieName].filter(Boolean).join(' · ')
      || m.tournament?.name || m.name || '电竞赛事',
    home, away,
    utcDate: m.begin_at,
    status,
    score: score || null,
    channels: pickChannels([lgName, serieName, m.tournament?.name, m.videogame?.name, game]),
    info: null,
    bo: m.number_of_games ? `BO${m.number_of_games}` : null,
    game,                                                 // lol / csgo / valorant / dota2
  };
}

/** 赛果采样：按「相对天 × 项目」分组，每天每项目最多 perDay 场，组内知名赛事优先。
 *  半个月的电竞赛果有 700+ 场，全量返回会把前端灌爆，也会让用户看不到重点。 */
function sampleResults(list, perDay) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const buckets = new Map();
  for (const m of list) {
    const d = new Date(m.utcDate); d.setHours(0, 0, 0, 0);
    const k = Math.round((d - today) / 86400000);         // 相对天（负数 = 过去）
    const key = `${m.game}|${k}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(m);
  }
  const kept = [];
  for (const arr of buckets.values()) {
    arr.sort((a, b) => {
      const ta = TOP_LEAGUE_RE.test(a.league) ? 1 : 0;
      const tb = TOP_LEAGUE_RE.test(b.league) ? 1 : 0;
      if (ta !== tb) return tb - ta;                      // 知名赛事排前面
      return new Date(b.utcDate) - new Date(a.utcDate);   // 再按时间新 → 旧
    });
    kept.push(...arr.slice(0, perDay));
  }
  return kept;
}

async function fetchEsports() {
  if (!PS_KEY) { console.warn('[skip] 未配置 PANDASCORE_KEY'); return { upcoming: [], results: [] }; }
  const now = Date.now();
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const lo = dayStart.getTime();                       // 只留今天及以后的赛程
  const hi = now + FB_LOOKAHEAD_DAYS * 86400000;
  const resLo = now - RESULT_LOOKBACK_DAYS * 86400000;
  const todayKey0 = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); })();

  const groups = await Promise.all(PS_GAMES.map(async game => {
    let out = [];
    const pastRaw = [];
    try {
      // ① 未开赛 / 进行中：range 限定窗口 + 翻页（单页 100 条装不下半个月）
      //    下界往前多放 1 天，只为兜住「昨晚开打、现在还在进行」的场次，本地会再收紧
      const rawUp = await psFetch(game, 'upcoming', lo - 86400000, hi, PS_MAX_PAGES, '&sort=begin_at');
      for (const m of rawUp) {
        const ts = new Date(m.begin_at).getTime();
        const live = m.status === 'running';
        if (!live && !(ts >= lo && ts <= hi)) continue;     // 双保险：本地再按窗口过滤
        const item = psNormalize(m, game, m.status === 'not_started' ? 'SCHEDULED' : m.status);
        if (!item) continue;
        item._ts = ts;
        out.push(item);
      }

      // 按「相对天」分组，每天最多留 PS_MAX_PER_DAY 场（取开赛最早的）
      const byDay = new Map();
      for (const m of out) {
        const dk = Math.round((m._ts - todayKey0) / 86400000);
        if (!byDay.has(dk)) byDay.set(dk, []);
        byDay.get(dk).push(m);
      }
      const kept = [];
      for (const list of byDay.values()) {
        list.sort((a, b) => a._ts - b._ts);
        kept.push(...list.slice(0, PS_MAX_PER_DAY));
      }
      console.log(`[ps] ${game} 赛程 ${out.length} 场 → 每天上限截断后 ${kept.length} 场`);
      out = kept;

      // ② 已结束 → 赛果（过去 15 天）
      // ⚠️ 实测坑：**不能加 `sort=-begin_at`** —— 会把 begin_at 为 null 的
      //    canceled 场次排到最前面，真赛果全被挤掉。默认顺序本身就按时间新→旧。
      const rawPast = await psFetch(game, 'past', resLo, now, PS_MAX_PAGES_PAST);
      for (const m of rawPast) {
        if (m.status !== 'finished' || !m.begin_at) continue;  // 排除 canceled / 未开赛
        const ts = new Date(m.end_at || m.begin_at).getTime(); // 用结束时间判断新旧
        if (ts < resLo || ts > now) continue;
        const item = psNormalize(m, game, 'FINISHED');
        if (!item) continue;
        item._ts = ts;
        pastRaw.push(item);
      }
      const sampled = sampleResults(pastRaw, PS_RESULT_PER_DAY);
      console.log(`[ps] ${game} 赛果 ${pastRaw.length} 场 → 按天采样后 ${sampled.length} 场`);
      return { out, past: sampled };
    } catch (e) {
      console.warn(`[ps] ${game} 失败:`, e.message);
      return { out, past: [] };
    }
  }));

  const upcoming = groups.flatMap(g => g.out);
  const results = groups.flatMap(g => g.past)
    .sort((a, b) => b._ts - a._ts)                          // 最新的赛果排前面
    .slice(0, RESULT_MAX);
  console.log(`[ps] 合计取到 ${upcoming.length} 场赛程 / ${results.length} 场赛果`);
  return { upcoming, results };
}

// ============ 同步 + 缓存 ============
// ============ 数据源 3：UEFA 官方（欧国联）============
/**
 * 分页拉取 UEFA 接口。params 里传额外过滤（如 { status: 'FINISHED' }）。
 * 翻到「不满一页」为止 —— 与 PandaScore 同样的套路，单页 100 条装不下整个赛季。
 */
async function uefaFetch(params) {
  const out = [];
  for (let page = 0; page < UEFA_MAX_PAGES; page++) {
    const qs = new URLSearchParams({
      competitionId: UEFA_COMP_ID,
      offset: String(page * UEFA_PAGE),
      limit: String(UEFA_PAGE),
      seasonYear: String(UEFA_SEASON),
      ...params,
    });
    try {
      const res = await fetch(`${UEFA_API}?${qs}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) { uefaErr = uefaErr || `http-${res.status}`; console.warn(`[uefa] HTTP ${res.status}（第 ${page + 1} 页）`); break; }
      const j = await res.json();
      const list = Array.isArray(j) ? j : (j.data || []);
      out.push(...list);
      if (list.length < UEFA_PAGE) break;
    } catch (e) {
      uefaErr = uefaErr || `net-${String(e.message || e).slice(0, 32)}`;
      console.warn('[uefa] 请求失败:', e.message);
      break;
    }
  }
  return out;
}

/** UEFA 单场 → 本站 match 结构 */
function uefaNormalize(m, withScore) {
  const dt = m.kickOffTime?.dateTime;
  if (!dt) return null;
  const homeEN = m.homeTeam?.internationalName || m.homeTeam?.translations?.displayName?.EN;
  const awayEN = m.awayTeam?.internationalName || m.awayTeam?.translations?.displayName?.EN;
  // 中文优先：本地映射表 → UEFA 自带官方中文（translations.displayName.ZH）→ 英文原名
  // （先查映射表是为了和 football-data 那边的译名保持一致，如两个源都叫「捷克」而非一个「Czechia」）
  const home = zhTeam(homeEN) || m.homeTeam?.translations?.displayName?.ZH || homeEN;
  const away = zhTeam(awayEN) || m.awayTeam?.translations?.displayName?.ZH || awayEN;
  if (!home || !away) return null;

  const leagueName = m.group?.league?.metaData?.leagueName || '';   // "League A" / "League B" …
  const matchday = m.matchday?.longName || '';                      // "Matchday 3"
  const reg = m.score?.regular;
  const score = (withScore && reg) ? `${reg.home} : ${reg.away}` : null;

  return {
    id: `uefa-${m.id}`,
    sport: 'football',
    league: ['欧国联', zhStage(leagueName) || leagueName].filter(Boolean).join(' · '),  // →「欧国联 · A级」
    home, away,
    utcDate: dt,
    status: m.status === 'UPCOMING' ? 'SCHEDULED' : m.status,
    score,
    channels: pickChannels(['欧国联', 'UEFA Nations League', 'Nations League', leagueName]),
    info: null,
    stage: matchday || null,        // 「Matchday 3」这类比赛日标签
    _ts: new Date(dt).getTime(),
  };
}

async function fetchUEFA() {
  const now = Date.now();
  const todayKey0 = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); })();
  // -1：含第 N 天整天，但不把第 N+1 天的数据也带回来（前端按天过滤，多出来的就是脏数据）
  const hi = todayKey0 + (FB_LOOKAHEAD_DAYS + 1) * 86400000 - 1;
  const resLo = todayKey0 - RESULT_LOOKBACK_DAYS * 86400000;

  try {
    uefaErr = null;
    // 两次请求：① 全量（含状态）② 已结束（只有这个带比分）
    const [allRaw, finishedRaw] = await Promise.all([
      uefaFetch({}),
      uefaFetch({ status: 'FINISHED' }),
    ]);

    const scoreById = new Map();
    for (const m of finishedRaw) {
      const reg = m.score?.regular;
      if (reg) scoreById.set(String(m.id), `${reg.home} : ${reg.away}`);
    }
    console.log(`[uefa] 拉取 ${allRaw.length} 场（seasonYear=${UEFA_SEASON}）/ 已结束 ${finishedRaw.length} 场`);

    const upcoming = [];
    const results = [];
    for (const raw of allRaw) {
      if (Number(raw.seasonYear) !== UEFA_SEASON) continue;
      const ts = new Date(raw.kickOffTime?.dateTime || 0).getTime();
      if (!ts) continue;

      if (raw.status === 'FINISHED') {
        // 已结束 → 赛果（必须有比分才算）
        if (ts < resLo || ts > now) continue;
        const m = uefaNormalize(raw, true);
        if (!m) continue;
        m.score = scoreById.get(String(raw.id)) || null;
        if (!m.score) continue;
        results.push(m);
      } else {
        // 未开赛 / 进行中 → 赛程（只要有今天 0 点之后的）
        if (ts < todayKey0 || ts > hi) continue;
        const m = uefaNormalize(raw, false);
        if (m) upcoming.push(m);
      }
    }
    console.log(`[uefa] 命中赛程 ${upcoming.length} 场 / 赛果 ${results.length} 场`);
    return { upcoming, results };
  } catch (e) {
    console.warn('[uefa] 整体失败，跳过该数据源:', e.message);
    if (!uefaErr) uefaErr = `parse-${String(e.message || e).slice(0, 32)}`;
    return { upcoming: [], results: [] };
  }
}

// ============ 数据源 4：BWF（羽毛球）============
// 本次调用里 BWF 的失败原因（'no-curl' / 'rate_limited' / 'http-xxx'），线上排障用
let bwfErr = null;

/** 走 curl 取 JSON。Node 的 fetch/https 会被 Cloudflare 按 TLS 指纹 403（见上方常量区注释） */
function bwfCurl(path, params, timeout = 20) {
  const qs = new URLSearchParams(Object.entries(params || {}).filter(([, v]) => v != null && v !== ''));
  const url = `${BWF_API}${path}${qs.toString() ? '?' + qs : ''}`;
  return new Promise((resolve) => {
    execFile('curl', [
      // ⚠️ 不要加 --compressed：Windows 自带 curl 8.0.1 不带该选项，加了直接报错退出
      '-s', '-m', String(timeout),
      '-H', 'Accept: application/json, text/plain, */*',
      '-H', 'Referer: https://bwfbadminton.com/',
      '-H', 'Origin: https://bwfbadminton.com',
      '-H', `User-Agent: ${BWF_UA}`,
      '-w', '\n__HTTP__%{http_code}',
      url,
    ], { maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' }, (err, stdout) => {
      if (err) {
        // ENOENT = 机器上没有 curl（Vercel 之外的精简镜像可能出现）
        bwfErr = err.code === 'ENOENT' ? 'no-curl' : `exec-${String(err.code || err.message).slice(0, 40)}`;
        return resolve(null);
      }
      const m = stdout.match(/\n__HTTP__(\d+)\s*$/);
      const code = m ? Number(m[1]) : 0;
      if (code !== 200) { bwfErr = code === 403 ? 'rate_limited' : `http-${code}`; return resolve(null); }
      try { resolve(JSON.parse(stdout.replace(/\n__HTTP__\d+\s*$/, ''))); }
      catch { bwfErr = 'bad-json'; resolve(null); }
    });
  });
}

/** 该赛事值不值得展示（滤掉青少年组 / 未来系列 / AirBadminton / 已取消） */
function bwfWorth(t) {
  const s = `${t?.name || ''} ${t?.category || ''}`;
  // 硬排除放最前：AirBadminton 是户外玩法（不是标准羽毛球），取消的赛事也没必要展示。
  // ⚠️ 顺序不能反 —— KEEP 里的 "Continental Championships" 会把
  //    "BWF AirBadminton European Continental Championships" 一起放行（实测踩过）。
  if (/AirBadminton|Cancelled/i.test(s)) return false;
  if (BWF_KEEP_RE.test(s)) return true;
  return !BWF_SKIP_RE.test(s);
}

/** 赛事名 → 短名（去赞助商前缀、去 "powered by xxx"、去年份与尾部括号备注） */
function bwfShortName(name) {
  let s = String(name || '').trim();
  s = s.replace(/\s+powered by[\s\S]*$/i, '');
  s = s.replace(BWF_PREFIX_RE, '');
  s = s.replace(/^\d+(?:st|nd|rd|th)\s+/i, '');       // "20th Asian Games …" → "Asian Games …"
  s = s.replace(/\s*\b(?:19|20)\d{2}\b/g, '');
  s = s.replace(/\s*\(([^)]*)\)\s*$/, '');
  return s.replace(/\s{2,}/g, ' ').trim() || String(name || '').trim();
}

/** 一方球员名：单打取 1 人，双打用 " / " 连起来 */
function bwfSide(m, side) {
  return [m?.[`${side}p1_detail`], m?.[`${side}p2_detail`]]
    .filter(Boolean)
    .map(p => p.name_display || [p.first_name, p.last_name].filter(Boolean).join(' ') || p.name_short1 || '')
    .filter(Boolean)
    .join(' / ');
}

/** 逐局比分：BWF 给的是 HTML 片段（`<span>21</span><span>21</span>`），剥标签后拼成 "21-18 21-15" */
function bwfScore(m) {
  const strip = (h) => String(h || '').replace(/<[^>]+>/g, ' ').trim().split(/\s+/).filter(Boolean);
  const a = strip(m?.team1Score), b = strip(m?.team2Score);
  if (!a.length || !b.length) return null;
  return a.map((x, i) => `${x}-${b[i] ?? '?'}`).join(' ');
}

/**
 * 开赛时刻：BWF 的 `start_time` **只精确到天**（当天 00:00 UTC），
 * 真正的时间藏在 `oop_text` 里（Order of Play 的自然语言）：
 *   "Starting at 9:00 AM" / "Not before 1:00 PM" / "Followed by" / "Court and time TBA"
 * 实测 148 场里 123 场是 "Followed by"（按顺序连排，BWF 官网也是这么显示的）。
 * ⚠️ 解析出来的是**场馆当地时间**，BWF 不给时区 —— 所以只当文本展示，不参与 UTC 换算。
 */
function bwfOopTime(oop) {
  const m = String(oop || '').match(/(?:Starting at|Not before)\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (/PM/i.test(m[3])) h += 12;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

const BWF_DISC = { MS: '男单', WS: '女单', MD: '男双', WD: '女双', XD: '混双' };
const BWF_ROUND = {
  F: '决赛', Final: '决赛', Finals: '决赛', SF: '半决赛', 'Semi Finals': '半决赛',
  QF: '1/4决赛', 'Quarter Finals': '1/4决赛',
  R16: '16强', R32: '32强', R64: '64强', R128: '128强',
};
/** 轮次 → 中文；"Qual. R32" 这类资格赛单独处理 */
function bwfRound(roundName, roundKey) {
  const r = String(roundName || roundKey || '').trim();
  if (!r) return null;
  if (BWF_ROUND[r]) return BWF_ROUND[r];
  const q = r.match(/^Qual\.?\s*(.*)$/i);
  if (q) return `资格赛${BWF_ROUND[q[1]] || q[1] || ''}`;
  return r;
}

async function fetchBWF() {
  const empty = { upcoming: [], results: [], tournaments: 0, matches: 0 };
  if (!BWF_ON) return empty;
  const t0b = Date.now();                      // 本函数的预算起点（见下面按剩余预算降级）

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const t0 = today.getTime();
  // -1：含第 N 天整天，但不把第 N+1 天的数据也带回来（前端按天过滤，多出来的就是脏数据）
  const hi = t0 + (FB_LOOKAHEAD_DAYS + 1) * 86400000 - 1;
  const resLo = t0 - RESULT_LOOKBACK_DAYS * 86400000;
  const d2 = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

  try {
    // ① 赛事列表：一次拿全窗口（左右各多放一天，兜住时区边界）
    // ⚠️ 并发同步时首次请求常被挤到超时（curl exit 28），而 BWF 单独探活只要 1~2s；
    //    一次超时就放弃会让羽毛球整段消失。改成「快失败 + 重试一次」（仍受 60s 截止守护）。
    bwfErr = null;
    const listParams = {
      startDate: d2(resLo - 86400000), endDate: d2(hi + 86400000),
      page: 1, perPage: 100, drawCount: 1, activeTab: 1,
    };
    let listJson = null, listErr = null;
    for (let attempt = 0; attempt < 2 && !listJson; attempt++) {
      if (attempt) { bwfErr = null; await sleep(500); }
      listJson = await bwfCurl('/vue-tournaments-search', listParams, attempt ? 20000 : 18000);
      if (!listJson) {
        listErr = bwfErr;
        console.warn(`[bwf] 赛事列表第 ${attempt + 1}/2 次失败：${bwfErr}`);
        if (bwfErr === 'rate_limited') break;         // 403 是限流，重试只会加重
      }
    }
    bwfErr = listJson ? null : listErr;
    let list = listJson?.results?.data || [];
    // ⚠️ 早返回必须把原因写回 bwfErr（同 api/matches.js）：上游「成功但零条」与「上游报错」
    //    以前都表现为 badminton:0 + bwf_error:null，等于把线索一起丢了。
    if (!list.length) {
      if (!listErr) bwfErr = 'empty-list';
      console.warn(`[bwf] 赛事列表为空（${bwfErr || '未知原因'}），跳过该数据源`);
      return empty;
    }
    const rawCount = list.length;
    // 先按开赛日期排序再截断：上限是为了别把同步拖死，那该留的是**最近的**赛事
    list = list
      .filter(bwfWorth)
      .sort((a, b) => new Date(String(a.start_date || 0)) - new Date(String(b.start_date || 0)))
      .slice(0, BWF_MAX_TOURNAMENTS);
    if (!list.length) {
      if (!listErr) bwfErr = `filtered-out(${rawCount})`;
      console.warn(`[bwf] ${rawCount} 项赛事全部被过滤（${bwfErr}），跳过该数据源`);
      return empty;
    }

    // ② 并发拉每个赛事的对阵（限流靠并发度 + 每次之间的短间隔压住）
    // ⚠️ 对阵请求必须给短超时：默认 20s 时只要两三个赛事卡住，worker 就被占满，
    //    整轮会超过截止时间 → 羽毛球整段消失。短超时的代价只是个别赛事退化成赛事级卡片。
    const detail = new Array(list.length).fill(null);
    let cursor = 0, fails = 0, skipped = 0;
    await Promise.all(Array.from({ length: Math.min(BWF_CONCURRENCY, list.length) }, async () => {
      while (true) {
        const i = cursor++;
        if (i >= list.length) return;
        // 预算见底就不再等：拿不到对阵的赛事会退化成「赛事级卡片」，
        // 总比整段羽毛球因为超时消失强（实测出现过 timeout → badminton:0）
        const left = BWF_DEADLINE_MS - 6000 - (Date.now() - t0b);
        if (left < 2000) { skipped++; continue; }
        const j = await bwfCurl('/vue-tournament-matches', { tmtId: list[i].id }, Math.min(7000, left));
        if (!j) fails++;
        detail[i] = j?.results?.by_court || null;
        await sleep(120 + Math.random() * 180);     // 轻微抖动，避免整齐划一地打过去
      }
    }));

    // ③ 归一化：有对阵 → 逐场卡片；抽签未出 → 赛事级卡片
    // 个别赛事上游 500（实测过，如 BWF AirBadminton 某站）不代表这个数据源坏了；
    // 只有大面积失败才算异常，否则 sources.bwf_error 会天天误报，反而掩盖真问题。
    bwfErr = (fails > 2 && fails > list.length * 0.4) ? 'partial-fail'
           : (skipped ? `budget-cut(${skipped})` : listErr);

    const upcoming = [];
    const results = [];
    let withDraw = 0;
    const channels = pickChannels(['羽毛球', 'BWF']);

    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      const bc = detail[i];
      const tmtName = bwfShortName(t.name);

      if (!bc || !Object.keys(bc).length) {
        // 抽签未出：给一张「赛事级」卡片，至少让用户知道这周有这项赛事
        // （这类占多数 —— 未来 15 天里只有临近的赛事才排好签）
        const sd = new Date(String(t.start_date || '').replace(' ', 'T'));
        if (isNaN(sd.getTime()) || sd.getTime() < t0 || sd.getTime() > hi) continue;
        upcoming.push({
          id: `bwf-t${t.id}`,
          sport: 'badminton',
          league: `羽毛球 · ${bwfCat(t.category)}`,
          home: tmtName,                  // 大字是赛事名，小字是级别 —— 避免同一个名字重复两遍
          away: null,
          top: BWF_TOP_RE.test(`${t.category || ''} ${t.name || ''}`) ? 1 : 0,
                     // 无对手 → 前端只渲染赛事名，不显示 "vs"
          utcDate: sd.toISOString(),
          status: 'SCHEDULED',
          score: null,
          timeText: '全天',               // 赛事级卡片代表「这几天有这项赛事」，谈不上具体时刻
          channels,
          info: null,
          stage: String(t.location || '').trim() || null,   // 地点（Modal 里显示）
          pending: true,                  // 标记：赛事级卡片（抽签未出）
          _ts: sd.getTime(),
        });
        continue;
      }
      withDraw++;

      for (const [roundKey, ms] of Object.entries(bc)) {
        for (const m of Object.values(ms)) {
          const ts = Number(m?.start_time) * 1000;
          if (!ts || isNaN(ts)) continue;
          const home = bwfSide(m, 't1'), away = bwfSide(m, 't2');
          if (!home || !away) continue;                 // 双方未定（签位空着）不展示

          const drawRaw = String(m.draw_name || '');
          const discCode = drawRaw.split(/\s+-\s+/)[0].trim();
          const round = bwfRound(m.round_name, roundKey);
          const finished = Number(m.winner) > 0;
          const score = bwfScore(m);

          const base = {
            id: `bwf-${t.id}-${m.id}`,
            sport: 'badminton',
            league: [tmtName, BWF_DISC[discCode] || discCode].filter(Boolean).join(' · '),
            home, away,
            utcDate: new Date(ts).toISOString(),
            channels,
            info: null,
            bo: round,                    // 复用「赛制」显示位 → 卡片上显示成 "· 1/4决赛"
            stage: round,
            top: BWF_TOP_RE.test(`${t.category || ''} ${t.name || ''}`) ? 1 : 0,
            _ts: ts,
          };

          if (finished) {
            if (ts < resLo || ts > Date.now()) continue;
            // ⚠️ 上游只给到「天」（start_time 是当天 00:00 UTC），不标记的话前端会显示成
            //    「08:00 开赛」——那是时区换算出来的假时间，会误导用户。
            results.push({ ...base, status: 'FINISHED', score: score || 'W/O', timeText: '—' });   // 退赛/轮空没有局分
          } else {
            if (ts < t0 || ts > hi) continue;
            // ⚠️ oop_text 里的时间是**场馆当地时间**（BWF 不给时区），直接当北京时间显示会让人错过比赛，
            //    所以统一显示「待定」，把当地时间放进弹窗的情报卡里说明清楚。
            const local = bwfOopTime(m.oop_text);
            upcoming.push({
              ...base, status: 'SCHEDULED', score: null, timeText: '待定',
              info: local ? { note: `${String(t.location || '').trim()} · 开赛 ${local}（场馆当地时间，非北京时间）` }
                          : (String(t.location || '').trim() ? { note: String(t.location).trim() } : null),
            });
          }
        }
      }
    }

    console.log(`[bwf] 赛事 ${list.length} 项（已出签 ${withDraw} 项）→ 赛程 ${upcoming.length} 场 / 赛果 ${results.length} 场`);
    return { upcoming, results, tournaments: list.length, matches: upcoming.length + results.length };
  } catch (e) {
    console.warn('[bwf] 整体失败，跳过该数据源:', e.message);
    if (!bwfErr) bwfErr = `parse-${String(e.message || e).slice(0, 40)}`;
    return empty;
  }
}

// 截止时间保护：BWF 同步最慢（冷启动整轮 60s+），超时就先放弃，别把整个接口拖死。
// ⚠️⚠️ 必须 clearTimeout —— 之前用 sleep()+Promise.race，计时器不会取消：
//   fetchBWF 明明已在 20 秒成功返回，到 60 秒时计时器仍会把 bwfErr 覆写成 'timeout'，
//   sources.bwf_error 于是天天误报（数据其实是好的），正好违背"不要误报"的初衷。
function bwfWithDeadline() {
  let timer = null;
  let timedOut = false;
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      bwfErr = 'timeout';
      resolve({ upcoming: [], results: [], tournaments: 0 });
    }, BWF_DEADLINE_MS);
  });
  // ⚠️ Promise.race 不会阻止败者继续跑：超时后 fetchBWF 跑完会把 bwfErr 覆盖成 null，
  //    结果就是「badminton:0 但 bwf_error:null」（自相矛盾、无从排障）。迟到时写回原因。
  const job = fetchBWF().then(
    (r) => { if (timedOut) bwfErr = 'timeout'; return r; },
    (e) => { if (timedOut) bwfErr = 'timeout'; throw e; },
  );
  return Promise.race([job, guard]).finally(() => { if (timer) clearTimeout(timer); });
}

async function sync() {
  loadChannels();
  const [fb, ps, uefa, bwf] = await Promise.all([
    fetchFootball(), fetchEsports(), fetchUEFA(), bwfWithDeadline(),
  ]);
  const clean = (m) => { const { _ts, ...rest } = m; return rest; };   // 去掉内部字段，不写进缓存

  // 羽毛球一个赛事动辄上百场（大满贯 400+），不设上限会把页面撑爆、也会挤掉足球电竞的位置。
  // 只保留时间上最近的一批。
  const bwfUpcoming = [...bwf.upcoming].sort((a, b) => a._ts - b._ts).slice(0, BWF_MAX_MATCHES);
  const bwfResults = [...bwf.results]
    .sort((a, b) => (b.top || 0) - (a.top || 0) || b._ts - a._ts)   // 高级别赛事优先，其次最新的
    .slice(0, BWF_RESULT_MAX);
  if (bwf.upcoming.length > bwfUpcoming.length || bwf.results.length > bwfResults.length) {
    console.log(`[bwf] 场次超限，赛程 ${bwf.upcoming.length}→${bwfUpcoming.length} / 赛果 ${bwf.results.length}→${bwfResults.length}`);
  }

  const data = [...fb.upcoming, ...ps.upcoming, ...uefa.upcoming, ...bwfUpcoming]
    .filter(m => m.utcDate)
    .map(m => {
      const rest = clean(m);
      // 羽毛球自带 top（按赛事级别判定，联赛名里看不出级别），别用正则覆盖掉
      if (rest.top === undefined) rest.top = TOP_LEAGUE_RE.test(`${rest.league || ''}`) ? 1 : 0;
      return rest;
    })
    .sort((a, b) => {
      const t = new Date(a.utcDate) - new Date(b.utcDate);
      if (t !== 0) return t;
      return (b.top || 0) - (a.top || 0);          // 同时间，知名赛事优先
    });

  // 赛果回顾：合并四个源，按时间倒序（最新结束的排最前），覆盖最近半个月
  const results = [...fb.results, ...ps.results, ...uefa.results, ...bwfResults]
    .filter(m => m.utcDate && m.score)
    .map(clean)
    .sort((a, b) => new Date(b.utcDate) - new Date(a.utcDate))
    .slice(0, RESULT_MAX);

  // 写之前再确保目录存在：进程启动后目录若被外部删掉（例如手工清理 cache），
  // 只在启动时 mkdir 一次就会 writeFileSync ENOENT，整个接口 502
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify({ t: Date.now(), data, results }, null, 0));
  console.log(`[sync] 赛程 ${data.length} 场（知名 ${data.filter(m => m.top).length} 场）/ 赛果 ${results.length} 场，已写入缓存`);
  return { data, results, bwf };
}

function getCache() {
  if (!existsSync(CACHE_FILE)) return null;
  try { return JSON.parse(readFileSync(CACHE_FILE, 'utf-8')); } catch { return null; }
}

// 同一时刻只允许一次同步：
// 否则并发请求（多个标签页 / 前端重试）会各自触发一次完整同步，
// 上游请求数成倍增加 → football-data.org 免费版 10 次/分钟瞬间打满（429）。
let inflight = null;

// ============ HTTP 服务 ============
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // 开发期放开跨域；上线请把 * 换成你的域名
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');

  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (url.pathname === '/api/matches') {
    let cache = getCache();
    const stale = !cache || Date.now() - cache.t > TTL;
    let servedStale = false;
    if (stale) {
      if (!inflight) inflight = sync().finally(() => { inflight = null; });
      if (cache && (cache.data || []).length) {
        // 有旧数据就**先回旧数据、后台刷新**：
        // 一轮完整同步 60~70 秒，硬等会把首屏卡成「数据加载中」，看起来像挂了
        servedStale = true;
        inflight.catch(e => console.error('[sync] 后台刷新失败:', e.message));
      } else {
        // 冷启动（本地第一次跑，还没有任何缓存）只能等
        try { cache = { t: Date.now(), ...(await inflight) }; }
        catch (e) {
          console.error('[sync] 失败:', e.message);
          if (!cache) { res.writeHead(502, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: e.message })); }
          console.warn('[sync] 拉取失败，回退到旧缓存');
        }
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    const list = cache.data || [];
    return res.end(JSON.stringify({
      updatedAt: new Date(cache.t).toISOString(),
      // true = 这份是旧缓存，服务端正在后台同步（前端可据此显示「刷新中」）
      stale: servedStale,
      age_s: Math.round((Date.now() - cache.t) / 1000),
      build: BUILD,
      // 与线上 api/matches.js 的 sources 对齐，方便「本地 / 线上」逐项对比排障
      sources: {
        football: list.filter(m => m.sport === 'football' && !String(m.id || '').startsWith('uefa-')).length,
        esports: list.filter(m => m.sport === 'esports').length,
        // 欧国联（UEFA 官方接口，免费无需 Key）。字段名与 api/matches.js 对齐，方便本地/线上对比
        uefa_nations_league: list.filter(m => String(m.id || '').startsWith('uefa-')).length,
        uefa_error: uefaErr,              // null = 接口正常；0 场且为 null 才说明「窗口内确实没有」
        // 羽毛球（BWF 内部接口，免费无需 Key）。pending = 抽签未出、只给了赛事名+日期的卡片
        badminton: list.filter(m => String(m.id || '').startsWith('bwf-')).length,
        badminton_pending: list.filter(m => m.pending).length,
        results: (cache.results || []).length,
        keys: { football: !!FB_KEY, esports: !!PS_KEY },
        // 非 null 说明 BWF 这一轮没取到数：no-curl(缺 curl) / rate_limited(403 限流) / http-xxx
        bwf_error: bwfErr,
      },
      matches: list,
      results: cache.results || [],
    }));
  }

  // 自检端点（与 Vercel 版 api/selfcheck.js 行为保持一致）
  // /api/selfcheck          只看函数层与配置状态
  // /api/selfcheck?probe=1  额外真实探测两个上游 Key 是否有效
  if (url.pathname === '/api/selfcheck') {
    const t0 = Date.now();
    const probeOne = async (u, headers) => {
      const s0 = Date.now();
      try {
        const r = await fetch(u, { headers });
        const t = await r.text();
        return { ok: r.ok, status: r.status, ms: Date.now() - s0, bytes: t.length };
      } catch (e) { return { ok: false, status: 0, ms: Date.now() - s0, error: e.message }; }
    };
    const payload = {
      ok: true, endpoint: '/api/selfcheck', runtime: 'local-node',
      node: process.version, time: new Date().toISOString(),
      env: {
        FOOTBALL_DATA_KEY: FB_KEY ? `已配置（${FB_KEY.length} 字符）` : '❌ 缺失',
        PANDASCORE_KEY: PS_KEY ? `已配置（${PS_KEY.length} 字符）` : '❌ 缺失',
        FB_COMPETITIONS: FB_COMPETITIONS.join(','),
        PS_GAMES: PS_GAMES.join(','),
      },
      cache: (() => { const c = getCache(); return { has_data: !!(c && c.data), count: c?.data?.length || 0, results: c?.results?.length || 0 }; })(),
    };
    if (url.searchParams.get('probe') === '1') {
      const [football, pandascore] = await Promise.all([
        FB_KEY ? probeOne(`https://api.football-data.org/v4/competitions/${FB_COMPETITIONS[0]}/matches`, { 'X-Auth-Token': FB_KEY }) : Promise.resolve({ skipped: '缺 Key' }),
        PS_KEY ? probeOne(`https://api.pandascore.co/${PS_GAMES[0]}/matches/upcoming?per_page=1&token=${PS_KEY}`) : Promise.resolve({ skipped: '缺 Key' }),
      ]);
      payload.probe = { football, pandascore };
      payload.probe_hint = 'football: 200=Key 有效 / 403=Key 无效 / 429=限流（稍后再试）';
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(payload, null, 2));
  }

  // 手动触发同步（调试用）：curl http://localhost:8787/api/refresh
  if (url.pathname === '/api/refresh') {
    try {
      const { data, results } = await sync();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, count: data.length, results: results.length }));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }

  // 免费直播源列表（含实时可用性探测）与同源 HLS 代理
  //   /api/streams      频道目录 + 每个源当前能不能拉起来
  //   /api/stream?c=id  按频道取流（服务端重写分片地址，解决 CORS / 混合内容）
  if (url.pathname === '/api/streams') {
    try {
      const payload = await listChannels();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(payload));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }
  if (url.pathname === '/api/stream') {
    return serveStream(req, res, `http://localhost:${PORT}`);
  }

  // 静态资源（本地播放器 hls.js 等）：同源提供，前端零外链依赖
  if (url.pathname.startsWith('/assets/')) {
    const rel = url.pathname.replace(/^\/+/, '').replace(/\.\./g, '');
    const f = join(__dirname, rel);
    if (existsSync(f)) {
      const ext = rel.split('.').pop().toLowerCase();
      const ct = ext === 'js' ? 'application/javascript; charset=utf-8'
        : ext === 'css' ? 'text/css; charset=utf-8'
        : ext === 'png' ? 'image/png' : 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'public, max-age=86400' });
      return res.end(readFileSync(f));
    }
  }

  // 静态托管（把前端页面放同目录即可，生产建议交给 Vercel/Nginx）
  if (url.pathname === '/' || url.pathname === '/index.html') {
    const f = join(__dirname, 'index.html');
    if (existsSync(f)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(readFileSync(f));
    }
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, () => {
  console.log(`\n海风看球 · 数据代理已启动`);
  console.log(`  赛程接口: http://localhost:${PORT}/api/matches`);
  console.log(`  手动刷新: http://localhost:${PORT}/api/refresh`);
  console.log(`  足球 Key: ${FB_KEY ? '已配置' : '❌ 未配置 FOOTBALL_DATA_KEY'}`);
  console.log(`  电竞 Key: ${PS_KEY ? '已配置' : '❌ 未配置 PANDASCORE_KEY'}\n`);
  // 启动即同步一次
  sync().catch(e => console.error('[startup sync] 失败:', e.message));
});
