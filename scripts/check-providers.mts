#!/usr/bin/env node
/**
 * Provider 层离线自检（不联网、不需要起服务）：
 *
 *   npm run check:providers
 *
 * 用一个 stub 掉的 HTTP 层覆盖 GDELT 的全部关键路径，
 * 因此即使 GDELT 被限流/不可达，也能确定性地验证：
 *   FIPS 映射、URL 构造、时间窗口、响应解析、去重与来源分散、
 *   seendate→ISO、0 条/限流/网络失败触发兜底、缓存命中与上游调用次数、节流间隔。
 */

import { EUROPE_COUNTRIES } from "../lib/countries.ts";
import {
  GDELT_COUNTRY_CODES,
  toFipsCode,
  toIsoAlpha2,
} from "../lib/gdelt-country-codes.ts";
import {
  GdeltProvider,
  buildGdeltUrl,
  buildQueryTemplates,
  buildTimeWindowParam,
  cleanGdeltArticles,
  gdeltSeenDateToIso,
  parseGdeltArticles,
  pickDiverseArticles,
  resetGdeltPacer,
} from "@/lib/providers/gdelt-provider";
import { resolveTopNews } from "@/lib/providers/index";
import { MockProvider } from "@/lib/providers/mock-provider";
import { TtlCache } from "@/lib/providers/ttl-cache";

let checks = 0;
let failures = 0;

const ok = (message: string) => {
  checks += 1;
  console.log(`  ✅ ${message}`);
};
const fail = (message: string) => {
  checks += 1;
  failures += 1;
  console.log(`  ❌ ${message}`);
};
const assert = (condition: boolean, message: string) => (condition ? ok(message) : fail(message));
const assertEqual = (actual: unknown, expected: unknown, message: string) =>
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    JSON.stringify(actual) === JSON.stringify(expected)
      ? message
      : `${message}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`,
  );

/** 构造一个真实形状的 GDELT artlist 响应 */
function gdeltPayload(articles: Array<Record<string, unknown>>) {
  return JSON.stringify({ articles });
}

const SAMPLE_ARTICLES = [
  {
    url: "https://www.spiegel.de/politik/beispiel-a-1",
    title: "Bundestag beschließt neues Energiepaket",
    seendate: "20250926T120000Z",
    domain: "spiegel.de",
    language: "German",
    sourcecountry: "Germany",
    socialimage: "https://cdn.example.com/1.jpg",
  },
  {
    url: "https://www.zeit.de/wirtschaft/beispiel-2",
    title: "Industrie rechnet mit sinkenden Preisen",
    seendate: "20250926T110000Z",
    domain: "zeit.de",
    language: "German",
    sourcecountry: "Germany",
  },
  {
    url: "https://www.faz.net/aktuell/beispiel-3",
    title: "Kommunen fordern mehr Investitionen",
    seendate: "20250926T100000Z",
    domain: "faz.net",
    language: "German",
    sourcecountry: "Germany",
  },
  {
    // 与第 1 条标题/URL 都不重复，但域名重复：用于验证「来源分散」
    url: "https://www.spiegel.de/politik/beispiel-4",
    title: "Opposition kritisiert Zeitplan",
    seendate: "20250926T090000Z",
    domain: "spiegel.de",
    language: "German",
    sourcecountry: "Germany",
  },
];

/** 造一个可控的 stub HTTP 层 */
function makeStub(responses: Array<{ status?: number; body: string } | Error>) {
  const calls: Array<{ url: string; timeoutMs: number }> = [];
  let index = 0;
  const request = async (url: string, options: { timeoutMs: number }) => {
    calls.push({ url, timeoutMs: options.timeoutMs });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (next instanceof Error) throw next;
    return { status: next.status ?? 200, body: next.body };
  };
  return { request, calls };
}

const RATE_LIMIT_TEXT =
  "Please limit requests to one every 5 seconds or contact kalev.leetaru5@gmail.com for larger queries.";

function makeProvider(stubResponses: Array<{ status?: number; body: string } | Error>, extra = {}) {
  const stub = makeStub(stubResponses);
  const sleeps: number[] = [];
  const logs: string[] = [];
  const provider = new GdeltProvider({
    request: stub.request,
    // 不让测试真的等 5 秒：记录被要求的等待时长，然后立即返回
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    logger: (...args: unknown[]) => logs.push(args.join(" ")),
    ...extra,
  });
  return { provider, calls: stub.calls, sleeps, logs };
}

async function main() {
  console.log("\n[1] ISO alpha-2 → FIPS 10-4 映射");
  assertEqual(Object.keys(GDELT_COUNTRY_CODES).length, EUROPE_COUNTRIES.length, `映射表覆盖 ${EUROPE_COUNTRIES.length} 个国家`);
  const missing = EUROPE_COUNTRIES.filter((country) => !toFipsCode(country.code));
  assertEqual(missing.map((c) => c.code), [], "46 个欧洲国家全部有 FIPS 映射");
  assertEqual(toFipsCode("DE"), "GM", "德国 DE → GM");
  assertEqual(toFipsCode("gb"), "UK", "英国 GB → UK（大小写不敏感）");
  assertEqual(toFipsCode("CZ"), "EZ", "捷克 CZ → EZ");
  assertEqual(toFipsCode("RU"), "RS", "俄罗斯 RU → RS");
  assertEqual(toFipsCode("XX"), null, "未知国家返回 null（不猜、不退化）");
  assertEqual(toIsoAlpha2("GM"), "DE", "反向查询 GM → DE");

  console.log("\n[2] 请求 URL 构造");
  const today = "2026-09-26";
  const todayUrl = buildGdeltUrl({ query: "sourcecountry:GM", date: today, today, maxRecords: 20 });
  assert(todayUrl.startsWith("https://api.gdeltproject.org/api/v2/doc/doc?"), "使用官方 DOC 2.0 端点");
  for (const fragment of [
    "query=sourcecountry%3AGM",
    "mode=artlist",
    "format=json",
    "maxrecords=20",
    "sort=datedesc",
    "timespan=1d",
  ]) {
    assert(todayUrl.includes(fragment), `URL 含 ${fragment}`);
  }
  assertEqual(buildTimeWindowParam(today, today), "timespan=1d", "今天用 timespan=1d");
  assertEqual(
    buildTimeWindowParam("2026-09-20", today),
    "startdatetime=20260920000000&enddatetime=20260920235959",
    "历史日期用显式区间（否则日期选择器会失去意义）",
  );
  assertEqual(
    buildQueryTemplates("GM", "Germany", ["sourcecountry:{fips}", '"{name}"']),
    ["sourcecountry:GM", '"Germany"'],
    "查询模板展开正确",
  );
  assertEqual(
    buildQueryTemplates("GM", "Germany", ["locationcc:{fips}"]),
    ["locationcc:GM"],
    "可用 GDELT_QUERY_TEMPLATES 覆盖策略（便于在别的网络下实验）",
  );

  console.log("\n[3] seendate 解析");
  assertEqual(gdeltSeenDateToIso("20250926T120000Z"), "2025-09-26T12:00:00Z", "标准 seendate → ISO");
  assertEqual(gdeltSeenDateToIso("20250926T120000"), "2025-09-26T12:00:00Z", "缺少 Z 也能解析");
  assertEqual(gdeltSeenDateToIso("2025-09-26"), null, "非法格式返回 null");
  assertEqual(gdeltSeenDateToIso(undefined), null, "空值返回 null");

  console.log("\n[4] 响应解析与筛选");
  assertEqual(parseGdeltArticles(JSON.parse(gdeltPayload(SAMPLE_ARTICLES))).length, 4, "解析 DOC 2.0 的 articles 字段");
  assertEqual(parseGdeltArticles({ docs: SAMPLE_ARTICLES }).length, 4, "兼容 docs 字段");
  assertEqual(parseGdeltArticles({ response: { docs: SAMPLE_ARTICLES } }).length, 4, "兼容 response.docs 字段（需求文档写法）");
  assertEqual(parseGdeltArticles({ articles: [] }).length, 0, "空数组正常返回");
  assertEqual(parseGdeltArticles(null).length, 0, "null 安全返回空");

  const dirty = [
    ...SAMPLE_ARTICLES,
    { url: "https://x.de/a", title: "   ", seendate: "20250926T120000Z", domain: "x.de" },
    { url: "javascript:void(0)", title: "非法链接", seendate: "20250926T120000Z", domain: "y.de" },
    { url: "https://z.de/a", title: "时间戳非法", seendate: "not-a-date", domain: "z.de" },
    { url: SAMPLE_ARTICLES[0].url, title: SAMPLE_ARTICLES[0].title, seendate: "20250926T120000Z", domain: "dup.de" },
  ];
  assertEqual(cleanGdeltArticles(dirty).length, 4, "过滤脏数据 + 按标题/URL 去重");
  const diverse = pickDiverseArticles(
    SAMPLE_ARTICLES.map((a) => ({ sourceName: String(a.domain), title: String(a.title) })),
    3,
  );
  assertEqual(diverse.length, 3, "取 3 条");
  assertEqual(new Set(diverse.map((d) => d.sourceName)).size, 3, "3 条来自 3 个不同域名（来源分散）");

  console.log("\n[5] GdeltProvider 正常路径");
  resetGdeltPacer();
  const happy = makeProvider([{ body: gdeltPayload(SAMPLE_ARTICLES) }]);
  const items = await happy.provider.getTopNews("DE", today, 3);
  assertEqual(items.length, 3, "返回 limit=3 条");
  assertEqual(items.map((i) => i.rank), [1, 2, 3], "rank 依次为 1/2/3");
  assertEqual(items.map((i) => i.score), [0.95, 0.88, 0.81], "score 按排名递减 0.95/0.88/0.81");
  assertEqual(items[0].title, "Bundestag beschließt neues Energiepaket", "title 映射正确");
  assertEqual(items[0].sourceName, "spiegel.de", "sourceName 用 domain");
  assertEqual(items[0].url, "https://www.spiegel.de/politik/beispiel-a-1", "url 映射正确");
  assertEqual(items[0].publishedAt, "2025-09-26T12:00:00Z", "publishedAt 由 seendate 转 ISO");
  assertEqual(items[0].imageUrl, undefined, "imageUrl 留空（避免前端请求外部图片）");
  assert(items[0].description.includes("spiegel.de"), `description 由真实元数据合成：${items[0].description}`);
  assert(!items.some((i) => i.title.startsWith("【Mock】")), "标题不是 Mock 模板");
  assertEqual(items.map((i) => i.sourceName), ["spiegel.de", "zeit.de", "faz.net"], "同一域名不会重复占据前三条");
  assertEqual(happy.calls.length, 1, "只调用一次上游");
  assert(happy.calls[0].url.includes("sourcecountry%3AGM"), "默认用 sourcecountry:<FIPS> 查询");

  console.log("\n[6] 节流与重试");
  resetGdeltPacer();
  // 先限流两次，再成功：验证「非 JSON 当可重试错误」而不是当成没有新闻
  const retry = makeProvider([
    { body: RATE_LIMIT_TEXT },
    { body: RATE_LIMIT_TEXT },
    { body: gdeltPayload(SAMPLE_ARTICLES) },
  ]);
  const retryItems = await retry.provider.getTopNews("DE", today, 3);
  assertEqual(retryItems.length, 3, "限流两次后重试成功");
  assertEqual(retry.calls.length, 3, "共 3 次上游调用");
  assert(retry.sleeps.length >= 2, `每次调用之间都做了节流等待（${retry.sleeps.length} 次）`);
  assert(
    retry.sleeps.every((ms) => ms > 4000),
    `节流间隔 ≥4s，遵守 GDELT 的「每 5 秒 1 次」：${retry.sleeps.map((m) => Math.round(m)).join(", ")}ms`,
  );

  console.log("\n[7] 0 条 / 全部失败 → 抛错（交给上层兜底）");
  resetGdeltPacer();
  const empty = makeProvider([{ body: gdeltPayload([]) }]);
  let emptyError = "";
  try {
    await empty.provider.getTopNews("DE", today, 3);
  } catch (error) {
    emptyError = error instanceof Error ? error.name : "unknown";
  }
  assertEqual(emptyError, "GdeltNoDataError", "0 条时抛 GdeltNoDataError");
  assertEqual(empty.calls.length, 2, "两个查询策略各试一次（sourcecountry:<FIPS> → \"国家名\"）");
  assert(
    empty.calls[1].url.includes("Germany"),
    "第二个策略退化为国家名关键词（小国没有本国媒体被索引时靠它补位）",
  );

  resetGdeltPacer();
  const broken = makeProvider([new Error("connect timeout"), new Error("connect timeout"), new Error("connect timeout")]);
  let brokenError = "";
  let brokenMessage = "";
  try {
    await broken.provider.getTopNews("DE", today, 3);
  } catch (error) {
    brokenError = error instanceof Error ? error.name : "unknown";
    brokenMessage = error instanceof Error ? error.message : "";
  }
  assertEqual(brokenError, "GdeltError", "连续网络失败后抛错（区别于「确实没有文章」）");
  assert(
    brokenMessage.includes("网络请求失败"),
    `失败原因可操作、能区分限流/网络/无数据：${brokenMessage.slice(0, 70)}…`,
  );
  assertEqual(broken.calls.length, 6, "两个策略 × 3 次重试 = 6 次尝试");

  resetGdeltPacer();
  const rateLimited = makeProvider([
    { status: 429, body: "Too Many Requests" },
    { status: 429, body: "Too Many Requests" },
    { status: 429, body: "Too Many Requests" },
  ]);
  let rateLimitMessage = "";
  try {
    await rateLimited.provider.getTopNews("DE", today, 3);
  } catch (error) {
    rateLimitMessage = error instanceof Error ? error.message : "";
  }
  assert(rateLimitMessage.includes("限流"), `HTTP 429 被识别为限流：${rateLimitMessage.slice(0, 60)}…`);

  console.log("\n[8] 缓存（1 小时 TTL + 并发合并 + 负缓存）");
  resetGdeltPacer();
  const cached = makeProvider([{ body: gdeltPayload(SAMPLE_ARTICLES) }]);
  await cached.provider.getTopNews("DE", today, 3);
  await cached.provider.getTopNews("DE", today, 3);
  assertEqual(cached.calls.length, 1, "同国家同日期第二次命中缓存，不再打上游");
  const cacheState = cached.provider.inspectCache();
  assertEqual(cacheState.length, 1, "缓存里只有 1 个 key");
  assertEqual(cacheState[0].key, `DE|${today}`, "缓存 key = countryCode|date");
  assert(cacheState[0].ttlRemainingMs > 59 * 60 * 1000, `TTL 约 1 小时（剩 ${Math.round(cacheState[0].ttlRemainingMs / 60000)} 分钟）`);

  resetGdeltPacer();
  const perLimit = makeProvider([{ body: gdeltPayload(SAMPLE_ARTICLES) }]);
  const three = await perLimit.provider.getTopNews("DE", today, 3);
  const two = await perLimit.provider.getTopNews("DE", today, 2);
  assertEqual([three.length, two.length], [3, 2], "同一缓存可服务不同 limit");
  assertEqual(perLimit.calls.length, 1, "不同 limit 不会重复打上游");

  resetGdeltPacer();
  const negative = makeProvider([{ body: gdeltPayload([]) }]);
  let negativeThrew = false;
  try {
    await negative.provider.getTopNews("VA", today, 3);
  } catch {
    negativeThrew = true;
  }
  const callsAfterFirst = negative.calls.length;
  try {
    await negative.provider.getTopNews("VA", today, 3);
  } catch {
    /* 预期继续抛错 */
  }
  assert(negativeThrew, "空结果的第一次抛错");
  assertEqual(negative.calls.length, callsAfterFirst, "空结果进入短负缓存，第二次不再打上游（保护免费接口）");

  console.log("\n[9] 通用 TTL 缓存");
  const ttlCache = new TtlCache<number>(50);
  ttlCache.set("a", 1);
  assertEqual(ttlCache.get("a"), 1, "写入后可读");
  await new Promise((resolve) => setTimeout(resolve, 80));
  assertEqual(ttlCache.get("a"), undefined, "超过 TTL 后过期");
  let loads = 0;
  const loader = async () => {
    loads += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return 42;
  };
  const [a, b] = await Promise.all([ttlCache.getOrLoad("k", loader), ttlCache.getOrLoad("k", loader)]);
  assertEqual([a, b, loads], [42, 42, 1], "并发 getOrLoad 只执行一次 loader（in-flight 合并）");

  console.log("\n[10] 环境变量切换与兜底（resolveTopNews）");
  process.env.NEWS_PROVIDER = "mock";
  const mockResult = await resolveTopNews("DE", today, 3);
  assertEqual(mockResult.dataSource, "mock", "NEWS_PROVIDER=mock 时 dataSource=mock");
  assert(mockResult.items[0].title.includes("【Mock】德国"), "mock 模式返回 Mock 数据");
  assertEqual(mockResult.fallbackReason, undefined, "mock 模式没有兜底原因");

  // 用依赖注入构造一个「必然失败」的 GDELT provider：完全离线、结果确定
  resetGdeltPacer();
  const failingProvider = new GdeltProvider({
    baseUrl: "https://127.0.0.1:9/gdelt",
    maxAttempts: 1,
    totalBudgetMs: 2_000,
    minIntervalMs: 10,
    timeoutMs: 500,
    sleep: async () => {},
    logger: () => {},
  });
  const fallback = await resolveTopNews("DE", today, 3, { providerId: "gdelt", primary: failingProvider });
  assertEqual(fallback.dataSource, "mock", "GDELT 不可用时 dataSource 回退为 mock");
  assertEqual(fallback.items.length, 3, "兜底仍返回 3 条，前端不报错");
  assert(
    fallback.items[0].title.includes("【Mock】德国"),
    "兜底返回的确实是 Mock 数据",
  );
  assert(
    Boolean(fallback.fallbackReason) && fallback.fallbackReason!.includes("网络请求失败"),
    `记录了可诊断的兜底原因：${String(fallback.fallbackReason).slice(0, 60)}…`,
  );

  console.log("\n[11] 未支持国家 / 中文小国（无 FIPS 映射）");
  resetGdeltPacer();
  const unmapped = new GdeltProvider({
    request: async () => ({ status: 200, body: gdeltPayload(SAMPLE_ARTICLES) }),
    sleep: async () => {},
    logger: () => {},
  });
  let unmappedError = "";
  try {
    await unmapped.getTopNews("TR", today, 3);
  } catch (error) {
    unmappedError = error instanceof Error ? error.message : "unknown";
  }
  assert(unmappedError.includes("FIPS"), `无映射时明确报错而不是猜：${unmappedError}`);
  const unmappedFallback = await resolveTopNews("TR", today, 3, {
    providerId: "gdelt",
    primary: unmapped,
  });
  assertEqual(unmappedFallback.dataSource, "mock", "无 FIPS 映射的国家回退 mock");
  // TR 不在本项目的 46 国表里，MockProvider 对未知国家按设计返回 0 条；
  // 真实用户碰不到这条路径，因为 /api/news/top 会先用 400 拦掉非欧洲国家。
  assertEqual(unmappedFallback.items.length, 0, "未知国家回退后为 0 条（路由层已用 400 拦截，不会走到这里）");

  const vatican = await resolveTopNews("VA", today, 3, {
    providerId: "gdelt",
    primary: new GdeltProvider({
      request: async () => ({ status: 200, body: gdeltPayload([]) }),
      sleep: async () => {},
      logger: () => {},
    }),
  });
  assertEqual(vatican.dataSource, "mock", "微型国家 GDELT 无数据时也回退 mock");

  process.env.NEWS_PROVIDER = "mock";

  console.log("\n[12] MockProvider 行为未被破坏（回归）");
  const mockProvider = new MockProvider();
  const mockItems = await mockProvider.getTopNews("DE", today, 3);
  assertEqual(mockItems.length, 3, "Mock 仍返回 3 条");
  assertEqual(mockItems[0].title, `【Mock】德国 ${today} 热点新闻 1`, "Mock 标题模板不变");
  assertEqual(mockItems.map((i) => i.score), [0.95, 0.88, 0.81], "Mock 分数仍是 0.95/0.88/0.81");
  const mockAgain = await mockProvider.getTopNews("DE", today, 3);
  assertEqual(mockAgain, mockItems, "Mock 数据仍然稳定（同国家同日不变）");

  console.log(`\n${failures === 0 ? "🎉 全部通过" : "❌ 存在失败项"}：${checks - failures}/${checks}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\n自检脚本异常：", error);
  process.exit(1);
});
