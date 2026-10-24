/**
 * 缓存体检：直接读 cache/matches.json，核对「半个月时间轴」是否真的铺满。
 * 比 curl 更适合快速回归 —— 不触发上游请求，纯本地读。
 * 用法：node tools/inspect-cache.mjs
 */
import { readFileSync } from 'node:fs';

const raw = JSON.parse(readFileSync('D:/桌面/飞书下载/观赛预告/cache/matches.json', 'utf-8'));
const { data: matches = [], results = [], t } = raw;

const today = new Date(); today.setHours(0, 0, 0, 0);
const off = iso => Math.round((new Date(new Date(iso).setHours(0, 0, 0, 0)) - today) / 86400000);
const dist = (arr) => {
  const m = {};
  arr.forEach(x => { const k = off(x.utcDate); m[k] = (m[k] || 0) + 1; });
  const keys = Object.keys(m).map(Number).sort((a, b) => a - b);
  return { keys, m };
};

console.log(`缓存时间 : ${new Date(t).toLocaleString('zh-CN')}`);
console.log(`赛程     : ${matches.length} 场`);
console.log(`赛果     : ${results.length} 场`);

const md = dist(matches);
console.log(`\n赛程时间轴（D+ = 未来第几天）`);
console.log(`  跨度 : D${md.keys[0]} ~ D+${md.keys[md.keys.length - 1]}，共 ${md.keys.length} 天有赛程`);
console.log(`  分布 : ${md.keys.map(k => `D${k >= 0 ? '+' : ''}${k}=${md.m[k]}`).join('  ')}`);

const rd = dist(results);
console.log(`\n赛果时间轴（D- = 几天前）`);
console.log(`  跨度 : D${rd.keys[0]} ~ D${rd.keys[rd.keys.length - 1]}，共 ${rd.keys.length} 天有赛果`);
console.log(`  分布 : ${rd.keys.map(k => `D${k}=${rd.m[k]}`).join('  ')}`);

const sportOf = a => a.reduce((o, x) => (o[x.sport] = (o[x.sport] || 0) + 1, o), {});
const gameOf = a => a.reduce((o, x) => (x.game ? (o[x.game] = (o[x.game] || 0) + 1, o) : o), {});
console.log(`\n赛程分项目 : ${JSON.stringify(sportOf(matches))}   电竞细分 ${JSON.stringify(gameOf(matches))}`);
console.log(`赛果分项目 : ${JSON.stringify(sportOf(results))}   电竞细分 ${JSON.stringify(gameOf(results))}`);

const withCh = matches.filter(m => m.channels.length).length;
console.log(`\n渠道覆盖   : ${withCh}/${matches.length} (${matches.length ? Math.round(withCh / matches.length * 100) : 0}%)`);
console.log(`TBD 残留   : ${matches.filter(m => /^tbd$/i.test(m.home) && /^tbd$/i.test(m.away)).length}`);
console.log(`CS2 残留   : 赛程 ${matches.filter(m => m.game === 'csgo').length} / 赛果 ${results.filter(r => r.game === 'csgo').length}`);
console.log(`_ts 泄漏   : 赛程 ${matches.filter(m => '_ts' in m).length} / 赛果 ${results.filter(r => '_ts' in r).length}`);
console.log(`top 标记   : ${matches.filter(m => m.top).length} 场知名赛事`);
console.log(`赛果倒序   : ${results.every((r, i) => i === 0 || new Date(results[i - 1].utcDate) >= new Date(r.utcDate)) ? '✓' : '✗'}`);
console.log(`赛程升序   : ${matches.every((m, i) => i === 0 || new Date(matches[i - 1].utcDate) <= new Date(m.utcDate)) ? '✓' : '✗'}`);

// 每天场次是否过于悬殊（前端体验指标）
const dailyRes = Object.values(rd.m);
console.log(`\n赛果单日最多 ${Math.max(...dailyRes)} 场 / 最少 ${Math.min(...dailyRes)} 场（采样上限 PS_RESULT_PER_DAY=3 × 该项目数）`);
