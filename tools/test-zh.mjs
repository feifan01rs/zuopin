/**
 * 中文化覆盖率自检
 * ------------------------------------------------------------
 * 拿 cache/matches.json 里**真实抓到的英文数据**当测试集，
 * 反查 lib/zh.js 还有哪些队名/联赛名没收录 —— 比人工数映射表靠谱得多。
 *
 * 用法：node tools/test-zh.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zhLeague, zhTeam, zhStage } from '../lib/zh.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// ⚠️ 测试集要挑**英文原文**用：cache/matches.json 是同步后的产物（已中文化），
//    拿它反查映射表必然全不命中。优先用备份（重跑前的英文缓存）。
const CANDIDATES = [
  join(__dirname, '..', 'cache', 'matches.backup.json'),
  join(__dirname, '..', 'cache', 'matches.json'),
];
const CACHE = CANDIDATES.find(p => existsSync(p));

if (!CACHE) { console.log('没有缓存文件，跳过'); process.exit(0); }
const raw = JSON.parse(readFileSync(CACHE, 'utf-8'));
const all = [...(raw.data || []), ...(raw.results || [])].filter(m => m.sport === 'football');

console.log(`测试集：足球比赛 ${all.length} 场\n`);

const missTeams = new Map();
const missLeagues = new Set();
let okTeams = 0, okLeagues = 0;

for (const m of all) {
  for (const side of ['home', 'away']) {
    const n = m[side];
    if (!n) continue;
    // 已经是中文（源数据被翻过）→ 直接算通过，不必再查表
    if (zhTeam(n) || /[\u3400-\u9fff]/.test(n)) okTeams++;
    else missTeams.set(n, (missTeams.get(n) || 0) + 1);
  }
  const cn = zhLeague(m.league || '');
  // 判定「翻干净了」= 不含连续 2 个以上字母（即不含英文单词）。
  // ⚠️ 不能要求完全无字母：「欧国联 · A级」「英超 · 第 5 轮」里的 A、轮次数字都是合法的。
  if (cn && !/[A-Za-z]{2,}/.test(cn)) okLeagues++; else missLeagues.add(m.league);
}

const totalTeams = okTeams + [...missTeams.values()].reduce((a, b) => a + b, 0);
console.log(`球队名命中 ${okTeams}/${totalTeams}  (${(okTeams / totalTeams * 100).toFixed(1)}%)`);
console.log(`联赛名命中 ${okLeagues}/${all.length}  (${(okLeagues / all.length * 100).toFixed(1)}%)`);

if (missTeams.size) {
  console.log(`\n❌ 未收录球队 ${missTeams.size} 个：`);
  for (const [n, c] of [...missTeams].sort((a, b) => b[1] - a[1])) console.log(`   ${n}  (${c} 场)`);
}
if (missLeagues.size) {
  console.log(`\n❌ 未翻译联赛 ${missLeagues.size} 个：`);
  for (const l of missLeagues) console.log(`   ${l}  →  ${zhLeague(l)}`);
}
if (!missTeams.size && !missLeagues.size) console.log('\n✅ 全部命中');

// —— 关键 bug 回归：HSV/PSV 不能再被砍成 H/P ——
console.log('\n回归检查（short() 后缀误伤）：');
for (const [en, want] of [['HSV', '汉堡'], ['PSV', '埃因霍温'], ['Hamburger SV', '汉堡'], ['1. FC Köln', '科隆']]) {
  const got = zhTeam(en);
  console.log(`   ${en} → ${got || '(未收录)'} ${got === want ? '✅' : '❌ 期望 ' + want}`);
}
