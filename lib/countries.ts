/**
 * 欧洲国家/地区注册表（ISO 3166-1 alpha-2）。
 *
 * 这是整个应用的唯一事实来源：
 *  - API 用它校验 country 参数
 *  - MockProvider 用它生成中文国名
 *  - GeoJSON 构建脚本用它把 Natural Earth 的要素映射成 alpha-2
 *  - 地图用 capital 坐标为微型国家（安道尔/列支敦士登/摩纳哥/圣马力诺/梵蒂冈/马耳他）
 *    生成兜底多边形与可点击标记
 */

export type CountryMeta = {
  /** ISO 3166-1 alpha-2 */
  code: string;
  /** ISO 3166-1 numeric（科索沃在 Natural Earth 中为 -99） */
  numeric: string;
  /** 英文名 */
  name: string;
  /** 中文名 */
  nameZh: string;
  /** 首都/中心点坐标 [lon, lat] */
  capital: [number, number];
  /** 兼容 Natural Earth / world-atlas 中的不同写法 */
  aliases?: string[];
};

export const EUROPE_COUNTRIES: CountryMeta[] = [
  { code: "AL", numeric: "008", name: "Albania", nameZh: "阿尔巴尼亚", capital: [19.8187, 41.3275] },
  { code: "AD", numeric: "020", name: "Andorra", nameZh: "安道尔", capital: [1.5218, 42.5063] },
  { code: "AT", numeric: "040", name: "Austria", nameZh: "奥地利", capital: [16.3738, 48.2082] },
  { code: "BY", numeric: "112", name: "Belarus", nameZh: "白俄罗斯", capital: [27.5615, 53.9023] },
  { code: "BE", numeric: "056", name: "Belgium", nameZh: "比利时", capital: [4.3517, 50.8503] },
  {
    code: "BA",
    numeric: "070",
    name: "Bosnia and Herzegovina",
    nameZh: "波黑",
    capital: [18.4131, 43.8563],
    aliases: ["Bosnia and Herz.", "Bosnia Herzegovina", "Bosnia and Herz"],
  },
  { code: "BG", numeric: "100", name: "Bulgaria", nameZh: "保加利亚", capital: [23.3219, 42.6977] },
  { code: "HR", numeric: "191", name: "Croatia", nameZh: "克罗地亚", capital: [15.9819, 45.815] },
  { code: "CY", numeric: "196", name: "Cyprus", nameZh: "塞浦路斯", capital: [33.3823, 35.1856] },
  { code: "CZ", numeric: "203", name: "Czechia", nameZh: "捷克", capital: [14.4378, 50.0755], aliases: ["Czech Republic", "Czech Rep."] },
  { code: "DK", numeric: "208", name: "Denmark", nameZh: "丹麦", capital: [12.5683, 55.6761] },
  { code: "EE", numeric: "233", name: "Estonia", nameZh: "爱沙尼亚", capital: [24.7536, 59.437] },
  { code: "FI", numeric: "246", name: "Finland", nameZh: "芬兰", capital: [24.9384, 60.1699] },
  { code: "FR", numeric: "250", name: "France", nameZh: "法国", capital: [2.3522, 48.8566] },
  { code: "DE", numeric: "276", name: "Germany", nameZh: "德国", capital: [13.405, 52.52] },
  { code: "GR", numeric: "300", name: "Greece", nameZh: "希腊", capital: [23.7275, 37.9838] },
  { code: "HU", numeric: "348", name: "Hungary", nameZh: "匈牙利", capital: [19.0402, 47.4979] },
  { code: "IS", numeric: "352", name: "Iceland", nameZh: "冰岛", capital: [-21.8277, 64.1265] },
  { code: "IE", numeric: "372", name: "Ireland", nameZh: "爱尔兰", capital: [-6.2603, 53.3498] },
  { code: "IT", numeric: "380", name: "Italy", nameZh: "意大利", capital: [12.4964, 41.9028] },
  {
    code: "XK",
    numeric: "-99",
    name: "Kosovo",
    nameZh: "科索沃",
    capital: [21.1655, 42.6629],
    aliases: ["Republic of Kosovo", "Kosovo and Metohija"],
  },
  { code: "LV", numeric: "428", name: "Latvia", nameZh: "拉脱维亚", capital: [24.1052, 56.9496] },
  { code: "LI", numeric: "438", name: "Liechtenstein", nameZh: "列支敦士登", capital: [9.5215, 47.141] },
  { code: "LT", numeric: "440", name: "Lithuania", nameZh: "立陶宛", capital: [25.2797, 54.6872] },
  { code: "LU", numeric: "442", name: "Luxembourg", nameZh: "卢森堡", capital: [6.1296, 49.6116] },
  { code: "MT", numeric: "470", name: "Malta", nameZh: "马耳他", capital: [14.5146, 35.8989] },
  {
    code: "MD",
    numeric: "498",
    name: "Moldova",
    nameZh: "摩尔多瓦",
    capital: [28.8638, 47.0105],
    aliases: ["Republic of Moldova"],
  },
  { code: "MC", numeric: "492", name: "Monaco", nameZh: "摩纳哥", capital: [7.4246, 43.7384] },
  { code: "ME", numeric: "499", name: "Montenegro", nameZh: "黑山", capital: [19.2636, 42.4304] },
  { code: "NL", numeric: "528", name: "Netherlands", nameZh: "荷兰", capital: [4.9041, 52.3676] },
  {
    code: "MK",
    numeric: "807",
    name: "North Macedonia",
    nameZh: "北马其顿",
    capital: [21.4254, 41.9981],
    aliases: ["Macedonia", "Republic of North Macedonia"],
  },
  { code: "NO", numeric: "578", name: "Norway", nameZh: "挪威", capital: [10.7522, 59.9139] },
  { code: "PL", numeric: "616", name: "Poland", nameZh: "波兰", capital: [21.0122, 52.2297] },
  { code: "PT", numeric: "620", name: "Portugal", nameZh: "葡萄牙", capital: [-9.1393, 38.7223] },
  { code: "RO", numeric: "642", name: "Romania", nameZh: "罗马尼亚", capital: [26.1025, 44.4268] },
  {
    code: "RU",
    numeric: "643",
    name: "Russia",
    nameZh: "俄罗斯",
    capital: [37.6173, 55.7558],
    aliases: ["Russian Federation"],
  },
  { code: "SM", numeric: "674", name: "San Marino", nameZh: "圣马力诺", capital: [12.4578, 43.9424] },
  {
    code: "RS",
    numeric: "688",
    name: "Serbia",
    nameZh: "塞尔维亚",
    capital: [20.4489, 44.7866],
    aliases: ["Republic of Serbia"],
  },
  { code: "SK", numeric: "703", name: "Slovakia", nameZh: "斯洛伐克", capital: [17.1077, 48.1486] },
  { code: "SI", numeric: "705", name: "Slovenia", nameZh: "斯洛文尼亚", capital: [14.5058, 46.0569] },
  { code: "ES", numeric: "724", name: "Spain", nameZh: "西班牙", capital: [-3.7038, 40.4168] },
  { code: "SE", numeric: "752", name: "Sweden", nameZh: "瑞典", capital: [18.0686, 59.3293] },
  { code: "CH", numeric: "756", name: "Switzerland", nameZh: "瑞士", capital: [7.4474, 46.948] },
  { code: "UA", numeric: "804", name: "Ukraine", nameZh: "乌克兰", capital: [30.5234, 50.4501] },
  {
    code: "GB",
    numeric: "826",
    name: "United Kingdom",
    nameZh: "英国",
    capital: [-0.1276, 51.5074],
    aliases: ["United Kingdom of Great Britain and Northern Ireland", "Great Britain", "England"],
  },
  {
    code: "VA",
    numeric: "336",
    name: "Vatican",
    nameZh: "梵蒂冈",
    capital: [12.4534, 41.9029],
    aliases: ["Vatican City", "Holy See", "Vatican City State"],
  },
];

/** 面积/尺寸过小、在地图整体缩放下几乎不可点的小国 —— 需要额外的可点击标记 */
export const MICRO_STATE_CODES = ["AD", "LI", "MC", "MT", "SM", "VA"] as const;

export const EUROPE_COUNTRY_CODES: string[] = EUROPE_COUNTRIES.map((c) => c.code);

const BY_CODE = new Map<string, CountryMeta>(EUROPE_COUNTRIES.map((c) => [c.code, c]));
const BY_NUMERIC = new Map<string, CountryMeta>(
  EUROPE_COUNTRIES.filter((c) => c.numeric !== "-99").map((c) => [c.numeric, c]),
);

/** 名称归一化：去音标、去标点、转小写，便于匹配 Natural Earth 的各种写法 */
export function normalizeCountryName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

const BY_NAME = new Map<string, CountryMeta>();
for (const country of EUROPE_COUNTRIES) {
  BY_NAME.set(normalizeCountryName(country.name), country);
  BY_NAME.set(normalizeCountryName(country.nameZh), country);
  for (const alias of country.aliases ?? []) {
    BY_NAME.set(normalizeCountryName(alias), country);
  }
}

export function getCountry(code: string | null | undefined): CountryMeta | undefined {
  if (!code) return undefined;
  return BY_CODE.get(code.trim().toUpperCase());
}

export function isSupportedCountry(code: string | null | undefined): boolean {
  return getCountry(code) !== undefined;
}

export function getCountryByNumeric(numeric: string | number | null | undefined): CountryMeta | undefined {
  if (numeric === null || numeric === undefined) return undefined;
  return BY_NUMERIC.get(String(numeric));
}

export function getCountryByName(name: string | null | undefined): CountryMeta | undefined {
  if (!name) return undefined;
  return BY_NAME.get(normalizeCountryName(name));
}

export function isMicroState(code: string): boolean {
  return (MICRO_STATE_CODES as readonly string[]).includes(code);
}
