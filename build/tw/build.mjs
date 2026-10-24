/**
 * Tailwind 编译 + 内联进 index.html —— 一条命令搞定「去 CDN 化」。
 *
 * 为什么这样做：
 *   index.html 原本依赖 https://cdn.tailwindcss.com（约 400KB 的 JS，运行时才生成 CSS）。
 *   国内访问该域名经常超时 → 页面白屏、完全没样式，看起来像「网站挂了」。
 *   改成预先编译好的本地 CSS（约 16KB）内联进 HTML 后：
 *     零外部依赖 · 秒开 · 断网也能看 · 少一次跨域请求。
 *
 * 关键细节：
 *   - 编译产物必须插在页面自带 <style> 的**后面**。CDN 版是运行时注入的，
 *     天然排在后面；顺序一变，`.card:hover` 这类自定义样式会反过来盖掉 Tailwind，
 *     视觉上会有细微差异。
 *   - 幂等：重复跑只会替换那一块，不会越插越多。
 *
 * 用法：node build/tw/build.mjs
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const HTML = join(ROOT, 'index.html');
const TW_CSS = join(__dirname, 'tailwind.css');
const CONFIG = join(__dirname, 'tailwind.config.cjs');
const INPUT = join(__dirname, 'input.css');

// 托管 node + 隔离工作区里的 tailwindcss（不污染项目目录）
const NODE = 'C:/Users/ALOBON/.workbuddy/binaries/node/versions/22.22.2-2/node.exe';
const CLI = 'C:/Users/ALOBON/.workbuddy/binaries/node/workspace/node_modules/tailwindcss/lib/cli.js';

const MARKER_RE = /<!-- ===== Tailwind 本地编译[\s\S]*?<\/style>\s*/;
const BLOCK = (css) => `<!-- ===== Tailwind 本地编译（替代 cdn.tailwindcss.com；重建：node build/tw/build.mjs）===== -->
<style id="tw-compiled">${css}</style>
`;

// ---------- 1. 编译 ----------
if (!existsSync(CLI)) {
  console.error('❌ 找不到 tailwindcss CLI：' + CLI);
  console.error('   先装：cd <node workspace> && npm i tailwindcss@3.4.17 --registry=https://registry.npmmirror.com');
  process.exit(1);
}

// 2026-10 改版后 index.html 已改成**纯手写 CSS**（深色监控台风格），不再用 Tailwind。
// 这个脚本留着是为了「万一想切回去」；直接跑会把 preflight 注入进来、把新样式悄悄改掉 —— 所以先挡一道。
{
  const html0 = readFileSync(HTML, 'utf8');
  if (!html0.includes('id="tw-compiled"') && /纯手写 CSS/.test(html0)) {
    console.log('⏭  当前 index.html 是纯手写 CSS 版本，不需要 Tailwind 编译，已跳过。');
    console.log('   真要用 Tailwind：给 <head> 加回编译块占位，再删掉这段守卫。');
    process.exit(0);
  }
}
console.log('① 编译 Tailwind…');
execFileSync(NODE, [CLI, '-c', CONFIG, '-i', INPUT, '-o', TW_CSS, '--minify'], { stdio: 'pipe' });
const css = readFileSync(TW_CSS, 'utf8').trim();
console.log(`   → ${(css.length / 1024).toFixed(1)} KB`);

// ---------- 2. 内联 ----------
console.log('② 内联进 index.html…');
let html = readFileSync(HTML, 'utf8');
const before = html.length;

// 留一份 CDN 版备份，方便日后 diff / 回退（只留第一次的）
const bak = join(__dirname, 'index.cdn-backup.html');
if (!existsSync(bak)) { copyFileSync(HTML, bak); console.log('   → 已备份 CDN 版到 build/tw/index.cdn-backup.html'); }

// 2a. 移除 CDN <script> 和它的 tailwind.config 块
const removedCdn = /<script\s+src="https:\/\/cdn\.tailwindcss\.com"><\/script>\s*<script>[\s\S]*?<\/script>\s*/;
if (removedCdn.test(html)) {
  html = html.replace(removedCdn, '');
  console.log('   → 已移除 CDN script + tailwind.config');
} else if (!/<script[^>]*\bsrc=["']https:\/\/cdn\.tailwindcss\.com["']/.test(html)) {
  // ⚠️ 这里必须判断**真实的 script 标签**，不能用 html.includes('cdn.tailwindcss.com')：
  //    内联块自己的注释里就写着这个域名，用 includes 判定会导致「第二次跑必报错」。
  console.log('   → CDN 已被移除（幂等，跳过）');
} else {
  console.error('❌ 检测到 cdn.tailwindcss.com，但结构不符合预期，未自动移除。请手工检查第 7 行附近。');
  process.exit(1);
}

// 2b. 写入/替换编译块（必须排在自带 <style> 之后）
const hadBlock = MARKER_RE.test(html);
html = html.replace(MARKER_RE, '');
const firstStyleClose = html.indexOf('</style>');
if (firstStyleClose === -1) {
  console.error('❌ 找不到自带 <style> 块，无法确定插入位置');
  process.exit(1);
}
const at = firstStyleClose + '</style>'.length;
html = html.slice(0, at) + '\n' + BLOCK(css) + html.slice(at);

writeFileSync(HTML, html, 'utf8');
console.log(`   → ${hadBlock ? '替换' : '插入'}编译块，index.html ${before} → ${html.length} 字节`);
console.log('✅ 完成。跑 node tools/check-css.mjs 验收覆盖率。');
