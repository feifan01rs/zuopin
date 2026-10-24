/**
 * 线上部署诊断 —— 一眼判定「为什么部署后显示的还是演示数据」
 *
 * 用法：
 *   node tools/diagnose-online.mjs https://你的域名.vercel.app
 *   node tools/diagnose-online.mjs 你的域名.vercel.app          （自动补 https://）
 *
 * 它会依次检查：
 *   1. 首页能不能打开（静态托管是否正常）
 *   2. 首页里前端请求的接口地址是什么（有没有被写死成别的域名）
 *   3. /api/matches 到底返回了什么（状态码 / 类型 / CDN 缓存头 / 内容）
 *   4. 根据返回内容直接给出「根因 + 该怎么修」
 *
 * 脚本只发 GET 请求做只读探测，不会改动线上任何东西。
 */

const raw = process.argv[2];
if (!raw) {
  console.error('用法：node tools/diagnose-online.mjs <域名或完整URL>');
  console.error('例如：node tools/diagnose-online.mjs watch-schedule.vercel.app');
  process.exit(1);
}
const BASE = /^https?:\/\//i.test(raw) ? raw.replace(/\/+$/, '') : `https://${raw.replace(/\/+$/, '')}`;

const C = {
  ok: s => `\x1b[32m${s}\x1b[0m`,
  bad: s => `\x1b[31m${s}\x1b[0m`,
  warn: s => `\x1b[33m${s}\x1b[0m`,
  dim: s => `\x1b[90m${s}\x1b[0m`,
  b: s => `\x1b[1m${s}\x1b[0m`,
};

let problemCount = 0;
const findings = [];   // { level, title, detail, fix }

function finding(level, title, detail, fix) {
  if (level === 'bad') problemCount++;
  findings.push({ level, title, detail, fix });
}

console.log(C.b(`\n▶ 诊断目标：${BASE}\n`));

// ---------------------------------------------------------------- 1. 首页
async function checkHome() {
  console.log(C.b('[1/3] 首页静态托管'));
  let res;
  try {
    res = await fetch(BASE + '/', { redirect: 'follow' });
  } catch (e) {
    console.log(C.bad(`  ✗ 首页打不开：${e.message}`));
    finding('bad', '首页无法访问', e.message,
      '先确认域名拼写正确、项目部署状态是 Ready（不是 Error / Building）。');
    return null;
  }
  const html = await res.text();
  const isHtml = /<html/i.test(html) || /text\/html/.test(res.headers.get('content-type') || '');
  console.log(`  HTTP ${res.status} · ${(html.length / 1024).toFixed(0)} KB · ${isHtml ? 'HTML' : '非 HTML'}`);

  if (!isHtml) {
    console.log(C.bad('  ✗ 根路径返回的不是页面'));
    finding('bad', '根路径不是 HTML 页面', `Content-Type: ${res.headers.get('content-type')}`,
      '确认项目里有 index.html，且它位于仓库根目录（不能套一层文件夹）。');
    return html;
  }

  // 前端里写死的接口地址
  const forced = html.match(/__API_BASE__\s*=\s*['"]([^'"]*)['"]/);
  if (forced) {
    const val = forced[1];
    if (!val) {
      finding('bad', '前端把接口地址写成了空字符串', `window.__API_BASE__ = ''`,
        '这行会让前端永远走同域相对路径或直接回退演示数据。删掉这行（现在的版本支持自动判定）。');
      console.log(C.bad(`  ✗ 发现 window.__API_BASE__ = ''`));
    } else if (!val.includes(new URL(BASE).host)) {
      finding('warn', '前端接口地址指向了别的域名', `window.__API_BASE__ = '${val}'`,
        `如果那不是你的线上域名，前端会跨域请求失败并回退演示数据；改成 ${BASE} 或删掉这行。`);
      console.log(C.warn(`  ⚠ window.__API_BASE__ = '${val}'（与本域名不一致）`));
    } else {
      console.log(C.ok(`  ✓ window.__API_BASE__ = '${val}'`));
    }
  } else {
    console.log(C.ok('  ✓ 前端未写死接口地址（走同域 /api/matches，符合预期）'));
  }

  const hasFetch = /\/api\/matches/.test(html);
  console.log(hasFetch ? C.ok('  ✓ 前端确实会请求 /api/matches')
                       : C.warn('  ⚠ 前端代码里没找到 /api/matches'));
  if (!hasFetch) {
    finding('bad', '前端没有请求接口', '页面源码里找不到 /api/matches',
      '你上传的 index.html 可能是旧版本 / 演示版。请用项目里最新的 index.html 重新部署。');
  }
  return html;
}

// ------------------------------------------------------------ 2. 接口探测
async function checkApi() {
  console.log(C.b('\n[2/3] 接口 /api/matches'));
  let res;
  try {
    res = await fetch(BASE + '/api/matches', { headers: { 'cache-control': 'no-cache' } });
  } catch (e) {
    console.log(C.bad(`  ✗ 请求失败：${e.message}`));
    finding('bad', '接口请求失败', e.message, '检查域名是否可访问。');
    return;
  }

  const ct = res.headers.get('content-type') || '';
  const cacheHdr = res.headers.get('cache-control') || '(无)';
  const vercelCache = res.headers.get('x-vercel-cache') || '(无)';
  console.log(`  HTTP ${res.status} · ${ct.split(';')[0]}`);
  console.log(C.dim(`  cache-control: ${cacheHdr} · x-vercel-cache: ${vercelCache}`));

  const text = await res.text();

  // —— 404 / HTML：函数根本没部署
  if (res.status === 404 || (ct.includes('html') && res.status !== 200)) {
    console.log(C.bad('  ✗ 这个地址上没有任何函数（返回的是 Vercel 的 404 页面）'));
    finding('bad', 'API 函数没有部署 —— 最常见的原因：只上传了 index.html',
      'Vercel 只把你上传的内容当作静态站点。/api/matches 不存在，前端请求失败后回退成演示数据。',
      '把 api/ 目录一起上传：项目根必须是 index.html + api/matches.js + channels.json + package.json。\n'
      + '      建议直接拖「观赛预告-deploy」这个文件夹（已按此结构准备好）。');
    return;
  }

  if (res.status === 500 || res.status === 502 || res.status === 504) {
    console.log(C.bad(`  ✗ 函数执行出错（HTTP ${res.status}）`));
    finding('bad', `函数运行失败（HTTP ${res.status}）`,
      text.slice(0, 300),
      res.status === 504
        ? '函数执行超时。半个月窗口要并发访问上游，冷启动可能超过 30s；可以调小 PS_MAX_PAGES_PAST / RESULT_LOOKBACK_DAYS。'
        : '看 Vercel 后台 Functions 标签页的实时日志，报错信息会直接写在那里。');
    return;
  }

  if (!ct.includes('json')) {
    console.log(C.bad('  ✗ 返回的不是 JSON'));
    finding('bad', '接口返回了非 JSON 内容', text.slice(0, 200),
      '通常是路由被重写、或函数没被识别成 Serverless Function。');
    return;
  }

  let json;
  try { json = JSON.parse(text); } catch (e) {
    console.log(C.bad(`  ✗ JSON 解析失败：${e.message}`));
    finding('bad', 'JSON 解析失败', text.slice(0, 200), '检查函数返回体。');
    return;
  }

  const src = json.sources || {};
  const matches = json.matches || [];
  const results = json.results || [];

  // —— 缺环境变量
  const missing = src.missing_keys || [];
  if (missing.length) {
    console.log(C.bad(`  ✗ 未配置环境变量：${missing.join(' / ')}`));
    finding('bad', 'Vercel 上没配 API Key（.env 不会被上传，这是设计如此）',
      `缺失：${missing.join(' / ')}`,
      'Vercel 项目 → Settings → Environment Variables，添加 FOOTBALL_DATA_KEY 与 PANDASCORE_KEY（三个环境都勾），\n'
      + '      然后到 Deployments 里对最新部署点 Redeploy —— 改完环境变量不重新部署是不生效的。');
  } else if (json.sources) {
    console.log(C.ok('  ✓ 两个数据源的 Key 都已配置'));
  }

  // —— 有数据但为 0
  console.log(C.dim(`  sources: ${JSON.stringify(src)}`));
  console.log(`  赛程 ${matches.length} 场 · 赛果 ${results.length} 场`);
  if (src.channels_table === 'fallback') {
    console.log(C.warn('  ⚠ 渠道表用的是内置兜底副本（channels.json 没被打包进函数）'));
    finding('warn', 'channels.json 没能随函数一起打包',
      '渠道列可能偏少，但不影响赛事数据。',
      '把 channels.json 放在项目根目录并重新部署；函数会自动优先读取它。');
  } else if (src.channels_table === 'file') {
    console.log(C.ok('  ✓ 渠道表已随函数打包'));
  }

  if (matches.length === 0 && !missing.length) {
    const f = src.football ?? '?', e = src.esports ?? '?';
    console.log(C.bad(`  ✗ 一个数据都没取到（足球 ${f} / 电竞 ${e}）`));
    finding('bad', '函数跑通了但上游返回 0 场',
      `sources: ${JSON.stringify(src)} —— 前端拿到 0 场会判定失败并回退演示数据`,
      Number(src.football_rate_limited) > 0
        ? '本次足球源被限流（429），稍等重试即可。'
        : '逐个排除：① Key 是否有效（去 football-data.org / pandascore.co 后台确认）；② 函数日志里有没有上游报错。');
  } else if (matches.length > 0) {
    console.log(C.ok(`  ✓ 接口正常返回真实数据（${matches.length} 场赛程 / ${results.length} 场赛果）`));
    if (!results.length) {
      finding('warn', '接口正常，但赛果为 0', '赛程有数据、赛果为空',
        '如果只是"赛果回顾"区块显示示例数据，属这种情况；通常是最近 15 天确实没有已结束的比赛。');
    }
    if (src.football === 0) {
      finding('warn', '足球 0 场', '可能是被限流，也可能是当前没有赛事',
        '免费版限流 10 次/分钟；等 1 分钟刷新即可。');
    }
  }

  // —— CDN 缓存的影响
  const age = res.headers.get('age');
  if (age && Number(age) > 0) {
    console.log(C.dim(`  （本次命中了 CDN 缓存，数据是 ${age} 秒前的快照）`));
  }

  return { json, html: null };
}

// --------------------------------------------------------------- 3. 结论
function report() {
  console.log(C.b('\n[3/3] 结论'));
  if (!findings.length) {
    console.log(C.ok('  ✓ 没有发现明显问题：接口已接入，页面应该在展示真实数据。'));
    console.log(C.dim('    如果浏览器里仍显示演示数据，请强制刷新（Ctrl+F5）清掉旧的页面缓存。'));
    return;
  }
  findings.forEach((f, i) => {
    const tag = f.level === 'bad' ? C.bad('✗ 问题') : C.warn('⚠ 注意');
    console.log(`\n  ${tag} ${i + 1}：${C.b(f.title)}`);
    console.log(`    现象：${f.detail}`);
    console.log(`    处理：${f.fix}`);
  });
  console.log(`\n  共 ${problemCount} 个会导致「显示演示数据」的问题。\n`);
}

try {
  await checkHome();
  await checkApi();
  report();
} catch (e) {
  console.error(C.bad(`\n诊断中断：${e.message}`));
  process.exit(1);
}
