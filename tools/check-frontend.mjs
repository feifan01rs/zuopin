/**
 * 前端语法体检：把 index.html 里的 <script> 块抽出来做语法检查。
 * 只校验语法，不执行 —— 页面逻辑依赖 DOM，本地 node 跑不了。
 * 顺带检查三个历史坑：script 提前闭合、重复声明的顶层常量、残留的 csgo。
 */
import { readFileSync } from 'node:fs';

const html = readFileSync('D:/桌面/飞书下载/观赛预告/index.html', 'utf-8');

// ① script 块数量与提取
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
console.log(`[1] 提取到 ${blocks.length} 个 <script> 块`);
// 取「最长的那块」当主逻辑。
// ⚠️ 别硬编码 blocks[1]：去 CDN 之前是 [tailwind.config, 主逻辑] 两块，
//    去 CDN 之后 tailwind.config 那块没有了 → blocks[1] 是 undefined，
//    main 变成空串，下面所有结构断言会**全部假失败**（曾经真的这么误报过一次）。
const main = blocks.slice().sort((a, b) => b.length - a.length)[0] || '';

// ② 逐块语法检查
let ok = true;
blocks.forEach((code, i) => {
  try {
    new Function(code);                       // 只解析不执行
    console.log(`    ✓ script#${i} 语法正常 (${code.split('\n').length} 行)`);
  } catch (e) {
    ok = false;
    console.log(`    ✗ script#${i} 语法错误: ${e.message}`);
  }
});

// ③ 顶层重复声明检查（曾在改造中把 DAY_LABEL / WD 搬来搬去搬出重复声明）

for (const name of ['DAY_LABEL', 'WD', 'LOOKAHEAD_DAYS', 'BLOCKED_GAMES', 'GAME_ICON', 'RESULTS', 'MATCHES']) {
  const n = (main.match(new RegExp(`^\\s*(?:const|let|var)\\s+${name}\\s*=`, 'gm')) || []).length;
  console.log(`    ${n === 1 ? '✓' : '✗'} ${name.padEnd(15)} 顶层声明 ${n} 次${n === 1 ? '' : ' ← 应为 1'}`);
  if (n !== 1) ok = false;
}

// ④ 残留检查
const checks = [
  ['无 csgo 图标映射残留', !/GAME_ICON[^\n]*csgo/.test(main)],
  ['无 CS2 mock 场次残留', !/CS2 Major/.test(main)],
  ['日期条用 LOOKAHEAD_DAYS 上限', /i<=LOOKAHEAD_DAYS/.test(main)],
  ['赛事窗口已放到 15 天', /m\.day <= LOOKAHEAD_DAYS/.test(main)],
  ['赛果按日期分组', /groups\.get\(r\.dateKey\)/.test(main)],
  ['赛果折叠函数存在', /function expandResults/.test(main) && /function collapseResults/.test(main)],
  ['注入点 backToday 存在', /getElementById\('backToday'\)/.test(main)],
  ['注入点 resultHint 存在', /resultHint/.test(html)],
  ['注入点 resultTabs 存在', /rsport-tab/.test(html)],
];
console.log(`\n[3] 关键结构与残留`);
for (const [name, pass] of checks) {
  console.log(`    ${pass ? '✓' : '✗'} ${name}`);
  if (!pass) ok = false;
}

console.log(`\n${ok ? '✅ 前端体检通过' : '❌ 存在问题，需修复'}`);
process.exit(ok ? 0 : 1);
