import { request as httpsRequest } from "node:https";

import { toFipsCode } from "@/lib/gdelt-country-codes";
import { getCountry } from "@/lib/countries";
import { todayIsoDate } from "@/lib/date";
import { scoreForRank } from "./scoring";
import { TtlCache } from "./ttl-cache";
import type { NewsItem, NewsProvider } from "./types";

/**
 * GDELT DOC 2.0 API 客户端。
 *
 * 端点：https://api.gdeltproject.org/api/v2/doc/doc
 * 免费、无需 API Key，支持按国家过滤（FIPS 10-4 代码，见 lib/gdelt-country-codes.ts）。
 *
 * 实测踩到的三个坑，都在这里处理掉了：
 *
 * 1) **超频会返回 HTTP 200 + 纯文本**
 *    GDELT 要求「每 5 秒最多 1 次请求」，超了会返回
 *    "Please limit requests to one every 5 seconds or contact ..."（不是 JSON，状态码仍是 200）。
 *    所以本模块有一个**全局串行节流器**（默认 5.2s 间隔），并且把非 JSON 响应当成可重试错误，
 *    而不是当成「没有新闻」。
 *
 * 2) **连接经常超过 10 秒**
 *    undici（Node 内置 fetch）的 connectTimeout 固定 10s，实测到 GDELT 的 TCP 握手经常 >10s，
 *    表现为 `UND_ERR_CONNECT_TIMEOUT`，与业务无关。这里改用 node:https，
 *    用 socket 超时统一覆盖「连接 + 读响应」两个阶段，并配合重试。
 *
 * 3) **0 条结果应该走兜底而不是显示空列表**
 *    与 MockProvider 的契约一致：查不到就抛错，由 lib/providers/index.ts 回退到 Mock。
 */

export const GDELT_DATA_SOURCE = "gdelt";
export const GDELT_API_BASE = "https://api.gdeltproject.org/api/v2/doc/doc";

/** GDELT artlist 单条文章（只列我们真正用到的字段） */
export type GdeltArticle = {
  url?: string;
  url_mobile?: string;
  title?: string;
  seendate?: string;
  socialimage?: string;
  domain?: string;
  language?: string;
  sourcecountry?: string;
};

/** HTTP 抽象：默认用 node:https，测试可注入替身，从而完全离线地验证解析/兜底/缓存 */
export type GdeltHttpRequest = (
  url: string,
  options: { timeoutMs: number },
) => Promise<{ status: number; body: string }>;

export type GdeltProviderOptions = {
  baseUrl?: string;
  /** 单次请求的 socket 超时（连接+读取） */
  timeoutMs?: number;
  /** 一次 getTopNews 的总预算，超了就直接抛错走兜底 */
  totalBudgetMs?: number;
  /** 全局最小请求间隔，遵守 GDELT 的「每 5 秒 1 次」 */
  minIntervalMs?: number;
  maxAttempts?: number;
  maxRecords?: number;
  /** 成功结果缓存 TTL，默认 1 小时 */
  cacheTtlMs?: number;
  /** 「上游确实没有这条国家/日期」的短缓存，避免每次刷新都去戳上游 */
  negativeCacheTtlMs?: number;
  request?: GdeltHttpRequest;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  logger?: (...args: unknown[]) => void;
};

const DEFAULT_OPTIONS = {
  baseUrl: GDELT_API_BASE,
  /**
   * 单次请求超时（连接+读取）。实测到 GDELT 常常需要 10-40s，
   * 但也不宜无限等：配合 totalBudgetMs 决定最坏情况下的等待上限。
   */
  timeoutMs: 12_000,
  /**
   * 一次 getTopNews 的总预算。
   * 这是「用户点一个国家最多等多久」的上限：超了就回退 Mock，
   * 所以不能太大 —— 45s 的骨架屏没人受得了。想更耐心可用 GDELT_TOTAL_BUDGET_MS 调大。
   */
  totalBudgetMs: 30_000,
  /** 全局最小请求间隔，遵守 GDELT 的「每 5 秒 1 次」 */
  minIntervalMs: 5_200,
  maxAttempts: 3,
  maxRecords: 20,
  cacheTtlMs: 60 * 60 * 1000,
  negativeCacheTtlMs: 5 * 60 * 1000,
} as const;

const USER_AGENT = "europe-news-map/0.1 (Next.js server-side GDELT client)";

/** 全局串行节流：不同国家、并发请求都共用同一条节奏，保证任意两次上游调用间隔 ≥ minIntervalMs */
let pacerChain: Promise<void> = Promise.resolve();
let lastRequestAt = 0;

function pace(minIntervalMs: number, sleepFn: (ms: number) => Promise<void>): Promise<void> {
  const task = pacerChain.then(async () => {
    const waitMs = Math.max(0, lastRequestAt + minIntervalMs - Date.now());
    if (waitMs > 0) await sleepFn(waitMs);
    lastRequestAt = Date.now();
  });
  // 单个任务失败不应打断整条队列
  pacerChain = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}

/** 仅供测试：重置全局节流状态 */
export function resetGdeltPacer(): void {
  pacerChain = Promise.resolve();
  lastRequestAt = 0;
}

const defaultRequest: GdeltHttpRequest = (url, { timeoutMs }) =>
  new Promise((resolve, reject) => {
    const req = httpsRequest(
      url,
      {
        method: "GET",
        headers: { "user-agent": USER_AGENT, accept: "application/json" },
        // socket 超时同时覆盖「建立连接」和「等待响应」两个阶段
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("timeout", () => req.destroy(new Error(`GDELT 请求超时（${timeoutMs}ms）`)));
    req.on("error", reject);
    req.end();
  });

/** GDELT 的 seendate（如 20250926T120000Z）→ ISO 字符串（2025-09-26T12:00:00Z） */
export function gdeltSeenDateToIso(seenDate: string | undefined | null): string | null {
  if (!seenDate) return null;
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/.exec(seenDate.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}Z`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

/**
 * 从响应里抽出文章数组。
 * DOC 2.0 的 artlist 实际返回 `{ "articles": [...] }`；
 * 需求描述里的 `response.docs` 是旧版/文档里的写法，这里一并兼容，避免上游字段名变动直接打挂。
 */
export function parseGdeltArticles(payload: unknown): GdeltArticle[] {
  if (!payload || typeof payload !== "object") return [];
  const candidates = [
    (payload as { articles?: unknown }).articles,
    (payload as { docs?: unknown }).docs,
    (payload as { response?: { docs?: unknown } }).response?.docs,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate as GdeltArticle[];
  }
  return [];
}

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** 合成一行说明文字：GDELT artlist 不提供摘要，但域名/语言/来源国是真实字段，比重复标题更有信息量 */
export function buildGdeltDescription(article: GdeltArticle): string {
  const parts = ["GDELT 实时索引"];
  if (article.domain) parts.push(`来源 ${article.domain}`);
  if (article.sourcecountry) parts.push(article.sourcecountry);
  if (article.language) parts.push(article.language);
  return `${parts.join(" · ")}（GDELT artlist 模式不提供摘要）`;
}

/**
 * 清洗：丢掉缺标题 / 非 http 链接 / 时间戳无法解析的脏数据，
 * 并按标题与 URL 去重（GDELT 常有同一稿件被多家转载）。
 */
export function cleanGdeltArticles(articles: GdeltArticle[]): GdeltArticle[] {
  const seenTitles = new Set<string>();
  const seenUrls = new Set<string>();
  const cleaned: GdeltArticle[] = [];

  for (const article of articles) {
    const title = typeof article.title === "string" ? article.title.trim() : "";
    const url = typeof article.url === "string" ? article.url.trim() : "";
    if (!title || !url) continue;
    if (!/^https?:\/\//i.test(url)) continue;
    if (!gdeltSeenDateToIso(article.seendate)) continue;

    const titleKey = normalizeTitle(title);
    const urlKey = url.replace(/[#?].*$/, "").replace(/\/$/, "");
    if (!titleKey || seenTitles.has(titleKey) || seenUrls.has(urlKey)) continue;
    seenTitles.add(titleKey);
    seenUrls.add(urlKey);
    cleaned.push(article);
  }

  return cleaned;
}

/**
 * 从候选里挑 limit 条：优先让来源域名分散（避免三条都来自同一家媒体），
 * 不足时再按原顺序回填。GDELT 的 datedesc 顺序在整个过程中保持不变。
 */
export function pickDiverseArticles<T extends { sourceName: string }>(items: T[], limit: number): T[] {
  const picked: T[] = [];
  const usedSources = new Set<string>();
  const target = Math.max(1, limit);

  for (const item of items) {
    if (picked.length >= target) break;
    const source = (item.sourceName ?? "").toLowerCase();
    if (source && usedSources.has(source)) continue;
    if (source) usedSources.add(source);
    picked.push(item);
  }
  for (const item of items) {
    if (picked.length >= target) break;
    if (!picked.includes(item)) picked.push(item);
  }

  return picked;
}

/** 清洗 + 挑选（对外暴露的组合函数，便于测试与复用） */
export function selectTopArticles(articles: GdeltArticle[], limit: number): GdeltArticle[] {
  return pickDiverseArticles(
    cleanGdeltArticles(articles).map((article) => ({ ...article, sourceName: article.domain ?? "GDELT" })),
    limit,
  ).map(({ sourceName: _sourceName, ...article }) => article);
}

/** 已映射但尚未定排名的条目（排名在最后挑选时才确定） */
export type MappedGdeltNews = Omit<NewsItem, "rank" | "score">;

/** 原始文章 → NewsItem（不含 rank/score，排名在挑选之后统一赋） */
export function mapArticleToNewsItem(article: GdeltArticle): MappedGdeltNews {
  return {
    title: String(article.title ?? "").trim(),
    sourceName: article.domain ? String(article.domain) : "GDELT",
    publishedAt: gdeltSeenDateToIso(article.seendate) ?? new Date().toISOString(),
    url: String(article.url ?? ""),
    description: buildGdeltDescription(article),
    // 需求要求留空：一是 artlist 的 socialimage 不是每篇都有，
    // 二是用了它前端就会去请求外部图片，破坏「Network 里只有同源请求」这条验收。
    imageUrl: undefined,
  };
}

/** 定排名 + 按固定规则给热度分 */
export function toNewsItem(mapped: MappedGdeltNews, rank: number): NewsItem {
  return { ...mapped, rank, score: scoreForRank(rank) };
}

/** 依据日期选择时间窗口：今天用 timespan=1d（覆盖过去 24 小时），历史/未来日期用显式区间，否则日期选择器会失去意义 */
export function buildTimeWindowParam(date: string, today = todayIsoDate()): string {
  if (date === today) return "timespan=1d";
  const compact = date.replace(/-/g, "");
  return `startdatetime=${compact}000000&enddatetime=${compact}235959`;
}

export function buildGdeltUrl(options: {
  query: string;
  date: string;
  today?: string;
  maxRecords: number;
  baseUrl?: string;
}): string {
  const params = new URLSearchParams();
  params.set("query", options.query);
  params.set("mode", "artlist");
  params.set("format", "json");
  params.set("maxrecords", String(options.maxRecords));
  params.set("sort", "datedesc");
  const base = options.baseUrl ?? GDELT_API_BASE;
  return `${base}?${params.toString()}&${buildTimeWindowParam(options.date, options.today)}`;
}

/**
 * 查询策略模板（按顺序尝试，命中即止）。占位符：{fips}、{name}。
 *
 * 这里和需求文档给的写法有出入，是实测结论：
 *  - 文档写的 `locationcc:<FIPS>` 被真实 API **拒绝**：
 *    返回 200 + 纯文本「One or more of your keywords were too short, too long or too common: (locationcc:gm)」。
 *    即它被当成关键字而不是运算符，拿不到任何数据。
 *  - `sourcecountry:<FIPS>`（DOC 2.0 官方运算符，值为 FIPS 代码）能返回合法 JSON，是有效的国家过滤。
 *  - 纯运算符查询在小国/冷门时段容易 0 条，所以补一个「国家名关键词」兜底策略。
 *
 * 想自己验证/调整（例如你的网络下 locationcc 可用），用环境变量覆盖即可，不用改代码：
 *   GDELT_QUERY_TEMPLATES=locationcc:{fips},sourcecountry:{fips},"{name}"
 */
const DEFAULT_QUERY_TEMPLATES = ['sourcecountry:{fips}', '"{name}"'];

function resolveQueryTemplates(): string[] {
  const raw = process.env.GDELT_QUERY_TEMPLATES;
  if (!raw) return DEFAULT_QUERY_TEMPLATES;
  const parsed = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : DEFAULT_QUERY_TEMPLATES;
}

/** 把模板展开成具体查询串 */
export function buildQueryTemplates(
  fips: string,
  countryName: string,
  templates: string[] = resolveQueryTemplates(),
): string[] {
  return templates.map((template) =>
    template.replaceAll("{fips}", fips).replaceAll("{name}", countryName),
  );
}

export class GdeltNoDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GdeltNoDataError";
  }
}

export class GdeltError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GdeltError";
  }
}

export class GdeltProvider implements NewsProvider {
  readonly id = GDELT_DATA_SOURCE;

  private readonly options: Required<Omit<GdeltProviderOptions, "request" | "sleep" | "now" | "logger">> & {
    request: GdeltHttpRequest;
    sleep: (ms: number) => Promise<void>;
    now: () => number;
    logger: (...args: unknown[]) => void;
  };

  private readonly cache: TtlCache<MappedGdeltNews[]>;

  constructor(options: GdeltProviderOptions = {}) {
    this.options = {
      baseUrl: options.baseUrl ?? process.env.GDELT_API_BASE ?? DEFAULT_OPTIONS.baseUrl,
      timeoutMs: options.timeoutMs ?? Number(process.env.GDELT_TIMEOUT_MS ?? DEFAULT_OPTIONS.timeoutMs),
      totalBudgetMs:
        options.totalBudgetMs ?? Number(process.env.GDELT_TOTAL_BUDGET_MS ?? DEFAULT_OPTIONS.totalBudgetMs),
      minIntervalMs:
        options.minIntervalMs ?? Number(process.env.GDELT_MIN_INTERVAL_MS ?? DEFAULT_OPTIONS.minIntervalMs),
      maxAttempts: options.maxAttempts ?? Number(process.env.GDELT_MAX_ATTEMPTS ?? DEFAULT_OPTIONS.maxAttempts),
      maxRecords: options.maxRecords ?? DEFAULT_OPTIONS.maxRecords,
      cacheTtlMs: options.cacheTtlMs ?? DEFAULT_OPTIONS.cacheTtlMs,
      negativeCacheTtlMs: options.negativeCacheTtlMs ?? DEFAULT_OPTIONS.negativeCacheTtlMs,
      request: options.request ?? defaultRequest,
      sleep: options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms))),
      now: options.now ?? (() => Date.now()),
      logger: options.logger ?? ((...args: unknown[]) => console.warn(...args)),
    };
    this.cache = new TtlCache<MappedGdeltNews[]>(this.options.cacheTtlMs);
  }

  /** 诊断/测试用：缓存状态 */
  inspectCache() {
    return this.cache.inspect();
  }

  async getTopNews(countryCode: string, date: string, limit: number): Promise<NewsItem[]> {
    const country = (countryCode ?? "").trim().toUpperCase();
    const fips = toFipsCode(country);
    if (!fips) {
      throw new GdeltError(`GDELT 没有 ${country} 的 FIPS 映射，无法查询`);
    }

    const cacheKey = `${country}|${date}`;
    const candidates = await this.cache.getOrLoad(
      cacheKey,
      async () => {
        const articles = await this.fetchArticles(fips, country, date);
        return articles.map((article) => mapArticleToNewsItem(article));
      },
      this.options.cacheTtlMs,
    );

    if (candidates.length === 0) {
      // 上游确实没有这个国家/日期的报道：抛错交给上层兜底，并写入短缓存避免反复打上游
      this.cache.set(cacheKey, [], this.options.negativeCacheTtlMs);
      throw new GdeltNoDataError(`GDELT 在 ${date} 没有返回 ${country} 的任何文章`);
    }

    // 最终 Top N 在这里才决定：先按来源域名分散，再定排名与热度分
    return pickDiverseArticles(candidates, limit).map((item, index) => toNewsItem(item, index + 1));
  }

  /**
   * 依次尝试查询策略，返回清洗后的候选文章。
   *
   * 返回 [] 的含义被刻意收紧为「确实拿到了合法 JSON，但里面一篇文章都没有」；
   * 如果是限流 / 网络失败 / 非 JSON，则抛 GdeltError 并带上**可操作的诊断**，
   * 这样上层日志与 check:gdelt 能直接告诉使用者是「被限流」还是「网络不通」。
   */
  private async fetchArticles(fips: string, country: string, date: string): Promise<GdeltArticle[]> {
    const countryName = getCountry(country)?.name ?? country;
    const strategies = buildQueryTemplates(fips, countryName);
    const startedAt = this.options.now();

    let sawRateLimit = false;
    let networkFailures = 0;
    const httpErrors: number[] = [];
    let sawValidJson = false;

    for (const query of strategies) {
      const url = buildGdeltUrl({
        query,
        date,
        maxRecords: this.options.maxRecords,
        baseUrl: this.options.baseUrl,
      });

      for (let attempt = 1; attempt <= this.options.maxAttempts; attempt += 1) {
        const spent = this.options.now() - startedAt;
        const remaining = this.options.totalBudgetMs - spent;
        if (remaining <= 0) {
          throw new GdeltError(
            `GDELT 查询超出总预算 ${this.options.totalBudgetMs}ms（${country} ${date}）：${this.diagnose({
              sawRateLimit,
              networkFailures,
              httpErrors,
            })}`,
          );
        }

        await pace(this.options.minIntervalMs, this.options.sleep);

        let status = 0;
        let body = "";
        try {
          const response = await this.options.request(url, {
            timeoutMs: Math.max(1_000, Math.min(this.options.timeoutMs, remaining)),
          });
          status = response.status;
          body = response.body;
        } catch (error) {
          networkFailures += 1;
          this.options.logger(
            `[gdelt] ${country} ${date} ${query} 第 ${attempt}/${this.options.maxAttempts} 次请求失败：${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          continue;
        }

        if (status !== 200) {
          if (status === 429) sawRateLimit = true;
          else httpErrors.push(status);
          this.options.logger(`[gdelt] ${country} ${date} ${query} HTTP ${status}`);
          continue;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          // 实测：GDELT 超频时返回 200 + 纯文本限流提示；查询写法不合法时返回 200 + 纯文本校验错误
          if (/please limit requests/i.test(body)) sawRateLimit = true;
          this.options.logger(
            `[gdelt] ${country} ${date} ${query} 返回非 JSON（限流或查询被拒）：${body.slice(0, 120)}`,
          );
          continue;
        }

        sawValidJson = true;
        const articles = cleanGdeltArticles(parseGdeltArticles(parsed));
        if (articles.length > 0) return articles.slice(0, this.options.maxRecords);
        // 这个策略确实没有结果：换下一个策略，不必在同一策略上重试
        break;
      }
    }

    if (!sawValidJson) {
      throw new GdeltError(
        `GDELT 查询未成功（${country} ${date}）：${this.diagnose({ sawRateLimit, networkFailures, httpErrors })}`,
      );
    }

    return [];
  }

  /** 把失败情况翻译成一句可操作的话 */
  private diagnose(input: { sawRateLimit: boolean; networkFailures: number; httpErrors: number[] }): string {
    const parts: string[] = [];
    if (input.sawRateLimit) {
      parts.push("被 GDELT 限流（HTTP 429 或 200+限流提示，官方要求每 5 秒最多 1 次）");
    }
    if (input.networkFailures > 0) {
      parts.push(`网络请求失败 ${input.networkFailures} 次（连接超时或被重置）`);
    }
    if (input.httpErrors.length > 0) {
      parts.push(`上游异常状态码 ${[...new Set(input.httpErrors)].join("/")}`);
    }
    return parts.length > 0 ? parts.join("；") : "未知原因";
  }
}

/**
 * 默认单例（**惰性创建**）：整个进程共享一份缓存与节流节奏。
 *
 * 为什么是惰性而不是模块加载时 new：
 * 构造函数会读取 GDELT_API_BASE / GDELT_TIMEOUT_MS 等环境变量，
 * 如果模块一被 import 就实例化，那么「先 import、后设置环境变量」的场景（测试、脚本）
 * 会静默使用默认值 —— 我们就真的踩过一次（测试以为指向了假地址，实际打到了真 GDELT）。
 */
let gdeltProviderInstance: GdeltProvider | null = null;

export function getGdeltProvider(): GdeltProvider {
  if (!gdeltProviderInstance) {
    gdeltProviderInstance = new GdeltProvider();
  }
  return gdeltProviderInstance;
}

/** 仅用于测试：丢弃单例，让下次调用重新按当前环境变量构造 */
export function resetGdeltProvider(): void {
  gdeltProviderInstance = null;
}
