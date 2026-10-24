/**
 * 免费直播源层（单一数据源）
 * ------------------------------------------------------------
 * 为什么单独成模块：
 *   server.js（本地）和 api/streams.js + api/stream.js（Vercel）要共用同一份
 *   频道目录与代理逻辑。两边各写一份，参数（UA / 超时 / 重写规则）迟早漂移。
 *
 * 三种播放方式（前端按 kind 分派）：
 *   hls    公开 HLS（m3u8）。⚠️ 绝大多数源不带 CORS 头，浏览器直连必被拦，
 *          而且很多是 http:// ，在 https 页面里属于混合内容 —— 两个问题一起用
 *          「同源代理」解决：/api/stream 服务端取流后重写分片地址再吐给播放器。
 *   twitch Twitch 官方赛事频道，player.twitch.tv 内嵌（免 Key，需 parent 参数）
 *   page   只能外链打开的官方页（YouTube 频道直播页等），不硬嵌避免白框
 *
 * 健康检查：
 *   公开源极不稳定（限流/换 IP/换 token），所以**不写死可用性**，
 *   每次请求前按频道做一次 HEAD 级探测（取前 1KB 看是不是 #EXTM3U），
 *   结果缓存 PROBE_TTL，失败自动换下一个镜像。
 *
 * 版权：这些是各频道公开播出的信号，仅作「在哪看」的导航用途；
 *      页面同时给出官方入口，播放不了时以官方页为准。
 */
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

export const STREAMS_BUILD = 'stream-20261024a';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const PROBE_TTL = 3 * 60 * 1000;      // 探测成功缓存 3 分钟（公开源变化快，缓存久了会误报）
const FAIL_TTL = 25 * 1000;           // 探测失败只缓存 25 秒：同步期间网络被占满时的「全挂」是假象
const PROBE_TIMEOUT = 3500;
const FETCH_TIMEOUT = 9000;
const SALT = 'haifeng-live-proxy-v1';  // 只用于给代理 URL 签名，防止被当成任意 URL 转发器

/* ============================================================
 * 频道目录
 *   sports: 归属项目，前端用它给赛程行匹配「直播」按钮
 *   sources: 按优先级排列，前一个探测失败才用下一个
 * ============================================================ */
export const CHANNELS = [
  {
    id: 'cctv5',
    name: 'CCTV-5 体育',
    badge: '央视',
    sports: ['football', 'badminton'],
    note: '五大联赛 / 中超 / 羽毛球公开赛主力频道',
    page: 'https://tv.cctv.com/live/cctv5/',
    sources: [
      { kind: 'hls', label: '镜像 A', url: 'http://ivi.bupt.edu.cn/hls/cctv5hd.m3u8' },
      { kind: 'hls', label: '镜像 B', url: 'http://74.91.26.218:82/live/cctv5hd.m3u8' },
      { kind: 'hls', label: '镜像 C', url: 'http://183.207.248.71/gitv/live1/G_CCTV5/G_CCTV5' },
    ],
  },
  {
    id: 'cctv5p',
    name: 'CCTV-5+ 体育赛事',
    badge: '央视',
    sports: ['football', 'badminton'],
    note: '冷门联赛 / 羽毛球巡回赛常客，CCTV-5 冲突时切这里',
    page: 'https://tv.cctv.com/live/cctv5p/',
    sources: [
      { kind: 'hls', label: '镜像 A', url: 'http://ivi.bupt.edu.cn/hls/cctv5phd.m3u8' },
      { kind: 'hls', label: '镜像 B', url: 'http://74.91.26.218:82/live/cctv5p.m3u8' },
    ],
  },
  {
    id: 'cctv16',
    name: 'CCTV-16 奥林匹克',
    badge: '央视',
    sports: ['badminton', 'football'],
    note: '奥运频道，羽毛球/乒乓球赛事转播较多',
    page: 'https://tv.cctv.com/live/cctv16/',
    sources: [
      { kind: 'hls', label: '镜像 A', url: 'http://ivi.bupt.edu.cn/hls/cctv16.m3u8' },
      { kind: 'hls', label: '镜像 B', url: 'http://74.91.26.218:82/live/cctv16hd.m3u8' },
    ],
  },
  {
    id: 'fyzq',
    name: 'CCTV 风云足球',
    badge: '付费频道',
    sports: ['football'],
    note: '纯足球频道，欧洲联赛转播密度高',
    page: 'https://tv.cctv.com/live/cctvfyzz/',
    sources: [
      { kind: 'hls', label: '镜像 A', url: 'http://38.75.136.137:98/gslb/dsdqpub/fyzq.m3u8?auth=testpub' },
    ],
  },
  {
    id: 'sdty',
    name: '山东体育休闲',
    badge: '地方台',
    sports: ['football', 'badminton'],
    note: '地方台免费信号，中超/亚冠覆盖较好',
    page: 'https://www.iqilu.com/live/typd/',
    sources: [
      { kind: 'hls', label: '官方源', url: 'http://livealone302.iqilu.com/iqilu/typd.m3u8' },
    ],
  },
  {
    id: 'jsty',
    name: '江苏体育休闲',
    badge: '地方台',
    sports: ['football', 'badminton'],
    note: '地方台免费信号，含羽毛球赛事',
    page: 'https://www.jstv.com/live/',
    sources: [
      { kind: 'hls', label: '官方源', url: 'http://183.207.248.71/gitv/live1/G_JSTY/G_JSTY' },
    ],
  },
  {
    id: 'redbull',
    name: 'Red Bull TV',
    badge: '海外免费',
    sports: [],
    note: '官方免费频道，极限/户外运动为主，海外网络更稳',
    page: 'https://www.redbull.com/int-en/tv/',
    sources: [
      { kind: 'hls', label: '官方源', url: 'https://rbmn-live.akamaized.net/hls/live/590964/BoRB-AT/master.m3u8' },
    ],
  },
  {
    id: 'twitch-riot',
    name: 'Riot Games（Twitch）',
    badge: '官方直播',
    sports: ['esports'],
    note: 'LOL 官方英文流，国际赛事全程免费',
    page: 'https://www.twitch.tv/riotgames',
    sources: [{ kind: 'twitch', channel: 'riotgames' }],
  },
  {
    id: 'twitch-valorant',
    name: 'VALORANT（Twitch）',
    badge: '官方直播',
    sports: ['esports'],
    note: '无畏契约官方流，VCT 赛事免费',
    page: 'https://www.twitch.tv/valorant',
    sources: [{ kind: 'twitch', channel: 'valorant' }],
  },
  {
    id: 'twitch-dota2',
    name: 'DOTA2（Twitch）',
    badge: '官方直播',
    sports: ['esports'],
    note: 'DOTA2 官方流，TI / Major 免费',
    page: 'https://www.twitch.tv/dota2',
    sources: [{ kind: 'twitch', channel: 'dota2' }],
  },
  {
    id: 'bwf-yt',
    name: 'BWF TV（YouTube）',
    badge: '官方直播',
    sports: ['badminton'],
    note: '世界羽联官方频道，公开赛全程直播（需可访问 YouTube）',
    page: 'https://www.youtube.com/@bwftv/live',
    sources: [{ kind: 'page' }],
  },
];

/* ============================================================
 * 健康探测
 * ============================================================ */
const probeCache = new Map();   // channelId -> { t, ok, url, label, ms, error }

async function probeOne(url, timeout = PROBE_TIMEOUT) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: '*/*', Referer: new URL(url).origin + '/' },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeout),
    });
    if (!r.ok) return { ok: false, status: r.status, ms: Date.now() - t0, error: `http-${r.status}` };
    const buf = await r.text();
    const head = buf.slice(0, 64).trim();
    if (!head.startsWith('#EXTM3U')) {
      // 常见的两种「假成功」：返回 JSON 错误 / 返回 HTML 登录页
      return { ok: false, status: r.status, ms: Date.now() - t0, error: head.startsWith('{') ? 'upstream-error-json' : 'not-a-playlist' };
    }
    return { ok: true, status: r.status, ms: Date.now() - t0, finalUrl: r.url };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, error: e.name === 'TimeoutError' ? 'timeout' : (e.message || 'fetch-failed') };
  }
}

/** 探测某个频道，返回第一个可用镜像（成功缓存 3 分钟，失败只缓存 25 秒） */
export async function probeChannel(ch) {
  const hit = probeCache.get(ch.id);
  const ttl = hit?.ok ? PROBE_TTL : FAIL_TTL;   // 失败别缓存太久：可能只是这一秒网络忙
  if (hit && Date.now() - hit.t < ttl) return hit;

  const hlsSources = ch.sources.filter(s => s.kind === 'hls');
  let result = { t: Date.now(), ok: false, url: null, label: null, ms: 0, error: 'no-hls-source', mirrors: [] };

  // 串行探测：镜像通常同一批上游，并发只是更快被限流
  for (const s of hlsSources) {
    const r = await probeOne(s.url);
    result.mirrors.push({ label: s.label, ok: r.ok, ms: r.ms, error: r.error || null });
    if (r.ok) {
      result = { ...result, ok: true, url: s.url, label: s.label, ms: r.ms, error: null };
      break;
    }
    result.error = r.error;
    result.ms = r.ms;
  }

  // 没有 HLS 的频道（Twitch / 官方页）：无法也不该在服务端判断「是否在播」
  const kinds = new Set(ch.sources.map(s => s.kind));
  if (!hlsSources.length) result = { ...result, ok: true, playable: false, note: '外部直播', error: null };

  probeCache.set(ch.id, result);
  return result;
}

/** 频道列表 + 实时可用性（给前端渲染直播源面板） */
export async function listChannels() {
  const out = await Promise.all(CHANNELS.map(async ch => {
    const p = await probeChannel(ch);
    const src = ch.sources[0];
    return {
      id: ch.id,
      name: ch.name,
      badge: ch.badge,
      sports: ch.sports,
      note: ch.note,
      page: ch.page,
      kind: src.kind,
      // 只有 hls 才谈「可播放」，其余给 null（未知），前端不显示红绿灯
      playable: src.kind === 'hls' ? !!p.ok : null,
      live: src.kind === 'hls' ? !!p.ok : null,
      latency_ms: p.ms || null,
      group: src.kind === 'twitch' ? 'twitch' : (src.kind === 'page' ? 'page' : 'hls'),
      twitch: src.kind === 'twitch' ? src.channel : null,
      origin: 'https://tv.cctv.com',
      error: p.error || null,
    };
  }));
  return { build: STREAMS_BUILD, checkedAt: new Date().toISOString(), channels: out };
}

/* ============================================================
 * 同源代理（HLS）
 * ============================================================ */
const sign = (u) => createHash('sha1').update(u + SALT).digest('hex').slice(0, 16);
const b64 = (u) => Buffer.from(u, 'utf8').toString('base64url');
const unb64 = (s) => Buffer.from(s, 'base64url').toString('utf8');

function proxyUrl(absUrl, origin) {
  return `${origin}/api/stream?u=${b64(absUrl)}&s=${sign(absUrl)}`;
}

/** 把 m3u8 里的所有 URI（分片 / 子清单 / 密钥 / init 段）改写成走同源代理 */
function rewritePlaylist(text, baseUrl, origin) {
  const abs = (u) => { try { return new URL(u, baseUrl).href; } catch { return null; } };
  return text.split('\n').map(line => {
    const t = line.trim();
    if (!t) return line;
    if (t.startsWith('#')) {
      // EXT-X-KEY:URI= / EXT-X-MAP:URI= / EXT-X-MEDIA:URI=
      return line.replace(/URI="([^"]+)"/g, (m, u) => {
        const a = abs(u);
        return a ? `URI="${proxyUrl(a, origin)}"` : m;
      });
    }
    const a = abs(t);
    return a ? proxyUrl(a, origin) : line;
  }).join('\n');
}

/**
 * 统一入口：处理 /api/stream
 *   ?c=<channelId>          —— 按频道取第一个可用镜像（前端只传 id，不接触上游地址）
 *   ?u=<base64url>&s=<sig>  —— 取已签名的子资源（分片/子清单）
 * 返回 ServerResponse，直接 res.end() 即可。
 */
export async function serveStream(req, res, origin) {
  const url = new URL(req.url, origin);
  const chId = url.searchParams.get('c');
  const rawU = url.searchParams.get('u');
  const sig = url.searchParams.get('s');

  let candidates = [];
  let target = null;
  let channelId = null;

  if (chId) {
    const ch = CHANNELS.find(c => c.id === chId);
    if (!ch) return json(res, 404, { error: 'unknown-channel', id: chId });
    channelId = ch.id;
    const p = probeCache.get(ch.id);          // 只用已有探测结果排序，不在这里现探
    const hlsAll = ch.sources.filter(s => s.kind === 'hls');
    if (!hlsAll.length) {
      return json(res, 400, { error: 'channel-not-playable-here', kind: ch.sources[0].kind, page: ch.page });
    }
    // ⚠️ 播放路径**不再先探活**：探测是给目录页（/api/streams）用的。
    //    这里直接按顺序试，第一个成功就返回 —— 否则「探活 4.5s×N + 拉流」会让首次播放等十几秒，
    //    而 hls.js 的清单请求是有超时的，等太久就直接报错了。
    const prefer = p?.ok ? hlsAll.find(s => s.url === p.url) : null;
    candidates = (prefer ? [prefer, ...hlsAll.filter(s => s !== prefer)] : hlsAll).map(s => s.url);
  } else if (rawU && sig) {
    let u;
    try { u = unb64(rawU); } catch { return json(res, 400, { error: 'bad-url' }); }
    if (sign(u) !== sig) return json(res, 403, { error: 'bad-signature' });
    // 只放行 http(s)，挡掉 file:// 之类
    if (!/^https?:\/\//i.test(u)) return json(res, 400, { error: 'scheme-not-allowed' });
    candidates = [u];
  } else {
    return json(res, 400, { error: 'need-c-or-u' });
  }

  let r = null, upstreamErr = null;
  for (const u of candidates) {
    target = u;
    try {
      const rr = await fetch(u, {
        headers: {
          'User-Agent': UA,
          Accept: '*/*',
          Referer: (() => { try { return new URL(u).origin + '/'; } catch { return undefined; } })(),
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(candidates.length > 1 ? 7000 : FETCH_TIMEOUT),
      });
      if (rr.ok) { r = rr; break; }
      upstreamErr = `http-${rr.status}`;
    } catch (e) {
      upstreamErr = e.name === 'TimeoutError' ? 'timeout' : (e.message || 'fetch-failed');
    }
  }

  if (!r) {
    return json(res, 502, { error: 'upstream-fetch-failed', detail: upstreamErr, channel: channelId, tried: candidates.length });
  }

  const ct = r.headers.get('content-type') || '';

  // 清单判定：优先看 Content-Type；很多源给的是 octet-stream/空，再退化为看路径后缀
  const looksManifest = /mpegurl/i.test(ct)
    || (/^(application\/octet-stream|text\/plain|)$/i.test(ct) && /\.m3u8?(\?|$)/i.test(target));

  // 清单：读成文本 → 重写 → 回吐（小文件，缓冲没问题）
  if (looksManifest) {
    const text = await r.text();
    if (!text.trimStart().startsWith('#EXTM3U')) {
      return json(res, 502, { error: 'upstream-not-playlist', preview: text.slice(0, 160), channel: channelId });
    }
    const body = rewritePlaylist(text, r.url || target, origin);
    res.writeHead(200, {
      'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
      'X-Upstream': (() => { try { return new URL(r.url || target).host; } catch { return '-'; } })(),
    });
    return res.end(body);
  }

  // 分片：直接流式转发，不落内存
  const headers = {
    'Content-Type': ct || 'video/mp2t',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=8',
  };
  const clen = r.headers.get('content-length');
  if (clen) headers['Content-Length'] = clen;
  res.writeHead(200, headers);

  // ⚠️ 这里的错误处理是必须的，不是保险：
  //    上游分片断了（公开源很常见）或用户拖进度条/关页面导致连接中断时，
  //    Readable 会 emit('error')；没有监听器就是 uncaughtException，
  //    整个 node 进程直接退出 —— 已经因此崩过一次。
  let stream;
  try {
    stream = Readable.fromWeb(r.body);
  } catch {
    return res.end();
  }
  stream.on('error', () => { try { res.destroy(); } catch {} });
  res.on('close', () => { try { stream.destroy(); } catch {} });
  stream.pipe(res);
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
