import { fnv1a } from "@/lib/hash";

type HeatPaletteEntry = { background: string; ring: string; label: string; text: string };

/** 把 ISO alpha-2 转成区域指示符 emoji 国旗（纯文本，不产生任何网络请求） */
export function flagEmoji(code: string): string {
  if (!/^[A-Za-z]{2}$/.test(code)) return "🏳️";
  return String.fromCodePoint(
    ...code
      .toUpperCase()
      .split("")
      .map((char) => 127397 + char.charCodeAt(0)),
  );
}

/**
 * 某个国家在某一天的 Mock「热度」（0..1）。
 * 与新闻数据使用同一套哈希思路：同一天刷新不变，切换日期整体变化。
 */
export function heatScore(code: string, date: string): number {
  return (fnv1a(`${code}|${date}|heat`) % 1000) / 1000;
}

export type HeatLevel = 0 | 1 | 2 | 3 | 4;

export function heatLevel(score: number): HeatLevel {
  if (score >= 0.82) return 4;
  if (score >= 0.62) return 3;
  if (score >= 0.4) return 2;
  if (score >= 0.2) return 1;
  return 0;
}

/** 地图配色：越热越亮，最热一档用暖色，便于一眼看出「热点」 */
const HEAT_PALETTE: HeatPaletteEntry[] = [
  { background: "hsl(215 26% 27%)", ring: "hsl(215 26% 38%)", label: "低", text: "hsl(210 20% 92%)" },
  { background: "hsl(208 45% 32%)", ring: "hsl(208 45% 44%)", label: "较低", text: "hsl(210 20% 95%)" },
  { background: "hsl(202 62% 38%)", ring: "hsl(202 62% 50%)", label: "中", text: "hsl(210 20% 97%)" },
  { background: "hsl(194 72% 42%)", ring: "hsl(194 72% 55%)", label: "高", text: "hsl(200 30% 98%)" },
  { background: "hsl(28 88% 52%)", ring: "hsl(28 88% 62%)", label: "最高", text: "hsl(30 40% 12%)" },
];

export function heatColor(level: HeatLevel) {
  return HEAT_PALETTE[level];
}

export const HEAT_LEGEND = HEAT_PALETTE.map((entry, index) => ({
  level: index as HeatLevel,
  color: entry.background,
  label: entry.label,
}));

/** 悬停高亮色 */
export const MAP_HOVER_COLOR = "hsl(38 92% 55%)";
/** 选中高亮色 */
export const MAP_SELECTED_COLOR = "hsl(199 89% 55%)";
export const MAP_STROKE_COLOR = "hsl(222 47% 9%)";
export const MAP_CONTEXT_COLOR = "hsl(217 33% 15%)";
