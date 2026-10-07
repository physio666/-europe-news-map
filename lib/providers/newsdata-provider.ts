import { todayIsoDate } from "@/lib/date";
import { httpsGetText, redactUrl, type HttpTextResponse } from "./http";
import { scoreForRank } from "./scoring";
import { TtlCache } from "./ttl-cache";
import type { NewsItem, NewsProvider } from "./types";

/**
 * NewsData.io Provider（https://newsdata.io/api/1/news）。
 *
 * 与聚合数据最大的区别：**它天生就支持按国家查询**（`country=de&language=de`），
 * 不需要像 juhe 那样从国际新闻池里做关键词/域名两级过滤，因此实现重点变成：
 *
 * 1) 语言映射：`country=<alpha-2 小写>` 是必填，`language` 是可选的。
 *    这里只给「主流新闻语言明确」的国家配语言，其余（微型国家、白俄罗斯、卢森堡、马耳他）
 *    **刻意不传 language**，让接口返回该国所有语言的新闻 —— 传错了只会拿到 0 条，
 *    而不传最多是语言杂一些（需求也是这么建议的）。
 * 2) 额度：免费层 200 credits/天、每请求 1 credit、每次最多 10 条。
 *    因此 per-country 结果缓存（key = 国家|日期，TTL 1 小时）+ 全局串行（间隔 ≥1s）
 *    + 当日调用上限保护；同一国家同一天刷新多少次都只花 1 credit。
 * 3) HTTP 200/401 都要看业务字段：真正的错误是 `status: "error"` +
 *    `results.code` / `results.message`（实测 401 返回
 *    `{"status":"error","results":{"code":"Unauthorized","message":"The provided API key is not valid."}}`），
 *    所以这里把 `results` / `error` 两种形状都兼容，并把错误码翻成人话写进回退原因。
 * 4) 拿不到 Key 时**不发请求**：省额度，也让原因直白（`缺少 NEWSDATA_API_KEY`）。
 */

export const NEWSDATA_DATA_SOURCE = "newsdata";
export const NEWSDATA_API_BASE = "https://newsdata.io/api/1/news";

/** 免费层单次最多返回 10 条（需求：我们只用前 3 条） */
export const NEWSDATA_MAX_SIZE = 10;

/**
 * 国家（ISO 3166-1 alpha-2）→ 主要新闻语言（ISO 639-1）。
 *
 * 需求给了 27 个主流国家，这里再补上语言同样明确的欧洲国家。
 * **不在表里的国家就是不传 `language`**（微型国家几乎没有本国语新闻索引，
 * 传 language 只会把结果筛成 0 条）：
 *   AD / LI / MC / SM / VA（微型国家）、BY（俄语/白俄语混杂）、
 *   LU（卢森堡语/法语/德语混杂）、MT（马耳他语/英语混杂）。
 */
export const COUNTRY_LANGUAGE: Record<string, string> = {
  // —— 需求指定的 27 个 ——
  DE: "de",
  FR: "fr",
  GB: "en",
  IT: "it",
  ES: "es",
  PL: "pl",
  NL: "nl",
  SE: "sv",
  NO: "no",
  FI: "fi",
  DK: "da",
  IE: "en",
  PT: "pt",
  GR: "el",
  CZ: "cs",
  AT: "de",
  CH: "de",
  BE: "nl",
  HU: "hu",
  RO: "ro",
  BG: "bg",
  HR: "hr",
  SK: "sk",
  SI: "sl",
  RS: "sr",
  UA: "uk",
  RU: "ru",
  // —— 补充：语言明确、能提高命中率的国家 ——
  AL: "sq",
  BA: "bs",
  CY: "el",
  EE: "et",
  IS: "is",
  LT: "lt",
  LV: "lv",
  MD: "ro",
  ME: "sr",
  MK: "mk",
  XK: "sq",
};

/** 取国家对应的主要语言；返回 null 表示「不要传 language」 */
export function languageForCountry(countryCode: string | null | undefined): string | null {
  const code = (countryCode ?? "").trim().toUpperCase();
  return COUNTRY_LANGUAGE[code] ?? null;
}

export type NewsdataErrorKind = "auth" | "quota" | "plan" | "country" | "params" | "network" | "unknown";

/**
 * 把 NewsData.io 的错误码归类，便于决定「值不值得重试」以及提示怎么修。
 * 码表来自官方 OpenAPI（https://newsdata.io/openapi.json 的 ErrorCode enum），
 * 所以这里的归类不是猜的：
 *   Unauthorized / AccessDenied        → 鉴权/权限
 *   RateLimitExceeded / ApiLimitExceeded / TooManyRequests → 额度（等窗口或明天再试）
 *   UnsupportedFilter＋invalid_country → 该国不在覆盖范围（按设计回退 Mock）
 *   其余 Unsupported / Invalid / TooMany 开头 → 参数问题
 */
export function newsdataErrorKind(code: string | null | undefined): NewsdataErrorKind {
  // 官方码表里 "ServiceUnavailable " 带尾随空格，所以统一 trim 后再比
  const value = (code ?? "").trim().toLowerCase();
  if (!value) return "unknown";
  if (["unauthorized", "accessdenied", "apikeymissing", "invalidapikey", "authenticationerror", "forbidden"].includes(value)) {
    return "auth";
  }
  if (
    ["ratelimitexceeded", "apilimitexceeded", "toomanyrequests", "quotaexceeded", "dailylimitexceeded"].includes(value)
  ) {
    return "quota";
  }
  if (["planupgraderequired", "upgradeplan", "notallowed", "restrictedparameter", "invalidplan"].includes(value)) {
    return "plan";
  }
  if (["unsupportedcountry", "invalidcountry", "countrynotfound", "unsupportedfilter"].includes(value)) {
    return "country";
  }
  if (
    [
      "invalidrequest",
      "malformedquery",
      "malformedurl",
      "unsupportedparameter",
      "unsupporteddateformat",
      "unsupportedquerylength",
      "unsupportedqintitlelength",
      "unsupportedqinmetalength",
      "toomanyqueryfilter",
      "toomanyfilter",
      "toomanylogicaloperator",
      "filterlimitexceed",
      "maxpagelimitexceeded",
      "parametermissing",
      "missingparameter",
      "invalidparameter",
      "invalidparameters",
      "badrequest",
    ].includes(value)
  ) {
    return "params";
  }
  // ServerError / ServiceUnavailable / NotFound / Conflict 等一律当作可重试的未知错误
  return "unknown";
}

/** 错误码 → 可操作的中文说明（会写进 X-Fallback-Reason，所以必须是纯文本、不含 Key） */
export function describeNewsdataError(
  code: string | null | undefined,
  message?: string,
  rejectedFilter?: string | null,
): string {
  const detail = (message ?? "").trim();
  const suffix = detail ? `：${detail}` : "";
  const rejected = (rejectedFilter ?? "").trim();
  const rejectedSuffix = rejected ? `（被拒绝的筛选值：${rejected}）` : "";
  switch (newsdataErrorKind(code)) {
    case "auth":
      return `NewsData.io 拒绝了请求（${code}）${suffix} —— 请检查 .env.local 里的 NEWSDATA_API_KEY`;
    case "quota":
      return `NewsData.io 当日额度/频率已用尽（${code}）${suffix} —— 免费层 200 credits/天，明天再试或改用其他数据源`;
    case "plan":
      return `NewsData.io 表示该参数需要更高套餐（${code}）${suffix}`;
    case "country":
      return `NewsData.io 不支持这个国家或该筛选值（${code}）${suffix}${rejectedSuffix} —— 该国家会按设计回退 Mock`;
    case "params":
      return `NewsData.io 认为请求参数非法（${code}）${suffix}${rejectedSuffix}`;
    default:
      return `NewsData.io 返回业务错误${code ? `（${code}）` : ""}${suffix}${rejectedSuffix}`;
  }
}

export class NewsdataError extends Error {
  readonly code: string | null;

  constructor(message: string, code: string | null = null) {
    super(message);
    this.name = "NewsdataError";
    this.code = code;
  }
}

/** 「请求成功但确实没有新闻」——与「请求失败」区分开，便于上层给出不同提示 */
export class NewsdataNoDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NewsdataNoDataError";
  }
}

/** NewsData.io 的一条新闻（只声明我们用到的字段） */
export type NewsdataArticle = {
  article_id?: string;
  title?: string | null;
  link?: string | null;
  description?: string | null;
  /** 形如 "2024-01-01 12:00:00"（UTC） */
  pubDate?: string | null;
  image_url?: string | null;
  source_id?: string | null;
  source_name?: string | null;
  language?: string | null;
  country?: string[] | null;
  category?: string[] | null;
};

export type NewsdataParseResult = {
  articles: NewsdataArticle[];
  totalResults: number;
  nextPage: string | null;
};

/**
 * 官方错误对象（OpenAPI 里的 ErrorDetail / InvalidFilterDetail）。
 * 筛选值不被支持时会额外带上 `invalid_country` / `invalid_language` 之类的字段，
 * 拿它就能说清「到底是这个国家不在覆盖范围，还是语言传错了」。
 */
export type NewsdataErrorDetail = {
  code?: string;
  message?: string;
  invalid_country?: string;
  invalid_language?: string;
  invalid_category?: string;
  invalid_domain?: string;
  invalid_parameter?: string;
};

/**
 * 解析 NewsData.io 响应体。
 *
 * 成功：`{ status: "success", totalResults, results: [...] }`
 * 失败：`{ status: "error", results: { code, message } }`（实测形状；也兼容 `error: {...}` 与顶层字段）
 */
export function parseNewsdataResponse(body: string): NewsdataParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new NewsdataError(`NewsData.io 返回的不是 JSON：${body.slice(0, 120)}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new NewsdataError("NewsData.io 返回结构异常（不是对象）");
  }

  const payload = parsed as {
    status?: string;
    totalResults?: number | string;
    results?: unknown;
    nextPage?: unknown;
    error?: NewsdataErrorDetail | null;
    code?: string;
    message?: string;
  };

  const errorObject =
    (payload.error && typeof payload.error === "object" ? payload.error : null) ??
    (payload.results && !Array.isArray(payload.results) && typeof payload.results === "object"
      ? (payload.results as NewsdataErrorDetail)
      : null);

  if (payload.status === "error" || errorObject) {
    const code = String(errorObject?.code ?? payload.code ?? "").trim() || null;
    const message = String(errorObject?.message ?? payload.message ?? "").trim();
    // 筛选值被拒时官方会在同一个对象里给出 invalid_country / invalid_language /
    // invalid_category / invalid_domain；把它带进原因，排查「小国为什么回退」时一目了然
    const rejected =
      errorObject?.invalid_country ??
      errorObject?.invalid_language ??
      errorObject?.invalid_category ??
      errorObject?.invalid_domain ??
      errorObject?.invalid_parameter ??
      null;
    throw new NewsdataError(describeNewsdataError(code, message, rejected), code);
  }

  const articles = Array.isArray(payload.results) ? (payload.results as NewsdataArticle[]) : [];
  const total = Number(payload.totalResults ?? articles.length);
  return {
    articles,
    totalResults: Number.isFinite(total) ? total : articles.length,
    nextPage: typeof payload.nextPage === "string" ? payload.nextPage : null,
  };
}

export function buildNewsdataUrl(options: {
  apiBase: string;
  apiKey: string;
  country: string;
  language?: string | null;
  category?: string | null;
  size?: number;
}): string {
  const params = new URLSearchParams();
  params.set("apikey", options.apiKey);
  params.set("country", options.country.trim().toLowerCase());
  // language 是可选的：没映射到语言就不传，让接口返回该国所有语言
  if (options.language) params.set("language", options.language);
  if (options.category) params.set("category", options.category);
  params.set("size", String(Math.min(Math.max(Math.trunc(options.size ?? NEWSDATA_MAX_SIZE) || NEWSDATA_MAX_SIZE, 1), NEWSDATA_MAX_SIZE)));
  return `${options.apiBase}?${params.toString()}`;
}

/**
 * `pubDate`（"2024-01-01 12:00:00"）→ ISO 字符串。
 * 需求要求转成 ISO；官方文档写明该字段是「请求所用 timezone 的墙上时间」，
 * 而我们从不下发 `timezone` 参数（即默认 UTC），所以补 `Z`，
 * 避免浏览器再按本地时区偏移一次、把时刻理解错。
 */
export function newsdataPubDateToIso(value: string | null | undefined): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const plain = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(raw);
  if (plain) return `${plain[1]}-${plain[2]}-${plain[3]}T${plain[4]}:${plain[5]}:${plain[6]}Z`;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?$/.test(raw)) return raw.endsWith("Z") ? raw : `${raw}Z`;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** 只保留 https 图片：站点是 https，http 图片会被浏览器按混合内容拦掉（卡片会变成空白） */
function httpsImageUrl(value: unknown): string | undefined {
  const raw = typeof value === "string" ? value.trim() : "";
  return raw.startsWith("https://") ? raw : undefined;
}

/** 只有 http(s) 链接可用；`javascript:` 之类的脏数据一律丢掉 */
const HTTP_LINK_RE = /^https?:\/\/\S+$/i;

/**
 * 图片文件链接。
 * ⚠️ 这不是假想的防御：实测 NewsData.io 会把**图片地址塞进 `link`**
 * （意大利样本 10 条里有 1 条，`link` 与 `image_url` 完全相同且以 .jpg 结尾），
 * 直接透出去就是「点『阅读原文』打开一张 JPG」。这类条目按不可用处理，
 * 由后面第 4~10 条补位（我们每次都向上游要 10 条，只取 3 条）。
 */
const IMAGE_LINK_RE = /\.(?:jpe?g|png|gif|webp|avif|bmp|svg|ico)(?:[?#]|$)/i;

/** 只接受「可跳转到文章」的 http(s) 链接，其余返回空串 */
function articleLink(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!HTTP_LINK_RE.test(raw)) return "";
  if (IMAGE_LINK_RE.test(raw)) return "";
  return raw;
}

/** 把上游文章映射成 NewsItem（不含日期过滤；排序沿用上游给出的顺序） */
export function toNewsItems(articles: NewsdataArticle[], limit: number): NewsItem[] {
  const items: NewsItem[] = [];
  for (const article of articles) {
    if (items.length >= limit) break;
    const title = String(article?.title ?? "").trim();
    const url = articleLink(article?.link);
    // 标题为空、或链接不可跳转（缺失 / 非法 / 其实是图片）的条目直接丢弃：
    // 宁可顺位取第 4 条，也不要推一张点不开的「死卡片」（上游给了 10 条，够补位）
    if (!title || !url) continue;
    const rank = items.length + 1;
    items.push({
      rank,
      title,
      sourceName: String(article?.source_name ?? "").trim() || String(article?.source_id ?? "").trim() || "NewsData.io",
      publishedAt: newsdataPubDateToIso(article?.pubDate) ?? "",
      url,
      // 需求：description 可能为空，留空即可（前端卡片对空摘要已有兜底渲染）
      description: String(article?.description ?? "").trim(),
      imageUrl: httpsImageUrl(article?.image_url),
      score: scoreForRank(rank),
    });
  }
  return items;
}

export type NewsdataProviderOptions = {
  apiBase?: string;
  apiKey?: string;
  /** 默认 top（头条） */
  category?: string;
  /** 每次向上游要多少条（默认 10，免费层上限 10） */
  size?: number;
  /** 单次请求超时 */
  timeoutMs?: number;
  /** 全局最小请求间隔（默认 1 秒；免费层额度充足，不需要像聚合数据那样严格） */
  minIntervalMs?: number;
  /** per-country 结果缓存 TTL（需求要求 1 小时） */
  cacheTtlMs?: number;
  /** 当日上游调用上限保护（免费层 200 credits/天） */
  dailyLimit?: number;
  /** 上游刚失败后的短路时长，避免把额度浪费在必失的请求上 */
  failureCooldownMs?: number;
  /** 非今天的日期是否只保留当天稿件（默认 true：免费层查不了历史，避免拿今天的新闻冒充历史日期） */
  strictDate?: boolean;
  request?: (url: string, options: { timeoutMs: number }) => Promise<HttpTextResponse>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  logger?: (...args: unknown[]) => void;
};

/** 「确实没有新闻」的负缓存时长：短到不会锁死结果，长到不会被反复刷新白白消耗额度 */
const NEGATIVE_CACHE_TTL_MS = 5 * 60 * 1000;

const DEFAULT_OPTIONS = {
  apiBase: NEWSDATA_API_BASE,
  category: "top",
  size: NEWSDATA_MAX_SIZE,
  timeoutMs: 12_000,
  minIntervalMs: 1_000,
  cacheTtlMs: 60 * 60 * 1000,
  dailyLimit: 200,
  failureCooldownMs: 60_000,
  strictDate: true,
} as const;

/** 全局串行节流：不同国家、并发请求共用同一条节奏（免费层虽然宽松，也别并发打） */
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
export function resetNewsdataPacer(): void {
  pacerChain = Promise.resolve();
  lastRequestAt = 0;
}

export type NewsdataTopNews = {
  items: NewsItem[];
  diagnostics: {
    /** 本次是否命中「国家|日期」结果缓存（命中就没有任何上游调用） */
    cached: boolean;
    /** 实际传给上游的 language（null = 未传，让接口返回该国所有语言） */
    language: string | null;
    /** 上游本次返回的条数 */
    returned: number;
    upstreamCallsToday: number;
  };
};

export class NewsdataProvider implements NewsProvider {
  readonly id = NEWSDATA_DATA_SOURCE;

  private readonly options: Required<
    Omit<NewsdataProviderOptions, "request" | "sleep" | "now" | "logger" | "apiKey">
  > & {
    apiKey: string;
    request: (url: string, options: { timeoutMs: number }) => Promise<HttpTextResponse>;
    sleep: (ms: number) => Promise<void>;
    now: () => number;
    logger: (...args: unknown[]) => void;
  };

  /** 单国家结果缓存：key = 国家|日期（需求要求 1 小时） */
  private readonly cache: TtlCache<NewsdataTopNews>;
  /** 「确实没有新闻」的短负缓存：key 同上，只是 TTL 短得多，避免反复戳上游把 credit 打光 */
  private readonly negativeCache: TtlCache<string>;
  /** 当日上游调用计数（免费层 200 credits/天） */
  private upstreamCalls = 0;
  private upstreamDay = "";
  /** 最近一次上游失败：短时间内不再打，避免把额度浪费在必失的请求上 */
  private lastFailure: { at: number; message: string; code: string | null } | null = null;

  constructor(options: NewsdataProviderOptions = {}) {
    this.options = {
      apiBase: options.apiBase ?? process.env.NEWSDATA_API_BASE ?? DEFAULT_OPTIONS.apiBase,
      apiKey: options.apiKey ?? process.env.NEWSDATA_API_KEY ?? "",
      category: options.category ?? process.env.NEWSDATA_CATEGORY ?? DEFAULT_OPTIONS.category,
      size: options.size ?? Number(process.env.NEWSDATA_SIZE ?? DEFAULT_OPTIONS.size),
      timeoutMs: options.timeoutMs ?? Number(process.env.NEWSDATA_TIMEOUT_MS ?? DEFAULT_OPTIONS.timeoutMs),
      minIntervalMs:
        options.minIntervalMs ?? Number(process.env.NEWSDATA_MIN_INTERVAL_MS ?? DEFAULT_OPTIONS.minIntervalMs),
      cacheTtlMs: options.cacheTtlMs ?? Number(process.env.NEWSDATA_CACHE_TTL_MS ?? DEFAULT_OPTIONS.cacheTtlMs),
      dailyLimit: options.dailyLimit ?? Number(process.env.NEWSDATA_DAILY_LIMIT ?? DEFAULT_OPTIONS.dailyLimit),
      failureCooldownMs:
        options.failureCooldownMs ?? Number(process.env.NEWSDATA_FAILURE_COOLDOWN_MS ?? DEFAULT_OPTIONS.failureCooldownMs),
      strictDate: options.strictDate ?? DEFAULT_OPTIONS.strictDate,
      request: options.request ?? ((url, config) => httpsGetText(url, { timeoutMs: config.timeoutMs })),
      sleep: options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms))),
      now: options.now ?? (() => Date.now()),
      logger: options.logger ?? ((...args: unknown[]) => console.warn(...args)),
    };
    this.cache = new TtlCache<NewsdataTopNews>(this.options.cacheTtlMs);
    this.negativeCache = new TtlCache<string>(NEGATIVE_CACHE_TTL_MS);
  }

  /** 诊断/测试用 */
  inspectCache() {
    return {
      countries: this.cache.inspect(),
      negative: this.negativeCache.inspect(),
      upstreamCallsToday: this.upstreamCalls,
    };
  }

  async getTopNews(countryCode: string, date: string, limit: number): Promise<NewsItem[]> {
    const result = await this.getTopNewsWithMeta(countryCode, date, limit);
    return result.items;
  }

  async getTopNewsWithMeta(countryCode: string, date: string, limit: number): Promise<NewsdataTopNews> {
    const country = (countryCode ?? "").trim().toUpperCase();
    const safeLimit = Math.min(Math.max(Math.trunc(limit) || 3, 1), NEWSDATA_MAX_SIZE);
    const language = languageForCountry(country);

    // 没有 Key 就不要浪费额度，直接给出可诊断的错误（上层会回退 Mock）
    if (!this.options.apiKey.trim()) {
      throw new NewsdataError("缺少 NEWSDATA_API_KEY 环境变量（未配置 NewsData.io API Key）");
    }

    const cacheKey = `${country}|${date}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      // 命中缓存：本次没有上游调用，所以把 cached 标记刷新成当前事实
      return { items: cached.items.slice(0, safeLimit), diagnostics: { ...cached.diagnostics, cached: true } };
    }

    // 刚刚确认过这个国家这一天没有新闻：短时间内直接给出同样的结论（省 credit）
    const negative = this.negativeCache.get(cacheKey);
    if (negative) throw new NewsdataNoDataError(negative);

    let result: NewsdataTopNews;
    try {
      result = await this.fetchCountry(country, date, language, safeLimit);
    } catch (error) {
      if (error instanceof NewsdataNoDataError) this.negativeCache.set(cacheKey, error.message);
      throw error;
    }

    this.cache.set(cacheKey, result, this.options.cacheTtlMs);
    return { ...result, items: result.items.slice(0, safeLimit) };
  }

  /** 真正访问上游：节流 → 请求 → 解析 → 日期校验 → 映射 */
  private async fetchCountry(
    country: string,
    date: string,
    language: string | null,
    safeLimit: number,
  ): Promise<NewsdataTopNews> {
    const now = this.options.now();
    const today = new Date(now).toISOString().slice(0, 10);
    if (this.upstreamDay !== today) {
      this.upstreamDay = today;
      this.upstreamCalls = 0;
    }

    if (this.lastFailure && now - this.lastFailure.at < this.options.failureCooldownMs) {
      throw new NewsdataError(
        `${this.lastFailure.message}（${Math.round(this.options.failureCooldownMs / 1000)} 秒内不重复请求上游）`,
        this.lastFailure.code,
      );
    }

    if (this.upstreamCalls >= this.options.dailyLimit) {
      throw new NewsdataError(
        `已达当日上游调用上限保护（${this.options.dailyLimit} 次，免费层约 200 credits/天），今日不再请求 NewsData.io`,
      );
    }

    await pace(this.options.minIntervalMs, this.options.sleep);

    const url = buildNewsdataUrl({
      apiBase: this.options.apiBase,
      apiKey: this.options.apiKey,
      country,
      language,
      category: this.options.category,
      size: Math.max(this.options.size, safeLimit),
    });

    this.upstreamCalls += 1;
    let response: HttpTextResponse;
    try {
      response = await this.options.request(url, { timeoutMs: this.options.timeoutMs });
    } catch (error) {
      const message = `请求 NewsData.io 失败：${error instanceof Error ? error.message : String(error)}`;
      this.lastFailure = { at: now, message, code: null };
      this.options.logger(`[newsdata] ${country} ${date} ${redactUrl(url)} → ${message}`);
      throw new NewsdataError(message);
    }

    // 401/429 等同样可能带业务错误体，所以先解析 body 再判断状态码
    let articles: NewsdataArticle[];
    try {
      const parsed = parseNewsdataResponse(response.body);
      if (response.status !== 200) {
        throw new NewsdataError(`NewsData.io 返回 HTTP ${response.status}（响应体未给出业务错误码）`);
      }
      articles = parsed.articles;
    } catch (error) {
      const code = error instanceof NewsdataError ? error.code : null;
      const message =
        error instanceof NewsdataError && response.status !== 200
          ? `${error.message}（HTTP ${response.status}）`
          : error instanceof Error
            ? error.message
            : String(error);
      // 鉴权/额度/参数类错误短时间内别重试：重试只会继续浪费额度
      this.lastFailure = { at: now, message, code };
      this.options.logger(`[newsdata] ${country} ${date} 失败（${newsdataErrorKind(code)}）：${message}`);
      throw new NewsdataError(message, code);
    }

    this.lastFailure = null;

    const strictDate = this.options.strictDate && date !== todayIsoDate() ? date : null;
    const usable = strictDate
      ? articles.filter((article) => (newsdataPubDateToIso(article?.pubDate) ?? "").slice(0, 10) === strictDate)
      : articles;

    const items = toNewsItems(usable, Math.max(safeLimit, 3));
    if (items.length === 0) {
      throw new NewsdataNoDataError(
        strictDate
          ? `NewsData.io 免费层只能查最新新闻，没有 ${country} 在 ${date} 当天的稿件（该接口无法回溯历史日期）`
          : `NewsData.io 没有返回 ${country} 的可用新闻（上游 ${articles.length} 条，标题/链接可用的 0 条）`,
      );
    }

    return {
      items,
      diagnostics: {
        cached: false,
        language,
        returned: articles.length,
        upstreamCallsToday: this.upstreamCalls,
      },
    };
  }
}

/** 默认单例（惰性创建：环境变量在「首次使用」时读取，测试可随时覆盖） */
let newsdataProviderInstance: NewsdataProvider | null = null;

export function getNewsdataProvider(): NewsdataProvider {
  if (!newsdataProviderInstance) {
    newsdataProviderInstance = new NewsdataProvider();
  }
  return newsdataProviderInstance;
}

/** 仅供测试 */
export function resetNewsdataProvider(): void {
  newsdataProviderInstance = null;
}
