/**
 * GET /api/stream?c=<channelId>            按频道取流（首个可用镜像）
 * GET /api/stream?u=<base64url>&s=<sig>    取已签名的子清单 / 分片
 *
 * 为什么需要这个代理：
 *   1. 公开 HLS 源基本不发 Access-Control-Allow-Origin，浏览器 fetch 直接被拦；
 *   2. 很多源还是 http://，在 https 页面里属于混合内容，浏览器会拒绝加载。
 *   由服务端取流 + 重写分片地址后，播放器看到的永远是同源 https 地址。
 *
 * 代理本身不缓存视频，只做转发；签名（lib/stream.js 里的 SALT）防止
 * 被别人当成任意 URL 转发器（SSRF）。
 */
import { serveStream } from '../lib/stream.js';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  const origin = `${proto}://${host}`;
  await serveStream(req, res, origin);
}
