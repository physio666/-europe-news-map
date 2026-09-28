/** 与日期相关的纯函数工具：全部按“本地日期”处理，避免 UTC 偏移导致日期跳变 */

const WEEKDAYS_ZH = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Date -> YYYY-MM-DD（使用本地时间分量，不用 toISOString，避免时区偏移） */
export function toIsoDate(date: Date): string {
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, "0");
  const d = `${date.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function todayIsoDate(): string {
  return toIsoDate(new Date());
}

/** 严格校验 YYYY-MM-DD，且必须是真实存在的日历日期（例如拒绝 2026-02-30） */
export function isValidIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE_RE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const parsed = new Date(Date.UTC(y, m - 1, d));
  return (
    parsed.getUTCFullYear() === y &&
    parsed.getUTCMonth() === m - 1 &&
    parsed.getUTCDate() === d
  );
}

/** YYYY-MM-DD -> Date（本地 00:00） */
export function parseIsoDate(value: string): Date {
  const [y, m, d] = value.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function addDaysIso(value: string, days: number): string {
  const date = parseIsoDate(value);
  date.setDate(date.getDate() + days);
  return toIsoDate(date);
}

/** 2026-09-26 -> 2026年9月26日 周六 */
export function formatDateZh(value: string): string {
  if (!isValidIsoDate(value)) return value;
  const date = parseIsoDate(value);
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${WEEKDAYS_ZH[date.getDay()]}`;
}

/** ISO 时间戳 -> HH:mm（本地时间） */
export function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--";
  const hh = `${date.getHours()}`.padStart(2, "0");
  const mm = `${date.getMinutes()}`.padStart(2, "0");
  return `${hh}:${mm}`;
}

/** 相对今天：今天 / 昨天 / 明天 / null（用于日期选择器上显示“今天”标记） */
/**
 * 相对今天的标签。
 *
 * `today` 必须由调用方传入（而不是在这里读时钟）：服务端渲染与客户端 hydration
 * 必须使用同一个"今天"，否则两边的时钟/时区一旦跨零点就会出现 hydration 不匹配。
 */
export function relativeDayLabel(value: string, today: string): string | null {
  if (value === today) return "今天";
  if (value === addDaysIso(today, -1)) return "昨天";
  if (value === addDaysIso(today, 1)) return "明天";
  return null;
}

export type CalendarCell = {
  iso: string;
  day: number;
  inCurrentMonth: boolean;
};

export type CalendarMonth = {
  /** 该月第一天所在周的周一 */
  startIso: string;
  cells: CalendarCell[];
  /** 月份标题，如 2026年9月 */
  label: string;
  monthKey: string;
};

/** 生成用于日历展示的 6x7 网格（周一开始） */
export function buildCalendarMonth(monthKey: string): CalendarMonth {
  const [year, month] = monthKey.split("-").map(Number);
  const first = new Date(year, month - 1, 1);
  const offset = (first.getDay() + 6) % 7; // 周一为一周起点
  const start = new Date(year, month - 1, 1 - offset);

  const cells: CalendarCell[] = [];
  for (let i = 0; i < 42; i += 1) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    cells.push({
      iso: toIsoDate(day),
      day: day.getDate(),
      inCurrentMonth: day.getMonth() === month - 1,
    });
  }

  return {
    startIso: toIsoDate(start),
    cells,
    label: `${year}年${month}月`,
    monthKey,
  };
}

export function monthKeyOf(iso: string): string {
  return iso.slice(0, 7);
}

export function addMonths(monthKey: string, delta: number): string {
  const [year, month] = monthKey.split("-").map(Number);
  const date = new Date(year, month - 1 + delta, 1);
  return `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, "0")}`;
}

/** 最近 n 天的日期列表（含今天），从新到旧 —— 供「最近 7 天」这类快捷入口使用 */
export function recentDays(count: number): string[] {
  const today = todayIsoDate();
  return Array.from({ length: count }, (_, i) => addDaysIso(today, -i));
}
