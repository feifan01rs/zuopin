// 临时排查：查看 football-data.org 返回的原始队名字段
const KEY = process.env.FOOTBALL_DATA_KEY || '';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const targets = { BL1: 565808, CL: 575348 };
let first = true;
for (const [comp, id] of Object.entries(targets)) {
  if (!first) await sleep(7000); first = false;
  const r = await fetch(`https://api.football-data.org/v4/competitions/${comp}/matches`, { headers: { 'X-Auth-Token': KEY } });
  console.log(comp, r.status);
  if (!r.ok) continue;
  const { matches = [] } = await r.json();
  const m = matches.find(x => x.id === id);
  if (!m) { console.log('  未找到', id); continue; }
  console.log(JSON.stringify({ id: m.id, utcDate: m.utcDate, home: m.homeTeam, away: m.awayTeam }, null, 1));
}
