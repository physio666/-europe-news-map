"use client";

import * as React from "react";
import { ArrowUpRight, Clock, Flame, Newspaper } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatTime } from "@/lib/date";
import type { NewsItem } from "@/lib/providers/types";
import { cn } from "@/lib/utils";

const RANK_STYLES: Record<number, string> = {
  1: "bg-amber-400 text-amber-950",
  2: "bg-slate-300 text-slate-900",
  3: "bg-amber-700 text-amber-50",
};

export type NewsCardProps = {
  item: NewsItem;
  className?: string;
};

/**
 * 是否是「可跳转的真实原文链接」。
 *
 * 刻意只看 url 本身，不看 dataSource：
 *  - 真实数据源（juhe / gdelt）给的是 https://… 真实链接 → 可跳转
 *  - Mock 的 url 固定为 "#" → 不可跳转
 * 这样以后新增数据源时，前端不用跟着改判断逻辑。
 */
export function hasRealOriginalUrl(url: unknown): boolean {
  if (typeof url !== "string") return false;
  const trimmed = url.trim();
  if (trimmed === "" || trimmed === "#") return false;
  if (/^javascript:/i.test(trimmed)) return false;
  return /^https?:\/\//i.test(trimmed);
}

/** 单条新闻卡片：排名 / 标题 / 来源 / 发布时间 / 摘要 / 原文按钮 */
export function NewsCard({ item, className }: NewsCardProps) {
  const rankStyle = RANK_STYLES[item.rank] ?? "bg-secondary text-secondary-foreground";
  const isRealUrl = hasRealOriginalUrl(item.url);

  return (
    <Card
      className={cn(
        "animate-fade-up overflow-hidden transition-colors hover:border-primary/40",
        className,
      )}
    >
      <div className="relative aspect-[16/7] w-full overflow-hidden bg-muted">
        {item.imageUrl ? (
          // 占位图是内联 SVG data URI，不产生任何网络请求
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={item.imageUrl}
            alt=""
            aria-hidden
            className="h-full w-full object-cover opacity-90"
            loading="lazy"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <Newspaper className="h-6 w-6" />
          </div>
        )}
        <span
          className={cn(
            "absolute left-3 top-3 inline-flex h-7 min-w-7 items-center justify-center rounded-md px-2 text-sm font-bold shadow",
            rankStyle,
          )}
        >
          #{item.rank}
        </span>
        <span className="absolute right-3 top-3 inline-flex items-center gap-1 rounded-md bg-black/55 px-2 py-1 text-[11px] font-medium text-white backdrop-blur">
          <Flame className="h-3 w-3" />
          {item.score.toFixed(2)}
        </span>
      </div>

      <CardContent className="space-y-2.5 p-4">
        <h3 className="text-[15px] font-semibold leading-snug tracking-tight">{item.title}</h3>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <Newspaper className="h-3.5 w-3.5" />
            {item.sourceName}
          </span>
          <span className="inline-flex items-center gap-1">
            <Clock className="h-3.5 w-3.5" />
            {formatTime(item.publishedAt)}
          </span>
        </div>

        {item.description ? (
          <p className="text-[13px] leading-relaxed text-muted-foreground">{item.description}</p>
        ) : null}

        <div className="flex items-center justify-between pt-1">
          <Badge variant="muted" className="font-normal">
            热度 {item.score.toFixed(2)}
          </Badge>
          {isRealUrl ? (
            <Button asChild size="sm" variant="secondary" className="h-8">
              {/* 判断依据是 item.url 本身，而不是 dataSource：
                  juhe/gdelt 等真实源会给真实链接，Mock 的 url 固定为 "#"。
                  真实链接不拦截点击、不加 onClick，直接在新标签页打开。 */}
              <a
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                title={`在新标签页打开原文（${item.sourceName}）`}
                data-testid="news-original-link"
              >
                阅读原文
                <ArrowUpRight className="h-3.5 w-3.5" />
              </a>
            </Button>
          ) : (
            // 只有 url 为空或 "#" 时才是「暂无原文链接」：真正的 button + disabled，
            // 而不是给 <a> 加 onClick 拦截（那样键盘/中键仍可能触发跳转）。
            <Button
              size="sm"
              variant="secondary"
              className="h-8 cursor-not-allowed opacity-60"
              disabled
              title="Mock 演示数据：暂无真实原文链接"
              data-testid="news-no-original-link"
            >
              暂无原文链接
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/** 加载骨架 */
export function NewsCardSkeleton() {
  return (
    <Card className="overflow-hidden">
      <Skeleton className="aspect-[16/7] w-full rounded-none" />
      <CardContent className="space-y-3 p-4">
        <Skeleton className="h-4 w-11/12" />
        <Skeleton className="h-3 w-1/3" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-4/5" />
        <div className="flex items-center justify-between pt-1">
          <Skeleton className="h-5 w-20" />
          <Skeleton className="h-8 w-24" />
        </div>
      </CardContent>
    </Card>
  );
}
