/**
 * 「国内访问体验」验收 —— 在掐断所有外部 CDN 的环境里加载页面。
 *
 * 验三件事：
 *   ① 页面发出的请求里，有没有任何一个指向外域（有 = 还有依赖没拔干净）
 *   ② 故意 block 掉 tailwindcss/googlefonts/jsdelivr/unpkg 等常见 CDN 后，样式是否还在
 *   ③ 直接对真实浏览器算出的 computedStyle 做断言（比截图肉眼比更硬）
 *
 * 用法（需要 8787 服务 + 9222 调试 Chrome）：
 *   node tools/verify-offline.mjs [页面URL] [截图输出路径]
 */
import { writeFileSync } from 'node:fs';

const url = process.argv[2] || 'http://127.0.0.1:8787/';
const shot = process.argv[3] || 'E:/下载/观赛预告-国内访问优化.png';

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = list.find(t => t.type === 'page');
if (!page) { console.error('没有可用标签页'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0;
const pending = new Map();
const requests = [];
const blocked = [];

ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Network.requestWillBeSent') requests.push(m.params.request.url);
  if (m.method === 'Network.loadingFailed' && m.params.blockedReason) {
    blocked.push(m.params.blockedReason + ' ' + (m.params.requestId || ''));
  }
};
const send = (method, params = {}) => new Promise(r => {
  const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params }));
});

// 模拟「国内网络访问不到这些境外 CDN」—— 这正是用户遇到的场景
const CDN_PATTERNS = [
  '*cdn.tailwindcss.com*', '*tailwindcss.com/*', '*cdn.jsdelivr.net*',
  '*unpkg.com*', '*cdnjs.cloudflare.com*', '*fonts.googleapis.com*', '*fonts.gstatic.com*',
];

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
await send('Network.setBlockedURLs', { urls: CDN_PATTERNS });
await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1500, deviceScaleFactor: 1, mobile: false });

const loaded = new Promise(r => {
  const prev = ws.onmessage;
  const t = setTimeout(() => { ws.onmessage = prev; r(); }, 30000);
  ws.onmessage = (e) => {
    prev(e);
    if (JSON.parse(e.data).method === 'Page.loadEventFired') { clearTimeout(t); ws.onmessage = prev; r(); }
  };
});
await send('Page.navigate', { url });
await loaded;
await new Promise(r => setTimeout(r, 5000));

// ---- ① 外域请求体检 ----
const external = [...new Set(requests)].filter(u => !/^https?:\/\/(127\.0\.0\.1|localhost)\b/.test(u));

// ---- ③ computedStyle 断言（临时插元素，直接问浏览器「这个类生效了吗」）----
const PROBES = [
  ['bg-sea-500', 'backgroundColor', 'rgb(90, 185, 222)'],
  ['text-ink-1', 'color', 'rgb(30, 58, 76)'],
  ['bg-sea-50', 'backgroundColor', 'rgb(234, 246, 251)'],
  ['bg-white', 'backgroundColor', 'rgb(255, 255, 255)'],
  ['bg-cloud/90', 'backgroundColor', 'rgba(249, 253, 253, 0.9)'],
  ['rounded-full', 'borderRadius', '9999px'],
  ['flex', 'display', 'flex'],
  ['hidden', 'display', 'none'],
  ['shadow-card', 'boxShadow', null],   // 只校验「不是 none」
  ['font-num', 'fontFamily', null],     // 只校验含 DIN Alternate
];
const probeExpr = `(() => {
  const probes = ${JSON.stringify(PROBES)};
  const box = document.createElement('div');
  document.body.appendChild(box);
  const out = [];
  for (const [cls, prop, want] of probes) {
    box.className = cls;
    const got = getComputedStyle(box)[prop];
    out.push([cls, prop, String(got), want]);
  }
  box.remove();
  const header = document.querySelector('header');
  out.push(['<header>', 'position', header ? getComputedStyle(header).position : '(无)', 'sticky']);
  return out;
})()`;
const pr = await send('Runtime.evaluate', { expression: probeExpr, returnByValue: true });
const rows = pr.result?.result?.value || [];

// ---- ② 截图 ----
const cap = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(shot, Buffer.from(cap.result.data, 'base64'));

// ---- 汇总 ----
let pass = 0, fail = 0;
console.log(`\n① 网络请求体检：共 ${new Set(requests).size} 个地址`);
if (external.length === 0) { console.log('   ✅ 零外域请求（全部同域/本地）'); pass++; }
else { console.log(`   ❌ 仍有 ${external.length} 个外域请求：`); external.forEach(u => console.log('      ' + u)); fail++; }
console.log(`   已屏蔽的 CDN 模式：${CDN_PATTERNS.length} 条（本次实际被拦截 ${blocked.length} 次）`);

console.log('\n② 样式断言（掐断 CDN 后逐个验证）');
for (const [cls, prop, got, want] of rows) {
  let ok;
  if (want === null) {
    ok = prop === 'boxShadow' ? got !== 'none' : /DIN Alternate/.test(got);
  } else ok = got === want;
  console.log(`   ${ok ? '✅' : '❌'} .${cls} → ${prop}: ${got}${ok || want === null ? '' : `  (期望 ${want})`}`);
  ok ? pass++ : fail++;
}

console.log(`\n③ 截图：${shot}`);
console.log(`\n${fail === 0 ? '✅ 全部通过' : `❌ ${fail} 项未通过`}（通过 ${pass} 项）`);
ws.close();
process.exit(fail === 0 ? 0 : 1);
