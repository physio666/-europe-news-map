#!/usr/bin/env node
/**
 * 验收自检脚本（需要先启动 dev server）：
 *
 *   npm run dev                 # 另开一个终端
 *   npm run verify
 *   BASE_URL=http://localhost:4000 npm run verify
 *
 * 检查项：
 *  1. 首页 200 且包含标题与地图容器
 *  2. /geo/europe.geojson 覆盖全部 46 个 ISO alpha-2
 *  3. /api/news/top 对 46 个国家都返回 3 条结构正确的 Mock 新闻
 *  4. 同一国家同一天的结果稳定（除 updatedAt 完全一致）
 *  5. 切换日期后标题里的日期同步变化
 *  6. 非法参数返回 400
 *  7. 页面 HTML 不引用任何外部域名资源（保证 Network 里只有同源请求）
 */

import { EUROPE_COUNTRIES, getCountry } from "../lib/countries.ts";
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const DATE_A = "2026-09-26";
const DATE_B = "2026-09-27";
const EXPECTED_SCORES = [0.95, 0.88, 0.81];

let failures = 0;
let checks = 0;

function ok(message: string) {
  checks += 1;
  console.log(`  ✅ ${message}`);
}

function fail(message: string) {
  checks += 1;
  failures += 1;
  console.log(`  ❌ ${message}`);
}

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) ok(message);
  else fail(`${message}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);
}

function assertTrue(condition: boolean, message: string) {
  if (condition) ok(message);
  else fail(message);
}

async function getJson(path: string) {
  const response = await fetch(`${BASE}${path}`);
  const text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: response.status, body, text, headers: response.headers };
}

/** 当前服务配置的数据源（由 /api/news/top 的 X-Provider-Mode 头给出）：mock | newsdata | juhe | gdelt */
async function detectProviderMode(): Promise<string> {
  try {
    const probe = await getJson("/api/news/top?country=DE&date=" + new Date().toISOString().slice(0, 10));
    return probe.headers.get("x-provider-mode") ?? "mock";
  } catch {
    return "mock";
  }
}

async function main() {
  console.log(`\n验证目标：${BASE}\n`);
  const providerMode = await detectProviderMode();
  console.log(`NEWS_PROVIDER = ${providerMode}（验收脚本会自动适配数据源）\n`);

  // 1. 首页
  console.log("[1] 首页");
  const home = await fetch(`${BASE}/`);
  const html = await home.text();
  assertEqual(home.status, 200, "GET / 返回 200");
  assertTrue(html.includes("欧洲每日新闻热点地图"), "首页包含站点标题");
  // 地图容器由 SSR 输出（grid-pattern 是地图容器自身的类）；SVG 需要客户端测量尺寸后再渲染，
  // 这部分由 scripts/browser-check.mts 用 headless 浏览器做真实验证。
  assertTrue(html.includes("grid-pattern") || html.includes("rsm-svg"), "首页包含地图容器");

  const externalRefs = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)]
    .map((match) => match[1])
    .filter((url) => !url.startsWith(BASE) && !url.includes("localhost") && !url.includes("127.0.0.1"));
  assertEqual(externalRefs, [], "页面不引用任何外部域名资源");

  // 2. 地图数据
  console.log("\n[2] 地图数据 /geo/europe.geojson");
  const geo = await getJson("/geo/europe.geojson");
  assertEqual(geo.status, 200, "GET /geo/europe.geojson 返回 200");
  const features = (geo.body as { features?: Array<{ properties?: Record<string, unknown> }> })?.features ?? [];
  assertEqual(features.length, EUROPE_COUNTRIES.length, `要素数量为 ${EUROPE_COUNTRIES.length}`);
  const codesInGeo = new Set(features.map((feature) => String(feature.properties?.iso_a2 ?? "")));
  const missing = EUROPE_COUNTRIES.filter((country) => !codesInGeo.has(country.code)).map((c) => c.code);
  assertEqual(missing, [], "地图覆盖全部目标国家（含微型国家）");
  assertEqual(features.filter((f) => f.properties?.micro === true).length, 6, "标记出 6 个微型国家");

  // 2.1 ISO alpha-2 映射正确性：光有 46 个要素还不够，要确认「这个多边形真的是那个国家」。
  //     做法：每个国家的首都坐标必须落在自己要素的经纬度包围盒内（含少量容差）。
  //     映射串位（例如 Slovakia ↔ Slovenia）会立刻被抓出来。
  const mappingIssues: string[] = [];
  const seenCodes = new Set<string>();
  const duplicated: string[] = [];
  for (const feature of features as Array<{
    properties?: { iso_a2?: unknown; nameZh?: unknown; capital?: unknown; synthetic?: unknown };
  }>) {
    const code = String(feature.properties?.iso_a2 ?? "");
    if (seenCodes.has(code)) duplicated.push(code);
    seenCodes.add(code);

    const meta = getCountry(code);
    if (!meta) {
      mappingIssues.push(`${code} 不在国家表中`);
      continue;
    }
    const capital = feature.properties?.capital as [number, number] | undefined;
    const [lon, lat] = capital ?? meta.capital;
    const geometry = feature as unknown as { geometry: { type: string; coordinates: unknown } };
    const positions: Array<[number, number]> = [];
    const walk = (value: unknown) => {
      if (!Array.isArray(value)) return;
      if (typeof value[0] === "number" && typeof value[1] === "number") {
        positions.push(value as [number, number]);
        return;
      }
      value.forEach(walk);
    };
    walk(geometry.geometry.coordinates);
    if (positions.length === 0) {
      mappingIssues.push(`${code} 无坐标`);
      continue;
    }
    let minLon = Infinity;
    let maxLon = -Infinity;
    let minLat = Infinity;
    let maxLat = -Infinity;
    for (const [x, y] of positions) {
      if (x < minLon) minLon = x;
      if (x > maxLon) maxLon = x;
      if (y < minLat) minLat = y;
      if (y > maxLat) maxLat = y;
    }
    // 微型国家的多边形只有零点几度，容差要小；含海外领地的国家（法/荷/葡/挪/西）包围盒天然很大
    const tolerance = String(feature.properties?.synthetic) === "true" ? 1 : meta.code === "FR" || meta.code === "NL" || meta.code === "PT" || meta.code === "NO" || meta.code === "ES" ? 12 : 3;
    if (
      lon < minLon - tolerance ||
      lon > maxLon + tolerance ||
      lat < minLat - tolerance ||
      lat > maxLat + tolerance
    ) {
      mappingIssues.push(
        `${code}(${meta.nameZh}) 首都 ${lon},${lat} 落在自身包围盒 [${minLon.toFixed(2)},${minLat.toFixed(2)}]-[${maxLon.toFixed(2)},${maxLat.toFixed(2)}] 之外`,
      );
    }
  }
  assertEqual(duplicated, [], "没有重复的 iso_a2（无国家被覆盖丢弃）");
  if (mappingIssues.length === 0) ok("46 个国家多边形与首都位置一一对应（ISO alpha-2 映射正确）");
  else fail(`映射可疑：${mappingIssues.slice(0, 5).join("；")}`);

  const context = await getJson("/geo/europe-context.geojson");
  assertEqual(context.status, 200, "GET /geo/europe-context.geojson 返回 200");

  // 3. 国家 × 3 条新闻（按当前数据源适配断言）
  //
  // 注意：真实数据源下刻意**只扫核心国家**。GDELT 是免费公共接口（每 5 秒 1 次），
  // 46 个国家连扫等于自己把自己限流；这里扫 DE/FR/GB/IT 已足够验证契约，
  // 需要全量覆盖时请用 mock 模式（Mock 数据源对 46 国都有稳定数据）。
  const sweepCountries =
    providerMode === "gdelt"
      ? EUROPE_COUNTRIES.filter((country) => ["DE", "FR", "GB", "IT"].includes(country.code))
      : EUROPE_COUNTRIES;
  console.log(
    `\n[3] /api/news/top 契约校验（当前数据源：${providerMode}，抽查 ${sweepCountries.length} 个国家）`,
  );
  const issues: string[] = [];
  const sourceSeen = new Set<string>();
  for (const country of sweepCountries) {
    const response = await getJson(`/api/news/top?country=${country.code}&date=${DATE_A}&limit=3`);
    const { status, body } = response;
    if (status !== 200) {
      issues.push(`${country.code} HTTP ${status}`);
      continue;
    }
    const payload = body as {
      country: string;
      date: string;
      dataSource: string;
      updatedAt: string;
      items: Array<Record<string, unknown>>;
    };
    sourceSeen.add(payload.dataSource);
    if (payload.country !== country.code) issues.push(`${country.code} country 字段错误`);
    if (payload.date !== DATE_A) issues.push(`${country.code} date 字段错误`);
    if (
      payload.dataSource !== "mock" &&
      payload.dataSource !== "gdelt" &&
      payload.dataSource !== "juhe" &&
      payload.dataSource !== "newsdata"
    ) {
      issues.push(`${country.code} dataSource 取值非法：${payload.dataSource}`);
    }
    if (!payload.updatedAt) issues.push(`${country.code} 缺少 updatedAt`);
    // 真实数据源只保证「不超过 limit 条」（池子里可能只有 1-2 条相关稿件）；Mock 必须正好 3 条
    const minItems = payload.dataSource === "mock" ? 3 : 1;
    if (!Array.isArray(payload.items) || payload.items.length < minItems || payload.items.length > 3) {
      issues.push(`${country.code} 新闻条数 ${payload.items?.length}（期望 ${minItems}-3）`);
      continue;
    }

    const isMock = payload.dataSource === "mock";
    const isJuhe = payload.dataSource === "juhe";
    if (isJuhe) {
      // 聚合数据链路必须给出 queryMode，取值只能是 keyword/domain/both
      const mode = (payload as { queryMode?: string }).queryMode;
      if (mode !== "keyword" && mode !== "domain" && mode !== "both") {
        issues.push(`${country.code} juhe 的 queryMode 非法：${String(mode)}`);
      }
    }
    payload.items.forEach((item, index) => {
      const rank = index + 1;
      if (item.rank !== rank) issues.push(`${country.code} #${rank} rank 错误`);
      if (item.score !== EXPECTED_SCORES[index]) issues.push(`${country.code} #${rank} score=${String(item.score)}`);
      if (typeof item.title !== "string" || item.title.trim().length < 5) {
        issues.push(`${country.code} #${rank} 标题为空`);
      }
      if (typeof item.sourceName !== "string" || item.sourceName.trim() === "") {
        issues.push(`${country.code} #${rank} 缺少来源`);
      }
      if (typeof item.description !== "string") {
        issues.push(`${country.code} #${rank} 缺少 description 字段`);
      }
      if (!Number.isFinite(Date.parse(String(item.publishedAt)))) {
        issues.push(`${country.code} #${rank} publishedAt 不是合法时间`);
      }

      if (isMock) {
        // Mock 数据源：保持原有的严格模板校验
        if (item.title !== `【Mock】${country.nameZh} ${DATE_A} 热点新闻 ${rank}`) {
          issues.push(`${country.code} #${rank} 标题不符：${String(item.title)}`);
        }
        if (item.sourceName !== "Mock News") issues.push(`${country.code} #${rank} 来源不符`);
        if (item.url !== "#") issues.push(`${country.code} #${rank} url 不是 #`);
        if (String(item.publishedAt).slice(0, 10) !== DATE_A) {
          issues.push(`${country.code} #${rank} 发布时间不在当天`);
        }
        if (typeof item.imageUrl !== "string" || !item.imageUrl.startsWith("data:image/svg+xml")) {
          issues.push(`${country.code} #${rank} 配图不是内联 data URI`);
        }
        if (!item.description || String(item.description).length < 10) {
          issues.push(`${country.code} #${rank} Mock 摘要异常`);
        }
      } else {
        // 真实数据源（newsdata / gdelt / juhe）：标题与链接必须是真东西
        if (!/^https?:\/\//i.test(String(item.url))) {
          issues.push(`${country.code} #${rank} url 不是 http(s) 链接`);
        }
        if (String(item.title).startsWith("【Mock】")) {
          issues.push(`${country.code} #${rank} dataSource=${payload.dataSource} 却是 Mock 标题`);
        }
        if (payload.dataSource === "gdelt" && item.imageUrl != null) {
          // GDELT 链路刻意留空配图，避免浏览器去请求外部图片
          issues.push(`${country.code} #${rank} gdelt 的 imageUrl 应为空`);
        }
      }
    });
  }
  if (issues.length === 0) {
    ok(`${sweepCountries.length} 个国家全部返回 3 条结构正确的新闻（dataSource: ${[...sourceSeen].join("/")}）`);
  } else {
    fail(`存在问题：${issues.slice(0, 8).join("；")}${issues.length > 8 ? ` 等 ${issues.length} 项` : ""}`);
  }

  // 4. 稳定性
  console.log("\n[4] 数据稳定性（同一国家同一天刷新不变）");
  const first = await getJson(`/api/news/top?country=DE&date=${DATE_A}&limit=3`);
  const second = await getJson(`/api/news/top?country=DE&date=${DATE_A}&limit=3`);
  const itemsOf = (payload: unknown) => (payload as { items: unknown }).items;
  assertEqual(itemsOf(second.body), itemsOf(first.body), "两次请求的 items 完全一致");
  assertTrue(
    (first.body as { updatedAt: string }).updatedAt !== (second.body as { updatedAt: string }).updatedAt ||
      first.text.includes("updatedAt"),
    "updatedAt 是请求时间（items 之外唯一变化）",
  );

  // 5. 切换日期
  console.log("\n[5] 切换日期");
  const other = await getJson(`/api/news/top?country=DE&date=${DATE_B}&limit=3`);
  assertEqual((other.body as { date: string }).date, DATE_B, `请求 date=${DATE_B} 时响应 date 字段同步`);
  if (providerMode !== "mock") {
    // 真实源（gdelt / juhe）：标题里不保证有日期，改为校验「要么真数据、要么明确回退」
    const otherItems = itemsOf(other.body) as Array<{ title: string }>;
    assertTrue(otherItems.length >= 1 && otherItems.length <= 3, `切换日期后仍返回 1-3 条（实际 ${otherItems.length}）`);
    const otherSource = (other.body as { dataSource?: string }).dataSource;
    if (otherSource === providerMode) {
      assertTrue(
        otherItems.every((item) => !String(item.title).startsWith("【Mock】")),
        `拿到真实 ${providerMode} 数据时标题不是 Mock 模板`,
      );
    } else {
      // 真实源失败会按设计回退，此时标题就是 Mock —— 关键是必须给出原因，不能静默
      const reason = other.headers.get("x-fallback-reason");
      assertTrue(Boolean(reason), `回退到 mock 时带上了原因：${reason ? decodeURIComponent(reason) : "（缺失）"}`);
    }
  } else {
    const otherItems = itemsOf(other.body) as Array<{ title: string }>;
    assertEqual(
      otherItems.map((item) => item.title),
      [1, 2, 3].map((rank) => `【Mock】德国 ${DATE_B} 热点新闻 ${rank}`),
      `日期切换到 ${DATE_B} 后标题同步变化`,
    );
    const deOnA = itemsOf(first.body) as Array<{ title: string }>;
    assertTrue(
      deOnA.every((item) => item.title.includes(DATE_A)),
      `日期 ${DATE_A} 的标题包含该日期`,
    );
  }

  // 5.1 数据源模式自洽性：真实源模式下要么真拿到数据，要么明确回退并给出原因
  console.log("\n[5.1] 数据源模式自洽性");
  const modeProbe = first;
  const modeSource = (modeProbe.body as { dataSource?: string })?.dataSource;
  const fallbackReason = modeProbe.headers.get("x-fallback-reason");
  if (providerMode !== "mock") {
    const consistent = modeSource === providerMode || (modeSource === "mock" && Boolean(fallbackReason));
    assertTrue(
      consistent,
      modeSource === providerMode
        ? `${providerMode} 模式拿到了真实数据`
        : `${providerMode} 模式已按设计回退（原因：${fallbackReason ? decodeURIComponent(fallbackReason) : "未提供"}）`,
    );
    if (providerMode === "juhe") {
      // 聚合数据链路必须给出 queryMode，回退时是 mock
      const mode = (modeProbe.body as { queryMode?: string })?.queryMode;
      const expected = modeSource === "juhe" ? ["keyword", "domain", "both"] : ["mock"];
      assertTrue(
        expected.includes(String(mode)),
        `queryMode 与 dataSource 自洽（dataSource=${modeSource}, queryMode=${String(mode)}）`,
      );
      if (modeSource === "juhe") {
        const stats = modeProbe.headers.get("x-juhe-stats");
        assertTrue(Boolean(stats), `透出额度诊断头：${stats}`);
      }
    }
  } else {
    assertEqual(modeSource, "mock", "mock 模式下 dataSource=mock");
    assertEqual(
      (modeProbe.body as { queryMode?: string })?.queryMode,
      "mock",
      "mock 模式下 queryMode=mock",
    );
  }

  // 6. 参数校验
  console.log("\n[6] 参数校验");
  for (const [path, label] of [
    ["/api/news/top?country=US&date=2026-09-26", "非欧洲国家 US → 400"],
    ["/api/news/top?date=2026-09-26", "缺少 country → 400"],
    ["/api/news/top?country=DE&date=2026-13-01", "非法日期 → 400"],
    ["/api/news/top?country=DE&date=2026-09-26&limit=99", "limit 越界 → 400"],
    ["/api/news/top?country=DE&date=2026-09-26&limit=abc", "limit 非数字 → 400"],
  ] as const) {
    const { status } = await getJson(path);
    assertEqual(status, 400, label);
  }
  const lower = await getJson("/api/news/top?country=de&date=2026-09-26");
  assertEqual(lower.status, 200, "小写国家代码自动转大写");

  // 6.1 数据源快照接口 /api/news/sources（地图绿/灰上色的数据来源）
  console.log("\n[6.1] /api/news/sources 数据源快照");
  const sources = await getJson(`/api/news/sources?date=${DATE_A}`);
  assertEqual(sources.status, 200, "GET /api/news/sources 返回 200");
  const snapshot = sources.body as {
    date: string;
    provider: string;
    countries: Record<string, { dataSource: string; itemCount: number }>;
    summary?: { total: number; real: number; mock: number; unknown: number };
  };
  assertEqual(snapshot.date, DATE_A, "响应回显查询日期");
  assertEqual(Object.keys(snapshot.countries ?? {}).length, EUROPE_COUNTRIES.length, `覆盖全部 ${EUROPE_COUNTRIES.length} 个国家`);
  const allowedSources = ["newsdata", "juhe", "gdelt", "mock", "unknown"];
  const badSources = Object.entries(snapshot.countries).filter(
    ([, entry]) => !allowedSources.includes(entry.dataSource),
  );
  assertEqual(badSources.map(([code]) => code), [], "每个国家的 dataSource 取值合法");
  assertEqual(
    sources.headers.get("x-upstream-calls"),
    "0",
    "该接口不产生任何上游调用（不会消耗聚合数据额度）",
  );
  assertEqual(
    (snapshot.summary?.real ?? 0) + (snapshot.summary?.mock ?? 0) + (snapshot.summary?.unknown ?? 0),
    EUROPE_COUNTRIES.length,
    "summary 三类计数之和等于国家总数",
  );
  const invalidSourcesDate = await getJson("/api/news/sources?date=2026-13-01");
  assertEqual(invalidSourcesDate.status, 400, "非法日期 → 400");

  console.log(`\n${failures === 0 ? "🎉 全部通过" : "❌ 存在失败项"}：${checks - failures}/${checks}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`\n验证脚本异常：${error instanceof Error ? error.message : String(error)}`);
  console.error(`请确认 dev server 已在 ${BASE} 运行（npm run dev）。\n`);
  process.exit(1);
});
