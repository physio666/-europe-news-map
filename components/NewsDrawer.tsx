"use client";

import * as React from "react";
import { AlertTriangle, CalendarClock, Database, Inbox, RotateCcw } from "lucide-react";

import { NewsCard, NewsCardSkeleton } from "@/components/NewsCard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { getCountry } from "@/lib/countries";
import { formatDateZh, formatTime } from "@/lib/date";
import { flagEmoji } from "@/lib/heat";
import { dataSourceBadgeText, newsSourceKind } from "@/lib/news-sources";
import type { NewsItem } from "@/lib/providers/types";
import type { NewsStatus } from "@/lib/use-top-news";
import { cn } from "@/lib/utils";

export type NewsDrawerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 当前选中的国家（ISO alpha-2），null 表示未选中 */
  countryCode: string | null;
  date: string;
  status: NewsStatus;
  items: NewsItem[];
  error: string | null;
  updatedAt: string | null;
  dataSource: string | null;
  onRetry: () => void;
  /** 移动端从底部弹出，桌面端从右侧滑出 */
  isMobile: boolean;
};

function StateBox({
  icon,
  title,
  description,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed bg-card/40 px-6 py-10 text-center">
      <div className="flex h-11 w-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
        {icon}
      </div>
      <div className="space-y-1">
        <p className="text-sm font-semibold">{title}</p>
        <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>
      </div>
      {action}
    </div>
  );
}

/**
 * 右侧/底部新闻抽屉：国家名 + 日期 + Top 3 新闻卡片。
 * 覆盖加载骨架、错误提示、无数据提示三种状态。
 */
export function NewsDrawer({
  open,
  onOpenChange,
  countryCode,
  date,
  status,
  items,
  error,
  updatedAt,
  dataSource,
  onRetry,
  isMobile,
}: NewsDrawerProps) {
  const country = getCountry(countryCode);

  return (
    <Sheet open={open} onOpenChange={onOpenChange} modal={isMobile}>
      <SheetContent
        side={isMobile ? "bottom" : "right"}
        withOverlay={isMobile}
        // 桌面端是非模态侧栏：点击顶栏（日期选择器）或地图上别的国家时不应关闭抽屉。
        // 移动端保持默认行为：点遮罩即关闭。
        onInteractOutside={(event) => {
          if (!isMobile) event.preventDefault();
        }}
        onFocusOutside={(event) => {
          if (!isMobile) event.preventDefault();
        }}
        className={cn(
          isMobile
            ? "h-[74vh] max-h-[74vh] rounded-t-2xl"
            : // 桌面端从顶栏下方开始，避免遮住日期选择器
              "w-full border-l bg-background/95 backdrop-blur sm:max-w-[420px] md:!top-16 md:!h-[calc(100dvh-4rem)]",
        )}
      >
        {/* 移动端顶部拖拽提示条 */}
        {isMobile ? (
          <div className="flex justify-center pt-2.5">
            <div className="h-1 w-10 rounded-full bg-border" />
          </div>
        ) : null}

        <SheetHeader className="gap-2">
          <div className="flex items-center gap-3 pr-8">
            <span className="text-2xl leading-none" aria-hidden>
              {country ? flagEmoji(country.code) : "🇪🇺"}
            </span>
            <div className="min-w-0">
              <SheetTitle className="truncate text-xl">
                {country ? country.nameZh : "选择一个国家"}
              </SheetTitle>
              <SheetDescription className="truncate text-xs">
                {country ? `${country.name} · ${country.code}` : "点击地图上的国家查看当日热点新闻"}
              </SheetDescription>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Badge variant="secondary" className="gap-1 font-normal">
              <CalendarClock className="h-3 w-3" />
              {formatDateZh(date)}
            </Badge>
            {dataSource ? (
              <Badge
                variant="outline"
                className={cn(
                  "gap-1 font-normal",
                  newsSourceKind(dataSource) === "real"
                    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                    : "text-muted-foreground",
                )}
                data-testid="drawer-data-source-badge"
              >
                <Database className="h-3 w-3" />
                {/* 需求指定文案：数据源：NewsData.io / 聚合数据（中文媒体国际报道）/ Mock 演示数据 */}
                {dataSourceBadgeText(dataSource)}
              </Badge>
            ) : null}
            {updatedAt ? (
              <span className="text-[11px] text-muted-foreground">
                更新于 {formatTime(updatedAt)}
              </span>
            ) : null}
          </div>
        </SheetHeader>

        <div className="scrollbar-thin flex-1 overflow-y-auto px-5 pb-6">
          {!country ? (
            <StateBox
              icon={<Inbox className="h-5 w-5" />}
              title="尚未选择国家"
              description="在欧洲地图上点击任意国家（含安道尔、列支敦士登、梵蒂冈等微型国家），即可查看当天的 Top 3 热点。"
            />
          ) : status === "loading" || status === "idle" ? (
            <div className="space-y-3.5">
              <div className="text-xs text-muted-foreground">正在加载 {country.nameZh} 的当日热点…</div>
              {[0, 1, 2].map((index) => (
                <NewsCardSkeleton key={index} />
              ))}
            </div>
          ) : status === "error" ? (
            <StateBox
              icon={<AlertTriangle className="h-5 w-5 text-destructive" />}
              title="加载失败"
              description={error ?? "请求 /api/news/top 时出现未知错误。"}
              action={
                <Button size="sm" variant="secondary" onClick={onRetry}>
                  <RotateCcw className="h-3.5 w-3.5" />
                  重试
                </Button>
              }
            />
          ) : status === "empty" ? (
            <StateBox
              icon={<Inbox className="h-5 w-5" />}
              title="暂无数据"
              description={`${country.nameZh} 在 ${date} 没有返回任何新闻条目，请尝试切换日期。`}
              action={
                <Button size="sm" variant="secondary" onClick={onRetry}>
                  <RotateCcw className="h-3.5 w-3.5" />
                  重新获取
                </Button>
              }
            />
          ) : (
            <div className="space-y-3.5">
              {items.map((item) => (
                <NewsCard key={`${country.code}-${date}-${item.rank}`} item={item} />
              ))}
              <p className="pt-1 text-center text-[11px] leading-relaxed text-muted-foreground">
                {dataSource === "newsdata" ? (
                  <>
                    数据来自 NewsData.io（dataSource: newsdata），由服务端按国家与主要语言查询头条；
                    页面只请求 <code>/api/news/top</code>，浏览器不会直连 NewsData.io，也不会接触 API Key。
                  </>
                ) : dataSource === "juhe" ? (
                  <>
                    数据来自聚合数据「新闻头条」国际新闻池（dataSource: juhe），
                    由服务端按关键词与来源域名两级过滤后取最新 {items.length} 条；
                    页面只请求 <code>/api/news/top</code>，浏览器不会直连聚合数据。
                  </>
                ) : dataSource === "gdelt" ? (
                  <>
                    数据来自 GDELT DOC 2.0 公开 API（dataSource: gdelt），由服务端抓取并按时间倒序筛选；
                    页面只请求 <code>/api/news/top</code>，浏览器不会直连 GDELT。
                  </>
                ) : (
                  <>
                    数据来自本项目的 MockProvider（dataSource: {dataSource ?? "mock"}），
                    属于演示数据、没有真实原文链接；页面只请求 <code>/api/news/top</code>。
                  </>
                )}
              </p>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
