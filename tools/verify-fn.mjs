/**
 * 离线模拟 Vercel Serverless 调用 api/matches.js
 * 目的：不部署也能验证「函数在 Vercel 环境下能否正常返回数据」
 * 用法：node tools/verify-fn.mjs
 *
 * 当前数据契约（半个月窗口）：
 *   matches → 今天 ~ 未来 15 天，按开赛时间升序
 *   results → 过去 15 天已结束，按结束时间倒序
 *   ⚠️ CS2(csgo) 已从数据源排除，两个数组都不应出现
 */
import { readFileSync } from 'node:fs';

const PROJ = 'D:/桌面/飞书下载/观赛预告';
const FN = `${PROJ}/api/matches.js`;
const LOOKAHEAD = 15;      // 赛程往后 15 天
const LOOKBACK = 15;       // 赛果往前 15 天

// 1) 把 .env 注入 process.env（Vercel 上这步由平台完成）
const envRaw = readFileSync(`${PROJ}/.env`, 'utf-8');
let envCount = 0;
for (const line of envRaw.split(/\r?\n/)) {
  if (/^\s*#/.test(line)) continue;
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$/);
  if (m) { process.env[m[1]] = m[2]; envCount++; }
}
console.log(`[1] 从 .env 注入 ${envCount} 个环境变量`);
console.log(`    FOOTBALL_DATA_KEY = ${process.env.FOOTBALL_DATA_KEY ? '已注入' : '缺失 ✗'}`);
console.log(`    PANDASCORE_KEY    = ${process.env.PANDASCORE_KEY ? '已注入' : '缺失 ✗'}`);
console.log(`    PS_GAMES          = ${process.env.PS_GAMES || '(代码默认 lol,valorant,dota2)'}`);

// 2) 动态引入函数（模拟 ESM 加载，验证 package.json type:module 的必要性）
console.log(`\n[2] 以 ESM 方式 import ${FN}`);
const { default: handler } = await import(`file:///${FN}`);
console.log(`    handler 类型: ${typeof handler} ${typeof handler === 'function' ? '✓' : '✗'}`);

// 3) 构造最小 req/res，调用 handler
console.log(`\n[3] 调用 handler（会真实请求两个上游 API，请稍候…）`);
const t0 = Date.now();
let payload = null;
const res = {
  _headers: {},
  _status: null,
  setHeader(k, v) { this._headers[k] = v; },
  status(c) { this._status = c; return this; },
  json(o) { payload = o; },
};
await handler({ method: 'GET', url: '/api/matches' }, res);
const cost = ((Date.now() - t0) / 1000).toFixed(1);

// 4) 校验返回
console.log(`\n[4] 结果`);
console.log(`    HTTP 状态   : ${res._status}`);
console.log(`    Cache-Control: ${res._headers['Cache-Control'] || '(未设置)'}`);
console.log(`    CORS        : ${res._headers['Access-Control-Allow-Origin'] || '(未设置)'}`);
console.log(`    耗时        : ${cost}s`);

if (!payload || !Array.isArray(payload.matches)) {
  console.log(`    ✗ 返回结构异常: ${JSON.stringify(payload)?.slice(0, 300)}`);
  process.exit(1);
}

const ms = payload.matches;
const rs = Array.isArray(payload.results) ? payload.results : [];
const today = new Date(); today.setHours(0, 0, 0, 0);
const off = iso => Math.round((new Date(new Date(iso).setHours(0, 0, 0, 0)) - today) / 86400000);
const dayOf = m => off(m.utcDate);

console.log(`    数据源      : ${JSON.stringify(payload.sources || {})}`);
console.log(`    赛程场次    : ${ms.length}`);

const bySport = {};
ms.forEach(m => bySport[m.sport] = (bySport[m.sport] || 0) + 1);
console.log(`    分项目      : ${JSON.stringify(bySport)}`);

// 按天分布：这是「15 天跨度」是否真的生效的直接证据
const dist = {};
ms.forEach(m => { const d = dayOf(m); dist[d] = (dist[d] || 0) + 1; });
const days = Object.keys(dist).map(Number).sort((a, b) => a - b);
console.log(`    赛程天数跨度: 第 ${days[0]} 天 ~ 第 ${days[days.length - 1]} 天（共 ${days.length} 天有赛程）`);
console.log(`    每天场次    : ${days.map(d => `D${d >= 0 ? '+' : ''}${d}:${dist[d]}`).join('  ')}`);

const withCh = ms.filter(m => m.channels.length).length;
console.log(`    渠道覆盖    : ${withCh}/${ms.length} (${ms.length ? Math.round(withCh / ms.length * 100) : 0}%)`);
console.log(`    TBD 残留    : ${ms.filter(m => /^tbd$/i.test(m.home) && /^tbd$/i.test(m.away)).length}`);
console.log(`    CS2 残留    : ${ms.filter(m => m.game === 'csgo').length}`);

// 4-b) 赛果（过去半个月）
console.log(`\n    赛果场次    : ${rs.length}`);
if (rs.length) {
  const bad = rs.filter(r => !r.home || !r.away || !r.score || !r.utcDate);
  console.log(`    赛果字段完整: ${rs.length - bad.length}/${rs.length}`);
  const rDist = {};
  rs.forEach(r => { const d = off(r.utcDate); rDist[d] = (rDist[d] || 0) + 1; });
  const rDays = Object.keys(rDist).map(Number).sort((a, b) => a - b);
  console.log(`    赛果天数跨度: 第 ${rDays[0]} 天 ~ 第 ${rDays[rDays.length - 1]} 天（共 ${rDays.length} 天有赛果）`);
  console.log(`    赛果按天    : ${rDays.map(d => `${d}天:${rDist[d]}`).join('  ')}`);
  const rSport = {};
  rs.forEach(r => rSport[r.sport] = (rSport[r.sport] || 0) + 1);
  console.log(`    赛果分项目  : ${JSON.stringify(rSport)}`);
  console.log(`    赛果样例    :`);
  rs.slice(0, 4).forEach(r => {
    console.log('       ', new Date(r.utcDate).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
      '|', (r.game || r.sport).padEnd(8), '|', String(r.home).slice(0, 14), r.score, String(r.away).slice(0, 14));
  });
}

// 4.5) 欧国联专项（数据源 3：UEFA 官方接口）
const unlM = ms.filter(m => String(m.id || '').startsWith('uefa-'));
const unlR = rs.filter(r => String(r.id || '').startsWith('uefa-'));
console.log(`\n    欧国联赛程  : ${unlM.length} 场 / 赛果 ${unlR.length} 场`);
if (unlM.length) {
  console.log('    欧国联样例  :');
  unlM.slice(0, 5).forEach(m => console.log('       ',
    new Date(m.utcDate).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
    '|', String(m.league).padEnd(18), '|', String(m.home).slice(0, 16), 'vs', String(m.away).slice(0, 16),
    '|', m.stage || '', '|', m.channels.map(c => c.n).join('/') || '(无渠道)'));
}
if (unlR.length) {
  console.log('    欧国联赛果  :');
  unlR.slice(0, 5).forEach(r => console.log('       ',
    new Date(r.utcDate).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
    '|', String(r.league).padEnd(18), '|', String(r.home).slice(0, 16), r.score, String(r.away).slice(0, 16)));
}

// 4b) 羽毛球样例
const bwSamp = ms.filter(m => String(m.id || '').startsWith('bwf-'));
if (bwSamp.length) {
  console.log(`\n    羽毛球赛程  : ${bwSamp.length} 场（抽签未出 ${bwSamp.filter(m => m.pending).length} 场）`);
  bwSamp.slice(0, 5).forEach(m => console.log('       ',
    m.utcDate.slice(0, 10), '|', String(m.timeText || '').padEnd(4), '|',
    String(m.league).slice(0, 30).padEnd(32), '|',
    m.away ? `${String(m.home).slice(0, 14)} vs ${String(m.away).slice(0, 14)}` : String(m.home).slice(0, 32)));
}

// 5) 关键断言
console.log(`\n[5] 断言`);
const maxDay = days.length ? days[days.length - 1] : -999;
const minResDay = rs.length ? Math.min(...rs.map(r => off(r.utcDate))) : 0;
// 中文化断言用到的中间量
const fbAll = [...ms, ...rs].filter(m => m.sport === 'football');
const EN_LEAGUE_RE = /Premier League|Bundesliga|Serie A|Ligue 1|Primera|Campeonato|Championship|Champions League|Nations League/;
// 中文译名里合法保留的拉丁缩写白名单（行业通用写法：AC米兰 / 巴黎FC / 雅典AEK …）
const ALLOW_LATIN = /AC米兰|国际米兰|巴黎FC|雅典AEK|AEK雅典|沙尔克04/g;
const latinLeft = s => String(s || '').replace(ALLOW_LATIN, '').match(/[A-Za-z]{2,}/);

// 羽毛球（数据源 4：BWF 内部接口）
const bwM = ms.filter(m => String(m.id || '').startsWith('bwf-'));
const bwR = rs.filter(r => String(r.id || '').startsWith('bwf-'));
const bwPending = bwM.filter(m => m.pending);        // 抽签未出的「赛事级卡片」
const bwPlay = bwM.filter(m => !m.pending);          // 有对阵的场次
// BWF 只给到「天」，后端据此标记，绝不能出现时区换算出来的假时刻（如 08:00）
const BW_TIME_MARKS = ['待定', '全天'];

// ⚠️ 欧国联只在国际比赛窗口（9/10/11 月）才有比赛：15 天前瞻里为 0 是**正常态**，
//    套一条「必须 > 0」的硬断言，一年里大半时间都是红的，久了就没人看这个脚本了。
//    但也不能无条件放过 —— 只有「接口明确报正常（uefa_error 为 null）」时才算「确实没有」；
//    接口 403/超时、或旧版本压根没这个字段（无法判断），都仍然算红。
const UNL_NA = (payload.sources?.uefa_error === null && payload.sources?.uefa_nations_league === 0)
  ? '当前窗口内没有欧国联比赛（UEFA 接口正常）'
  : '';

const checks = [
  ['HTTP 200', res._status === 200],
  ['返回数组', Array.isArray(ms)],
  ['有真实数据', ms.length > 0],
  [`赛程跨度拉满（≥${LOOKAHEAD} 天）`, days.length >= LOOKAHEAD],
  [`赛程不越界（≤ 之后 ${LOOKAHEAD} 天）`, maxDay <= LOOKAHEAD],
  ['赛程无过去场次（除进行中）', days[0] >= 0],
  ['CS2 已排除（赛程）', ms.every(m => m.game !== 'csgo')],
  ['无 TBD 垃圾行', ms.filter(m => /^tbd$/i.test(m.home) && /^tbd$/i.test(m.away)).length === 0],
  ['渠道表读取成功', withCh > 0],
  ['有 CORS 头', res._headers['Access-Control-Allow-Origin'] === '*'],
  ['有 CDN 缓存头', !!res._headers['Cache-Control']],
  ['results 是数组', Array.isArray(payload.results)],
  [`赛果回溯 ≥ ${Math.floor(LOOKBACK * 0.6)} 天`, minResDay <= -Math.floor(LOOKBACK * 0.6)],
  [`赛果不越界（≥ -${LOOKBACK} 天）`, minResDay >= -LOOKBACK],
  ['CS2 已排除（赛果）', rs.every(r => r.game !== 'csgo')],
  ['赛果字段完整', rs.length > 0 && rs.every(r => r.home && r.away && r.score && r.utcDate)],
  ['赛果按时间倒序', rs.every((r, i) => i === 0 || new Date(rs[i - 1].utcDate) >= new Date(r.utcDate))],
  // ⚠️ 阈值按运动分开：足球/电竞靠「项目×天」采样压在 60 以内，
  //    但羽毛球一天几十场是常态（亚运会实测单日 64 场），套同一个阈值必然假失败。
  ['赛果每天有采样上限（非羽毛球）', Math.max(...Object.values(rs.filter(r => r.sport !== 'badminton').reduce((a, r) => { const k = off(r.utcDate); a[k] = (a[k] || 0) + 1; return a; }, { x: 0 }))) <= 60],
  ['羽毛球赛果每天有上限', Math.max(...Object.values(bwR.reduce((a, r) => { const k = off(r.utcDate); a[k] = (a[k] || 0) + 1; return a; }, { x: 0 }))) <= 120],
  // —— 欧国联（数据源 3：UEFA 官方接口）——
  ['欧国联赛程已接入', unlM.length > 0, UNL_NA],
  ['欧国联 league 带组别（中文）', unlM.every(m => /^欧国联 · [ABCD]级$/.test(m.league))],
  ['欧国联赛程有渠道', unlM.every(m => m.channels.some(c => c.n === '央视体育' || c.n === '咪咕视频'))],
  ['欧国联赛程不越界', unlM.every(m => off(m.utcDate) >= 0 && off(m.utcDate) <= LOOKAHEAD)],
  ['欧国联赛程带比赛日', unlM.every(m => /^Matchday \d$/.test(m.stage || ''))],
  ['欧国联赛果带比分', unlR.length > 0 && unlR.every(r => /^\d+ : \d+$/.test(r.score)), UNL_NA],
  ['欧国联赛果在回溯窗口内', unlR.every(r => off(r.utcDate) >= -LOOKBACK && off(r.utcDate) <= 0)],
  ['sources 报了欧国联场次', typeof payload.sources?.uefa_nations_league === 'number'],
  ['sources 有 uefa_error 字段（区分「确实没有」和「接口挂了」）', 'uefa_error' in (payload.sources || {})],
  // —— 足球赛事中文化（lib/zh.js）——
  // ⚠️ 回归防线：映射表漏了某个队、或有人把映射逻辑改坏，这里会立刻红。
  //    注意别写成 `...[(()=>{...})()]` —— 多包一层方括号会让 spread 只展开一层，
  //    4 条断言会被当成 1 个元素打印出来，看着「绿」其实没测（踩过）。
  ['足球赛事已取到数据', fbAll.length > 0],
  ['足球联赛名全中文', fbAll.every(m => !EN_LEAGUE_RE.test(m.league))],
  ['足球球队名全中文', fbAll.every(m => !latinLeft(m.home) && !latinLeft(m.away))],
  ['无 HSV/PSV 被截断的脏队名', fbAll.every(m => !/^[A-Za-z]$/.test(m.home) && !/^[A-Za-z]$/.test(m.away))],
  // —— 羽毛球（数据源 4：BWF 内部接口）——
  ['羽毛球赛程已接入', bwM.length > 0],
  ['羽毛球有观赛渠道', bwM.length > 0 && bwM.every(m => m.channels && m.channels.length > 0)],
  ['羽毛球赛程不越界', bwM.every(m => off(m.utcDate) >= 0 && off(m.utcDate) <= LOOKAHEAD)],
  ['羽毛球有「抽签未出」的赛事级卡片', bwPending.length > 0],
  ['赛事级卡片没有对手（前端只显示赛事名）', bwPending.every(m => !m.away && !!m.home)],
  ['赛事级卡片带地点', bwPending.every(m => !!m.stage)],
  ['对阵卡片双方齐全', bwPlay.length > 0 && bwPlay.every(m => m.home && m.away)],
  ['羽毛球联赛名带单项', bwPlay.every(m => /· (男单|女单|男双|女双|混双)$/.test(m.league))],
  ['羽毛球不显示假开赛时刻', bwM.every(m => BW_TIME_MARKS.includes(m.timeText))],
  ['羽毛球没混进青少年/AirBadminton', bwM.every(m => !/AirBadminton|Junior.*(U1[0-9]|U2[0-9])/i.test(m.home + ' ' + m.league))],
  ['羽毛球赛果带比分', bwR.length > 0 && bwR.every(r => !!r.score)],
  ['羽毛球赛果不显示假时刻', bwR.every(r => r.timeText === '—')],
  ['羽毛球赛果在回溯窗口内', bwR.every(r => off(r.utcDate) >= -LOOKBACK && off(r.utcDate) <= 0)],
  ['sources 报了羽毛球场次', typeof payload.sources?.badminton === 'number'],
  ['sources 报了抽签未出卡片数', typeof payload.sources?.badminton_pending === 'number'],
  ['sources 有 bwf_error 字段（便于线上排障）', 'bwf_error' in (payload.sources || {})],
];
let allOk = true;
for (const [name, pass, skip] of checks) {
  if (skip) { console.log(`    ⊘ ${name}  （跳过：${skip}）`); continue; }
  console.log(`    ${pass ? '✓' : '✗'} ${name}`);
  if (!pass) allOk = false;
}

console.log(`\n${allOk ? '✅ 全部通过 —— 这个函数可以直接部署到 Vercel' : '❌ 存在失败项，先修复再部署'}`);
console.log(`\n样例（按时间升序前 6 场）：`);
ms.slice(0, 6).forEach(m => {
  const d = new Date(m.utcDate);
  // ⚠️ 羽毛球只精确到天（00:00 UTC），直接打印 utcDate 会显示成「08:00」这种假时刻，
  //    和前端「不显示假时刻」的规则自相矛盾。有时间占位符时按占位符打印。
  const pad = n => String(n).padStart(2, '0');
  const placeholder = ['待定', '全天', '—'].includes(m.timeText);
  const when = placeholder
    ? `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${m.timeText}`
    : d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  console.log('   ', when,
    '|', (m.game || m.sport).padEnd(8), '|', String(m.home).slice(0, 16),
    m.away ? 'vs ' + String(m.away).slice(0, 16) : '(抽签未出)',
    '|', (m.channels || []).map(c => c.n).join('/') || '(无渠道)');
});
process.exit(allOk ? 0 : 1);
