import { NextResponse, type NextRequest } from "next/server";

import { EUROPE_COUNTRIES } from "@/lib/countries";
import { isValidIsoDate, todayIsoDate } from "@/lib/date";
import { getProviderId, resolveDataSourceSnapshot } from "@/lib/providers";
import type { ApiErrorResponse } from "@/lib/providers/types";

/** 只读快照，不做任何上游请求；但仍然按请求实时读取内存状态 */
export const dynamic = "force-dynamic";
export const revalidate = 0;

/** 与 /api/news/top 保持一致：Node.js 运行时 + 就近区域 */
export const runtime = "nodejs";
export const preferredRegion = "hkg1";

/**
 * GET /api/news/sources?date=2026-09-27
 *
 * 返回所有欧洲国家的数据源状态：
 *   { "date": "…", "provider": "juhe", "countries": { "DE": { "dataSource": "juhe", "itemCount": 3 }, … } }
 *
 * 关键设计：**不消耗任何上游额度**。
 * 数据来自 lib/providers 里「用户真正查询过哪些国家」的记录，
 * 所以未查询过的国家一律是 "unknown"，而不是为了统计一次性把 46 个国家都查一遍
 *（聚合数据免费额度只有 50 次/天，那样会瞬间打光）。
 */
export async function GET(request: NextRequest) {
  const rawDate = request.nextUrl.searchParams.get("date");
  const date = rawDate?.trim() ? rawDate.trim() : todayIsoDate();

  if (!isValidIsoDate(date)) {
    return NextResponse.json<ApiErrorResponse>(
      { error: "invalid_date", message: `日期格式非法 "${rawDate}"，请使用 YYYY-MM-DD` },
      { status: 400 },
    );
  }

  const countries = resolveDataSourceSnapshot(date);
  const counts = { real: 0, mock: 0, unknown: 0 };
  for (const code of EUROPE_COUNTRIES.map((country) => country.code)) {
    const entry = countries[code];
    if (!entry || entry.dataSource === "unknown") counts.unknown += 1;
    else if (entry.dataSource === "mock") counts.mock += 1;
    else counts.real += 1;
  }

  return NextResponse.json(
    {
      date,
      provider: getProviderId(),
      countries,
      summary: { total: EUROPE_COUNTRIES.length, ...counts },
    },
    {
      status: 200,
      headers: {
        "Cache-Control": "no-store, max-age=0",
        // 诊断用：这个接口本身不会产生任何上游调用
        "X-Upstream-Calls": "0",
      },
    },
  );
}
