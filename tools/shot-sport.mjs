/**
 * 截图指定项目（足球/电竞）的页面视图
 * ------------------------------------------------------------
 * 为什么要这么绕：前端的「⚽ 足球 / 🎮 电竞」是纯客户端筛选，不支持 URL 参数，
 * 所以 --screenshot 只能截到默认的「全部」。这里用 CDP 连上 headless Chrome，
 * 先模拟点击筛选按钮，再截图。
 *
 * 用法：
 *   1) 另开一个终端启动带调试端口的 Chrome：
 *      chrome --headless=new --remote-debugging-port=9222 --user-data-dir=%TEMP%\cdpprof about:blank
 *   2) node tools/shot-sport.mjs <sport> <输出png> [视口高度] [宽度]
 *      sport = football | esports | all
 *      ⚠️ 会同时点击「赛程」和「赛果」两个筛选条。若只想要赛程视图把 sport 写成
 *         `football-sched`（只点赛程筛选，不碰赛果，避免页面被滚到赛果区）。
 */
const DEBUG = 'http://127.0.0.1:9222';
const PAGE = 'http://127.0.0.1:8787/';

const rawSport = process.argv[2] || 'football';
// football-sched → 只筛赛程（不点赛果筛选，页面停在顶部）
const onlySched = rawSport.endsWith('-sched');
const sport = rawSport.replace('-sched', '');
const out = process.argv[3] || `E:/下载/观赛预告-${rawSport}.png`;
const height = Number(process.argv[4] || 4200);
const width = Number(process.argv[5] || 1440);

const sleep = ms => new Promise(r => setTimeout(r, ms));

// —— 新建标签页（新版 Chrome 要求 PUT）——
const created = await fetch(`${DEBUG}/json/new?about:blank`, { method: 'PUT' }).then(r => r.json());
const ws = new WebSocket(created.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let seq = 0;
const pending = new Map();
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise(res => {
  const id = ++seq;
  pending.set(id, res);
  ws.send(JSON.stringify({ id, method, params }));
});

await send('Page.enable');
// 视口先给足高度，配合 captureBeyondViewport=false 截「前 N 像素」
await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: PAGE });
await sleep(6000);   // 等首屏数据渲染

const click = await send('Runtime.evaluate', {
  expression: `(()=>{
    const a=document.querySelector('[data-sport="${sport}"]');
    const b=${onlySched} ? null : document.querySelector('[data-rsport="${sport}"]');
    if(a) a.click(); if(b) b.click();
    return (a?'sport-ok':'sport-missing')+'/'+(${onlySched} ? 'sched-only' : (b?'res-ok':'res-missing'));
  })()`,
  returnByValue: true,
});
console.log('筛选按钮点击结果:', click.result?.result?.value || JSON.stringify(click.result));
await sleep(2000);

// 可选：再点一个按钮（常用于点日期条上的「明天」，看未来赛程）
// 用法：第 6 个参数传按钮文本，如 明天
const clickText = process.argv[6] || '';
if (clickText) {
  const r = await send('Runtime.evaluate', {
    expression: `(()=>{
      const btn=[...document.querySelectorAll('button')].find(b=>(b.textContent||'').includes(${JSON.stringify(clickText)}));
      if(!btn) return 'btn-missing:'+${JSON.stringify(clickText)};
      btn.click(); return 'clicked:'+btn.textContent.trim().slice(0,12);
    })()`,
    returnByValue: true,
  });
  console.log('额外点击:', r.result?.result?.value);
  await sleep(1500);
}

// 可选：滚动到某个元素再截图（第 7 个参数传 CSS 选择器，如 #resultList）
// 用途：赛果区在页面下半部分，不滚动截不到
const scrollSel = process.argv[7] || '';
if (scrollSel) {
  const r = await send('Runtime.evaluate', {
    expression: `(()=>{
      const el=document.querySelector(${JSON.stringify(scrollSel)});
      if(!el) return 'sel-missing';
      el.scrollIntoView({block:'start'});
      window.scrollBy(0,-120);        // 上方留点上下文
      return 'scrolled:'+Math.round(window.scrollY);
    })()`,
    returnByValue: true,
  });
  console.log('滚动:', r.result?.result?.value);
  await sleep(800);
}

const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
const buf = Buffer.from(shot.result.data, 'base64');
const { writeFileSync, mkdirSync } = await import('node:fs');
const { dirname } = await import('node:path');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, buf);
console.log(`已保存 ${out}  (${(buf.length / 1024).toFixed(0)} KB, ${width}x${height})`);

await send('Page.close');
ws.close();
