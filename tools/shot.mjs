/**
 * 通用截图工具（自带 headless Chrome，用完自动关掉）
 *
 * 为什么需要：前端筛选、打开弹窗这类都是客户端行为，`chrome --screenshot` 只能截默认首屏。
 * 这里用 CDP：navigate → 执行一段 JS（可选）→ 等一会儿 → 截图。
 *
 * 用法：
 *   node tools/shot.mjs <输出png> [宽=1600] [高=1150] [要执行的JS] [等待ms=6000] [url]
 * 例：
 *   node tools/shot.mjs E:/下载/a.png 1600 1150 "document.querySelectorAll('.mrow')[0].click()" 3000
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const out = process.argv[2] || 'out.png';
const width = Number(process.argv[3] || 1600);
const height = Number(process.argv[4] || 1150);
const script = process.argv[5] || '';
const waitMs = Number(process.argv[6] || 6000);
const url = process.argv[7] || `http://127.0.0.1:8787/?v=${Date.now()}`;
const PORT = 9333;

const sleep = ms => new Promise(r => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'shot-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--autoplay-policy=no-user-gesture-required',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });

let ws, seq = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise(res => {
  const id = ++seq;
  pending.set(id, res);
  ws.send(JSON.stringify({ id, method, params }));
});

try {
  // 等 CDP 端口起来
  let ver = null;
  for (let i = 0; i < 40 && !ver; i++) {
    await sleep(300);
    try { ver = await fetch(`http://127.0.0.1:${PORT}/json/version`).then(r => r.json()); } catch {}
  }
  if (!ver) throw new Error('CDP 端口未就绪');

  const tab = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' }).then(r => r.json());
  ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };

  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url });
  await sleep(waitMs);

  if (script) {
    const r = await send('Runtime.evaluate', { expression: script, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) console.log('脚本报错:', JSON.stringify(r.result.exceptionDetails.text));
    else console.log('脚本结果:', JSON.stringify(r.result?.result?.value));
    await sleep(2500);
  }

  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
  console.log('✅ 已写入', out);
} finally {
  try { ws?.close(); } catch {}
  chrome.kill('SIGKILL');
}
