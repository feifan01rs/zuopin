/**
 * 把浏览器里「CDN 版 Tailwind 实际生成的 CSS」dump 出来，作为对比基准。
 *
 * 为什么不用「文本里找类名」那种土办法：
 *   cdn.tailwindcss.com 是运行时扫描 DOM 生成样式的，它生成的规则集合
 *   **就是**「页面真正需要的样式」的权威定义。dump 这份再和编译产物对比，
 *   才能零猜测地判断「编译版到底有没有掉样式」。
 *
 * 用法（先确保本地服务 8787 与调试 Chrome 9222 都在跑）：
 *   node tools/dump-css.mjs [输出文件] [页面URL]
 */
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] || join(__dirname, '..', 'build', 'tw', 'cdn-generated.css');
const url = process.argv[3] || 'http://127.0.0.1:8787/';

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = list.find(t => t.type === 'page');
if (!page) { console.error('没有可用标签页'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise(r => {
  const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params }));
});

const waitLoad = () => new Promise(r => {
  const t = setTimeout(() => { ws.onmessage0 = null; r(); }, 25000);
  const prev = ws.onmessage;
  ws.onmessage = (e) => {
    prev(e);
    const m = JSON.parse(e.data);
    if (m.method === 'Page.loadEventFired') { clearTimeout(t); ws.onmessage = prev; r(); }
  };
});

await send('Page.enable');
await send('Runtime.enable');
// 给 CDN 留足时间下载 + 生成（首次可能几秒）
await send('Page.navigate', { url });
await waitLoad();
await new Promise(r => setTimeout(r, 6000));

// ⚠️ 只抓 Tailwind 那张样式表：page 自带的 <style> 里是 .card/.oil-hero 这些自定义类，
//    混进来会被 check-css 误判成「编译后缺失」。判据 = 表里出现 `--tw-` 变量
//    （preflight 和 utilities 同表，所以整表保留）。
const expr = `(() => {
  const out = [];
  for (const sheet of document.styleSheets) {
    let rules = [];
    try { rules = [...sheet.cssRules]; } catch (e) { continue; }
    const text = rules.map(r => r.cssText).join('\\n');
    if (!text.includes('--tw-')) continue;
    out.push(text);
  }
  return out.join('\\n');
})()`;
const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
const css = res.result?.result?.value || '';
if (!css.trim()) {
  console.error('❌ 没抓到任何 CSS 规则 —— CDN 可能没加载成功（或页面本身就没样式）');
  process.exit(1);
}
writeFileSync(out, css, 'utf8');
console.log(`✅ 已 dump ${(css.length / 1024).toFixed(1)} KB → ${out}`);
ws.close();
