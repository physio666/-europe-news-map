"use client";

import * as React from "react";
import type { GeoProjection } from "d3-geo";
import { AlertTriangle, MapPin, Maximize2 } from "lucide-react";
import {
  ComposableMap,
  Geographies,
  Geography,
  Marker,
  ZoomableGroup,
  useZoomPanContext,
  type ProjectionFunction,
} from "react-simple-maps";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { getCountry } from "@/lib/countries";
import {
  createEuropeProjection,
  loadContextGeoJSON,
  loadEuropeGeoJSON,
  type ContextGeoJSON,
  type EuropeFeature,
  type EuropeGeoJSON,
} from "@/lib/geo";
import {
  MAP_CONTEXT_COLOR,
  MAP_HOVER_COLOR,
  MAP_SELECTED_COLOR,
  MAP_STROKE_COLOR,
} from "@/lib/heat";
import {
  SOURCE_LEGEND,
  SOURCE_PALETTE,
  dataSourceLabel,
  newsSourceKind,
  type CountrySourceEntry,
} from "@/lib/news-sources";
import { cn } from "@/lib/utils";

/** 点击与拖拽的区分阈值（屏幕像素）：小于该距离才算“点击选中国家” */
const CLICK_MOVE_THRESHOLD = 6;

/** Geographies 的 children 回调参数（@types 未导出该类型，这里从组件 props 中推导） */
type GeographiesArg = Parameters<
  NonNullable<React.ComponentProps<typeof Geographies>["children"]>
>[0];

export type EuropeMapProps = {
  /** 当前选中的国家代码 */
  selectedCode: string | null;
  /** 选中/取消选中回调，null 表示清空选中 */
  onSelect: (code: string | null) => void;
  /** 当前日期（用于「已获取真实新闻」的快照查询等） */
  date: string;
  /**
   * 国家 → 数据源状态（来自 /api/news/sources 的只读快照）。
   * 绿=真实新闻、灰=演示数据、浅=本次会话未查询；缺省时全部按「未查询」渲染。
   */
  sourceByCode?: Record<string, CountrySourceEntry>;
  className?: string;
};

type HoverState = { code: string; x: number; y: number } | null;

type LoadState<T> = { status: "loading" | "success" | "error"; data: T | null; error: string | null };

/** 监听容器尺寸（ResizeObserver + rAF 合并），用于把投影按实际像素重新适配 */
function useElementSize<T extends HTMLElement>() {
  const ref = React.useRef<T | null>(null);
  const [size, setSize] = React.useState({ width: 0, height: 0 });

  React.useEffect(() => {
    const element = ref.current;
    if (!element) return;

    let frame = 0;
    const apply = () => {
      const rect = element.getBoundingClientRect();
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
    };

    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(apply);
    };

    apply();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", schedule);
      return () => {
        window.removeEventListener("resize", schedule);
        cancelAnimationFrame(frame);
      };
    }

    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);

  return { ref, size };
}

/** 加载欧洲地图与背景图层 GeoJSON（同源静态文件，无外部请求） */
function useEuropeLayers() {
  const [europe, setEurope] = React.useState<LoadState<EuropeGeoJSON>>({
    status: "loading",
    data: null,
    error: null,
  });
  const [context, setContext] = React.useState<ContextGeoJSON | null>(null);
  const [nonce, setNonce] = React.useState(0);

  React.useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    setEurope({ status: "loading", data: null, error: null });

    Promise.all([loadEuropeGeoJSON(controller.signal), loadContextGeoJSON(controller.signal)])
      .then(([europeData, contextData]) => {
        if (cancelled) return;
        setEurope({ status: "success", data: europeData, error: null });
        setContext(contextData);
      })
      .catch((error: unknown) => {
        if (cancelled || (error instanceof DOMException && error.name === "AbortError")) return;
        setEurope({
          status: "error",
          data: null,
          error: error instanceof Error ? error.message : "地图数据加载失败",
        });
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [nonce]);

  const reload = React.useCallback(() => setNonce((value) => value + 1), []);
  return { europe, context, reload };
}

export function EuropeMap({
  selectedCode,
  onSelect,
  date,
  sourceByCode: sourceByCodeProp,
  className,
}: EuropeMapProps) {
  const { ref: containerRef, size } = useElementSize<HTMLDivElement>();
  const { europe, context, reload } = useEuropeLayers();

  const [hovered, setHovered] = React.useState<HoverState>(null);
  const [zoomLevel, setZoomLevel] = React.useState(1);
  const [viewNonce, setViewNonce] = React.useState(0);

  const pointerStart = React.useRef<{ x: number; y: number } | null>(null);

  const ready = size.width > 40 && size.height > 40;

  /** 投影：按容器像素尺寸把欧洲视野框 fit 进去 */
  const projection: GeoProjection | null = React.useMemo(() => {
    if (!ready) return null;
    return createEuropeProjection(size.width, size.height);
  }, [ready, size.width, size.height]);

  /**
   * ZoomableGroup 会按 projection(center) 平移，只有把「容器中心对应的经纬度」传进去，
   * 初始 transform 才是 translate(0,0)，即完全保留上面 fit 出来的构图。
   */
  const initialCenter = React.useMemo<[number, number]>(() => {
    if (!projection) return [10, 52];
    const inverted = projection.invert?.([size.width / 2, size.height / 2]);
    if (!inverted) return [10, 52];
    return [inverted[0], inverted[1]];
  }, [projection, size.width, size.height]);

  /**
   * 国家 → 数据源状态。优先用外部传入的 /api/news/sources 快照；
   * 没有该国家的记录时按「未查询」处理（不谎称是 mock）。
   */
  const sourceByCode = React.useMemo(() => sourceByCodeProp ?? {}, [sourceByCodeProp]);

  const handleMove = React.useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const code = event.currentTarget.dataset.hoverCode;
    if (!code) {
      setHovered(null);
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    setHovered({ code, x: event.clientX - rect.left, y: event.clientY - rect.top });
  }, []);

  const handlePointerDown = React.useCallback((event: React.PointerEvent) => {
    pointerStart.current = { x: event.clientX, y: event.clientY };
  }, []);

  /**
   * 用 pointerup + 位移阈值判定点击，而不是 onClick：
   * d3-zoom 会在拖拽后拦截 click 事件，pointerup 不受影响；微小手抖也不会被误判成拖拽。
   */
  const handleCountryPointerUp = React.useCallback(
    (code: string, event: React.PointerEvent) => {
      const start = pointerStart.current;
      pointerStart.current = null;
      if (start) {
        const distance = Math.hypot(event.clientX - start.x, event.clientY - start.y);
        if (distance > CLICK_MOVE_THRESHOLD) return;
      }
      onSelect(code);
      setHovered(null);
    },
    [onSelect],
  );

  const handleSurfaceClick = React.useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.target as Element;
      // 点在海洋/背景上：清空选中并关闭抽屉
      if (target.closest(".rsm-geography") || target.closest(".rsm-marker")) return;
      onSelect(null);
    },
    [onSelect],
  );

  const hoveredCountry = hovered ? getCountry(hovered.code) : undefined;
  const hoveredSource = hovered ? sourceByCode[hovered.code] : undefined;
  const hoveredPalette = SOURCE_PALETTE[newsSourceKind(hoveredSource?.dataSource)];

  return (
    <div
      ref={containerRef}
      className={cn("relative h-full w-full overflow-hidden bg-map-ocean grid-pattern", className)}
      onMouseMove={handleMove}
      onMouseLeave={() => setHovered(null)}
      onClick={handleSurfaceClick}
    >
      {europe.status === "loading" || !ready ? (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <Skeleton className="h-40 w-72 rounded-full opacity-40" />
            <span className="text-xs text-muted-foreground">正在加载欧洲地图数据…</span>
          </div>
        </div>
      ) : null}

      {europe.status === "error" ? (
        <div className="absolute inset-0 flex items-center justify-center p-6">
          <div className="flex max-w-md flex-col items-center gap-3 rounded-xl border border-dashed bg-card/60 px-6 py-8 text-center">
            <AlertTriangle className="h-6 w-6 text-destructive" />
            <p className="text-sm font-semibold">地图数据加载失败</p>
            <p className="text-xs text-muted-foreground">{europe.error}</p>
            <Button size="sm" variant="secondary" onClick={reload}>
              重新加载
            </Button>
          </div>
        </div>
      ) : null}

      {europe.status === "success" && europe.data && projection && ready ? (
        <ComposableMap
          width={size.width}
          height={size.height}
          // 传函数：RSM 会直接把它当作投影使用（d3 的 GeoProjection 本身可调用）
          projection={projection as unknown as ProjectionFunction}
          className="h-full w-full"
          role="img"
          aria-label="欧洲新闻热点地图"
        >
          <ZoomableGroup
            key={viewNonce}
            center={initialCenter}
            zoom={1}
            minZoom={1}
            maxZoom={16}
            onMoveEnd={(position) => setZoomLevel(position.zoom)}
          >
            <MapLayers
              europe={europe.data}
              context={context}
              selectedCode={selectedCode}
              hoveredCode={hovered?.code ?? null}
              sourceByCode={sourceByCode}
              onPointerDown={handlePointerDown}
              onCountryPointerUp={handleCountryPointerUp}
              onHover={(code) => {
                // 悬停状态由容器上的 mousemove 读取 dataset 统一驱动，这里只记录代码
                if (containerRef.current) containerRef.current.dataset.hoverCode = code ?? "";
              }}
              onSelect={onSelect}
            />
          </ZoomableGroup>
        </ComposableMap>
      ) : null}

      {/* 悬停提示：国家名 + 代码 + 数据源（真实 / 演示 / 未查询） */}
      {hovered && hoveredCountry ? (
        <div
          className="pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-[125%] rounded-lg border bg-popover/95 px-3 py-2 text-xs shadow-lg backdrop-blur"
          style={{
            left: Math.min(Math.max(hovered.x, 84), Math.max(size.width - 84, 84)),
            top: Math.max(hovered.y, 58),
          }}
        >
          <div className="flex items-center gap-2 font-semibold">
            <span
              className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: hoveredPalette.swatch }}
            />
            <span>{hoveredCountry.nameZh}</span>
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              {hoveredCountry.code}
            </span>
          </div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            {hoveredCountry.name}
          </div>
          <div className="mt-1 flex items-center gap-1.5 text-[11px]">
            <span
              className="rounded px-1.5 py-0.5 font-medium"
              style={{ backgroundColor: `${hoveredPalette.fill}33`, color: hoveredPalette.ring }}
            >
              {dataSourceLabel(hoveredSource?.dataSource)}
            </span>
            {hoveredSource && newsSourceKind(hoveredSource.dataSource) === "real" ? (
              <span className="text-muted-foreground">{hoveredSource.itemCount} 条</span>
            ) : null}
          </div>
          <div className="mt-1 text-[10px] text-muted-foreground/80">点击查看当日 Top 3</div>
        </div>
      ) : null}

      {/* 数据源图例：绿=真实新闻，灰=演示数据，浅=本次会话未查询 */}
      <div className="pointer-events-none absolute bottom-3 left-3 z-10 rounded-lg border bg-card/85 px-3 py-2 shadow-sm backdrop-blur">
        <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
          <MapPin className="h-3 w-3" />
          数据源
        </div>
        <div className="flex items-center gap-3">
          {SOURCE_LEGEND.map((entry) => (
            <div key={entry.kind} className="flex items-center gap-1">
              <span
                className="inline-block h-2.5 w-2.5 rounded-sm"
                style={{ backgroundColor: SOURCE_PALETTE[entry.kind].swatch }}
              />
              <span className="text-[10px] text-muted-foreground">
                {entry.emoji} {SOURCE_PALETTE[entry.kind].label}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* 操作提示 / 重置视图 */}
      <div className="absolute bottom-3 right-3 z-10 flex items-center gap-2">
        <span className="hidden rounded-md border bg-card/80 px-2 py-1 text-[10px] text-muted-foreground backdrop-blur md:inline">
          滚轮缩放 · 拖拽平移 · 点击国家
        </span>
        {zoomLevel > 1.01 ? (
          <Button
            size="sm"
            variant="secondary"
            className="h-8 gap-1.5"
            onClick={() => {
              setViewNonce((value) => value + 1);
              setZoomLevel(1);
            }}
          >
            <Maximize2 className="h-3.5 w-3.5" />
            重置视图
          </Button>
        ) : null}
      </div>
    </div>
  );
}

type MapLayersProps = {
  europe: EuropeGeoJSON;
  context: ContextGeoJSON | null;
  selectedCode: string | null;
  hoveredCode: string | null;
  /** 国家 → 数据源状态（决定填充色） */
  sourceByCode: Record<string, CountrySourceEntry>;
  onPointerDown: (event: React.PointerEvent) => void;
  onCountryPointerUp: (code: string, event: React.PointerEvent) => void;
  onHover: (code: string | null) => void;
  onSelect: (code: string) => void;
};

/**
 * 地图图层。必须是 ZoomableGroup 的子组件，
 * 这样才可以用 useZoomPanContext 拿到当前缩放系数，让描边宽度与标记半径保持屏幕尺寸恒定。
 */
function MapLayers({
  europe,
  context,
  selectedCode,
  hoveredCode,
  sourceByCode,
  onPointerDown,
  onCountryPointerUp,
  onHover,
  onSelect,
}: MapLayersProps) {
  const { k } = useZoomPanContext();

  const strokeBase = 0.6 / k;
  const markerRadius = Math.min(Math.max(5.5 / k, 1.8), 8);
  /**
   * 微型国家的点击热区半径（屏幕像素恒定，约 24px 直径）。
   * 缩放后夹在 4~14，保证任何缩放级别下都是一个舒适的可点目标。
   */
  const hotRadius = Math.min(Math.max(12 / k, 4), 14);

  /** 按数据源上色：绿=真实新闻、灰=演示数据、浅=本次会话未查询；选中=更亮的同色系，悬停=琥珀色 */
  const fillFor = (code: string) => {
    const palette = SOURCE_PALETTE[newsSourceKind(sourceByCode[code]?.dataSource)];
    if (code === selectedCode) return palette.selected;
    if (code === hoveredCode) return MAP_HOVER_COLOR;
    return palette.fill;
  };

  const noOutline = {
    default: { outline: "none" },
    hover: { outline: "none" },
    pressed: { outline: "none" },
  } as const;

  return (
    <>
      {/* 背景国家：不可交互，只提供地理参照 */}
      {context ? (
        <Geographies geography={context}>
          {({ geographies }: GeographiesArg) =>
            geographies.map((geography: Record<string, unknown>) => (
              <Geography
                key={geography.rsmKey as string}
                geography={geography}
                fill={MAP_CONTEXT_COLOR}
                stroke="hsl(222 47% 11%)"
                strokeWidth={strokeBase * 0.6}
                style={noOutline}
              />
            ))
          }
        </Geographies>
      ) : null}

      {/* 46 个欧洲国家/地区：可悬停、可点击、可键盘选中 */}
      <Geographies geography={europe}>
        {({ geographies }: GeographiesArg) =>
          geographies.map((geography: Record<string, unknown>) => {
            const feature = geography as unknown as EuropeFeature;
            const code = feature.properties.iso_a2;
            const isSelected = code === selectedCode;

            return (
              <Geography
                key={geography.rsmKey as string}
                geography={geography}
                fill={fillFor(code)}
                stroke={isSelected ? "hsl(199 89% 74%)" : MAP_STROKE_COLOR}
                strokeWidth={isSelected ? 1.6 / k : strokeBase}
                strokeLinejoin="round"
                className="cursor-pointer transition-[fill] duration-150"
                style={noOutline}
                onMouseEnter={() => onHover(code)}
                onMouseLeave={() => onHover(null)}
                onPointerDown={onPointerDown}
                onPointerUp={(event: React.PointerEvent) => onCountryPointerUp(code, event)}
                onKeyDown={(event: React.KeyboardEvent) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelect(code);
                  }
                }}
                aria-label={`${feature.properties.nameZh}（${code}）`}
              >
                <title>{`${feature.properties.nameZh}（${code}）`}</title>
              </Geography>
            );
          })
        }
      </Geographies>

      {/* 微型国家标记：真实几何太小点不到，用固定屏幕尺寸的圆点 + 透明热区保证可点击 */}
      {europe.features
        .filter((feature) => feature.properties.micro)
        .map((feature) => {
          const code = feature.properties.iso_a2;
          const isSelected = code === selectedCode;
          const isHovered = code === hoveredCode;
          const radius = isSelected || isHovered ? markerRadius * 1.3 : markerRadius;
          const palette = SOURCE_PALETTE[newsSourceKind(sourceByCode[code]?.dataSource)];
          const fill = isSelected ? palette.selected : isHovered ? MAP_HOVER_COLOR : palette.fill;

          return (
            <Marker key={`micro-${code}`} coordinates={feature.properties.capital}>
              {isSelected || isHovered ? (
                <circle
                  r={radius * 2.1}
                  fill="none"
                  stroke={isSelected ? MAP_SELECTED_COLOR : MAP_HOVER_COLOR}
                  strokeWidth={1.2 / k}
                  opacity={0.5}
                />
              ) : null}
              {/* 可见圆点：纯展示，不接收事件（事件统一交给上面的热区） */}
              <circle
                r={radius}
                fill={fill}
                stroke="hsl(222 47% 9%)"
                strokeWidth={1.1 / k}
                pointerEvents="none"
              />
              {/*
                点击热区：半径按屏幕像素恒定（≈24px 直径），
                因为 fill="transparent" 会参与命中测试而 fill="none" 不会。
                放在最后（最上层），保证小国“看得见就能点到”。
              */}
              <circle
                r={hotRadius}
                fill="transparent"
                className="cursor-pointer"
                onMouseEnter={() => onHover(code)}
                onMouseLeave={() => onHover(null)}
                onPointerDown={onPointerDown}
                onPointerUp={(event: React.PointerEvent) => onCountryPointerUp(code, event)}
                onKeyDown={(event: React.KeyboardEvent) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelect(code);
                  }
                }}
                role="button"
                tabIndex={0}
                aria-label={`${feature.properties.nameZh}（${code}）`}
              />
            </Marker>
          );
        })}
    </>
  );
}
