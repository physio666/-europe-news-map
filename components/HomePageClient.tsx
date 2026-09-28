"use client";

import * as React from "react";
import { Database, Globe2, Info } from "lucide-react";

import { DatePicker } from "@/components/DatePicker";
import { EuropeMap } from "@/components/EuropeMap";
import { NewsDrawer } from "@/components/NewsDrawer";
import { Badge } from "@/components/ui/badge";
import { EUROPE_COUNTRIES } from "@/lib/countries";
import { formatDateZh, todayIsoDate } from "@/lib/date";
import { dataSourceBadgeText } from "@/lib/news-sources";
import { useIsMobile } from "@/lib/use-media-query";
import { useNewsSources } from "@/lib/use-news-sources";
import { useTopNews } from "@/lib/use-top-news";
import { cn } from "@/lib/utils";

export type HomePageClientProps = {
  /** 服务端在请求时确定的「今天」（YYYY-MM-DD），用于保证 SSR 与 hydration 一致 */
  initialDate: string;
  /** 服务端读取的 NEWS_PROVIDER（mock | gdelt），仅用于顶栏展示 */
  providerMode: string;
};

export function HomePageClient({ initialDate, providerMode }: HomePageClientProps) {
  const isMobile = useIsMobile();

  // 初始值来自服务端，保证首屏 HTML 与客户端首次渲染完全一致（无 hydration 警告）
  const [date, setDate] = React.useState<string>(initialDate);
  const [today, setToday] = React.useState<string>(initialDate);
  const [selectedCode, setSelectedCode] = React.useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = React.useState(false);

  /**
   * hydration 之后再按浏览器本地时区校正一次「今天」。
   * 服务器与用户不在同一时区时（例如服务器 UTC、用户在 UTC+8），
   * 服务端的 initialDate 可能不是用户的今天 —— 这里静默修正。
   */
  React.useEffect(() => {
    const localToday = todayIsoDate();
    setToday(localToday);
    setDate((current) => (current === initialDate ? localToday : current));
  }, [initialDate]);

  // 日期或国家变化都会重新请求 /api/news/top
  const news = useTopNews(selectedCode, date, 3);

  // 数据源快照（只读缓存，不会消耗聚合数据额度）—— 决定地图上的绿/灰/浅与「已有 N 个国家」
  const sources = useNewsSources(date);

  /**
   * 某国的数据刚落地（或日期变了）时刷新快照，让地图颜色同步变化。
   * 用 ref 记住上次的「触发指纹」，避免无关渲染造成重复请求。
   */
  const lastSourceTrigger = React.useRef("");
  React.useEffect(() => {
    if (!selectedCode || news.status !== "success") return;
    const trigger = `${date}|${selectedCode}|${news.dataSource}|${news.items.length}`;
    if (trigger === lastSourceTrigger.current) return;
    lastSourceTrigger.current = trigger;
    void sources.reload();
  }, [date, selectedCode, news.status, news.dataSource, news.items.length, sources]);

  const handleSelect = React.useCallback((code: string | null) => {
    setSelectedCode(code);
    setDrawerOpen(code !== null);
  }, []);

  return (
    <main className="flex h-[100dvh] w-full flex-col overflow-hidden">
      <header className="z-30 flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border/80 bg-background/85 px-3 py-3 backdrop-blur md:h-16 md:flex-nowrap md:py-0 lg:px-5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
            <Globe2 className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold tracking-tight sm:text-[15px]">
              欧洲每日新闻热点地图
            </h1>
            <p className="truncate text-[11px] text-muted-foreground">
              覆盖 {EUROPE_COUNTRIES.length} 个欧洲国家/地区 · 每日 Top 3
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="hidden text-xs text-muted-foreground sm:inline">日期</span>
          <DatePicker value={date} today={today} onChange={setDate} />
        </div>

        <div className="ml-auto hidden items-center gap-2 lg:flex">
          <Badge variant="outline" className="gap-1.5 font-normal text-muted-foreground">
            <Database className="h-3 w-3" />
            {/* 需求指定文案：juhe → 聚合数据（中文媒体国际报道）；mock → Mock 演示数据 */}
            {dataSourceBadgeText(news.dataSource ?? providerMode)}
          </Badge>
          <Badge variant="secondary" className="gap-1.5 font-normal">
            <Info className="h-3 w-3" />
            抓取只在服务端
          </Badge>
        </div>
      </header>

      <div className="relative min-h-0 flex-1">
        <div
          className={cn(
            "absolute inset-0 transition-[padding] duration-300 ease-out",
            // 桌面端抽屉打开时把地图往左让出抽屉宽度，避免遮住伊比利亚半岛与爱尔兰
            !isMobile && drawerOpen ? "pr-[420px]" : "pr-0",
          )}
        >
          <EuropeMap
            selectedCode={selectedCode}
            onSelect={handleSelect}
            date={date}
            sourceByCode={sources.byCode}
          />
        </div>

        {/* 未选中任何国家时的引导条 */}
        {!selectedCode ? (
          <div className="pointer-events-none absolute inset-x-0 top-4 z-10 flex justify-center px-4">
            <div className="rounded-full border border-border/80 bg-card/85 px-4 py-2 text-center text-xs text-muted-foreground shadow-sm backdrop-blur">
              {isMobile ? "点击地图上的国家" : "点击地图上的任意国家"}
              <span className="hidden sm:inline">（含安道尔、列支敦士登、梵蒂冈等微型国家）</span>
              ，查看 {formatDateZh(date)} 的热点新闻
            </div>
          </div>
        ) : null}

        {/* 数据源覆盖度提示：只统计「已经查过」的国家，查询本身不消耗聚合数据额度 */}
        <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 hidden justify-center px-4 sm:flex">
          <div className="rounded-full border border-border/70 bg-card/85 px-3 py-1.5 text-[11px] text-muted-foreground shadow-sm backdrop-blur">
            {providerMode === "mock"
              ? "当前为 Mock 演示数据：地图上所有国家都是灰色"
              : `今日已有 ${sources.realCount} 个国家获取到真实新闻（绿色）；灰色为演示数据，浅色为本次会话尚未查询`}
            {sources.error ? " · 数据源状态获取失败" : ""}
          </div>
        </div>
      </div>

      <NewsDrawer
        open={drawerOpen && selectedCode !== null}
        onOpenChange={setDrawerOpen}
        countryCode={selectedCode}
        date={date}
        status={news.status}
        items={news.items}
        error={news.error}
        updatedAt={news.updatedAt}
        dataSource={news.dataSource}
        onRetry={news.reload}
        isMobile={isMobile}
      />
    </main>
  );
}
