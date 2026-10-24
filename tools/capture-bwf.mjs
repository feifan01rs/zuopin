/**
 * 抓 BWF 官网（bwfbadminton.com）前端实际发出的 XHR/API 请求。
 *
 * 目的：BWF 没有公开 API 文档，唯一可靠的办法是看它自己的页面在调什么。
 * 用法：
 *   1) 先起一个带调试端口的 Chrome：
 *      chrome --headless=new --remote-debugging-port=9222 --user-data-dir=%TEMP%\cdpprof about:blank
 *   2) node tools/capture-bwf.mjs [页面URL] [等待毫秒]
 */
const PAGE = process.argv[2] || 'https://bwfbadminton.com/calendar/';
const WAIT = Number(process.argv[3] || 15000);

const ver = await (await fetch('http://127.0.0.1:9222/json/version')).json();

// Node 22 内置全局 WebSocket，直接用
const sock = new WebSocket(ver.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const mid = ++id; pending.set(mid, { res, rej });
  sock.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }));
});

const hits = [];
let ready = false;

sock.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id); pending.delete(msg.id);
    msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
    return;
  }
  if (!ready) return;
  if (msg.method === 'Network.requestWillBeSent') {
    const { request } = msg.params;
    const u = request.url;
    if (!/\.(js|css|png|jpg|jpeg|svg|woff2?|gif|ico|webp)(\?|$)/i.test(u) || /api|\/v\d|xhr|json/i.test(u)) {
      hits.push({ method: request.method, url: u, headers: request.headers, type: msg.params.type });
    }
  }
});

await new Promise(r => sock.addEventListener('open', r));
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Network.enable', {}, sessionId);
await send('Page.enable', {}, sessionId);
await send('Emulation.setUserAgentOverride', {
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
}, sessionId);
await send('Page.navigate', { url: PAGE }, sessionId);

await new Promise(r => setTimeout(r, 3000));
ready = true;
await new Promise(r => setTimeout(r, WAIT));

console.log(`\n共捕获 ${hits.length} 条请求\n`);
const seen = new Set();
for (const h of hits) {
  const key = h.url.replace(/\?.*$/, '') + '|' + h.method;
  const auth = Object.entries(h.headers || {})
    .filter(([k]) => /auth|token|api-key|x-/i.test(k))
    .map(([k, v]) => `${k}: ${String(v).slice(0, 60)}`).join(', ');
  console.log(`${h.method.padEnd(5)} ${h.url}`);
  if (auth) console.log(`      ${auth}`);
  if (seen.has(key)) console.log('      (同路径重复)');
  seen.add(key);
}
console.log('\n唯一路径：');
for (const k of new Set(hits.map(h => h.url.replace(/\?.*$/, '')).filter(u => !/\.(js|css|png|svg|woff2?|gif|ico|webp)$/i.test(u)))) console.log('  ' + k);
process.exit(0);
