/**
 * 验证「线上跑的是旧版函数」这条诊断路径真的会亮起来。
 *
 * 为什么需要它：中文化只在函数层做，如果线上没 Redeploy，页面数据是全的、
 * 看着一切正常，只有联赛名还是英文 —— 没有任何报错。这条告警就是专门抓它的，
 * 所以必须证明它确实会触发，而不是写了却永远不亮。
 *
 * 做法：起一个假接口（返回**不带 build 字段**的旧版 payload），
 * 用 CDP 把页面的 window.__API_BASE__ 指向它，再看诊断横幅有没有出现。
 *
 * 用法：node tools/check-oldver-diag.mjs
 */
import http from 'node:http';

// ---- 假：旧版函数（有数据、有 updatedAt，就是没有 build） ----
const STUB = {
  updatedAt: new Date().toISOString(),
  sources: { football: 1, esports: 0, results: 0 },
  matches: [{ id: 'x1', sport: 'football', league: 'Premier League · 第 5 轮', home: 'Fulham', away: 'Man United', utcDate: new Date(Date.now() + 3600e3).toISOString(), status: 'SCHEDULED', channels: [] }],
  results: [],
};
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(STUB));
});
await new Promise(r => server.listen(8789, '127.0.0.1', r));

// ---- CDP ----
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = list.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });

await send('Page.enable');
await send('Runtime.enable');
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `window.__API_BASE__ = 'http://127.0.0.1:8789';`,
});
const loaded = new Promise(r => {
  const prev = ws.onmessage;
  const t = setTimeout(() => { ws.onmessage = prev; r(); }, 20000);
  ws.onmessage = (e) => { prev(e); if (JSON.parse(e.data).method === 'Page.loadEventFired') { clearTimeout(t); ws.onmessage = prev; r(); } };
});
await send('Page.navigate', { url: 'http://127.0.0.1:8787/' });
await loaded;
await new Promise(r => setTimeout(r, 3000));

const r = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
    badge: (document.getElementById('srcBadge')||{}).textContent || '',
    diagHidden: document.getElementById('apiDiag').classList.contains('hidden'),
    diag: document.getElementById('apiDiag').textContent.replace(/\\s+/g,' ').trim().slice(0,160),
    firstLeague: (document.querySelector('#matchList')||{}).textContent?.trim().slice(0,40) || '',
  })`,
  returnByValue: true,
});
const v = JSON.parse(r.result.result.value);
console.log('徽章：', v.badge);
console.log('横幅隐藏？', v.diagHidden);
console.log('横幅内容：', v.diag || '(空)');

const ok = !v.diagHidden && /旧版|没自报版本号/.test(v.diag) && /疑旧版/.test(v.badge);
console.log(ok ? '\n✅ 旧版函数告警正常触发' : '\n❌ 告警没触发，检查 renderApiDiag / API_BUILD');
ws.close(); server.close();
process.exit(ok ? 0 : 1);
