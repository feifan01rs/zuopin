/**
 * 实测 BWF 的限流阈值：并发 N 连续拉 M 个赛事，看成功率。
 * 结论用来定 fetchBWF() 的并发度与退避策略。
 *
 *   node tools/probe-bwf-conc.mjs [并发数] [赛事数]
 */
import { execFile } from 'node:child_process';

const API = 'https://extranet-lv.bwfbadminton.com/api';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** 走 curl 取 JSON（Node fetch 会被 Cloudflare 按 TLS 指纹 403） */
function curl(url, timeout = 50) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    execFile('curl', [
      '-s', '-m', String(timeout),
      '-H', 'Accept: application/json, text/plain, */*',
      '-H', 'Referer: https://bwfbadminton.com/',
      '-H', 'Origin: https://bwfbadminton.com',
      '-H', `User-Agent: ${UA}`,
      '-w', '\n__HTTP__%{http_code}',
      url,
    ], { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (err, stdout) => {
      const ms = Date.now() - t0;
      if (err) return resolve({ code: 0, body: '', bytes: 0, ms, err: err.message.slice(0, 40) });
      const m = stdout.match(/\n__HTTP__(\d+)\s*$/);
      const body = stdout.replace(/\n__HTTP__\d+\s*$/, '');
      resolve({ code: m ? Number(m[1]) : 0, body, bytes: Buffer.byteLength(body), ms });
    });
  });
}

const conc = Number(process.argv[2] || 4);
const limit = Number(process.argv[3] || 20);
const d2 = (dt) => dt.toISOString().slice(0, 10);
const s = d2(new Date(Date.now() - 15 * 864e5));
const e = d2(new Date(Date.now() + 15 * 864e5));

console.log(`\n① 取 ${s} ~ ${e} 赛事列表…`);
const lr = await curl(`${API}/vue-tournaments-search?` + new URLSearchParams({
  startDate: s, endDate: e, page: 1, perPage: 100, drawCount: 1, activeTab: 1,
}));
if (lr.code !== 200) { console.log('   列表失败', lr.code, lr.err || lr.body.slice(0, 80)); process.exit(1); }
const list = JSON.parse(lr.body).results.data;
console.log(`   共 ${list.length} 项赛事`);

const pick = list.slice(0, limit);
console.log(`\n② 并发 ${conc} 拉 ${pick.length} 个赛事的对阵…\n`);

let i = 0, ok = 0, fail403 = 0, failOther = 0, totBytes = 0, totMs = 0, totMatches = 0;
const t0 = Date.now();

const worker = async (wid) => {
  while (true) {
    const idx = i++;
    if (idx >= pick.length) return;
    const t = pick[idx];
    const r = await curl(`${API}/vue-tournament-matches?tmtId=${t.id}`);
    totBytes += r.bytes; totMs += r.ms;
    let n = '';
    if (r.code === 200) {
      ok++;
      try {
        const bc = JSON.parse(r.body)?.results?.by_court || {};
        const cnt = Object.values(bc).reduce((a, v) => a + Object.keys(v).length, 0);
        totMatches += cnt;
        n = cnt ? `场次 ${cnt}` : '抽签未出';
      } catch { n = '解析失败'; }
    } else if (r.code === 403) fail403++; else failOther++;
    console.log(`  w${wid} ${String(t.id).padEnd(5)} ${String(r.code).padEnd(4)} ${String(Math.round(r.bytes / 1024)).padStart(6)}KB ${String(r.ms).padStart(6)}ms  ${String(t.name).slice(0, 38).padEnd(40)} ${n}`);
    await sleep(200 + Math.random() * 300);
  }
};
await Promise.all(Array.from({ length: conc }, (_, k) => worker(k + 1)));

const wall = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n===== 结果 =====`);
console.log(`  成功 ${ok} / 403 ${fail403} / 其他 ${failOther}   总场次 ${totMatches}`);
console.log(`  总字节 ${(totBytes / 1048576).toFixed(1)} MB，平均单次 ${Math.round(totMs / pick.length)}ms`);
console.log(`  墙钟 ${wall}s（并发 ${conc}）`);
console.log(`  结论：${fail403 === 0 ? `并发 ${conc} 安全 ✅` : `并发 ${conc} 触发限流 ❌`}`);
