import { listChannels } from '../lib/stream.js';

const t0 = Date.now();
const r = await listChannels();
console.log('耗时', Date.now() - t0, 'ms');
for (const c of r.channels) {
  console.log(
    String(c.id).padEnd(15),
    String(c.kind).padEnd(7),
    'playable=' + String(c.playable).padEnd(6),
    (c.latency_ms ? c.latency_ms + 'ms' : '-').padEnd(8),
    c.error || ''
  );
}
