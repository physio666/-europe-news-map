"use client";

import * as React from "react";

import type { NewsItem } from "@/lib/providers/types";

export type NewsStatus = "idle" | "loading" | "success" | "empty" | "error";

export type TopNewsState = {
  status: NewsStatus;
  items: NewsItem[];
  error: string | null;
  updatedAt: string | null;
  dataSource: string | null;
  /** 出错后手动重试 */
  reload: () => void;
};

type ApiPayload = {
  country: string;
  date: string;
  updatedAt: string;
  dataSource: string;
  items: NewsItem[];
  error?: string;
  message?: string;
};

/**
 * 拉取某个国家某一天的 Top N 新闻。
 *
 * 只请求同源的 /api/news/top —— 不会产生任何外部新闻 API 请求。
 * country 为 null（未选中任何国家）时不会发起请求。
 */
export function useTopNews(countryCode: string | null, date: string, limit = 3): TopNewsState {
  const [state, setState] = React.useState<Omit<TopNewsState, "reload">>({
    status: "idle",
    items: [],
    error: null,
    updatedAt: null,
    dataSource: null,
  });
  const [nonce, setNonce] = React.useState(0);

  React.useEffect(() => {
    if (!countryCode) {
      setState({ status: "idle", items: [], error: null, updatedAt: null, dataSource: null });
      return;
    }

    const controller = new AbortController();
    let cancelled = false;

    setState((prev) => ({
      status: "loading",
      // 切换国家/日期时清空旧数据，避免看到上一个国家的新闻
      items: [],
      error: null,
      updatedAt: prev.updatedAt,
      dataSource: prev.dataSource,
    }));

    const params = new URLSearchParams({ country: countryCode, date, limit: String(limit) });

    fetch(`/api/news/top?${params.toString()}`, { signal: controller.signal })
      .then(async (response) => {
        const payload = (await response.json().catch(() => null)) as ApiPayload | null;
        if (!response.ok) {
          throw new Error(payload?.message ?? `请求失败（HTTP ${response.status}）`);
        }
        if (!payload) throw new Error("接口返回内容无法解析");

        if (cancelled) return;
        setState({
          status: payload.items.length > 0 ? "success" : "empty",
          items: payload.items,
          error: null,
          updatedAt: payload.updatedAt,
          dataSource: payload.dataSource,
        });
      })
      .catch((error: unknown) => {
        if (cancelled || (error instanceof DOMException && error.name === "AbortError")) return;
        setState({
          status: "error",
          items: [],
          error: error instanceof Error ? error.message : "未知错误",
          updatedAt: null,
          dataSource: null,
        });
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [countryCode, date, limit, nonce]);

  const reload = React.useCallback(() => setNonce((value) => value + 1), []);

  return { ...state, reload };
}
