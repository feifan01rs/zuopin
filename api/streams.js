/**
 * GET /api/streams —— 免费直播源目录 + 实时可用性
 *
 * 与本地 server.js 的 /api/streams 完全同构（共用 lib/stream.js），
 * 区别只有运行时：这边跑在 Vercel 的 Node 函数里。
 *
 * 注意：函数跑在海外，探测国内地方台镜像大概率失败（geo-block），
 *      所以这里只把「探测结果」返回给前端，不在服务端做取舍 ——
 *      用户本地打开页面时命中的是本地 server.js，判定更准确。
 */
import { listChannels } from '../lib/stream.js';

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  try {
    const payload = await listChannels();
    res.status(200).json(payload);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}
