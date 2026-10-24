/**
 * 端到端验证同源代理：起一个临时 http 服务 → 请求 /api/stream?c=xxx
 * → 拿到重写后的 m3u8 → 再顺着第一条分片请求，确认能真的吐字节。
 *
 * 用法：node tools/probe-stream-proxy.mjs [channelId]
 */
import http from 'node:http';
import { serveStream } from '../lib/stream.js';

const id = process.argv[2] || 'cctv5';
const PORT = 8899;

const server = http.createServer((req, res) => serveStream(req, res, `http://127.0.0.1:${PORT}`));
await new Promise(r => server.listen(PORT, r));

const get = (p) => new Promise((resolve) => {
  http.get(`http://127.0.0.1:${PORT}${p}`, (res) => {
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(chunks) }));
  }).on('error', e => resolve({ status: 0, error: e.message, body: Buffer.alloc(0) }));
});

const m = await get(`/api/stream?c=${id}`);
console.log(`[${id}] manifest HTTP ${m.status} type=${m.type} bytes=${m.body.length}`);
const text = m.body.toString('utf8');
if (!text.startsWith('#EXTM3U')) {
  console.log('内容不是 m3u8：', text.slice(0, 300));
  server.close();
  process.exit(1);
}
console.log(text.split('\n').slice(0, 8).join('\n'));

// 顺着子清单继续往下钻，直到拿到分片（master → variant → segment）
async function drill(body, depth = 0) {
  const lines = body.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  const first = lines[0];
  if (!first) return null;
  const r = await get(first.replace(`http://127.0.0.1:${PORT}`, ''));
  const t = r.body.toString('utf8', 0, 16);
  console.log(`${'  '.repeat(depth + 1)}→ ${r.status} ${r.type} ${r.body.length}B ${t.startsWith('#EXTM3U') ? '(子清单)' : '(分片/媒体)'}`);
  if (t.startsWith('#EXTM3U') && depth < 3) return drill(r.body.toString('utf8'), depth + 1);
  return r;
}

const seg = await drill(text);
console.log(seg && seg.body.length > 5000 ? '✅ 代理链路通，能吐真实媒体数据' : '⚠️ 分片偏小，可能上游刚切换或加密');
server.close();
