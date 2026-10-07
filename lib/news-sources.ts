/**
 * 数据源可视化：把「这个国家显示的是真实新闻还是演示数据」映射成颜色与文案。
 *
 * 刻意**不加 "use client"**：这些常量与纯函数同时被服务端路由和客户端组件使用，
 * 加了指令就会把 React hook 拖进服务端 bundle。
 * 真正需要浏览器的 hook 在 lib/use-news-sources.ts。
 *
 * 三类状态：
 *   real    —— 真实新闻（NewsData.io / 聚合数据 juhe / GDELT）
 *   mock    —— 演示数据（MockProvider，含真实源失败后的自动回退）
 *   unknown —— 本次会话还没查询过（不谎称是 mock）
 */

export type NewsSourceKind = "real" | "mock" | "unknown";

export type CountrySourceEntry = { dataSource: string; itemCount: number };

export type NewsSourcesResponse = {
  date: string;
  provider: string;
  countries: Record<string, CountrySourceEntry>;
  summary?: { total: number; real: number; mock: number; unknown: number };
};

export function newsSourceKind(dataSource: string | null | undefined): NewsSourceKind {
  if (!dataSource) return "unknown";
  const value = dataSource.toLowerCase();
  if (value === "unknown" || value === "") return "unknown";
  if (value === "mock") return "mock";
  return "real";
}

/** 数据源的中文名（徽标与提示共用） */
export function dataSourceLabel(dataSource: string | null | undefined): string {
  switch ((dataSource ?? "").toLowerCase()) {
    case "newsdata":
      return "NewsData.io";
    case "juhe":
      return "聚合数据（中文媒体国际报道）";
    case "gdelt":
      return "GDELT 实时新闻";
    case "mock":
      return "Mock 演示数据";
    case "unknown":
    case "":
      return "尚未查询";
    default:
      return String(dataSource);
  }
}

/** 徽标文案：需求指定「数据源：NewsData.io」/「数据源：聚合数据（中文媒体国际报道）」/「数据源：Mock 演示数据」 */
export function dataSourceBadgeText(dataSource: string | null | undefined): string {
  return `数据源：${dataSourceLabel(dataSource)}`;
}

export type SourcePalette = {
  /** 常态填充 */
  fill: string;
  /** 选中态填充：刻意用「更亮的同色系」而不是青色高亮，
   *  否则点开一个国家就会盖掉「绿=真实 / 灰=演示」这个核心信息 */
  selected: string;
  ring: string;
  swatch: string;
  label: string;
  short: string;
};

/** 地图配色：绿 = 真实新闻，灰 = 演示数据，浅 = 未查询 */
export const SOURCE_PALETTE: Record<NewsSourceKind, SourcePalette> = {
  real: {
    fill: "hsl(152 52% 36%)",
    selected: "hsl(152 62% 48%)",
    ring: "hsl(152 52% 48%)",
    swatch: "hsl(152 52% 42%)",
    label: "真实新闻",
    short: "真实",
  },
  mock: {
    fill: "hsl(220 8% 44%)",
    selected: "hsl(220 8% 60%)",
    ring: "hsl(220 8% 56%)",
    swatch: "hsl(220 8% 52%)",
    label: "演示数据（Mock）",
    short: "演示",
  },
  unknown: {
    fill: "hsl(217 20% 27%)",
    selected: "hsl(217 22% 40%)",
    ring: "hsl(217 20% 38%)",
    swatch: "hsl(217 20% 33%)",
    label: "本次会话未查询",
    short: "未查询",
  },
};

export const SOURCE_LEGEND = [
  { kind: "real" as NewsSourceKind, emoji: "🟢" },
  { kind: "mock" as NewsSourceKind, emoji: "⚪" },
  { kind: "unknown" as NewsSourceKind, emoji: "◻️" },
];
