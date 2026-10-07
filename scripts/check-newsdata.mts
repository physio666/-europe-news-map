#!/usr/bin/env node
/**
 * NewsData.io Provider 自检。
 *
 *   npm run check:newsdata          # 离线部分（默认，不联网、不需要 Key）
 *   npm run check:newsdata -- --live # 额外做一次真实调用（需要 NEWSDATA_API_KEY）
 *
 * 为什么离线断言这么重要：免费层虽然比聚合数据宽松（200 credits/天），
 * 但「语言映射、URL 构造、错误形状、字段映射、缓存、节流、兜底」这些逻辑
 * 不可能靠反复打真接口来验证 —— 每次重试都在花 credit。
 * 所以这里用一个 stub 掉的 HTTP 层，把每条规则都钉死。
 */

import {
  COUNTRY_LANGUAGE,
  NEWSDATA_API_BASE,
  NewsdataNoDataError,
  NewsdataProvider,
  buildNewsdataUrl,
  getNewsdataProvider,
  languageForCountry,
  newsdataErrorKind,
  newsdataPubDateToIso,
  parseNewsdataResponse,
  resetNewsdataPacer,
  resetNewsdataProvider,
  toNewsItems,
} from "@/lib/providers/newsdata-provider";
import { getProviderId, resetResolvedSources, resolveDataSourceSnapshot, resolveTopNews } from "@/lib/providers/index";
import { EUROPE_COUNTRIES } from "@/lib/countries";
import { todayIsoDate } from "@/lib/date";

// 与 Next 一致地加载 .env / .env.local：Key 通常配在 .env.local 里，
// 而独立脚本默认看不到它（那是 next dev 加载的）。不加载就会出现「配了 Key 却说没配」的假故障。
const { loadEnvFiles } = await import("./env.mjs");
const loadedEnvFiles = loadEnvFiles();

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

/** 真实的 NewsData.io 成功响应形状 */
function newsdataPayload(articles: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ status: "success", totalResults: articles.length, results: articles, nextPage: null, ...extra });
}

/** 真实的 NewsData.io 错误形状（实测 401 就是这么返回的；码表来自官方 OpenAPI 的 ErrorCode enum） */
function newsdataErrorPayload(code: string, message: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ status: "error", results: { message, code, ...extra } });
}

const TODAY = todayIsoDate();
/** 用「今天」构造时间戳，避免 strictDate 在非今天时把测试数据过滤掉 */
const T = (time: string) => `${TODAY} ${time}`;

const ARTICLES = [
  {
    article_id: "de-1",
    title: "Bundestag beschließt neues Energiepaket",
    link: "https://www.spiegel.de/politik/de-1",
    description: "Der Bundestag hat am Mittwoch ein neues Energiepaket verabschiedet.",
    pubDate: T("09:47:15"),
    image_url: "https://cdn.example.com/de-1.jpg",
    source_id: "spiegel",
    source_name: "Spiegel Online",
    language: "de",
    country: ["germany"],
    category: ["top"],
  },
  {
    article_id: "de-2",
    title: "Kommunen fordern mehr Investitionen",
    link: "https://www.zeit.de/wirtschaft/de-2",
    description: "",
    pubDate: T("08:10:00"),
    image_url: "http://insecure.example.com/de-2.jpg",
    source_id: "zeit",
    source_name: "ZEIT ONLINE",
    language: "de",
  },
  {
    article_id: "de-3",
    title: "Industrie rechnet mit sinkenden Preisen",
    link: "https://www.faz.net/aktuell/de-3",
    pubDate: T("07:05:00"),
    image_url: "",
    source_id: "faz",
    source_name: "FAZ",
    language: "de",
  },
  // 脏数据：没有标题 / 没有可跳转链接 → 必须被丢弃
  { article_id: "bad-1", title: "   ", link: "https://example.com/bad-1", pubDate: T("07:00:00") },
  { article_id: "bad-2", title: "非法链接", link: "javascript:void(0)", pubDate: T("06:00:00") },
];

function makeProvider(responses: Array<{ status?: number; body: string } | Error>, extra: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const sleeps: number[] = [];
  const logs: string[] = [];
  let index = 0;
  const provider = new NewsdataProvider({
    apiKey: "TEST_KEY",
    request: async (url) => {
      calls.push(url);
      const next = responses[Math.min(index, responses.length - 1)];
      index += 1;
      if (next instanceof Error) throw next;
      return { status: next.status ?? 200, body: next.body };
    },
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    logger: (...args: unknown[]) => logs.push(args.join(" ")),
    ...extra,
  });
  return { provider, calls, sleeps, logs };
}

async function main() {
  console.log("\n[1] 国家 → 语言映射表");
  for (const [code, language] of [
    ["DE", "de"],
    ["FR", "fr"],
    ["GB", "en"],
    ["IT", "it"],
    ["ES", "es"],
    ["PL", "pl"],
    ["NL", "nl"],
    ["SE", "sv"],
    ["NO", "no"],
    ["FI", "fi"],
    ["DK", "da"],
    ["IE", "en"],
    ["PT", "pt"],
    ["GR", "el"],
    ["CZ", "cs"],
    ["AT", "de"],
    ["CH", "de"],
    ["BE", "nl"],
    ["HU", "hu"],
    ["RO", "ro"],
    ["BG", "bg"],
    ["HR", "hr"],
    ["SK", "sk"],
    ["SI", "sl"],
    ["RS", "sr"],
    ["UA", "uk"],
    ["RU", "ru"],
  ]) {
    assertEqual(languageForCountry(code), language, `需求指定的 ${code} → ${language}`);
  }
  assertEqual(languageForCountry("de"), "de", "小写国家码同样命中（大小写不敏感）");
  assertEqual(Object.keys(COUNTRY_LANGUAGE).length, 38, `映射表共 ${Object.keys(COUNTRY_LANGUAGE).length} 个国家`);
  const unmapped = EUROPE_COUNTRIES.map((c) => c.code).filter((code) => !languageForCountry(code));
  assertEqual(unmapped.sort(), ["AD", "BY", "LI", "LU", "MC", "MT", "SM", "VA"], "微型国家与语言混杂的国家刻意不传 language");
  assertEqual(languageForCountry("XX"), null, "未知国家返回 null（不猜）");

  console.log("\n[2] 请求 URL 构造");
  const deUrl = buildNewsdataUrl({
    apiBase: NEWSDATA_API_BASE,
    apiKey: "K",
    country: "de",
    language: "de",
    category: "top",
    size: 10,
  });
  assert(deUrl.startsWith("https://newsdata.io/api/1/news?"), "使用官方端点 https://newsdata.io/api/1/news");
  for (const fragment of ["apikey=K", "country=de", "language=de", "category=top", "size=10"]) {
    assert(deUrl.includes(fragment), `URL 含 ${fragment}`);
  }
  const gbUrl = buildNewsdataUrl({ apiBase: NEWSDATA_API_BASE, apiKey: "K", country: "GB", language: "en", category: "top" });
  assert(gbUrl.includes("country=gb"), "国家代码转成 ISO 3166-1 alpha-2 小写");
  const vaUrl = buildNewsdataUrl({ apiBase: NEWSDATA_API_BASE, apiKey: "K", country: "VA", language: null, category: "top" });
  assert(!vaUrl.includes("language="), "无语言映射的国家不传 language（让接口返回该国所有语言）");
  const bigUrl = buildNewsdataUrl({ apiBase: NEWSDATA_API_BASE, apiKey: "K", country: "DE", size: 99 });
  assert(bigUrl.includes("size=10"), "size 被夹到免费层上限 10（传 99 会被上游拒绝）");

  console.log("\n[3] pubDate → ISO");
  assertEqual(newsdataPubDateToIso("2024-01-01 12:00:00"), "2024-01-01T12:00:00Z", '"YYYY-MM-DD HH:mm:ss" → ISO（补 Z）');
  assertEqual(newsdataPubDateToIso("2024-01-01T12:00:00"), "2024-01-01T12:00:00Z", "T 分隔同样能解析");
  assertEqual(newsdataPubDateToIso(""), null, "空值返回 null");
  assertEqual(newsdataPubDateToIso("not-a-date"), null, "非法格式返回 null");

  console.log("\n[4] 响应解析");
  const parsedOk = parseNewsdataResponse(newsdataPayload(ARTICLES));
  assertEqual(parsedOk.articles.length, 5, "解析出全部 results");
  assertEqual(parsedOk.totalResults, 5, "totalResults 透出");
  assertEqual(parseNewsdataResponse(newsdataPayload([])).articles.length, 0, "空 results 不报错（交给上层当 0 条处理）");
  let errorCode: string | null = null;
  let errorMessage = "";
  try {
    parseNewsdataResponse(newsdataErrorPayload("Unauthorized", "The provided API key is not valid."));
  } catch (error) {
    errorCode = error instanceof Error && "code" in error ? (error as { code: string | null }).code : null;
    errorMessage = error instanceof Error ? error.message : "";
  }
  assertEqual(errorCode, "Unauthorized", '实测形状 {status:"error",results:{code,message}} 能解析出 code');
  assert(
    errorMessage.includes("NEWSDATA_API_KEY"),
    `鉴权错误被翻成人话并指向环境变量：${errorMessage.slice(0, 70)}…`,
  );
  let nonJson = "";
  try {
    parseNewsdataResponse("<html>502 Bad Gateway</html>");
  } catch (error) {
    nonJson = error instanceof Error ? error.message : "";
  }
  assert(nonJson.includes("不是 JSON"), `非 JSON 响应抛出可诊断错误：${nonJson.slice(0, 50)}…`);
  assertEqual(newsdataErrorKind("RateLimitExceeded"), "quota", "RateLimitExceeded 识别为额度类");
  assertEqual(newsdataErrorKind("ApiLimitExceeded"), "quota", "ApiLimitExceeded（当日额度）也识别为额度类");
  assertEqual(newsdataErrorKind("UnsupportedFilter"), "country", "UnsupportedFilter 识别为「筛选值/国家不支持」类");
  assertEqual(newsdataErrorKind("FilterLimitExceed"), "params", "FilterLimitExceed 识别为参数类");
  assertEqual(newsdataErrorKind("ServiceUnavailable "), "unknown", "ServiceUnavailable（官方码带尾随空格）能被 trim 后正确落到兜底类");
  assertEqual(newsdataErrorKind(null), "unknown", "未知/空错误码不硬猜");
  let filterReason = "";
  try {
    parseNewsdataResponse(
      newsdataErrorPayload("UnsupportedFilter", "Country filters are not supported", { invalid_country: "ad" }),
    );
  } catch (error) {
    filterReason = error instanceof Error ? error.message : "";
  }
  assert(
    filterReason.includes("被拒绝的筛选值：ad"),
    `被拒的筛选值被带进原因（小国为什么回退一眼可见）：${filterReason.slice(0, 90)}…`,
  );

  console.log("\n[5] 字段映射（NewsItem）");
  const items = toNewsItems(ARTICLES, 3);
  assertEqual(items.length, 3, "取前 3 条（脏数据已被丢弃，不足 3 条时按实际数量）");
  assertEqual(items.map((i) => i.rank), [1, 2, 3], "rank 依次 1/2/3");
  assertEqual(items.map((i) => i.score), [0.95, 0.88, 0.81], "score 按排名递减 0.95/0.88/0.81");
  assertEqual(items[0].title, "Bundestag beschließt neues Energiepaket", "title ← title");
  assertEqual(items[0].sourceName, "Spiegel Online", "sourceName ← source_name");
  assertEqual(items[0].publishedAt, `${TODAY}T09:47:15Z`, "publishedAt ← pubDate（ISO）");
  assertEqual(items[0].url, "https://www.spiegel.de/politik/de-1", "url ← link（真实可跳转）");
  assert(items[0].description.includes("Energiepaket"), "description ← description");
  assertEqual(items[0].imageUrl, "https://cdn.example.com/de-1.jpg", "imageUrl ← image_url（https）");
  assertEqual(items[1].imageUrl, undefined, "http 图片被丢弃（https 页面不会被混合内容拦掉）");
  assertEqual(items[1].description, "", "description 为空时留空（前端有兜底渲染）");
  assertEqual(items[2].imageUrl, undefined, "image_url 为空时留空");
  assert(!items.some((i) => i.url.startsWith("javascript:")), "非法链接不会出现在结果里");

  // 实测问题：NewsData.io 偶尔把图片地址塞进 link（link 与 image_url 完全相同，以 .jpg 结尾），
  // 直接透出去就是「点『阅读原文』打开一张 JPG」。这类条目必须被剔除并由后面的条目补位。
  const withImageLink = [
    { title: "正常新闻一", link: "https://news.example.com/a", pubDate: T("09:00:00") },
    {
      title: "链接其实是图片的新闻",
      link: "https://images.example.com/w:329/h:256/plain/s3://bucket/x.jpg",
      image_url: "https://images.example.com/w:329/h:256/plain/s3://bucket/x.jpg",
      pubDate: T("08:00:00"),
    },
    { title: "正常新闻二", link: "https://news.example.com/b", pubDate: T("07:00:00") },
  ];
  const cleaned = toNewsItems(withImageLink, 3);
  assertEqual(cleaned.length, 2, "link 是图片文件的条目被剔除（第 4 条会顺位补上）");
  assertEqual(
    cleaned.map((i) => i.title),
    ["正常新闻一", "正常新闻二"],
    "补位后仍然是可跳转的真实新闻，rank 连续",
  );
  assertEqual(cleaned.map((i) => i.rank), [1, 2], "剔除后 rank 依然从 1 连续编号");
  assert(
    !cleaned.some((i) => /\.(jpe?g|png|gif|webp|avif|bmp|svg|ico)([?#]|$)/i.test(i.url)),
    "结果里不会出现图片文件链接",
  );

  console.log("\n[6] 正常取数：缓存 / 额度 / 诊断");
  resetNewsdataPacer();
  const happy = makeProvider([{ body: newsdataPayload(ARTICLES) }]);
  const first = await happy.provider.getTopNewsWithMeta("DE", TODAY, 3);
  assertEqual(first.items.length, 3, "返回 limit=3 条");
  assertEqual(first.diagnostics.cached, false, "首次取数 cache=miss");
  assertEqual(first.diagnostics.language, "de", "诊断里带上了实际使用的 language");
  assertEqual(first.diagnostics.upstreamCallsToday, 1, "消耗 1 次上游调用（= 1 credit）");
  assertEqual(happy.calls.length, 1, "只调用一次上游");
  assert(happy.calls[0].includes("country=de") && happy.calls[0].includes("language=de"), "请求参数与需求示例一致");

  const second = await happy.provider.getTopNewsWithMeta("DE", TODAY, 3);
  assertEqual(happy.calls.length, 1, "同国家同日期第二次命中缓存，不再打上游（省 credit）");
  assertEqual(second.diagnostics.cached, true, "第二次标记 cache=hit");
  const cacheState = happy.provider.inspectCache();
  assertEqual(cacheState.countries.length, 1, "缓存里只有 1 个 key");
  assertEqual(cacheState.countries[0].key, `DE|${TODAY}`, "缓存 key = 国家|日期");
  assert(
    cacheState.countries[0].ttlRemainingMs > 59 * 60 * 1000,
    `TTL 约 1 小时（剩 ${Math.round(cacheState.countries[0].ttlRemainingMs / 60000)} 分钟）`,
  );
  const two = await happy.provider.getTopNewsWithMeta("DE", TODAY, 2);
  assertEqual(two.items.length, 2, "同一缓存可服务不同的 limit");
  assertEqual(happy.calls.length, 1, "不同 limit 不会重复打上游");
  const fr = await happy.provider.getTopNewsWithMeta("FR", TODAY, 3);
  assertEqual(fr.diagnostics.language, "fr", "换国家用对应的语言（FR → fr）");
  assertEqual(happy.calls.length, 2, "换国家是一次新的上游调用（每国家独立缓存）");

  console.log("\n[7] 请求构造与节流");
  resetNewsdataPacer();
  const paced = makeProvider([{ body: newsdataPayload(ARTICLES) }, { body: newsdataPayload(ARTICLES) }], { cacheTtlMs: 1 });
  await paced.provider.getTopNewsWithMeta("DE", TODAY, 3);
  await new Promise((r) => setTimeout(r, 5));
  await paced.provider.getTopNewsWithMeta("FR", TODAY, 3);
  assertEqual(paced.calls.length, 2, "缓存过期后重新请求上游");
  assert(
    paced.sleeps.length >= 1 && paced.sleeps[0] >= 500,
    `两次上游调用之间做了 ≥1s 节流（实际 ${paced.sleeps.map((m) => Math.round(m)).join(",")}ms）`,
  );

  console.log("\n[8] 失败路径：错误可读、不重试、走兜底");
  const errPayload = newsdataErrorPayload("Unauthorized", "The provided API key is not valid.");
  resetNewsdataPacer();
  const unauthorized = makeProvider([{ status: 401, body: errPayload }]);
  let unauthorizedReason = "";
  try {
    await unauthorized.provider.getTopNewsWithMeta("DE", TODAY, 3);
  } catch (error) {
    unauthorizedReason = error instanceof Error ? error.message : "";
  }
  assert(
    unauthorizedReason.includes("Unauthorized") && unauthorizedReason.includes("NEWSDATA_API_KEY"),
    `无效 Key 的失败原因可操作：${unauthorizedReason.slice(0, 70)}…`,
  );
  const callsAfterAuthFailure = unauthorized.calls.length;
  try {
    await unauthorized.provider.getTopNewsWithMeta("FR", TODAY, 3);
  } catch {
    /* 预期继续失败 */
  }
  assertEqual(unauthorized.calls.length, callsAfterAuthFailure, "鉴权失败后 60 秒内不重复请求上游（保护 credit）");

  resetNewsdataPacer();
  const network = makeProvider([new Error("connect timeout")]);
  let networkReason = "";
  try {
    await network.provider.getTopNewsWithMeta("DE", TODAY, 3);
  } catch (error) {
    networkReason = error instanceof Error ? error.message : "";
  }
  assert(networkReason.includes("请求 NewsData.io 失败"), `网络失败原因可读：${networkReason.slice(0, 50)}…`);

  resetNewsdataPacer();
  let noKeyCalls = 0;
  const noKey = new NewsdataProvider({
    apiKey: "",
    request: async () => {
      noKeyCalls += 1;
      return { status: 200, body: newsdataPayload(ARTICLES) };
    },
  });
  let noKeyReason = "";
  try {
    await noKey.getTopNewsWithMeta("DE", TODAY, 3);
  } catch (error) {
    noKeyReason = error instanceof Error ? error.message : "";
  }
  assert(noKeyReason.includes("NEWSDATA_API_KEY"), `未配置 Key 时给出明确原因：${noKeyReason}`);
  assertEqual(noKeyCalls, 0, "未配置 Key 时不发请求（不浪费额度）");

  resetNewsdataPacer();
  const rateLimited = makeProvider([{ status: 429, body: newsdataErrorPayload("RateLimitExceeded", "Too many requests") }]);
  let rateReason = "";
  try {
    await rateLimited.provider.getTopNewsWithMeta("DE", TODAY, 3);
  } catch (error) {
    rateReason = error instanceof Error ? error.message : "";
  }
  assert(rateReason.includes("额度"), `限流错误提示额度：${rateReason.slice(0, 60)}…`);

  console.log("\n[9] 0 条 / 历史日期 → 抛错（由上层回退 Mock）");
  resetNewsdataPacer();
  const empty = makeProvider([{ body: newsdataPayload([]) }]);
  let emptyName = "";
  try {
    await empty.provider.getTopNewsWithMeta("VA", TODAY, 3);
  } catch (error) {
    emptyName = error instanceof Error ? error.name : "unknown";
  }
  assertEqual(emptyName, "NewsdataNoDataError", "0 条时抛 NewsdataNoDataError（区别于请求失败）");
  const callsAfterEmpty = empty.calls.length;
  try {
    await empty.provider.getTopNewsWithMeta("VA", TODAY, 3);
  } catch {
    /* 预期继续抛错 */
  }
  assertEqual(empty.calls.length, callsAfterEmpty, "0 条结果进入短负缓存，第二次不再打上游");
  assert(
    empty.provider.inspectCache().negative.length === 1,
    "负缓存只影响「没有新闻」的国家，正常结果仍走 1 小时缓存",
  );

  resetNewsdataPacer();
  const historical = makeProvider([{ body: newsdataPayload(ARTICLES) }]);
  let historicalReason = "";
  try {
    await historical.provider.getTopNewsWithMeta("DE", "2026-01-01", 3);
  } catch (error) {
    historicalReason = error instanceof Error ? error.message : "";
  }
  assert(
    historicalReason.includes("无法回溯历史日期"),
    `非今天日期不会拿今天的新闻冒充：${historicalReason.slice(0, 80)}…`,
  );
  resetNewsdataPacer();
  const lenient = makeProvider([{ body: newsdataPayload(ARTICLES) }], { strictDate: false });
  const lenientResult = await lenient.provider.getTopNewsWithMeta("DE", "2026-01-01", 3);
  assertEqual(lenientResult.items.length, 3, "strictDate=false 时完全按需求执行（只取前 3 条，不剔除其它日期）");

  console.log("\n[10] 当日额度上限");
  resetNewsdataPacer();
  const limited = makeProvider([{ body: newsdataPayload(ARTICLES) }], {
    dailyLimit: 1,
    cacheTtlMs: 1,
    minIntervalMs: 10,
  });
  await limited.provider.getTopNewsWithMeta("DE", TODAY, 3);
  await new Promise((r) => setTimeout(r, 5));
  let limitReason = "";
  try {
    await limited.provider.getTopNewsWithMeta("DE", TODAY, 3);
  } catch (error) {
    limitReason = error instanceof Error ? error.message : "";
  }
  assertEqual(limited.calls.length, 1, "达到当日上限后不再请求上游");
  assert(limitReason.includes("上限"), `上限保护会给出原因：${limitReason.slice(0, 60)}…`);

  console.log("\n[11] resolveTopNews 集成（newsdata → 失败/0 条回退 mock）");
  const originalProvider = process.env.NEWS_PROVIDER;

  process.env.NEWS_PROVIDER = "newsdata";
  assertEqual(getProviderId(), "newsdata", "NEWS_PROVIDER=newsdata 被识别");
  process.env.NEWS_PROVIDER = "juhe";
  assertEqual(getProviderId(), "juhe", "juhe 分支保持不变");
  process.env.NEWS_PROVIDER = "gdelt";
  assertEqual(getProviderId(), "gdelt", "gdelt 分支保持不变");
  process.env.NEWS_PROVIDER = "mock";
  assertEqual(getProviderId(), "mock", "mock 分支保持不变");
  process.env.NEWS_PROVIDER = "MOCK";
  assertEqual(getProviderId(), "mock", "大小写不敏感");
  process.env.NEWS_PROVIDER = originalProvider ?? "mock";

  resetNewsdataPacer();
  const successProvider = makeProvider([{ body: newsdataPayload(ARTICLES) }]);
  const resolved = await resolveTopNews("DE", TODAY, 3, { providerId: "newsdata", newsdata: successProvider.provider });
  assertEqual(resolved.dataSource, "newsdata", "成功时 dataSource=newsdata");
  assertEqual(resolved.items.length, 3, "成功时返回 3 条真实新闻");
  assert(
    Boolean(resolved.headers?.["X-Newsdata-Stats"]),
    `透出额度诊断头：${resolved.headers?.["X-Newsdata-Stats"]}`,
  );
  assertEqual(resolved.fallbackReason, undefined, "成功时没有兜底原因");

  resetNewsdataPacer();
  const failing = makeProvider([
    {
      status: 422,
      body: newsdataErrorPayload("UnsupportedFilter", "Country filters are not supported", { invalid_country: "ad" }),
    },
  ]);
  const fallback = await resolveTopNews("AD", TODAY, 3, { providerId: "newsdata", newsdata: failing.provider });
  assertEqual(fallback.dataSource, "mock", "国家不受支持 → dataSource=mock");
  assertEqual(fallback.queryMode, "mock", "回退时 queryMode=mock");
  assertEqual(fallback.items.length, 3, "回退后仍返回 3 条（前端不报错）");
  assert(
    String(fallback.fallbackReason).includes("不支持这个国家"),
    `回退原因说明了国家不受支持：${String(fallback.fallbackReason).slice(0, 70)}…`,
  );

  resetNewsdataPacer();
  const emptyProvider = makeProvider([{ body: newsdataPayload([]) }]);
  const emptyFallback = await resolveTopNews("LI", TODAY, 3, { providerId: "newsdata", newsdata: emptyProvider.provider });
  assertEqual(emptyFallback.dataSource, "mock", "上游返回 0 条 → 回退 mock");

  resetNewsdataPacer();
  const brokenProvider = makeProvider([new Error("socket hang up")]);
  const brokenFallback = await resolveTopNews("DE", TODAY, 3, { providerId: "newsdata", newsdata: brokenProvider.provider });
  assertEqual(brokenFallback.dataSource, "mock", "网络失败 → 回退 mock");
  assert(brokenFallback.items[0].title.includes("【Mock】德国"), "兜底返回的确实是 Mock 数据");

  console.log("\n[11.1] 数据源快照与取数记录（跨路由模块实例共享）");
  // Next 会为每个路由单独打包本模块：早先用模块级 Map 时，/api/news/top 写入的记录
  // /api/news/sources 读不到，地图永远显示「未查询」。改成挂 globalThis 后必须能读到。
  const originalMode = process.env.NEWS_PROVIDER;
  process.env.NEWS_PROVIDER = "newsdata";
  resetResolvedSources();
  const snapProvider = makeProvider([{ body: newsdataPayload(ARTICLES) }]);
  await resolveTopNews("DE", TODAY, 3, { providerId: "newsdata", newsdata: snapProvider.provider });
  const snapshot = resolveDataSourceSnapshot(TODAY);
  assertEqual(snapshot.DE.dataSource, "newsdata", "查询过的国家在快照里是真实源（地图会变绿）");
  assertEqual(snapshot.DE.itemCount, 3, "快照带上条数");
  assertEqual(snapshot.FR.dataSource, "unknown", "没查过的国家仍是 unknown（不谎称有数据）");
  const host = globalThis as typeof globalThis & {
    __europeNewsResolvedSources?: { map: Map<string, unknown> };
  };
  assert(
    Boolean(host.__europeNewsResolvedSources?.map.has(`DE|${TODAY}`)),
    "记录挂在 globalThis 上（跨路由打包副本共享同一份记录）",
  );
  resetResolvedSources();
  assertEqual(resolveDataSourceSnapshot(TODAY).DE.dataSource, "unknown", "清空后回到 unknown");
  process.env.NEWS_PROVIDER = originalMode ?? "mock";

  console.log("\n[12] 单例惰性读取环境变量 + Key 不外泄");
  const originalKey = process.env.NEWSDATA_API_KEY;
  process.env.NEWS_PROVIDER = "newsdata";
  process.env.NEWSDATA_API_KEY = "ENV_KEY_SET_LATER";
  resetNewsdataProvider();
  const fromEnv = getNewsdataProvider();
  assert(
    JSON.stringify(fromEnv.inspectCache()).includes("upstreamCallsToday"),
    "单例可正常构造（环境变量在首次使用时读取）",
  );
  if (originalKey === undefined) delete process.env.NEWSDATA_API_KEY;
  else process.env.NEWSDATA_API_KEY = originalKey;
  process.env.NEWS_PROVIDER = originalProvider ?? "mock";
  resetNewsdataProvider();

  // 失败原因是要写进 X-Fallback-Reason 的，绝不能把 Key 拼进去
  resetNewsdataPacer();
  const secret = "SECRET_KEY_abcdef123456";
  const leakProbe = makeProvider([new Error("connect timeout")], { apiKey: secret });
  let leakReason = "";
  let leakLog = "";
  try {
    await leakProbe.provider.getTopNewsWithMeta("DE", TODAY, 3);
  } catch (error) {
    leakReason = error instanceof Error ? error.message : "";
    leakLog = leakProbe.logs.join("\n");
  }
  assert(!leakReason.includes(secret), "失败原因（→ X-Fallback-Reason）里没有 Key");
  assert(!leakLog.includes(secret), "日志 URL 做了 apikey=*** 脱敏，不会把 Key 写进日志");

  // ---------- 可选的真实调用 ----------
  if (process.argv.includes("--live")) {
    console.log("\n[13] 真实调用（--live；每个国家消耗 1 credit，免费层 200/天）");
    const key = process.env.NEWSDATA_API_KEY;
    if (!key) {
      console.log("  ⚠️  未设置 NEWSDATA_API_KEY：脚本会读取项目根目录的 .env.local，也可用 shell 变量覆盖");
    } else {
      console.log(`  （使用 Key：…${key.slice(-4)}，共 ${key.length} 位）`);
      const live = new NewsdataProvider({ apiKey: key });
      const countries = ["DE", "FR", "GB", "IT"];
      for (const code of countries) {
        try {
          const result = await live.getTopNewsWithMeta(code, todayIsoDate(), 3);
          console.log(
            `  ✅ ${code} dataSource=newsdata lang=${result.diagnostics.language ?? "any"}` +
              ` 条数=${result.items.length} 上游返回=${result.diagnostics.returned} 上游调用=${result.diagnostics.upstreamCallsToday}`,
          );
          for (const item of result.items) {
            console.log(`       · [${item.sourceName}] ${item.title.slice(0, 70)}`);
            console.log(`         ${item.publishedAt}  ${String(item.url).slice(0, 80)}`);
          }
        } catch (error) {
          console.log(`  ⚠️  ${code} 未拿到数据（将回退 Mock）：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      console.log(`\n  本次共消耗上游调用 ${live.inspectCache().upstreamCallsToday} 次 credit（每国家 1 次，缓存 1 小时）`);
    }
  } else {
    console.log("\n（需要真实调用时：npm run check:newsdata -- --live，Key 读 .env.local 的 NEWSDATA_API_KEY）");
  }

  console.log(`\n${failures === 0 ? "🎉 全部通过" : "❌ 存在失败项"}：${checks - failures}/${checks}\n`);
  if (loadedEnvFiles.length === 0) console.log("（提示：未找到 .env.local/.env，用 shell 环境变量也可以）");
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\n自检脚本异常：", error);
  process.exit(1);
});
