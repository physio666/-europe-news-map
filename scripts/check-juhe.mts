#!/usr/bin/env node
/**
 * 聚合数据 Provider 自检。
 *
 *   npm run check:juhe          # 离线部分（默认，不联网、不需要 Key）
 *   JUHE_NEWS_KEY=xxx npm run check:juhe -- --live    # 额外做一次真实调用
 *
 * 为什么要靠离线断言：聚合数据需要 AppKey 且免费额度只有 50 次/天，
 * 过滤规则、错误码、额度保护这些逻辑不可能靠反复打真接口来验证。
 * 所以这里用一个 stub 掉的 HTTP 层，把每条规则都钉死。
 */

import {
  COUNTRY_DOMAINS,
  COUNTRY_KEYWORDS,
  filterJuheArticles,
  matchDomain,
  matchKeyword,
  toIsoLocalDateTime,
} from "@/lib/juhe-filters";
import { describeJuheError, juheErrorKind } from "@/lib/juhe-error-codes";
import {
  JuheProvider,
  buildJuheUrl,
  getJuheProvider,
  resetJuhePacer,
  resetJuheProvider,
} from "@/lib/providers/juhe-provider";
import { resolveTopNews } from "@/lib/providers/index";
import { EUROPE_COUNTRIES } from "@/lib/countries";
import { todayIsoDate } from "@/lib/date";

// 与 Next 一致地加载 .env / .env.local：
// 用户把 JUHE_NEWS_KEY 配在 .env.local 里，而独立脚本默认看不到它（那是 next dev 加载的）。
// 不加载就会出现「明明配了 Key，脚本却说没配」的假故障。
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

/** 真实的聚合数据响应结构：{ reason, error_code, result: { stat, data: [...] } } */
function juhePayload(data: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    reason: "成功的返回",
    error_code: 0,
    result: { stat: "1", data, ...extra },
  });
}

const TODAY = todayIsoDate();
const D = (time: string) => `${TODAY} ${time}`;

/** 一批混合新闻：德国（中/英关键词）、法国（域名）、乌克兰（用于验证 UK 不误伤）、无关新闻 */
const POOL = [
  {
    uniquekey: "de-1",
    title: "德国总理表示将继续推进能源转型",
    date: D("08:47:15"),
    category: "国际",
    author_name: "环球网",
    url: "https://world.huanqiu.com/article/de-1",
    thumbnail_pic_s: "https://img.example.com/de-1.jpg",
    is_content: "1",
  },
  {
    uniquekey: "de-2",
    title: "Berlin announces new defence spending plan",
    date: D("07:10:00"),
    category: "国际",
    author_name: "参考消息",
    url: "https://www.cankaoxiaoxi.com/de-2",
    is_content: "1",
  },
  {
    uniquekey: "fr-1",
    title: "法国国民议会通过预算修正案",
    date: D("09:05:00"),
    category: "国际",
    author_name: "海外网",
    url: "https://news.haiwainet.cn/fr-1",
    is_content: "1",
  },
  {
    // 域名命中（lemonde.fr），标题里没有德国关键词 → 属于「仅域名」命中
    uniquekey: "fr-2",
    title: "European markets close higher",
    date: D("06:30:00"),
    category: "国际",
    author_name: "lemonde.fr",
    url: "https://www.lemonde.fr/economie/article/fr-2",
    is_content: "1",
  },
  {
    // 关键词与域名同时命中
    uniquekey: "de-3",
    title: "德国柏林举行气候抗议",
    date: D("10:20:00"),
    category: "国际",
    author_name: "spiegel.de",
    url: "https://www.spiegel.de/politik/de-3",
    is_content: "1",
  },
  {
    // 用来验证 "UK" 不会误命中 "Ukraine"
    uniquekey: "ua-1",
    title: "Ukraine reports new drone attacks overnight",
    date: D("05:00:00"),
    category: "国际",
    author_name: "环球时报",
    url: "https://world.huanqiu.com/ua-1",
    is_content: "1",
  },
  {
    uniquekey: "misc-1",
    title: "全球气候变化大会即将召开",
    date: D("04:00:00"),
    category: "国际",
    author_name: "新华网",
    url: "https://www.xinhuanet.com/misc-1",
    is_content: "1",
  },
  {
    // 重复 uniquekey：验证按 uniquekey 去重
    uniquekey: "de-1",
    title: "德国总理表示将继续推进能源转型（转载）",
    date: D("08:20:00"),
    category: "国际",
    author_name: "转载媒体",
    url: "https://example.com/dup",
    is_content: "1",
  },
];

function makeProvider(
  responses: Array<{ status?: number; body: string } | Error>,
  extra: Record<string, unknown> = {},
) {
  const calls: string[] = [];
  const sleeps: number[] = [];
  let index = 0;
  const provider = new JuheProvider({
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
    logger: () => {},
    ...extra,
  });
  return { provider, calls, sleeps };
}

async function main() {
  console.log("\n[1] 过滤规则表");
  assertEqual(Object.keys(COUNTRY_KEYWORDS).length, EUROPE_COUNTRIES.length, `关键词表覆盖 ${EUROPE_COUNTRIES.length} 个国家`);
  const missingKeywords = EUROPE_COUNTRIES.filter((c) => (COUNTRY_KEYWORDS[c.code] ?? []).length === 0);
  assertEqual(missingKeywords.map((c) => c.code), [], "每个国家都有关键词");
  assert(COUNTRY_KEYWORDS.DE.includes("Germany"), "保留了需求给的英文关键词 Germany");
  assert(COUNTRY_KEYWORDS.DE.includes("德国"), "补充了中文关键词 德国（聚合数据以中文稿为主）");
  assert(COUNTRY_DOMAINS.DE.includes("spiegel.de"), "域名表保留了需求给的 spiegel.de");
  assertEqual(Object.keys(COUNTRY_DOMAINS).length >= 27, true, `域名表覆盖 ${Object.keys(COUNTRY_DOMAINS).length} 个国家`);

  console.log("\n[2] 匹配方式（词边界 + 中文子串）");
  assertEqual(matchKeyword("Germany unveils budget", COUNTRY_KEYWORDS.DE), "Germany", "英文关键词命中");
  assertEqual(matchKeyword("德国总理发表讲话", COUNTRY_KEYWORDS.DE), "德国", "中文关键词命中");
  assertEqual(matchKeyword("Berlin announces plan", COUNTRY_KEYWORDS.DE), "Berlin", "首都命中");
  assertEqual(matchKeyword("Ukraine reports drone attacks", COUNTRY_KEYWORDS.GB), null, '关键词 "UK" 不会误命中 "Ukraine"（词边界）');
  assertEqual(matchKeyword("IT sector grows in Asia", COUNTRY_KEYWORDS.IT), null, '不会因 "IT" 这类短词误判（表里用的是 Italy/Italian）');
  assertEqual(matchKeyword("", COUNTRY_KEYWORDS.DE), null, "空标题返回 null");
  assertEqual(matchDomain({ url: "https://www.spiegel.de/a" }, COUNTRY_DOMAINS.DE), "spiegel.de", "url 命中域名");
  assertEqual(matchDomain({ author_name: "lemonde.fr" }, COUNTRY_DOMAINS.FR), "lemonde.fr", "author_name 命中域名");
  assertEqual(matchDomain({ url: "https://example.com/x" }, COUNTRY_DOMAINS.DE), null, "无关域名不命中");

  console.log("\n[3] 两级过滤 / 去重 / 排序 / queryMode");
  const de = filterJuheArticles(POOL, "DE");
  assertEqual(de.matches.map((m) => m.article.uniquekey), ["de-3", "de-1", "de-2"], "德国：按时间倒序且 uniquekey 去重");
  assertEqual(de.queryMode, "both", "德国同时有关键词与域名命中 → both");
  const fr = filterJuheArticles(POOL, "FR");
  assertEqual(fr.queryMode, "both", "法国：关键词（法国）+ 域名（lemonde.fr）→ both");
  const onlyDomain = filterJuheArticles(
    [{ uniquekey: "x", title: "European markets close higher", author_name: "lemonde.fr", date: D("06:30:00") }],
    "FR",
  );
  assertEqual(onlyDomain.queryMode, "domain", "仅域名命中 → domain");
  const onlyKeyword = filterJuheArticles(
    [{ uniquekey: "y", title: "德国总理讲话", author_name: "环球网", date: D("06:30:00") }],
    "DE",
  );
  assertEqual(onlyKeyword.queryMode, "keyword", "仅关键词命中 → keyword");
  assertEqual(filterJuheArticles(POOL, "PT").queryMode, null, "池子里没有葡萄牙相关稿件 → null（触发兜底）");
  assertEqual(filterJuheArticles(POOL, "UA").matches.length, 1, "乌克兰稿件能被正确归属（不会算到英国）");

  console.log("\n[4] 日期处理与严格日期模式");
  assertEqual(toIsoLocalDateTime("2026-09-27 08:47:15"), "2026-09-27T08:47:15", "date 原串转成合法 ISO（墙上时间不变）");
  assertEqual(toIsoLocalDateTime(""), null, "空日期返回 null");
  const oldPool = [{ uniquekey: "old", title: "德国旧闻", date: "2026-01-01 08:00:00", author_name: "环球网", url: "" }];
  assertEqual(filterJuheArticles(oldPool, "DE", { strictDate: TODAY }).matches.length, 0, "严格日期模式会剔除其它日期的稿件");
  assertEqual(filterJuheArticles(oldPool, "DE").matches.length, 1, "非严格模式（需求默认过滤策略）保留");

  console.log("\n[5] 正常取数：映射 / queryMode / 缓存 / 额度");
  resetJuhePacer();
  const happy = makeProvider([{ body: juhePayload(POOL) }]);
  const result = await happy.provider.getTopNewsWithMeta("DE", TODAY, 3);
  assertEqual(result.items.length, 3, "返回 limit=3 条");
  assertEqual(result.items.map((i) => i.rank), [1, 2, 3], "rank 依次 1/2/3");
  assertEqual(result.items.map((i) => i.score), [0.95, 0.88, 0.81], "score 按排名递减");
  assertEqual(result.items[0].title, "德国柏林举行气候抗议", "title 映射正确（最新一条）");
  assertEqual(result.items[0].sourceName, "spiegel.de", "sourceName ← author_name");
  assertEqual(result.items[0].url, "https://www.spiegel.de/politik/de-3", "url 映射正确");
  assertEqual(result.items[0].publishedAt, `${TODAY}T10:20:00`, "publishedAt ← date（转合法 ISO）");
  assertEqual(result.items[0].description, "", "description 留空（列表接口无摘要）");
  assert(
    result.items.some((item) => item.imageUrl === "https://img.example.com/de-1.jpg"),
    `imageUrl ← thumbnail_pic_s（命中项已带上缩略图）`,
  );
  assertEqual(result.queryMode, "both", "queryMode=both");
  assertEqual(result.diagnostics.poolCached, false, "首次取数是 pool=fetched");
  assertEqual(happy.calls.length, 1, "只调用一次上游");

  const second = await happy.provider.getTopNewsWithMeta("DE", TODAY, 3);
  assertEqual(happy.calls.length, 1, "同国家同日期第二次命中缓存，不再调用上游");
  assertEqual(second.diagnostics.poolCached, true, "第二次标记为 pool=cached（没有上游调用）");
  assertEqual(second.diagnostics.countryCached, true, "第二次命中的是「国家|日期」结果缓存");

  const fr2 = await happy.provider.getTopNewsWithMeta("FR", TODAY, 3);
  assertEqual(happy.calls.length, 1, "换国家仍走共享新闻池缓存 → 额度不增加（46 国只花 1 次额度）");
  assertEqual(fr2.diagnostics.countryCached, false, "换国家是新国家缓存，但新闻池仍来自缓存");
  assertEqual(fr2.diagnostics.poolCached, true, "换国家时 pool=cached（没有新增上游调用）");
  assertEqual(fr2.queryMode, "both", "法国也能筛出结果");

  console.log("\n[6] 请求构造与节流");
  const built = buildJuheUrl({
    apiBase: "https://v.juhe.cn/toutiao/index",
    apiKey: "K",
    type: "guoji",
    page: 1,
    pageSize: 30,
    isFilter: "0",
  });
  for (const fragment of ["type=guoji", "page=1", "page_size=30", "is_filter=0", "key=K"]) {
    assert(built.includes(fragment), `URL 含 ${fragment}`);
  }
  resetJuhePacer();
  const paced = makeProvider([{ body: juhePayload(POOL) }, { body: juhePayload(POOL) }], { poolTtlMs: 1 });
  await paced.provider.getTopNewsWithMeta("DE", TODAY, 3);
  await new Promise((r) => setTimeout(r, 5));
  await paced.provider.getTopNewsWithMeta("FR", TODAY, 3);
  assertEqual(paced.calls.length, 2, "新闻池缓存过期后重新请求上游");
  assert(
    paced.sleeps.length >= 1 && paced.sleeps[0] >= 2000,
    `两次上游调用之间做了 ≥2s 节流（实际 ${paced.sleeps.map((m) => Math.round(m)).join(",")}ms）`,
  );

  console.log("\n[7] 错误码处理 → 回退原因可读");
  assertEqual(juheErrorKind(10012), "quota", "10012 识别为额度类");
  assertEqual(juheErrorKind(10001), "config", "10001 识别为配置类");
  assert(describeJuheError(10001).includes("无效的请求KEY"), "10001 有可读说明");
  assert(describeJuheError(10012).includes("额度"), "10012 提示额度用尽");
  const errPayload = JSON.stringify({ reason: "请求超过次数限制", error_code: 10012, result: null });
  resetJuhePacer();
  const quota = makeProvider([{ body: errPayload }]);
  let quotaReason = "";
  try {
    await quota.provider.getTopNewsWithMeta("DE", TODAY, 3);
  } catch (error) {
    quotaReason = error instanceof Error ? error.message : "";
  }
  assert(quotaReason.includes("10012") && quotaReason.includes("额度"), `错误码被翻译成人话：${quotaReason.slice(0, 60)}…`);

  resetJuhePacer();
  const broken = makeProvider([new Error("connect timeout")]);
  let brokenReason = "";
  try {
    await broken.provider.getTopNewsWithMeta("DE", TODAY, 3);
  } catch (error) {
    brokenReason = error instanceof Error ? error.message : "";
  }
  assert(brokenReason.includes("请求聚合数据失败"), `网络失败原因可读：${brokenReason.slice(0, 50)}…`);
  const callsAfterFailure = broken.calls.length;
  try {
    await broken.provider.getTopNewsWithMeta("FR", TODAY, 3);
  } catch {
    /* 预期继续失败 */
  }
  assertEqual(broken.calls.length, callsAfterFailure, "60 秒内不重复打上游（保护 50 次/天的额度）");

  console.log("\n[8] 缺少 Key / 当日额度上限");
  resetJuhePacer();
  const noKey = new JuheProvider({ apiKey: "", request: async () => ({ status: 200, body: juhePayload(POOL) }) });
  let noKeyReason = "";
  let noKeyCalls = 0;
  try {
    await noKey.getTopNewsWithMeta("DE", TODAY, 3);
  } catch (error) {
    noKeyReason = error instanceof Error ? error.message : "";
  }
  void noKeyCalls;
  assert(noKeyReason.includes("JUHE_NEWS_KEY"), `未配置 Key 时给出明确原因：${noKeyReason}`);
  resetJuhePacer();
  const limited = makeProvider([{ body: juhePayload(POOL) }], {
    dailyLimit: 1,
    poolTtlMs: 1,
    cacheTtlMs: 1, // 连「国家|日期」结果缓存也过期，才能真正走到额度保护这一步
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
  assert(limitReason.includes("上限"), `上限保护会给出原因：${limitReason.slice(0, 50)}…`);

  console.log("\n[9] resolveTopNews 集成（juhe → 兜底 mock）");
  process.env.NEWS_PROVIDER = "mock";
  const mockResolved = await resolveTopNews("DE", TODAY, 3);
  assertEqual([mockResolved.dataSource, mockResolved.queryMode], ["mock", "mock"], "mock 模式：dataSource=mock 且 queryMode=mock");

  resetJuhePacer();
  const juheSuccess = makeProvider([{ body: juhePayload(POOL) }]);
  const resolved = await resolveTopNews("DE", TODAY, 3, { providerId: "juhe", juhe: juheSuccess.provider });
  assertEqual(resolved.dataSource, "juhe", "成功时 dataSource=juhe");
  assertEqual(resolved.queryMode, "both", "成功时带 queryMode");
  assertEqual(resolved.items.length, 3, "成功时返回 3 条");
  assert(Boolean(resolved.headers?.["X-Juhe-Stats"]), `透出额度诊断头：${resolved.headers?.["X-Juhe-Stats"]}`);

  resetJuhePacer();
  const juheFail = makeProvider([{ body: errPayload }]);
  const fallback = await resolveTopNews("DE", TODAY, 3, { providerId: "juhe", juhe: juheFail.provider });
  assertEqual(fallback.dataSource, "mock", "聚合数据失败 → dataSource=mock");
  assertEqual(fallback.queryMode, "mock", "回退时 queryMode=mock");
  assertEqual(fallback.items.length, 3, "回退后仍返回 3 条（前端不报错）");
  assert(
    Boolean(fallback.fallbackReason) && fallback.fallbackReason!.includes("10012"),
    `回退原因可读：${String(fallback.fallbackReason).slice(0, 60)}…`,
  );
  assert(!fallback.headers?.["X-Query-Mode"], "回退时不再透出 juhe 的 X-Query-Mode");

  resetJuhePacer();
  const noMatch = makeProvider([{ body: juhePayload(POOL) }]);
  const noMatchFallback = await resolveTopNews("PT", TODAY, 3, { providerId: "juhe", juhe: noMatch.provider });
  assertEqual(noMatchFallback.dataSource, "mock", "过滤后 0 条 → 回退 mock");
  assert(
    String(noMatchFallback.fallbackReason).includes("没有 PT"),
    `0 命中原因说明了国家与池子大小：${String(noMatchFallback.fallbackReason).slice(0, 70)}…`,
  );

  console.log("\n[10] 单例惰性读取环境变量");
  // 注意：这里要保存并恢复真实 Key。早先版本直接 delete，
  // 结果把后面 [11] 的真实调用也一起干掉了（脚本自己制造的假故障）。
  const originalKey = process.env.JUHE_NEWS_KEY;
  const originalProvider = process.env.NEWS_PROVIDER;
  process.env.NEWS_PROVIDER = "juhe";
  process.env.JUHE_NEWS_KEY = "ENV_KEY_SET_LATER";
  resetJuheProvider();
  const fromEnv = getJuheProvider();
  assert(
    JSON.stringify(fromEnv.inspectCache()).includes("upstreamCallsToday"),
    "单例可正常构造（环境变量在首次使用时读取）",
  );
  if (originalKey === undefined) delete process.env.JUHE_NEWS_KEY;
  else process.env.JUHE_NEWS_KEY = originalKey;
  process.env.NEWS_PROVIDER = originalProvider ?? "mock";

  // ---------- 可选的真实调用 ----------
  if (process.argv.includes("--live")) {
    console.log("\n[11] 真实调用（--live；每个国家会消耗免费额度，注意 50 次/天）");
    const key = process.env.JUHE_NEWS_KEY;
    if (!key) {
      console.log("  ⚠️  未设置 JUHE_NEWS_KEY：脚本会读取项目根目录的 .env.local，也可用 shell 变量覆盖");
    } else {
      console.log(`  （使用 Key：…${key.slice(-4)}，共 ${key.length} 位）`);
      const live = new JuheProvider({ apiKey: key, maxPages: 2 });
      const countries = ["DE", "FR", "GB", "IT"];
      for (const code of countries) {
        try {
          const liveResult = await live.getTopNewsWithMeta(code, todayIsoDate(), 3);
          console.log(
            `  ✅ ${code} dataSource=juhe queryMode=${liveResult.queryMode} 条数=${liveResult.items.length}` +
              ` 池=${liveResult.diagnostics.poolSize} 命中=${liveResult.diagnostics.matched}` +
              ` 池命中缓存=${liveResult.diagnostics.poolCached} 上游调用=${liveResult.diagnostics.upstreamCallsToday}`,
          );
          for (const item of liveResult.items) {
            console.log(`       · [${item.sourceName}] ${item.title.slice(0, 70)}`);
            console.log(`         ${item.publishedAt}  ${String(item.url).slice(0, 80)}`);
          }
        } catch (error) {
          console.log(`  ⚠️  ${code} 未拿到数据（将回退 Mock）：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      console.log(
        `\n  本次共调用上游 ${live.inspectCache().upstreamCallsToday} 次（新闻池共享，国家越多越省额度）`,
      );
    }
  } else {
    console.log("\n（需要真实调用时：JUHE_NEWS_KEY=xxx npm run check:juhe -- --live）");
  }

  console.log(`\n${failures === 0 ? "🎉 全部通过" : "❌ 存在失败项"}：${checks - failures}/${checks}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\n自检脚本异常：", error);
  process.exit(1);
});
