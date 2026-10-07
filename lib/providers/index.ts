import { MockProvider, mockProvider } from "./mock-provider";
import { GdeltProvider, getGdeltProvider } from "./gdelt-provider";
import { JuheProvider, getJuheProvider } from "./juhe-provider";
import { NewsdataProvider, getNewsdataProvider } from "./newsdata-provider";
import { EUROPE_COUNTRIES } from "@/lib/countries";
import type { NewsItem, NewsProvider, TopNewsResponse } from "./types";

export type { NewsItem, NewsProvider, TopNewsResponse, ApiErrorResponse } from "./types";
export {
  MockProvider,
  mockProvider,
  GdeltProvider,
  getGdeltProvider,
  JuheProvider,
  getJuheProvider,
  NewsdataProvider,
  getNewsdataProvider,
};
export { JuheError, JuheNoMatchError } from "./juhe-provider";
export { NewsdataError, NewsdataNoDataError, languageForCountry } from "./newsdata-provider";

/** 支持的数据源：NEWS_PROVIDER=mock | gdelt | juhe | newsdata，默认 mock */
export type NewsProviderId = "mock" | "gdelt" | "juhe" | "newsdata";

export const MOCK_DATA_SOURCE_ID = "mock";
export const GDELT_DATA_SOURCE_ID = "gdelt";
export const JUHE_DATA_SOURCE_ID = "juhe";
export const NEWSDATA_DATA_SOURCE_ID = "newsdata";

/** queryMode 的取值（聚合数据链路） */
export type QueryMode = NonNullable<TopNewsResponse["queryMode"]>;

/**
 * 读取当前数据源。刻意在「每次调用时」读 process.env 而不是模块加载时读：
 * 这样测试可以随时切换，也不会因为模块缓存导致 .env 改动不生效。
 */
export function getProviderId(): NewsProviderId {
  const raw = (process.env.NEWS_PROVIDER ?? "").trim().toLowerCase();
  if (raw === "gdelt") return "gdelt";
  if (raw === "juhe") return "juhe";
  if (raw === "newsdata") return "newsdata";
  return "mock";
}

/** 当前主数据源（由 NEWS_PROVIDER 决定） */
export function getNewsProvider(): NewsProvider {
  switch (getProviderId()) {
    case "gdelt":
      return getGdeltProvider();
    case "juhe":
      return getJuheProvider();
    case "newsdata":
      return getNewsdataProvider();
    default:
      return mockProvider;
  }
}

/** 兜底数据源：永远可用的 MockProvider */
export function getFallbackProvider(): NewsProvider {
  return mockProvider;
}

export function getDataSourceId(): string {
  return getProviderId();
}

/**
 * 「哪个国家当前显示的是真实新闻、哪个是演示数据」的记录。
 *
 * 只在**真的解析过一次**（用户点了某个国家）之后才写入，key = `国家|日期`。
 * /api/news/sources 直接读它即可，因此不会为了统计而额外消耗上游额度
 * —— 这正是需求里强调的「不要一次性请求 46 个国家」。
 *
 * ⚠️ 这份记录**必须挂在 globalThis 上**，不能用模块级变量：
 * Next.js 会为每个路由单独打包（实测 `.next-dev/server/app/api/news/{top,sources}/route.js`
 * 与 `app/page.js` 里各有一份本模块的副本），因此模块级 Map 在
 * `/api/news/top`（写）与 `/api/news/sources`（读）之间**根本不是同一个对象**——
 * 现象是：点了国家、拿到了真实新闻，地图却始终显示「未查询」（浅色）。
 * 挂在 globalThis 上即可让同一进程内所有路由共享同一份记录。
 */
export type ResolvedSourceStatus = { dataSource: string; itemCount: number; updatedAt: string };

const MAX_TRACKED_SOURCES = 500;

type ResolvedSourceStore = { map: Map<string, ResolvedSourceStatus> };

const resolvedSourceHost = globalThis as typeof globalThis & {
  __europeNewsResolvedSources?: ResolvedSourceStore;
};

function getResolvedSourceStore(): ResolvedSourceStore {
  if (!resolvedSourceHost.__europeNewsResolvedSources) {
    resolvedSourceHost.__europeNewsResolvedSources = { map: new Map<string, ResolvedSourceStatus>() };
  }
  return resolvedSourceHost.__europeNewsResolvedSources;
}

function rememberResolvedSource(country: string, date: string, dataSource: string, itemCount: number): void {
  const { map } = getResolvedSourceStore();
  const key = `${country}|${date}`;
  // 先删后插：让 Map 的插入顺序反映「最近更新」，裁剪时优先丢掉最旧的
  map.delete(key);
  map.set(key, { dataSource, itemCount, updatedAt: new Date().toISOString() });
  while (map.size > MAX_TRACKED_SOURCES) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

export type DataSourceSnapshotEntry = { dataSource: string; itemCount: number };

/**
 * 国家 → 数据源快照（**只读记录，不发起任何上游请求**）。
 *  - mock 模式：所有国家都是 "mock"（Mock 零成本且必然可用）
 *  - 真实源模式：只有被查询过的国家有状态，其余是 "unknown"
 */
export function resolveDataSourceSnapshot(date: string): Record<string, DataSourceSnapshotEntry> {
  const providerId = getProviderId();
  const { map } = getResolvedSourceStore();
  const snapshot: Record<string, DataSourceSnapshotEntry> = {};

  for (const country of EUROPE_COUNTRIES) {
    if (providerId === "mock") {
      snapshot[country.code] = { dataSource: MOCK_DATA_SOURCE_ID, itemCount: 3 };
      continue;
    }
    const tracked = map.get(`${country.code}|${date}`);
    snapshot[country.code] = tracked
      ? { dataSource: tracked.dataSource, itemCount: tracked.itemCount }
      : { dataSource: "unknown", itemCount: 0 };
  }

  return snapshot;
}

/** 仅供测试：清空记录 */
export function resetResolvedSources(): void {
  getResolvedSourceStore().map.clear();
}

export type ResolvedTopNews = {
  items: NewsItem[];
  /** 实际提供数据的来源：mock | gdelt | juhe | newsdata */
  dataSource: string;
  /** 聚合数据链路的筛选方式；dataSource=mock 时为 "mock" */
  queryMode?: QueryMode;
  /** 从真实源回退到 mock 时给出原因，便于日志与响应头排查 */
  fallbackReason?: string;
  /** 供响应头透出的诊断信息（值都保证是 ASCII） */
  headers?: Record<string, string>;
};

/**
 * 取 Top N 新闻，并在这里统一处理「真实源失败 → 回退 Mock」。
 *
 * 兜底放在这一层而不是路由里，好处：
 *  - 每个 Provider 只负责自己怎么取数，NewsProvider 接口保持完全不变；
 *  - 「什么算失败、怎么记日志」只有一处实现，路由保持轻薄；
 *  - 可以完全离线地做单元测试（不用起 HTTP 服务、不依赖外网）。
 *
 * `deps` 只用于测试注入（生产不传，用单例）。
 */
export async function resolveTopNews(
  countryCode: string,
  date: string,
  limit: number,
  deps: {
    providerId?: NewsProviderId;
    primary?: NewsProvider;
    fallback?: NewsProvider;
    juhe?: JuheProvider;
    newsdata?: NewsdataProvider;
  } = {},
): Promise<ResolvedTopNews> {
  const providerId = deps.providerId ?? getProviderId();
  const fallbackProvider = deps.fallback ?? mockProvider;

  if (providerId === "mock") {
    const items = await (deps.primary ?? mockProvider).getTopNews(countryCode, date, limit);
    rememberResolvedSource(countryCode, date, MOCK_DATA_SOURCE_ID, items.length);
    return { items, dataSource: MOCK_DATA_SOURCE_ID, queryMode: "mock" };
  }

  try {
    if (providerId === "juhe") {
      // 聚合数据不支持按国家查询：它只回一个国际新闻池，由 Provider 内部做两级过滤
      const juhe = deps.juhe ?? (deps.primary as JuheProvider | undefined) ?? getJuheProvider();
      const result = await juhe.getTopNewsWithMeta(countryCode, date, limit);
      if (result.items.length === 0) throw new Error("聚合数据两级过滤后为 0 条");
      rememberResolvedSource(countryCode, date, JUHE_DATA_SOURCE_ID, result.items.length);
      return {
        items: result.items,
        dataSource: JUHE_DATA_SOURCE_ID,
        queryMode: result.queryMode,
        headers: {
          "X-Query-Mode": result.queryMode,
          // 把「是命中缓存还是真的调了上游」透出来，方便一眼确认额度保护生效
          "X-Juhe-Stats": [
            `pool=${result.diagnostics.poolCached ? "cached" : "fetched"}`,
            `country=${result.diagnostics.countryCached ? "cached" : "miss"}`,
            `size=${result.diagnostics.poolSize}`,
            `matched=${result.diagnostics.matched}`,
            `pages=${result.diagnostics.pagesFetched}`,
            `calls=${result.diagnostics.upstreamCallsToday}`,
          ].join(";"),
        },
      };
    }

    if (providerId === "newsdata") {
      // NewsData.io 天生支持按国家（+主要语言）查询，不需要做池内过滤
      const newsdata = deps.newsdata ?? (deps.primary as NewsdataProvider | undefined) ?? getNewsdataProvider();
      const result = await newsdata.getTopNewsWithMeta(countryCode, date, limit);
      if (result.items.length === 0) throw new Error("NewsData.io 返回 0 条");
      rememberResolvedSource(countryCode, date, NEWSDATA_DATA_SOURCE_ID, result.items.length);
      return {
        items: result.items,
        dataSource: NEWSDATA_DATA_SOURCE_ID,
        headers: {
          // 一眼确认「是命中缓存还是真的花了 1 credit」，以及本次是否带 language
          "X-Newsdata-Stats": [
            `cache=${result.diagnostics.cached ? "hit" : "miss"}`,
            `lang=${result.diagnostics.language ?? "any"}`,
            `returned=${result.diagnostics.returned}`,
            `calls=${result.diagnostics.upstreamCallsToday}`,
          ].join(";"),
        },
      };
    }

    const primary = deps.primary ?? getGdeltProvider();
    const items = await primary.getTopNews(countryCode, date, limit);
    if (items.length === 0) {
      // 双保险：Provider 内部已在 0 条时抛错，这里再挡一层
      throw new Error("GDELT 返回 0 条");
    }
    rememberResolvedSource(countryCode, date, GDELT_DATA_SOURCE_ID, items.length);
    return { items, dataSource: GDELT_DATA_SOURCE_ID };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[news] ${providerId} 取数失败，回退 MockProvider：${countryCode} ${date} —— ${reason}`);
    const fallbackItems = await fallbackProvider.getTopNews(countryCode, date, limit);
    // 回退也要记录：用户看到的就是演示数据，地图上应该显示成灰色
    rememberResolvedSource(countryCode, date, MOCK_DATA_SOURCE_ID, fallbackItems.length);
    return {
      items: fallbackItems,
      dataSource: MOCK_DATA_SOURCE_ID,
      queryMode: "mock",
      fallbackReason: reason,
    };
  }
}
