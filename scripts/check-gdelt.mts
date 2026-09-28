#!/usr/bin/env node
/**
 * GDELT 实时连通性检查（真连外网）。
 *
 *   # 终端 1：用 gdelt 模式启动
 *   $env:NEWS_PROVIDER="gdelt"; npm run dev
 *   # 终端 2：
 *   npm run check:gdelt                       # 默认查 DE, FR, GB, IT
 *   npm run check:gdelt -- DE FR GB IT PL SE  # 自定义国家
 *
 * 为什么要单独一个脚本：
 *   GDELT 是免费公共接口，限流很严（每 5 秒 1 次），而且从某些网络到它的 TCP 连接经常 >10 秒。
 *   这个脚本按顺序、留足间隔地逐个查询，并把「是数据源问题还是网络问题」直接打出来，
 *   避免你把网络问题误判成代码问题。
 */

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const DEFAULT_COUNTRIES = ["DE", "FR", "GB", "IT"];
const EXTRA_COUNTRIES = process.argv.slice(2).filter((arg) => /^[A-Za-z]{2}$/.test(arg));
const COUNTRIES = EXTRA_COUNTRIES.length > 0 ? EXTRA_COUNTRIES.map((c) => c.toUpperCase()) : DEFAULT_COUNTRIES;

const today = new Date();
const DATE = `${today.getFullYear()}-${`${today.getMonth() + 1}`.padStart(2, "0")}-${`${today.getDate()}`.padStart(2, "0")}`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  console.log(`\nGDELT 实时检查：${BASE_URL}  日期=${DATE}  国家=${COUNTRIES.join(", ")}\n`);

  // 先确认当前服务跑在哪个数据源上
  const modeProbe = await fetch(`${BASE_URL}/api/news/top?country=DE&date=${DATE}&limit=3`);
  if (!modeProbe.ok) {
    console.error(`❌ 接口不可用：HTTP ${modeProbe.status}，请确认 dev server 已启动`);
    process.exit(1);
  }
  const probePayload = (await modeProbe.json()) as { dataSource?: string };
  const providerMode = modeProbe.headers.get("x-provider-mode") ?? "unknown";
  console.log(`当前 NEWS_PROVIDER = ${providerMode}（接口本次实际返回 dataSource = ${probePayload.dataSource}）`);
  if (providerMode !== "gdelt") {
    console.log("⚠️  服务不是以 gdelt 模式启动的，下面的结果会一直是 mock。");
    console.log("   请用 NEWS_PROVIDER=gdelt 重启：  $env:NEWS_PROVIDER=\"gdelt\"; npm run dev\n");
  }

  let gdeltCount = 0;
  const results: Array<{ country: string; source: string; items: number; ms: number; note: string }> = [];

  for (const country of COUNTRIES) {
    const started = Date.now();
    let source = "?";
    let items = 0;
    let note = "";

    try {
      const response = await fetch(`${BASE_URL}/api/news/top?country=${country}&date=${DATE}&limit=3`, {
        signal: AbortSignal.timeout(120_000),
      });
      const payload = (await response.json()) as {
        dataSource?: string;
        items?: Array<{ title?: string; sourceName?: string; url?: string; publishedAt?: string }>;
      };
      source = payload.dataSource ?? "?";
      items = payload.items?.length ?? 0;
      // 兜底原因在响应头里做了百分号编码（header 只允许 latin-1），这里还原成可读中文
      const rawReason = response.headers.get("x-fallback-reason");
      note = rawReason ? decodeURIComponent(rawReason) : "";

      if (source === "gdelt") {
        gdeltCount += 1;
        console.log(`✅ ${country}  dataSource=gdelt  条数=${items}  ${Date.now() - started}ms`);
        for (const item of payload.items ?? []) {
          console.log(`     · [${item.sourceName ?? "?"}] ${String(item.title).slice(0, 78)}`);
          console.log(`       ${item.publishedAt}  ${String(item.url).slice(0, 88)}`);
        }
      } else {
        console.log(`⚠️  ${country}  dataSource=${source}（回退）  条数=${items}  ${Date.now() - started}ms`);
        if (note) console.log(`     兜底原因：${note.slice(0, 160)}`);
      }
    } catch (error) {
      note = error instanceof Error ? error.message : String(error);
      console.log(`❌ ${country} 请求异常：${note}`);
    }

    results.push({ country, source, items, ms: Date.now() - started, note });

    // GDELT 要求「每 5 秒最多 1 次」，这里留足间隔，避免自己把自己限流
    if (country !== COUNTRIES[COUNTRIES.length - 1]) await sleep(6500);
  }

  console.log("\n汇总：");
  for (const result of results) {
    console.log(`  ${result.country}: ${result.source} / ${result.items} 条 / ${result.ms}ms`);
  }

  const allGdelt = gdeltCount === COUNTRIES.length;
  console.log(
    `\n${allGdelt ? "🎉 全部国家都拿到了 GDELT 真实新闻" : `⚠️ ${gdeltCount}/${COUNTRIES.length} 个国家拿到 GDELT 数据，其余已按设计回退 Mock`}\n`,
  );

  if (!allGdelt) {
    console.log("排查建议：");
    console.log("  1) 若兜底原因是「非 JSON（可能是限流）」→ GDELT 限流，等几分钟再试，或调大 GDELT_MIN_INTERVAL_MS");
    console.log("  2) 若兜底原因是「请求超时」/ connect timeout → 本机到 GDELT 网络不稳，调大 GDELT_TIMEOUT_MS");
    console.log("  3) 若兜底原因是「没有返回任何文章」→ 该国当天确实没有报道，属正常，界面会显示 Mock 数据\n");
    process.exit(allGdelt ? 0 : 1);
  }
}

main().catch((error) => {
  console.error("\n检查脚本异常：", error);
  process.exit(1);
});
