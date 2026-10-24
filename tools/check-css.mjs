/**
 * 编译版 vs CDN 版 Tailwind —— 逐类对比，确认「没有掉样式」。
 *
 * 原理：
 *   cdn.tailwindcss.com 是运行时扫描真实 DOM 生成 CSS 的，它生成的规则集合
 *   就是「这个页面真正需要的样式」的权威基线。
 *   拿它和本地编译产物对比，谁多谁少一目了然 —— 比在源码里正则找类名靠谱得多
 *   （那种做法会把 URL、JS 变量名都当成类名，噪声极大）。
 *
 * 用法：
 *   1) node tools/dump-css.mjs        # 必须在「还没去 CDN」的版本上跑，产出基线
 *   2) node build/tw/build.mjs        # 编译 + 内联
 *   3) node tools/check-css.mjs       # 对比，退出码 0 = 无缺失
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = join(__dirname, '..', 'build', 'tw', 'cdn-generated.css');
const COMPILED = join(__dirname, '..', 'build', 'tw', 'tailwind.css');

for (const [p, tip] of [[BASE, '先跑 node tools/dump-css.mjs'], [COMPILED, '先跑 node build/tw/build.mjs']]) {
  if (!existsSync(p)) { console.error(`❌ 缺文件 ${p}\n   ${tip}`); process.exit(1); }
}

/** 从 CSS 文本里抽出所有类名（带转义处理：.hover\:bg-x:hover → hover:bg-x） */
function classSet(css) {
  const RE = /\.((?:\\[\s\S]|[^\\\s{},>+~()"'[\]:#%.])+)/g;
  const set = new Set();
  for (const m of css.matchAll(RE)) {
    const t = m[1].replace(/\\(.)/g, '$1');
    if (t && !/^\d/.test(t)) set.add(t);
  }
  return set;
}

const esc = (t) => t.replace(/[!/.[\]%#(),:;+~>'"@]/g, (m) => '\\' + m);

const baseCss = readFileSync(BASE, 'utf8');
const compCss = readFileSync(COMPILED, 'utf8');
const base = classSet(baseCss);
const comp = classSet(compCss);

const missing = [...base].filter(c => !compCss.includes('.' + esc(c)) && !compCss.includes('.' + c));
const extra = [...comp].filter(c => !baseCss.includes('.' + esc(c)) && !baseCss.includes('.' + c));

console.log(`CDN 基线类名 ${base.size} 个（${(baseCss.length / 1024).toFixed(1)} KB）`);
console.log(`编译产物类名 ${comp.size} 个（${(compCss.length / 1024).toFixed(1)} KB）`);

if (extra.length) {
  console.log(`\nℹ️  编译产物多出 ${extra.length} 个（无害，通常是被 <style> 里字符串误抓的候选）：`);
  console.log('   ' + extra.slice(0, 12).join(', ') + (extra.length > 12 ? ` …` : ''));
}

if (missing.length === 0) {
  console.log('\n✅ 无缺失：CDN 生成过的每一类，编译产物里都有');
  process.exit(0);
}
console.log(`\n❌ 有 ${missing.length} 个类只存在于 CDN 版，编译后会掉样式：`);
for (const m of missing) console.log('   ' + m);
console.log('\n修法：写进 build/tw/tailwind.config.cjs 的 safelist 后重新编译。');
process.exit(1);
