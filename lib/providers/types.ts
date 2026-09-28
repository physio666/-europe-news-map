/**
 * 新闻数据提供者的统一契约。
 *
 * 本阶段只实现 MockProvider；将来接入真实数据源（NewsAPI / GDELT / 自建索引）时，
 * 只需要新增一个实现该接口的类，前端与 API 路由保持不变。
 */

export type NewsItem = {
  /** 排名，从 1 开始 */
  rank: number;
  title: string;
  sourceName: string;
  /** ISO 8601 发布时间 */
  publishedAt: string;
  url: string;
  description: string;
  imageUrl?: string;
  /** 热度分，按排名递减 */
  score: number;
};

export type NewsProvider = {
  getTopNews(countryCode: string, date: string, limit: number): Promise<NewsItem[]>;
};

/** GET /api/news/top 的响应体 */
export type TopNewsResponse = {
  country: string;
  date: string;
  updatedAt: string;
  dataSource: string;
  items: NewsItem[];
  /**
   * 仅聚合数据（juhe）链路使用：本次结果是怎么筛出来的
   *  - "keyword"：仅关键词命中
   *  - "domain" ：仅来源域名命中
   *  - "both"   ：两者都命中
   *  - "mock"   ：回退 Mock（没用上聚合数据）
   * gdelt 链路不产生该字段。
   */
  queryMode?: "keyword" | "domain" | "both" | "mock";
};

export type ApiErrorResponse = {
  error: string;
  message: string;
};
