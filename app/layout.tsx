import type { Metadata, Viewport } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "欧洲每日新闻热点地图（Mock 版）",
  description:
    "覆盖 46 个欧洲国家/地区的每日新闻热点地图，支持按日期查看每个国家的 Top 3 热点新闻。本阶段为 Mock 版：不接任何真实新闻 API、无数据库、无 API Key。",
  keywords: ["欧洲", "新闻热点", "地图", "Next.js", "react-simple-maps", "Mock"],
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // 地图内部用双指手势缩放，禁止浏览器层面的整页缩放以免手势冲突
  maximumScale: 1,
  userScalable: false,
  themeColor: "#0b1220",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" className="dark">
      <body className="min-h-[100dvh] bg-background text-foreground">{children}</body>
    </html>
  );
}
