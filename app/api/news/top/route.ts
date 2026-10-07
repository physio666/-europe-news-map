import { NextResponse, type NextRequest } from "next/server";

import { EUROPE_COUNTRY_CODES, getCountry, isSupportedCountry } from "@/lib/countries";
import { isValidIsoDate, todayIsoDate } from "@/lib/date";
import { getProviderId, resolveTopNews } from "@/lib/providers";
import type { ApiErrorResponse, TopNewsResponse } from "@/lib/providers/types";

/** 数据每次请求实时取（Provider 内部有内存缓存），不做静态化 */
export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * 必须跑在 Node.js 运行时（不能用 Edge）：Provider 用的是 node:https / node:http，
 * Edge Runtime 不提供这些模块。显式声明可避免以后被误改成 edge 导致线上 500。
 */
export const runtime = "nodejs";

/**
 * 就近执行：聚合数据与主要读者都在国内，香港节点往返最短。
 * 这是「期望值」而非硬绑定 —— 平台若不支持该区域会忽略它，不会导致构建失败。
 */
export const preferredRegion = "hkg1";

const DEFAULT_LIMIT = 3;
const MAX_LIMIT = 10;

function badRequest(error: string, message: string) {
  return NextResponse.json<ApiErrorResponse>({ error, message }, { status: 400 });
}

/**
 * HTTP 头只允许 latin-1（ByteString），把中文（比如「GDELT 在 … 没有返回 … 的任何文章」）
 * 直接塞进自定义头会让 undici 抛 TypeError，接口反而变成 500 —— 兜底路径自己崩掉。
 * 实测踩过：所以这里统一百分号编码，保证头值一定是 ASCII，客户端 decodeURIComponent 即可还原。
 */
function asciiHeaderValue(value: string, maxLength = 400): string {
  return encodeURIComponent(value).slice(0, maxLength);
}

/**
 * GET /api/news/top?country=DE&date=2026-09-26&limit=3
 *
 * 数据源由环境变量 NEWS_PROVIDER 决定：
 *  - mock    ：MockProvider（默认）
 *  - gdelt   ：GdeltProvider（GDELT DOC 2.0 公开 API，无需 Key）
 *  - juhe    ：JuheProvider（聚合数据新闻头条，需要 JUHE_NEWS_KEY；接口不支持按国家查，靠两级过滤）
 *  - newsdata：NewsdataProvider（NewsData.io，需要 NEWSDATA_API_KEY；支持按国家 + 主要语言查询）
 * 真实源失败 / 0 条时一律自动回退 Mock，并在 X-Fallback-Reason 头里说明原因。
 *
 * 抓取永远发生在服务端，前端只请求本接口。
 */
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;

  // ---- country ----
  const rawCountry = searchParams.get("country");
  if (!rawCountry) {
    return badRequest("missing_country", "缺少 country 参数，例如 ?country=DE");
  }
  const country = rawCountry.trim().toUpperCase();
  if (!isSupportedCountry(country)) {
    return badRequest(
      "unsupported_country",
      `不支持的国家代码 "${rawCountry}"。请使用 ISO 3166-1 alpha-2，例如：${EUROPE_COUNTRY_CODES.slice(0, 8).join(", ")} ...（共 ${EUROPE_COUNTRY_CODES.length} 个）`,
    );
  }

  // ---- date ----
  const rawDate = searchParams.get("date");
  const date = rawDate?.trim() ? rawDate.trim() : todayIsoDate();
  if (!isValidIsoDate(date)) {
    return badRequest("invalid_date", `日期格式非法 "${rawDate}"，请使用 YYYY-MM-DD，例如 2026-09-26`);
  }

  // ---- limit ----
  const rawLimit = searchParams.get("limit");
  let limit = DEFAULT_LIMIT;
  if (rawLimit !== null && rawLimit.trim() !== "") {
    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
      return badRequest("invalid_limit", `limit 必须是 1 到 ${MAX_LIMIT} 之间的整数，收到 "${rawLimit}"`);
    }
    limit = parsed;
  }

  // ---- 取数：主数据源 + 自动兜底（兜底逻辑集中在 lib/providers/resolveTopNews） ----
  const { items, dataSource, queryMode, fallbackReason, headers: providerHeaders } =
    await resolveTopNews(country, date, limit);

  const payload: TopNewsResponse = {
    country,
    date,
    updatedAt: new Date().toISOString(),
    dataSource,
    items,
    // 聚合数据链路才会产生 queryMode；其余模式省略该字段
    ...(queryMode ? { queryMode } : {}),
  };

  const headers: Record<string, string> = {
    "Cache-Control": "no-store, max-age=0",
    "X-Data-Source": asciiHeaderValue(dataSource),
    "X-Provider-Mode": asciiHeaderValue(getProviderId()),
    "X-Country-Name": asciiHeaderValue(getCountry(country)?.name ?? country),
    ...(providerHeaders ?? {}),
  };
  if (fallbackReason) {
    // 头部信息便于排查「为什么这次是 mock」，不污染 JSON 契约
    headers["X-Fallback-Reason"] = asciiHeaderValue(fallbackReason);
  }

  return NextResponse.json(payload, { status: 200, headers });
}
