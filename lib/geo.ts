import { geoArea, geoAzimuthalEqualArea, type GeoProjection } from "d3-geo";
import type { Feature, FeatureCollection, Geometry, Position } from "geojson";

/** public/geo/europe.geojson 中每个要素的属性 */
export type EuropeFeatureProperties = {
  /** ISO 3166-1 alpha-2 */
  iso_a2: string;
  iso_n3: string;
  name: string;
  nameZh: string;
  /** 首都/中心点 [lon, lat] */
  capital: [number, number];
  /** 是否为微型国家（安道尔/列支敦士登/摩纳哥/马耳他/圣马力诺/梵蒂冈） */
  micro: boolean;
  /** 经纬度跨度（度），越小国家越小 */
  span: number;
  centroid: [number, number];
  /** true 表示按首都坐标生成的兜底多边形 */
  synthetic: boolean;
};

export type EuropeFeature = Feature<Geometry, EuropeFeatureProperties>;

/** 背景图层（土耳其、高加索、北非等非目标国家）的要素属性 */
export type ContextFeatureProperties = { name: string; context?: boolean };
export type ContextFeature = Feature<Geometry, ContextFeatureProperties>;

export type EuropeGeoJSON = FeatureCollection<Geometry, EuropeFeatureProperties>;
export type ContextGeoJSON = FeatureCollection<Geometry, ContextFeatureProperties>;

/**
 * 视野框：经度 -25°..45°、纬度 33°..72°。
 * 用固定框而不是「对所有国家求包围盒」来做适配，原因：
 *  - 俄罗斯东西横跨 180°，挪威含斯瓦尔巴（北纬 80°），法国/荷兰/葡萄牙含海外领地，
 *    直接对数据求 bounds 会把整个欧洲压成一个小点；
 *  - 固定框在任何屏幕尺寸下都稳定，投影随容器尺寸重新 fit。
 */
export const EUROPE_FRAME = { minLon: -25, maxLon: 45, minLat: 33, maxLat: 72 } as const;

/**
 * 生成用于 fitExtent 的「视野框多边形」。
 * 边缘按 1° 采样：方位投影下经纬度矩形的边是曲线，采样后才能得到准确的包围盒。
 *
 * ⚠️ 绕向是关键：d3-geo 对球面多边形按右手法则判定内外，
 * 绕向反了会被理解成「整个地球挖掉这个框」的补集，
 * fitExtent 就会把大半个球面塞进画布 —— 现象是整张欧洲地图缩小约 6 倍
 * （实测德国只剩 31×34 px、卢森堡 3×3 px），小国自然点不到。
 * 这里不靠人脑记方向，直接用 geoArea 判：球面面积超过半个地球（2π）就反转。
 */
export function createEuropeFrame(): FeatureCollection {
  const { minLon, maxLon, minLat, maxLat } = EUROPE_FRAME;
  const ring: Position[] = [];
  const step = 1;

  for (let lon = minLon; lon <= maxLon; lon += step) ring.push([lon, minLat]);
  for (let lat = minLat; lat <= maxLat; lat += step) ring.push([maxLon, lat]);
  for (let lon = maxLon; lon >= minLon; lon -= step) ring.push([lon, maxLat]);
  for (let lat = maxLat; lat >= minLat; lat -= step) ring.push([minLon, lat]);
  ring.push([minLon, minLat]);

  if (geoArea({ type: "Polygon", coordinates: [ring] } as never) > 2 * Math.PI) {
    ring.reverse();
  }

  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {},
        geometry: { type: "Polygon", coordinates: [ring] },
      },
    ],
  };
}

const FRAME = createEuropeFrame();

/**
 * 按容器像素尺寸构建欧洲投影。
 * 使用 azimuthalEqualArea + clipAngle(90)：欧洲全境都在中心 30° 范围内，
 * 裁掉另外半球可以避免俄罗斯远东西伯利亚/海外领地在边缘产生的投影畸变。
 */
export function createEuropeProjection(width: number, height: number, padding = 26): GeoProjection {
  const projection = geoAzimuthalEqualArea().clipAngle(89.5);
  projection.fitExtent(
    [
      [padding, padding],
      [Math.max(padding + 1, width - padding), Math.max(padding + 1, height - padding)],
    ],
    FRAME as never,
  );
  return projection;
}

async function fetchGeoJSON<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`加载地图数据失败：${url}（HTTP ${response.status}）`);
  }
  return (await response.json()) as T;
}

export function loadEuropeGeoJSON(signal?: AbortSignal): Promise<EuropeGeoJSON> {
  return fetchGeoJSON<EuropeGeoJSON>("/geo/europe.geojson", signal);
}

export function loadContextGeoJSON(signal?: AbortSignal): Promise<ContextGeoJSON> {
  return fetchGeoJSON<ContextGeoJSON>("/geo/europe-context.geojson", signal);
}
