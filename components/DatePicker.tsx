"use client";

import * as React from "react";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  addDaysIso,
  addMonths,
  buildCalendarMonth,
  formatDateZh,
  monthKeyOf,
  relativeDayLabel,
} from "@/lib/date";
import { cn } from "@/lib/utils";

const WEEKDAY_LABELS = ["一", "二", "三", "四", "五", "六", "日"];

export type DatePickerProps = {
  value: string;
  /**
   * 「今天」（YYYY-MM-DD）。由上层传入而不是在这里读时钟：
   * 服务端与客户端必须用同一个值，否则跨零点/跨时区会产生 hydration 不匹配。
   */
  today: string;
  onChange: (date: string) => void;
  className?: string;
};

/**
 * 日期选择器（shadcn 风格 Popover + 自绘日历）。
 *
 * 不依赖 react-day-picker：日历网格由 lib/date.ts 的纯函数生成，
 * 因此没有额外的第三方依赖，也不会产生任何网络请求。
 */
export function DatePicker({ value, today, onChange, className }: DatePickerProps) {
  const [open, setOpen] = React.useState(false);
  const [month, setMonth] = React.useState(() => monthKeyOf(value));

  // 每次打开时定位到当前选中日期所在月份
  React.useEffect(() => {
    if (open) setMonth(monthKeyOf(value));
  }, [open, value]);

  const calendar = React.useMemo(() => buildCalendarMonth(month), [month]);

  const select = (iso: string) => {
    onChange(iso);
    setOpen(false);
  };

  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="h-9 w-9 shrink-0"
        onClick={() => onChange(addDaysIso(value, -1))}
        aria-label="前一天"
      >
        <ChevronLeft className="h-4 w-4" />
      </Button>

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            className="h-9 min-w-[188px] justify-start gap-2 px-3 font-medium"
            aria-label="选择日期"
          >
            <CalendarDays className="h-4 w-4 text-muted-foreground" />
            <span className="truncate">{formatDateZh(value)}</span>
            {relativeDayLabel(value, today) ? (
              <span className="ml-auto rounded bg-primary/15 px-1.5 py-0.5 text-[11px] font-medium text-primary">
                {relativeDayLabel(value, today)}
              </span>
            ) : null}
          </Button>
        </PopoverTrigger>

        <PopoverContent align="end" className="w-[296px] p-3">
          <div className="mb-3 flex items-center justify-between">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => setMonth((current) => addMonths(current, -1))}
              aria-label="上个月"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <div className="text-sm font-semibold">{calendar.label}</div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => setMonth((current) => addMonths(current, 1))}
              aria-label="下个月"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>

          <div className="mb-1 grid grid-cols-7 gap-1">
            {WEEKDAY_LABELS.map((label) => (
              <div key={label} className="py-1 text-center text-[11px] font-medium text-muted-foreground">
                {label}
              </div>
            ))}
          </div>

          <div className="grid grid-cols-7 gap-1">
            {calendar.cells.map((cell) => {
              const isSelected = cell.iso === value;
              const isToday = cell.iso === today;
              return (
                <button
                  key={cell.iso}
                  type="button"
                  onClick={() => select(cell.iso)}
                  className={cn(
                    "h-8 rounded-md text-xs tabular-nums transition-colors",
                    cell.inCurrentMonth ? "text-foreground" : "text-muted-foreground/50",
                    "hover:bg-accent hover:text-accent-foreground",
                    isToday && !isSelected && "ring-1 ring-inset ring-primary/60",
                    isSelected && "bg-primary font-semibold text-primary-foreground hover:bg-primary",
                  )}
                  aria-current={isToday ? "date" : undefined}
                >
                  {cell.day}
                </button>
              );
            })}
          </div>

          <div className="mt-3 flex items-center justify-between border-t pt-3">
            <Button type="button" variant="ghost" size="sm" onClick={() => select(addDaysIso(today, -1))}>
              昨天
            </Button>
            <Button type="button" variant="secondary" size="sm" onClick={() => select(today)}>
              回到今天
            </Button>
          </div>
        </PopoverContent>
      </Popover>

      <Button
        type="button"
        variant="outline"
        size="icon"
        className="h-9 w-9 shrink-0"
        onClick={() => onChange(addDaysIso(value, 1))}
        aria-label="后一天"
      >
        <ChevronRight className="h-4 w-4" />
      </Button>
    </div>
  );
}
