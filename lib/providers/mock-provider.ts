import { getCountry } from "@/lib/countries";
import { fnv1a, mulberry32, pick } from "@/lib/hash";
import { scoreForRank } from "./scoring";
import type { NewsItem, NewsProvider } from "./types";

/** 本阶段唯一的数据源标识，会原样出现在 API 响应的 dataSource 字段 */
export const MOCK_DATA_SOURCE = "mock";

/** Mock 新闻来源名称（按需求固定） */
export const MOCK_SOURCE_NAME = "Mock News";

/** 每日三条新闻的基准小时数，全部落在同一天的上午，保证“发布时间在当天” */
const BASE_HOURS = [6, 8, 11];

/** 摘要用的中性话题池：仅用于让 Mock 内容看起来有信息量，不代表任何真实事件 */
const TOPIC_POOL = [
  "能源价格与冬季供暖方案",
  "跨境铁路货运时刻表调整",
  "数字经济法案的二读讨论",
  "暑期旅游客流与住宿价格",
  "高校科研经费分配方案",
  "电动车购车补贴细则",
  "公共医疗系统的排班改革",
  "港口与物流枢纽吞吐量",
  "青年就业与实习岗位计划",
  "老城区文化遗产修缮工程",
  "中小学课程与语言教学改革",
  "新能源发电并网进度",
  "农产品出口检验新规",
  "城市轨道交通扩建招标",
  "空气质量监测与限行措施",
] as const;

/** 摘要模板：{country} 国家名，{topic} 话题 */
const DESCRIPTION_TEMPLATES = [
  "【Mock 数据】{country}今日关注度最高的话题是“{topic}”，相关讨论在本地媒体与社交平台上持续升温。",
  "【Mock 数据】围绕“{topic}”，{country}多家媒体给出了不同解读，各方仍在等待进一步说明。",
  "【Mock 数据】{country}方面就“{topic}”发布最新进展，舆论关注点集中在后续落地时间表。",
  "【Mock 数据】“{topic}”成为{country}当日热点，分析人士认为这一议题会持续影响未来数周。",
] as const;

/**
 * 生成占位配图：内联 SVG data URI。
 * 这样卡片有图可看，同时不会产生任何外部网络请求（Network 面板里只有 /api/news/top）。
 */
function buildPlaceholderImage(options: { code: string; date: string; rank: number; hue: number }): string {
  const { code, date, rank, hue } = options;
  const hue2 = (hue + 42) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},72%,42%)"/><stop offset="1" stop-color="hsl(${hue2},68%,18%)"/></linearGradient></defs><rect width="640" height="360" fill="url(#g)"/><g fill="none" stroke="rgba(255,255,255,0.16)" stroke-width="2"><circle cx="520" cy="80" r="120"/><circle cx="560" cy="300" r="160"/></g><text x="40" y="150" font-family="system-ui,Segoe UI,sans-serif" font-size="104" font-weight="700" fill="rgba(255,255,255,0.95)">#${rank}</text><text x="42" y="200" font-family="system-ui,Segoe UI,sans-serif" font-size="30" font-weight="600" fill="rgba(255,255,255,0.85)">${code} · ${date}</text><text x="42" y="236" font-family="system-ui,Segoe UI,sans-serif" font-size="22" fill="rgba(255,255,255,0.65)">Mock News placeholder</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

// 打分规则与 GDELT 共用同一实现（lib/providers/scoring.ts），保证两个数据源口径一致
const resolveScore = scoreForRank;

/**
 * MockProvider
 *
 * 完全确定性的假数据源：
 *  - 同一国家 + 同一天 → 永远返回同样的 3 条新闻（种子由 `CODE|date` 的 FNV-1a 哈希决定）
 *  - 不访问网络、不读数据库、不需要 API Key
 *  - 覆盖全部 46 个欧洲国家/地区，微型国家同样返回 3 条
 */
export class MockProvider implements NewsProvider {
  readonly id = MOCK_DATA_SOURCE;

  async getTopNews(countryCode: string, date: string, limit: number): Promise<NewsItem[]> {
    const country = getCountry(countryCode);
    // 非欧洲国家或非法代码：返回空数组，由上层决定如何提示（API 会先做 400 校验）
    if (!country) return [];

    const safeLimit = Math.min(Math.max(Math.trunc(limit) || 3, 1), 10);
    const seed = fnv1a(`${country.code}|${date}`);
    const rand = mulberry32(seed);
    const hue = seed % 360;

    const items: NewsItem[] = [];
    for (let i = 0; i < safeLimit; i += 1) {
      const rank = i + 1;
      const baseHour = BASE_HOURS[i] ?? 6 + i * 3;
      const hour = Math.min(baseHour + (i >= 3 ? (i - 2) * 2 : 0), 22);
      const minute = Math.floor(rand() * 6) * 10; // 0/10/20/30/40/50，仍是确定性的

      items.push({
        rank,
        // 标题模板按需求固定，日期变化时标题里的日期同步变化
        title: `【Mock】${country.nameZh} ${date} 热点新闻 ${rank}`,
        sourceName: MOCK_SOURCE_NAME,
        // 不带时区偏移的本地时间写法：无论用户处于哪个时区，显示的日期都等于请求的 date
        publishedAt: `${date}T${`${hour}`.padStart(2, "0")}:${`${minute}`.padStart(2, "0")}:00`,
        url: "#",
        description: pick(DESCRIPTION_TEMPLATES, rand).replace("{country}", country.nameZh).replace(
          "{topic}",
          pick(TOPIC_POOL, rand),
        ),
        imageUrl: buildPlaceholderImage({ code: country.code, date, rank, hue: (hue + rank * 37) % 360 }),
        score: resolveScore(rank),
      });
    }

    return items;
  }
}

export const mockProvider = new MockProvider();
