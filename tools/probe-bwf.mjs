/**
 * BWF（世界羽联）数据探测工具
 * ===============================================================
 * 结论先行：BWF **没有公开开发者 API**，但官网自己的前端在调一套
 * 内部接口，**零鉴权、零 Key**，只要带上官网 Referer 就能取到干净 JSON。
 * 本工具把这套接口固化下来，方便随时取数和验证。
 *
 * 接口来源：从 bwfbadminton.com 页面内联的 Vue 组件代码里读出来的（非猜测）。
 *
 * ⚠️ 两个必须知道的坑（都实测过）：
 *   1) 必须走 curl，不能用 Node 的 fetch / https
 *      —— Cloudflare 按 TLS 指纹拦截：Node(undici/OpenSSL) 一律 403
 *         「Attention Required! | Cloudflare」，curl(Windows Schannel) 200。
 *         所以这里用 execFile 调 curl。
 *   2) 有短时 IP 限流：连续几十次请求后会 403，**冷却约 30~60 秒自动恢复**。
 *         正常同步（几次请求）没问题，但别循环猛刷。
 *
 * 用法：
 *   node tools/probe-bwf.mjs live                    当前进行中/最近赛事
 *   node tools/probe-bwf.mjs list [起] [止]           列区间赛事
 *   node tools/probe-bwf.mjs matches <tmtId>          列某赛事对阵（含比分）
 *   node tools/probe-bwf.mjs window [天数]            未来 N 天全部赛事 + 场次统计
 */

import { execFile } from 'node:child_process';

const API = 'https://extranet-lv.bwfbadminton.com/api';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** 用 curl 取 JSON（Node fetch 会被 Cloudflare 403，见文件头注释） */
function curlJson(url, timeout = 60) {
  return new Promise((resolve, reject) => {
    execFile('curl', [
      // ⚠️ 不要加 --compressed：Windows 自带 curl 8.0.1(Schannel) 不带该选项，会直接报错退出
      '-s', '-m', String(timeout),
      '-H', `Accept: application/json, text/plain, */*`,
      '-H', `Referer: https://bwfbadminton.com/`,
      '-H', `Origin: https://bwfbadminton.com`,
      '-H', `User-Agent: ${UA}`,
      '-w', '\n__HTTP__%{http_code}',
      url,
    ], { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (err, stdout) => {
      if (err) return reject(err);
      const m = stdout.match(/\n__HTTP__(\d+)\s*$/);
      const body = stdout.replace(/\n__HTTP__\d+\s*$/, '');
      const code = m ? Number(m[1]) : 0;
      if (code !== 200) {
        return reject(new Error(`HTTP ${code}${code === 403 ? '（Cloudflare 拦截：可能触发了限流，等 30~60 秒再试）' : ''}`));
      }
      try { resolve(JSON.parse(body)); }
      catch { reject(new Error('返回不是 JSON：' + body.slice(0, 120))); }
    });
  });
}

const api = (path, params = {}) => {
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
  );
  return curlJson(`${API}${path}${qs.toString() ? '?' + qs : ''}`);
};

const d2 = (dt) => dt.toISOString().slice(0, 10);

/** 按日期区间列赛事（自动翻页） */
async function searchTournaments(start, end, { perPage = 100, maxPages = 4 } = {}) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const j = await api('/vue-tournaments-search', {
      startDate: start, endDate: end, page, perPage, drawCount: 1, activeTab: 1,
    });
    const rows = j?.results?.data || [];
    out.push(...rows);
    if (page >= (j?.results?.last_page ?? 1) || !rows.length) break;
    await sleep(1200);
  }
  return out;
}

/** 某赛事全部对阵 → 扁平数组 */
async function tournamentMatches(tmtId) {
  const j = await api('/vue-tournament-matches', { tmtId });
  const byCourt = j?.results?.by_court || {};
  const out = [];
  for (const [round, matches] of Object.entries(byCourt)) {
    for (const [mid, m] of Object.entries(matches)) out.push({ ...m, _round: round, _key: mid });
  }
  return out;
}

/** 某赛事某天的对阵（B4U 接口，结构最干净：时间/球场/状态/逐局比分）
 *  tournamentCode 是赛事列表里的 code 字段（UUID 形式），不是数字 id */
async function dayMatches(tournamentCode, date) {
  const j = await curlJson(`${API}/tournaments/day-matches?` + new URLSearchParams({ tournamentCode, date }));
  return Array.isArray(j) ? j : [];
}

const sideName = (m, side) => [m?.[`${side}p1_detail`], m?.[`${side}p2_detail`]]
  .filter(Boolean).map(p => p.name_display || `${p.first_name || ''} ${p.last_name || ''}`.trim())
  .join(' / ') || '待定';

const scoreText = (m) => {
  const strip = (s) => String(s || '').replace(/<[^>]+>/g, ' ').trim().split(/\s+/).filter(Boolean);
  const a = strip(m.team1Score), b = strip(m.team2Score);
  return a.length && b.length ? a.map((x, i) => `${x}-${b[i] ?? '?'}`).join(' ') : '';
};

const DISC = { MS: '男单', WS: '女单', MD: '男双', WD: '女双', XD: '混双' };
const ROUND = {
  R128: '128强', R64: '64强', R32: '32强', R16: '16强',
  'Quarter Finals': '1/4决赛', 'Semi Finals': '半决赛', Finals: '决赛', Final: '决赛',
};
const zhRound = (r) => ROUND[r] || r;
// start_time 是 UTC 秒；转成本地时间显示
const localTime = (ts) => new Date(ts * 1000).toLocaleString('zh-CN', { hour12: false });

// ------------------------------------------------------------------ CLI

const [cmd, ...args] = process.argv.slice(2);

if (cmd === 'live') {
  const j = await api('/match-center/vue-current-live');
  console.log('\n当前进行中 / 最近赛事：\n');
  for (const t of j.results || []) {
    console.log(`  id=${String(t.id).padEnd(5)} ${String(t.date).padEnd(18)} ${t.name}`);
    console.log(`        ${t.venue_name || '—'} · ${t.category_model?.name || ''}`);
  }
}

else if (cmd === 'list') {
  const start = args[0] || d2(new Date());
  const end = args[1] || d2(new Date(Date.now() + 15 * 864e5));
  const list = await searchTournaments(start, end);
  console.log(`\n${start} ~ ${end}   共 ${list.length} 项赛事\n`);
  for (const t of list) {
    console.log(`  id=${String(t.id).padEnd(5)} ${String(t.date || '').padEnd(17)} ${t.name}`);
    console.log(`        ${t.location || ''}${t.prize_money ? '   奖金 $' + t.prize_money : ''}${t.has_live_scores ? '   [有实时比分]' : ''}`);
  }
}

else if (cmd === 'day') {
  // node tools/probe-bwf.mjs day <tournamentCode> <YYYY-MM-DD>
  const [codeArg, dateArg] = args;
  const ms = await dayMatches(codeArg, dateArg);
  console.log(`\n赛事 ${codeArg}  ${dateArg}  共 ${ms.length} 场\n`);
  const byCourt = {};
  for (const m of ms) (byCourt[m.courtName || '场地待定'] ||= []).push(m);
  for (const [court, list] of Object.entries(byCourt)) {
    console.log(`  【${court}】`);
    for (const m of list) {
      const nm = (side) => (m[side]?.players || []).map(p => p.nameDisplay || p.nameShort).join(' / ')
        || m[side]?.teamName || m[side]?.countryCode || '待定';
      const sc = (m.score || []).map(s => `${s.home}-${s.away}`).join(' ');
      const st = m.matchStatusValue === 'Finished' ? '已结束' : (m.matchStatus === 'S' ? '未开始' : m.matchStatusValue || m.matchStatus);
      console.log(`    ${String(m.matchTime || '').slice(11, 16) || '--:--'}  [${DISC[m.eventName] || m.eventName}] ${zhRound(m.roundName).padEnd(6)} ${st.padEnd(4)}  ${nm('team1')} ${sc} ${nm('team2')}`);
    }
  }
  const stat = ms.reduce((a, m) => (a[m.matchStatusValue || m.matchStatus] = (a[m.matchStatusValue || m.matchStatus] || 0) + 1, a), {});
  console.log(`\n  状态分布：${JSON.stringify(stat)}`);
}

else if (cmd === 'matches') {
  const ms = await tournamentMatches(args[0]);
  console.log(`\n赛事 ${args[0]}：共 ${ms.length} 场对阵\n`);
  for (const m of ms.filter(x => x.winner).slice(0, 8)) {
    console.log(`  [${DISC[m.draw_name] || m.draw_name}] ${zhRound(m._round).padEnd(7)} ${localTime(m.start_time)}  ${m.court || ''}`);
    console.log(`      ${sideName(m, 't1')}  ${scoreText(m)}  ${sideName(m, 't2')}   （${m.time || '?'} 分钟）`);
  }
  const dist = ms.reduce((a, m) => (a[zhRound(m._round)] = (a[zhRound(m._round)] || 0) + 1, a), {});
  console.log(`\n  已出比分：${ms.filter(m => m.winner).length} / ${ms.length}`);
  console.log(`  轮次分布：${JSON.stringify(dist)}`);
}

else if (cmd === 'window') {
  const days = Number(args[0] || 15);
  const start = d2(new Date());
  const end = d2(new Date(Date.now() + days * 864e5));
  console.log(`\n抓取 ${start} ~ ${end} 的羽毛球赛事（每请求间隔 1.2s，避免触发限流）…\n`);
  const list = await searchTournaments(start, end);
  console.log(`赛事 ${list.length} 项，逐个取对阵…\n`);
  const rows = [];
  let total = 0, scored = 0, bytes = 0;
  for (const t of list) {
    try {
      const ms = await tournamentMatches(t.id);
      const inWin = ms.filter(m => { const day = d2(new Date(m.start_time * 1000)); return day >= start && day <= end; });
      total += inWin.length; scored += inWin.filter(m => m.winner).length;
      rows.push({ t, all: ms.length, inWin: inWin.length, sc: inWin.filter(m => m.winner).length });
    } catch (e) {
      rows.push({ t, err: e.message });
    }
    await sleep(1200);
  }
  console.log('赛事'.padEnd(44) + '总场次  窗口内  已出分');
  console.log('-'.repeat(76));
  for (const r of rows) {
    console.log(`${String(r.t.name).slice(0, 42).padEnd(44)}${String(r.err ? 'ERR' : r.all).padStart(5)}${String(r.err ? '-' : r.inWin).padStart(8)}${String(r.err ? '-' : r.sc).padStart(8)}${r.err ? '  ' + r.err.slice(0, 30) : ''}`);
  }
  console.log('-'.repeat(76));
  console.log(`合计：窗口内 ${total} 场，其中已出比分 ${scored} 场`);
}

else {
  console.log(`BWF 数据探测工具

  node tools/probe-bwf.mjs live                当前进行中/最近赛事
  node tools/probe-bwf.mjs list [起] [止]       列区间赛事（默认今天起 15 天）
  node tools/probe-bwf.mjs matches <tmtId>      列某赛事对阵（含比分）
  node tools/probe-bwf.mjs window [天数]        未来 N 天全部赛事 + 场次统计

接口基址 ${API}
零 Key，但必须带 Referer: https://bwfbadminton.com/ ，且必须走 curl（Node fetch 会被 Cloudflare 拦）。`);
}
