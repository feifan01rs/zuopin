/**
 * 全量队名缺口扫描
 * ------------------------------------------------------------
 * 把 football-data.org 八个联赛里**所有**球队的 shortName / name 都拉下来，
 * 逐一对照 lib/zh.js，输出没收录的清单 —— 一次性补齐，不用等比赛出现才发现漏译。
 *
 * ⚠️ 免费版限流 10 次/分钟，所以这里串行 + 间隔 6.5s，跑完约 50 秒。
 * 用法：node tools/dump-teams.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zhTeam, zhLeague } from '../lib/zh.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// 从 .env 读 Key 与联赛列表
function envVal(key) {
  const p = join(ROOT, '.env');
  if (!existsSync(p)) return '';
  const line = readFileSync(p, 'utf-8').split(/\r?\n/).find(l => l.startsWith(key + '='));
  return line ? line.slice(key.length + 1).replace(/^["']|["']$/g, '').trim() : '';
}
const KEY = process.env.FOOTBALL_DATA_KEY || envVal('FOOTBALL_DATA_KEY');
const COMPS = (envVal('FB_COMPETITIONS') || 'PL,PD,SA,BL1,FL1,CL,BSA,ELC').split(',').map(s => s.trim());
const sleep = ms => new Promise(r => setTimeout(r, ms));

const seen = new Map();   // name → {shortName, count}
let first = true;
for (const comp of COMPS) {
  if (!first) await sleep(6500); first = false;
  try {
    const r = await fetch(`https://api.football-data.org/v4/competitions/${comp}/matches`, { headers: { 'X-Auth-Token': KEY } });
    if (!r.ok) { console.log(`[${comp}] HTTP ${r.status}，跳过`); continue; }
    const { matches = [] } = await r.json();
    for (const m of matches) {
      for (const t of [m.homeTeam, m.awayTeam]) {
        if (!t?.name) continue;
        const k = `${t.shortName || ''}|${t.name}`;
        if (!seen.has(k)) seen.set(k, { comp, shortName: t.shortName, name: t.name });
      }
    }
    const lz = matches[0]?.competition?.name;
    console.log(`[${comp}] ${matches.length} 场，联赛名「${lz}」→「${zhLeague(lz || '')}」`);
  } catch (e) { console.log(`[${comp}] 失败: ${e.message}`); }
}

console.log(`\n共 ${seen.size} 支球队（含重复写法）\n`);
const miss = [];
for (const v of seen.values()) {
  const hit = zhTeam(v.shortName) || zhTeam(v.name);
  if (!hit) miss.push(v);
}
console.log(`❌ 未收录 ${miss.length} 支：`);
for (const v of miss.sort((a, b) => a.comp.localeCompare(b.comp))) {
  console.log(`   [${v.comp}] shortName="${v.shortName}"  name="${v.name}"`);
}
if (!miss.length) console.log('   （无）');
