#!/usr/bin/env node
/**
 * 生成欧洲地图数据。
 *
 *   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/build-geo.mts
 *   （或 npm run geo:build）
 *
 * 输入：node_modules/world-atlas/countries-50m.json（Natural Earth 1:50m 的 TopoJSON）
 * 输出：
 *   public/geo/europe.geojson          46 个欧洲国家/地区，带 ISO_A2 属性，可交互
 *   public/geo/europe-context.geojson  周边非目标国家（土耳其、高加索、北非等），仅作背景
 *
 * 关键点：
 *  1. world-atlas 的要素 id 是 ISO 3166-1 numeric（部分要素为 -99），因此用
 *     「名称优先、numeric 兜底」的方式映射到 alpha-2，避免 Natural Earth 里
 *     France / Norway / Kosovo 等 id 异常导致漏国。
 *  2. 1:50m 分辨率仍然缺失/极小的小国（摩纳哥、梵蒂冈等），脚本会用首都坐标生成
 *     一个可见的兜底多边形，保证「小国也能点击且有 Mock 数据」。
 *  3. 任一个目标国家缺失都会直接报错退出，避免产出不完整的地图数据。
 */

import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { geoBounds, geoCentroid } from "d3-geo";
// @ts-expect-error topojson-client 运行时由 node 直接加载，不参与 next 的类型检查
import { feature } from "topojson-client";

import {
  EUROPE_COUNTRIES,
  MICRO_STATE_CODES,
  getCountryByName,
  getCountryByNumeric,
} from "../lib/countries.ts";

type Position = [number, number];

type OutputFeature = {
  type: "Feature";
  id: string;
  properties: Record<string, unknown>;
  geometry: unknown;
};

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
const outDir = join(projectRoot, "public", "geo");

/** 微型国家的兜底多边形半径（度）。比真实面积略大，保证在整体视野下可见 */
const MICRO_RADIUS_DEG: Record<string, number> = {
  VA: 0.09,
  MC: 0.1,
  SM: 0.12,
  LI: 0.14,
  AD: 0.16,
  MT: 0.18,
};

/** 背景国家（非目标国家）保留的经纬度窗口：以欧洲为中心 */
const CONTEXT_WINDOW = { minLon: -32, maxLon: 56, minLat: 24, maxLat: 75 };

function resolveAtlasPath(): string {
  try {
    return require.resolve("world-atlas/countries-50m.json");
  } catch {
    return join(projectRoot, "node_modules", "world-atlas", "countries-50m.json");
  }
}

function roundCoords(value: unknown, precision = 4): unknown {
  if (typeof value === "number") return Number(value.toFixed(precision));
  if (Array.isArray(value)) return value.map((item) => roundCoords(item, precision));
  return value;
}

/** 以 center 为圆心生成一个正 n 边形（用于缺失的小国兜底） */
function circlePolygon(center: Position, radiusDeg: number, steps = 24): Position[] {
  const [lon, lat] = center;
  const lonScale = Math.cos((lat * Math.PI) / 180) || 1;
  const ring: Position[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const angle = (i / steps) * Math.PI * 2;
    ring.push([
      Number((lon + (radiusDeg * Math.cos(angle)) / lonScale).toFixed(4)),
      Number((lat + radiusDeg * Math.sin(angle)).toFixed(4)),
    ]);
  }
  return ring;
}

function main() {
  const atlasPath = resolveAtlasPath();
  const topology = JSON.parse(readFileSync(atlasPath, "utf8")) as {
    objects: Record<string, unknown>;
  };

  const objectKey = Object.keys(topology.objects)[0];
  const collection = feature(topology as never, topology.objects[objectKey] as never) as {
    features: Array<{
      type: "Feature";
      id?: string | number;
      properties?: Record<string, unknown>;
      geometry: unknown;
    }>;
  };

  console.log(`读取 ${atlasPath}`);
  console.log(`源要素数量：${collection.features.length}（objects.${objectKey}）`);

  const interactive = new Map<string, OutputFeature>();
  const context: OutputFeature[] = [];
  const matchedBy: Record<string, "name" | "numeric" | "missing"> = {};
  let skipped99 = 0;

  for (const item of collection.features) {
    const name = String(item.properties?.name ?? "").trim();
    const numeric = item.id === undefined || item.id === null ? "" : String(item.id).trim();
    if (numeric === "-99" || numeric === "0") skipped99 += 1;

    const target = getCountryByName(name) ?? getCountryByNumeric(numeric);

    if (target) {
      const bounds = geoBounds(item as never) as [[number, number], [number, number]];
      const centroid = geoCentroid(item as never) as Position;
      const span = Math.max(
        Math.abs(bounds[1][0] - bounds[0][0]),
        Math.abs(bounds[1][1] - bounds[0][1]),
      );
      interactive.set(target.code, {
        type: "Feature",
        id: target.code,
        properties: {
          iso_a2: target.code,
          iso_n3: target.numeric,
          name: target.name,
          nameZh: target.nameZh,
          capital: target.capital,
          micro: (MICRO_STATE_CODES as readonly string[]).includes(target.code),
          // 该要素的经纬度跨度（度），越小说明国家越小，前端据此决定是否额外画可点标记
          span: Number(span.toFixed(4)),
          centroid: [Number(centroid[0].toFixed(4)), Number(centroid[1].toFixed(4))],
          synthetic: false,
        },
        geometry: { type: item.geometry ? (item.geometry as { type: string }).type : "Polygon", coordinates: roundCoords((item.geometry as { coordinates: unknown }).coordinates) },
      });
      matchedBy[target.code] = getCountryByName(name) ? "name" : "numeric";
      continue;
    }

    // 非目标国家：落在欧洲窗口内的作为背景图层
    const centroid = geoCentroid(item as never) as Position;
    const inWindow =
      centroid[0] >= CONTEXT_WINDOW.minLon &&
      centroid[0] <= CONTEXT_WINDOW.maxLon &&
      centroid[1] >= CONTEXT_WINDOW.minLat &&
      centroid[1] <= CONTEXT_WINDOW.maxLat;
    if (inWindow && item.geometry) {
      context.push({
        type: "Feature",
        id: name || numeric || "context",
        properties: { name, context: true },
        geometry: {
          type: (item.geometry as { type: string }).type,
          coordinates: roundCoords((item.geometry as { coordinates: unknown }).coordinates),
        },
      });
    }
  }

  // ---- 兜底：源数据里缺失（或过小）的目标国家 ----
  const missing = EUROPE_COUNTRIES.filter((country) => !interactive.has(country.code));
  for (const country of missing) {
    const radius = MICRO_RADIUS_DEG[country.code] ?? 0.2;
    interactive.set(country.code, {
      type: "Feature",
      id: country.code,
      properties: {
        iso_a2: country.code,
        iso_n3: country.numeric,
        name: country.name,
        nameZh: country.nameZh,
        capital: country.capital,
        micro: true,
        span: Number((radius * 2).toFixed(4)),
        centroid: country.capital,
        // true 表示这个多边形是按首都坐标生成的兜底形状，不是真实边界
        synthetic: true,
      },
      geometry: { type: "Polygon", coordinates: [circlePolygon(country.capital, radius)] },
    });
    matchedBy[country.code] = "missing";
  }

  const features = EUROPE_COUNTRIES.map((country) => interactive.get(country.code)).filter(
    (item): item is OutputFeature => Boolean(item),
  );

  // ---- 校验：46/46 全覆盖 ----
  const missingCodes = EUROPE_COUNTRIES.filter((country) => !interactive.has(country.code)).map(
    (country) => country.code,
  );
  if (missingCodes.length > 0 || features.length !== EUROPE_COUNTRIES.length) {
    console.error(`❌ 地图数据不完整，缺失：${missingCodes.join(", ")}`);
    process.exit(1);
  }

  mkdirSync(outDir, { recursive: true });

  const europeCollection = {
    type: "FeatureCollection",
    metadata: {
      generatedBy: "scripts/build-geo.mts",
      source: "world-atlas/countries-50m.json (Natural Earth 1:50m)",
      generatedAt: new Date().toISOString(),
      countryCount: features.length,
      note: "properties.iso_a2 为 ISO 3166-1 alpha-2；properties.synthetic=true 表示按首都坐标生成的兜底多边形",
    },
    features,
  };

  const contextCollection = {
    type: "FeatureCollection",
    metadata: { source: "world-atlas/countries-50m.json", purpose: "非目标国家背景图层" },
    features: context,
  };

  const europePath = join(outDir, "europe.geojson");
  const contextPath = join(outDir, "europe-context.geojson");
  writeFileSync(europePath, JSON.stringify(europeCollection), "utf8");
  writeFileSync(contextPath, JSON.stringify(contextCollection), "utf8");

  // ---- 报告 ----
  const byName = Object.entries(matchedBy).filter(([, v]) => v === "name").length;
  const byNumeric = Object.entries(matchedBy).filter(([, v]) => v === "numeric").length;
  const synthetic = features.filter((f) => f.properties.synthetic === true);
  const microList = features
    .filter((f) => f.properties.micro === true)
    .map((f) => `${f.properties.iso_a2}${f.properties.synthetic ? "(兜底)" : ""}`);

  console.log("");
  console.log(`✅ 目标国家命中：${features.length}/${EUROPE_COUNTRIES.length}（名称匹配 ${byName}，numeric 匹配 ${byNumeric}）`);
  console.log(`   背景国家：${context.length}`);
  console.log(`   -99/numeric 异常要素：${skipped99}（已用名称映射兜住）`);
  console.log(`   微型国家：${microList.join(", ")}`);
  console.log(`   生成兜底多边形：${synthetic.length ? synthetic.map((f) => f.properties.iso_a2).join(", ") : "无"}`);
  console.log(`   输出：${europePath}`);
  console.log(`   输出：${contextPath}`);
  const sample = features.find((f) => f.properties.iso_a2 === "DE");
  console.log(`   抽查 DE：${JSON.stringify(sample?.properties)}`);
}

main();
