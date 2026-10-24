/**
 * Tailwind 编译配置 —— 与 index.html 里原本的 `tailwind.config = {...}` 逐字段一致。
 * 目的：把 CDN 版 JIT 换成预先编译好的本地 CSS，摆脱对 cdn.tailwindcss.com 的依赖
 *      （国内网络访问该域名经常超时 → 页面白屏无样式）。
 *
 * ⚠️ 改了 index.html 里的颜色/字体/阴影配置，必须同步改这里 + 重新编译，否则两边会漂移。
 * 用 .cjs 后缀是因为项目 package.json 有 "type": "module"。
 */
const path = require('path');

module.exports = {
  // 绝对路径，避免「相对于 cwd 还是相对于 config」的歧义（中文目录尤其容易踩）
  content: [path.resolve(__dirname, '..', '..', 'index.html')],
  theme: {
    extend: {
      colors: {
        sea: {
          50: '#EAF6FB', 100: '#D8EEF8', 200: '#B8E0F0', 300: '#93D4EC', 400: '#7CCFEA',
          500: '#5AB9DE', 600: '#3E9CC6', 700: '#357FA3', 800: '#2F6685', 900: '#2A546E',
        },
        deep: {
          400: '#7793BA', 500: '#6395C4', 600: '#4F6494', 700: '#3D507A',
          800: '#2E3E61', 900: '#212C46',
        },
        ice: '#EAF6FB',
        iceStrong: '#BCDFE8',
        cloud: '#F9FDFD',
        daisy: { DEFAULT: '#F5C542', hover: '#E0B02A', soft: '#FDF3D7' },
        ink: { 1: '#1E3A4C', 2: '#47687D', 3: '#7D9AAD' },
        ok: '#34B58F',
        warn: '#F2994A',
        err: '#E5604F',
      },
      fontFamily: {
        num: ['"DIN Alternate"', 'Bahnschrift', 'Consolas', 'monospace'],
      },
      boxShadow: {
        card: '0 4px 14px rgba(46,96,133,.12)',
        pop: '0 12px 32px rgba(46,96,133,.16)',
      },
    },
  },
};
