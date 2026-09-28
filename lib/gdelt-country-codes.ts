/**
 * ISO 3166-1 alpha-2 → FIPS 10-4 映射。
 *
 * GDELT 的地理/来源国家过滤（`locationcc:` / `sourcecountry:`）使用 FIPS 10-4 代码，
 * **不是** ISO alpha-2：德国是 GM 不是 DE，英国是 UK 不是 GB，捷克是 EZ 不是 CZ。
 * 因此凡是把本项目的国家代码交给 GDELT 的地方，都必须先过这张表。
 *
 * 缺失国家一律「查不到就不猜」：`toFipsCode()` 返回 null，调用方据此走兜底，
 * 绝不退化成把 ISO 代码直接丢给 GDELT（那样会静默查到错误的国家）。
 */
export const GDELT_COUNTRY_CODES: Record<string, string> = {
  AL: "AL",
  AD: "AN",
  AT: "AU",
  BY: "BO",
  BE: "BE",
  BA: "BK",
  BG: "BU",
  HR: "HR",
  CY: "CY",
  CZ: "EZ",
  DK: "DA",
  EE: "EN",
  FI: "FI",
  FR: "FR",
  DE: "GM",
  GR: "GR",
  HU: "HU",
  IS: "IC",
  IE: "EI",
  IT: "IT",
  XK: "KV",
  LV: "LG",
  LI: "LS",
  LT: "LH",
  LU: "LU",
  MT: "MT",
  MD: "MD",
  MC: "MN",
  ME: "MJ",
  NL: "NL",
  MK: "MK",
  NO: "NO",
  PL: "PL",
  PT: "PO",
  RO: "RO",
  RU: "RS",
  SM: "SM",
  RS: "RI",
  SK: "LO",
  SI: "SI",
  ES: "SP",
  SE: "SW",
  CH: "SZ",
  UA: "UP",
  GB: "UK",
  VA: "VT",
};

/** ISO alpha-2（大小写不敏感）→ FIPS 10-4；无映射返回 null */
export function toFipsCode(isoAlpha2: string | null | undefined): string | null {
  if (!isoAlpha2) return null;
  const key = isoAlpha2.trim().toUpperCase();
  return GDELT_COUNTRY_CODES[key] ?? null;
}

/** 反向查询：FIPS → ISO alpha-2（调试与日志用） */
export function toIsoAlpha2(fips: string | null | undefined): string | null {
  if (!fips) return null;
  const key = fips.trim().toUpperCase();
  const found = Object.entries(GDELT_COUNTRY_CODES).find(([, value]) => value === key);
  return found ? found[0] : null;
}

/** 映射表覆盖的国家数量（自检用） */
export const GDELT_COUNTRY_CODE_COUNT = Object.keys(GDELT_COUNTRY_CODES).length;
