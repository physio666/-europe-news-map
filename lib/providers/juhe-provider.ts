import { describeJuheError, juheErrorKind } from "@/lib/juhe-error-codes";
import {
  filterJuheArticles,
  toIsoLocalDateTime,
  type JuheArticle,
  type JuheQueryMode,
} from "@/lib/juhe-filters";
import { todayIsoDate } from "@/lib/date";
import { httpsGetText, redactUrl, type HttpTextResponse } from "./http";
import { scoreForRank } from "./scoring";
import { TtlCache } from "./ttl-cache";
import type { NewsItem, NewsProvider } from "./types";

/**
 * 聚合数据「新闻头条」Provider。
 *
 * 该接口**不支持按国家查询**，只能 `type=guoji` 拉国际新闻池，再用 lib/juhe-filters.ts
 * 的「关键词 + 来源域名」两级规则过滤出目标国家的稿件。因此这里的工程重点不是解析，
 * 而是**省额度**与**别把错误当成功**：
 *
 * 1) 免费额度只有 50 次/天 → 三层保护：
 *    - 全局串行 + 两次上游请求间隔 ≥3 秒；
 *    - **新闻池缓存**（1 小时，全国家共享）：46 个国家各查一次只会消耗 1 次额度，
 *      而不是 46 次。这一层是省额度的关键，比「per-country 缓存」重要得多；
 *    - per-country 结果缓存（key = 国家|日期，TTL 1 小时，符合需求）+ 当日调用上限保护。
 * 2) HTTP 200 ≠ 成功：业务结果看 `error_code`，非 0 一律按失败处理并回退 Mock。
 * 3) 拿不到 Key 时**不发请求**直接报错：省额度，也让原因更直白。
 */

export const JUHE_DATA_SOURCE = "juhe";
export const JUHE_API_BASE = "https://v.juhe.cn/toutiao/index";

export type JuheProviderOptions = {
  apiBase?: string;
  apiKey?: string;
  type?: string;
  page?: number;
  pageSize?: number;
  isFilter?: string;
  /** 单次请求超时 */
  timeoutMs?: number;
  /** 全局最小请求间隔（免费额度有限，默认 3 秒） */
  minIntervalMs?: number;
  /** 新闻池缓存 TTL（全国家共享） */
  poolTtlMs?: number;
  /** 单国家结果缓存 TTL（需求要求 1 小时） */
  cacheTtlMs?: number;
  /** 一次请求最多翻几页找目标国家（1 = 只用 page 1） */
  maxPages?: number;
  /** 当日上游调用次数上限（免费额度 50，留一点余量） */
  dailyLimit?: number;
  /** 非今天的日期是否只保留当天稿件（默认 true，避免拿今天的新闻冒充历史日期） */
  strictDate?: boolean;
  request?: (url: string, options: { timeoutMs: number }) => Promise<HttpTextResponse>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  logger?: (...args: unknown[]) => void;
};

const DEFAULT_OPTIONS = {
  apiBase: JUHE_API_BASE,
  type: "guoji",
  page: 1,
  pageSize: 30,
  isFilter: "0",
  timeoutMs: 10_000,
  minIntervalMs: 3_000,
  poolTtlMs: 60 * 60 * 1000,
  cacheTtlMs: 60 * 60 * 1000,
  maxPages: 2,
  dailyLimit: 45,
  strictDate: true,
} as const;

/** 全局串行节流：不同国家、并发请求共用同一条节奏 */
let pacerChain: Promise<void> = Promise.resolve();
let lastRequestAt = 0;

function pace(minIntervalMs: number, sleepFn: (ms: number) => Promise<void>): Promise<void> {
  const task = pacerChain.then(async () => {
    const waitMs = Math.max(0, lastRequestAt + minIntervalMs - Date.now());
    if (waitMs > 0) await sleepFn(waitMs);
    lastRequestAt = Date.now();
  });
  pacerChain = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}

/** 仅供测试 */
export function resetJuhePacer(): void {
  pacerChain = Promise.resolve();
  lastRequestAt = 0;
}

export class JuheError extends Error {
  readonly code: number | null;

  constructor(message: string, code: number | null = null) {
    super(message);
    this.name = "JuheError";
    this.code = code;
  }
}

export class JuheNoMatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JuheNoMatchError";
  }
}

export type JuheTopNews = {
  items: NewsItem[];
  /** keyword | domain | both（回退 Mock 时由上层写成 "mock"） */
  queryMode: Exclude<JuheQueryMode, "mock">;
  /** 诊断信息，进日志与响应头 */
  diagnostics: {
    /** 本次是否直接命中「国家|日期」结果缓存（命中就不会再碰新闻池） */
    countryCached: boolean;
    /** 本次用的新闻池是否来自共享缓存（true 表示没有产生上游调用） */
    poolCached: boolean;
    poolSize: number;
    matched: number;
    upstreamCallsToday: number;
    pagesFetched: number;
  };
};

/** 解析聚合数据响应体：区分「HTTP 成功但业务失败」和「真的没数据」 */
export function parseJuheResponse(body: string): { articles: JuheArticle[]; errorCode: number; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new JuheError(`聚合数据返回的不是 JSON：${body.slice(0, 120)}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new JuheError("聚合数据返回结构异常（不是对象）");
  }
  const payload = parsed as {
    error_code?: number | string;
    reason?: string;
    result?: { data?: unknown } | null;
  };
  const errorCode = Number(payload.error_code ?? 0);
  const reason = String(payload.reason ?? "");
  if (errorCode !== 0) {
    throw new JuheError(describeJuheError(errorCode, reason), errorCode);
  }
  const data = payload.result?.data;
  if (!Array.isArray(data)) {
    // error_code=0 但没有 data：视为「确实没有新闻」
    return { articles: [], errorCode: 0, reason };
  }
  return { articles: data as JuheArticle[], errorCode: 0, reason };
}

export function buildJuheUrl(options: {
  apiBase: string;
  apiKey: string;
  type: string;
  page: number;
  pageSize: number;
  isFilter: string;
}): string {
  const params = new URLSearchParams({
    key: options.apiKey,
    type: options.type,
    page: String(options.page),
    page_size: String(options.pageSize),
    is_filter: options.isFilter,
  });
  return `${options.apiBase}?${params.toString()}`;
}

export class JuheProvider implements NewsProvider {
  readonly id = JUHE_DATA_SOURCE;

  private readonly options: Required<
    Omit<JuheProviderOptions, "request" | "sleep" | "now" | "logger" | "apiKey">
  > & {
    apiKey: string;
    request: (url: string, options: { timeoutMs: number }) => Promise<HttpTextResponse>;
    sleep: (ms: number) => Promise<void>;
    now: () => number;
    logger: (...args: unknown[]) => void;
  };

  /** 单国家结果缓存：key = 国家|日期 */
  private readonly countryCache: TtlCache<JuheTopNews>;
  /** 新闻池缓存：所有国家共享同一次上游调用（省额度的关键） */
  private readonly poolCache: TtlCache<{ articles: JuheArticle[]; pages: number }>;
  /** 当日上游调用计数（免费额度保护） */
  private upstreamCalls = 0;
  private upstreamDay = "";
  /** 最近一次上游失败，避免连续请求把额度打光 */
  private lastFailure: { at: number; message: string; code: number | null } | null = null;

  constructor(options: JuheProviderOptions = {}) {
    this.options = {
      apiBase: options.apiBase ?? process.env.JUHE_API_BASE ?? DEFAULT_OPTIONS.apiBase,
      apiKey: options.apiKey ?? process.env.JUHE_NEWS_KEY ?? "",
      type: options.type ?? process.env.JUHE_NEWS_TYPE ?? DEFAULT_OPTIONS.type,
      page: options.page ?? Number(process.env.JUHE_PAGE ?? DEFAULT_OPTIONS.page),
      pageSize: options.pageSize ?? Number(process.env.JUHE_PAGE_SIZE ?? DEFAULT_OPTIONS.pageSize),
      isFilter: options.isFilter ?? process.env.JUHE_IS_FILTER ?? DEFAULT_OPTIONS.isFilter,
      timeoutMs: options.timeoutMs ?? Number(process.env.JUHE_TIMEOUT_MS ?? DEFAULT_OPTIONS.timeoutMs),
      minIntervalMs:
        options.minIntervalMs ?? Number(process.env.JUHE_MIN_INTERVAL_MS ?? DEFAULT_OPTIONS.minIntervalMs),
      poolTtlMs: options.poolTtlMs ?? Number(process.env.JUHE_POOL_TTL_MS ?? DEFAULT_OPTIONS.poolTtlMs),
      cacheTtlMs: options.cacheTtlMs ?? DEFAULT_OPTIONS.cacheTtlMs,
      maxPages: options.maxPages ?? Number(process.env.JUHE_MAX_PAGES ?? DEFAULT_OPTIONS.maxPages),
      dailyLimit: options.dailyLimit ?? Number(process.env.JUHE_DAILY_LIMIT ?? DEFAULT_OPTIONS.dailyLimit),
      strictDate: options.strictDate ?? DEFAULT_OPTIONS.strictDate,
      request: options.request ?? ((url, config) => httpsGetText(url, { timeoutMs: config.timeoutMs })),
      sleep: options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms))),
      now: options.now ?? (() => Date.now()),
      logger: options.logger ?? ((...args: unknown[]) => console.warn(...args)),
    };
    this.countryCache = new TtlCache<JuheTopNews>(this.options.cacheTtlMs);
    this.poolCache = new TtlCache<{ articles: JuheArticle[]; pages: number }>(this.options.poolTtlMs);
  }

  /** 诊断/测试用 */
  inspectCache() {
    return {
      countries: this.countryCache.inspect(),
      pool: this.poolCache.inspect(),
      upstreamCallsToday: this.upstreamCalls,
    };
  }

  async getTopNews(countryCode: string, date: string, limit: number): Promise<NewsItem[]> {
    const result = await this.getTopNewsWithMeta(countryCode, date, limit);
    return result.items;
  }

  async getTopNewsWithMeta(countryCode: string, date: string, limit: number): Promise<JuheTopNews> {
    const country = (countryCode ?? "").trim().toUpperCase();
    const safeLimit = Math.min(Math.max(Math.trunc(limit) || 3, 1), 10);

    // 没有 Key 就不要浪费一次额度，直接给出可诊断的错误
    if (!this.options.apiKey.trim()) {
      throw new JuheError("缺少 JUHE_NEWS_KEY 环境变量（未配置聚合数据 AppKey）");
    }

    const cacheKey = `${country}|${date}`;
    const cached = this.countryCache.get(cacheKey);
    if (cached) {
      // 命中「国家|日期」结果缓存：本次没有访问新闻池，更没有任何上游调用。
      // 把这两个标记刷新成当前事实，避免下游看到首次请求时的旧值而误判额度消耗。
      return {
        ...cached,
        items: cached.items.slice(0, safeLimit),
        diagnostics: { ...cached.diagnostics, countryCached: true, poolCached: true },
      };
    }

    const { pool, poolCached, pagesFetched } = await this.getPool(country, date);
    const strictDate = this.options.strictDate && date !== todayIsoDate() ? date : undefined;
    const { matches, queryMode } = filterJuheArticles(pool, country, { strictDate });

    if (matches.length === 0 || !queryMode) {
      throw new JuheNoMatchError(
        strictDate
          ? `聚合数据国际新闻池里没有 ${country} 在 ${date} 当天的稿件（该接口只有当前新闻池，无法回溯历史日期）`
          : `聚合数据国际新闻池（${pool.length} 条）里没有 ${country} 相关稿件（关键词与来源域名都没命中）`,
      );
    }

    const items: NewsItem[] = matches.slice(0, 10).map((match, index) => {
      // 只保留 https 缩略图：部署到 Vercel 后站点是 https，
      // 而聚合数据返回的图片大量是 http://…（例如 cms-bucket.ws.126.net），
      // 浏览器会按「混合内容」直接拦掉 —— 卡片上就会出现一片加载失败的空图。
      const thumbnail =
        typeof match.article.thumbnail_pic_s === "string" ? match.article.thumbnail_pic_s.trim() : "";
      return {
        rank: index + 1,
        title: String(match.article.title ?? "").trim(),
        sourceName: String(match.article.author_name ?? "聚合数据").trim() || "聚合数据",
        // 需求给的是聚合数据的 date 原串（"2026-09-27 08:47:15"）；
        // 这里只把分隔符换成 T，墙上时间完全一致，但保证是合法 ISO、Date.parse 与前端格式化都稳。
        publishedAt: toIsoLocalDateTime(match.article.date) ?? match.article.date ?? "",
        url: String(match.article.url ?? ""),
        // 需求：聚合数据列表接口不返回摘要 → 留空（前端卡片对空摘要已有兜底渲染）
        description: "",
        imageUrl: thumbnail.startsWith("https://") ? thumbnail : undefined,
        score: scoreForRank(index + 1),
      };
    });

    const result: JuheTopNews = {
      items,
      queryMode,
      diagnostics: {
        countryCached: false,
        poolCached,
        poolSize: pool.length,
        matched: matches.length,
        upstreamCallsToday: this.upstreamCalls,
        pagesFetched,
      },
    };

    this.countryCache.set(cacheKey, result, this.options.cacheTtlMs);
    return { ...result, items: items.slice(0, safeLimit) };
  }

  /** 取新闻池（优先命中共享缓存），必要时按页扩大 */
  private async getPool(
    country: string,
    date: string,
  ): Promise<{ pool: JuheArticle[]; poolCached: boolean; pagesFetched: number }> {
    const poolKey = `${this.options.type}|p${this.options.page}|s${this.options.pageSize}|f${this.options.isFilter}`;
    const cached = this.poolCache.get(poolKey);
    if (cached) {
      return { pool: cached.articles, poolCached: true, pagesFetched: cached.pages };
    }

    const pool: JuheArticle[] = [];
    let pagesFetched = 0;
    const maxPages = Math.max(1, this.options.maxPages);

    for (let pageOffset = 0; pageOffset < maxPages; pageOffset += 1) {
      const page = this.options.page + pageOffset;
      const articles = await this.fetchPage(page, country, date);
      pagesFetched += 1;
      pool.push(...articles);

      // 已经在池子里找到这个国家的稿子就不必再翻页（省额度）
      const probe = filterJuheArticles(pool, country, {
        strictDate: this.options.strictDate && date !== todayIsoDate() ? date : undefined,
      });
      if (probe.matches.length > 0) break;
    }

    this.poolCache.set(poolKey, { articles: pool, pages: pagesFetched }, this.options.poolTtlMs);
    return { pool, poolCached: false, pagesFetched };
  }

  /** 拉取一页；含节流、当日额度保护与「最近失败」短路 */
  private async fetchPage(page: number, country: string, date: string): Promise<JuheArticle[]> {
    const now = this.options.now();
    const today = new Date(now).toISOString().slice(0, 10);
    if (this.upstreamDay !== today) {
      this.upstreamDay = today;
      this.upstreamCalls = 0;
    }

    // 上游刚刚失败过：短时间内不再打，避免把 50 次额度浪费在必失的请求上
    if (this.lastFailure && now - this.lastFailure.at < 60_000) {
      throw new JuheError(`${this.lastFailure.message}（60 秒内不重复请求上游）`, this.lastFailure.code);
    }

    if (this.upstreamCalls >= this.options.dailyLimit) {
      throw new JuheError(
        `已达当日上游调用上限保护（${this.options.dailyLimit} 次，免费额度约 50 次/天），今日不再请求聚合数据`,
      );
    }

    await pace(this.options.minIntervalMs, this.options.sleep);

    const url = buildJuheUrl({
      apiBase: this.options.apiBase,
      apiKey: this.options.apiKey,
      type: this.options.type,
      page,
      pageSize: this.options.pageSize,
      isFilter: this.options.isFilter,
    });

    this.upstreamCalls += 1;
    let response: HttpTextResponse;
    try {
      response = await this.options.request(url, { timeoutMs: this.options.timeoutMs });
    } catch (error) {
      const message = `请求聚合数据失败：${error instanceof Error ? error.message : String(error)}`;
      this.lastFailure = { at: now, message, code: null };
      this.options.logger(`[juhe] ${country} ${date} page${page} ${redactUrl(url)} → ${message}`);
      throw new JuheError(message);
    }

    if (response.status !== 200) {
      const message = `聚合数据返回 HTTP ${response.status}`;
      this.lastFailure = { at: now, message, code: null };
      throw new JuheError(message);
    }

    try {
      const { articles } = parseJuheResponse(response.body);
      this.lastFailure = null;
      return articles;
    } catch (error) {
      const code = error instanceof JuheError ? error.code : null;
      const message = error instanceof Error ? error.message : String(error);
      // 额度类/配置类错误短时间内别重试；业务类错误同样缓存 60 秒，保护额度
      this.lastFailure = { at: now, message, code };
      this.options.logger(
        `[juhe] ${country} ${date} page${page} 业务失败（${juheErrorKind(code ?? 0)}）：${message}`,
      );
      throw error;
    }
  }
}

/** 默认单例（惰性创建：环境变量在「首次使用」时读取，测试可随时覆盖） */
let juheProviderInstance: JuheProvider | null = null;

export function getJuheProvider(): JuheProvider {
  if (!juheProviderInstance) {
    juheProviderInstance = new JuheProvider();
  }
  return juheProviderInstance;
}

/** 仅供测试 */
export function resetJuheProvider(): void {
  juheProviderInstance = null;
}
