/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // 开发服务器走独立的输出目录（由 scripts/dev.mts 注入 NEXT_DIST_DIR=.next-dev）。
  // 这样 `npm run build` 就不会覆盖 dev server 正在使用的 .next，
  // 避免出现 "Cannot find module './948.js'" 导致的接口 500 / 页面白屏。
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // 本项目为纯 Mock 版：不接任何外部新闻 API，禁止把未知域名加入 images.remotePatterns，
  // 以便从配置层面保证 Network 面板里只有 /api/news/top。
  images: {
    remotePatterns: [],
  },
};

export default nextConfig;
