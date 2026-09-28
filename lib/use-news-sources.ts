"use client";

import * as React from "react";

import type { CountrySourceEntry, NewsSourcesResponse } from "@/lib/news-sources";
import { newsSourceKind } from "@/lib/news-sources";

export type NewsSourcesState = {
  /** 国家代码 → 数据源状态 */
  byCode: Record<string, CountrySourceEntry>;
  /** 已拿到真实新闻的国家数 */
  realCount: number;
  loading: boolean;
  error: string | null;
  /** 重新拉取快照（服务端只读记录，不会消耗聚合数据额度） */
  reload: () => Promise<void>;
};

/**
 * 读取 /api/news/sources。
 *
 * 这个接口是纯读快照，所以「点击国家后刷新」非常廉价：
 * 服务端不会因此去请求聚合数据，只是把刚才那次查询的结果反映出来。
 */
export function useNewsSources(date: string): NewsSourcesState {
  const [byCode, setByCode] = React.useState<Record<string, CountrySourceEntry>>({});
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const fetchSnapshot = React.useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      try {
        const response = await fetch(`/api/news/sources?date=${date}`, { signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = (await response.json()) as NewsSourcesResponse;
        setByCode(payload.countries ?? {});
        setError(null);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setError(caught instanceof Error ? caught.message : "未知错误");
      } finally {
        setLoading(false);
      }
    },
    [date],
  );

  React.useEffect(() => {
    const controller = new AbortController();
    void fetchSnapshot(controller.signal);
    return () => controller.abort();
  }, [fetchSnapshot]);

  const reload = React.useCallback(() => fetchSnapshot(), [fetchSnapshot]);

  const realCount = React.useMemo(
    () => Object.values(byCode).filter((entry) => newsSourceKind(entry.dataSource) === "real").length,
    [byCode],
  );

  return { byCode, realCount, loading, error, reload };
}
