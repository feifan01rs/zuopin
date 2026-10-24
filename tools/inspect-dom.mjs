/**
 * 解析 Chrome --dump-dom 产出的「渲染后 DOM」，核对前端真实渲染结果。
 * 这比看截图精确：能直接数出日期条几个 chip、赛果分了几组、每组几张卡。
 * 用法：node tools/inspect-dom.mjs <dom文件路径>
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2];
const dom = readFileSync(file, 'utf-8');
const cut = (a, b) => {
  const i = dom.indexOf(a), j = b ? dom.indexOf(b) : dom.length;
  return (i < 0 || j < 0) ? '' : dom.slice(i, j);
};

let ok = true;
const check = (name, pass, extra = '') => {
  console.log(`  ${pass ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`);
  if (!pass) ok = false;
};

// ---------- 1. 头部徽章 ----------
console.log('\n[1] 数据源徽章');
const badge = dom.match(/id="srcBadge"[^>]*>([^<]*)</);
console.log(`  ${badge ? badge[1] : '(未找到)'}`);
check('徽章含「未来 15 天」', !!badge && /未来 15 天/.test(badge[1]));

// ---------- 2. 日期条 ----------
console.log('\n[2] 日期条（应为今天 + 未来 15 天 = 16 个）');
const strip = cut('id="dateStrip"', 'id="sportTabs"');
const chips = [...strip.matchAll(/<span class="text-sm font-bold whitespace-nowrap">([^<]*)<\/span>/g)].map(m => m[1]);
const counts = [...strip.matchAll(/<span class="text-\[10px\] leading-4[^"]*">([^<]*)<\/span>/g)].map(m => m[1]);
console.log(`  日期: ${chips.join(' | ')}`);
console.log(`  场次: ${counts.join(' | ')}`);
check('日期 chip 数为 16', chips.length === 16, `实际 ${chips.length}`);
check('第一个是「今天」', chips[0] === '今天');
check('跨度到 15 天后', chips.length >= 16);
const withGames = counts.filter(c => /\d/.test(c)).length;
console.log(`  其中 ${withGames} 天有比赛，${counts.length - withGames} 天为「—」`);

// ---------- 3. 赛程列表 ----------
console.log('\n[3] 当天赛程卡片');
const ml = cut('id="matchList"', 'id="resultHint"');
const matchCards = (ml.match(/onclick="openModal\(/g) || []).length;
console.log(`  渲染卡片数: ${matchCards}`);
check('赛程卡片 > 0', matchCards > 0);

// ---------- 4. 赛果分组 ----------
console.log('\n[4] 赛果回顾分组');
const rl = cut('id="resultList"', '<div class="brush-band');
const groups = [...rl.matchAll(/<span class="text-xs font-bold text-ink-1 font-num">([^<]*)<\/span>\s*<span class="text-\[11px\] text-ink-3">周([^<]*)<\/span>[\s\S]*?<span class="text-\[11px\] text-ink-3 font-num">(\d+) 场<\/span>/g)];
groups.forEach(g => console.log(`  ${g[1]} 周${g[2]} — ${g[3]} 场`));
const resultCards = (rl.match(/data-score="/g) || []).length;
const expandBtns = (rl.match(/onclick="expandResults\(/g) || []).length;
console.log(`  组数: ${groups.length} · 已渲染卡片: ${resultCards} · 「展开全部」按钮: ${expandBtns}`);
check('赛果按日期分组（≥10 组）', groups.length >= 10, `实际 ${groups.length}`);
check('每组默认折叠到 6 场（存在展开按钮）', expandBtns > 0, `实际 ${expandBtns}`);
const sumShown = resultCards;
console.log(`  默认展示 ${sumShown} 张，折叠隐藏 ${groups.reduce((s, g) => s + Number(g[3]), 0) - sumShown} 张（点「展开」可见）`);

// ---------- 5. 赛果标题统计 ----------
const hint = dom.match(/id="resultHint"[^>]*>([^<]*)</);
console.log(`  标题统计: ${hint ? hint[1] : '(空)'}`);
check('赛果统计显示「N 天 · M 场」', !!hint && /\d+ 天 · \d+ 场/.test(hint[1]));

// ---------- 6. 脏数据泄漏 ----------
console.log('\n[5] 渲染脏数据检查');
// ⚠️ 必须转义：'[object Object]' 里的方括号在正则中是字符类，不转义会匹配「任意一个字符」而狂报假阳性
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
for (const bad of ['undefined', 'NaN', '[object Object]']) {
  const n = (dom.match(new RegExp(esc(bad), 'g')) || []).length;
  check(`无 "${bad}" 泄漏`, n === 0, `出现 ${n} 次`);
}

console.log(`\n${ok ? '✅ 渲染结构全部正确' : '❌ 存在异常'}`);
process.exit(ok ? 0 : 1);
