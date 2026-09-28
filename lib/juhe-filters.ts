/**
 * 聚合数据「国际新闻」→ 目标国家的两级过滤规则。
 *
 * 背景：聚合数据的新闻头条接口**不支持按国家查询**，只能拉 type=guoji 的国际新闻池，
 * 再自己过滤出与某个国家相关的稿件。所以这里就是「哪个国家的新闻该被算作这个国家的」的判定规则。
 *
 * ── 关于中文关键词（重要） ────────────────────────────────────────────────
 * 聚合数据是中文聚合平台，type=guoji 返回的国际新闻绝大多数是**中文稿**：
 * 标题里写的是「德国」「柏林」「朔尔茨」，而不是 "Germany"/"Berlin"/"Scholz"。
 * 因此下面在需求给的全部英文关键词之外，**补了中文国家名/首都/领导人/机构关键词**，
 * 否则英文关键词几乎永远 0 命中，接口只会一直回退 Mock。
 *
 * ── 关于匹配方式（一处刻意的收紧） ────────────────────────────────────────
 * 需求写的是「title 包含任一关键词」。但拉丁字母关键词用裸子串匹配会误伤：
 * "UK" 会命中 "Ukraine"，"IT" 会命中 "Italy"... 国别判断错比漏掉几篇严重得多。
 * 所以：纯拉丁关键词走**词边界**匹配（\bUK\b 不会命中 Ukraine），
 * 中文/含 CJK 的关键词走普通子串匹配（中文没有词边界概念）。
 */

/** 附录 A：需求给定的英文关键词（原样保留，未做增删） */
const BASE_COUNTRY_KEYWORDS: Record<string, string[]> = {
  DE: ["Germany", "German", "Berlin", "Scholz", "Bundestag", "Deutschland", "Munich", "Frankfurt"],
  FR: ["France", "French", "Paris", "Macron", "Assemblée", "Lyon", "Marseille"],
  GB: ["UK", "Britain", "British", "London", "Westminster", "Sunak", "England", "Scotland"],
  IT: ["Italy", "Italian", "Rome", "Meloni", "Milan", "Naples"],
  ES: ["Spain", "Spanish", "Madrid", "Sánchez", "Barcelona", "Catalonia"],
  PL: ["Poland", "Polish", "Warsaw", "Tusk", "Krakow", "Gdansk"],
  NL: ["Netherlands", "Dutch", "Amsterdam", "The Hague", "Rutte", "Rotterdam"],
  SE: ["Sweden", "Swedish", "Stockholm", "Kristersson", "Gothenburg"],
  NO: ["Norway", "Norwegian", "Oslo", "Støre", "Bergen"],
  FI: ["Finland", "Finnish", "Helsinki", "Orpo", "Tampere"],
  DK: ["Denmark", "Danish", "Copenhagen", "Frederiksen", "Aarhus"],
  IE: ["Ireland", "Irish", "Dublin", "Varadkar", "Cork"],
  PT: ["Portugal", "Portuguese", "Lisbon", "Costa", "Porto"],
  GR: ["Greece", "Greek", "Athens", "Mitsotakis", "Thessaloniki"],
  CZ: ["Czech", "Prague", "Fiala", "Brno", "Czechia"],
  AT: ["Austria", "Austrian", "Vienna", "Nehammer", "Salzburg"],
  CH: ["Switzerland", "Swiss", "Bern", "Zurich", "Geneva"],
  BE: ["Belgium", "Belgian", "Brussels", "De Croo", "Antwerp"],
  HU: ["Hungary", "Hungarian", "Budapest", "Orbán", "Debrecen"],
  RO: ["Romania", "Romanian", "Bucharest", "Iohannis", "Cluj"],
  BG: ["Bulgaria", "Bulgarian", "Sofia", "Denkov", "Plovdiv"],
  HR: ["Croatia", "Croatian", "Zagreb", "Plenković", "Split"],
  SK: ["Slovakia", "Slovak", "Bratislava", "Fico", "Košice"],
  SI: ["Slovenia", "Slovenian", "Ljubljana", "Golob", "Maribor"],
  RS: ["Serbia", "Serbian", "Belgrade", "Vučić", "Novi Sad"],
  UA: ["Ukraine", "Ukrainian", "Kyiv", "Zelensky", "Kharkiv", "Odesa"],
  RU: ["Russia", "Russian", "Moscow", "Putin", "Kremlin", "St Petersburg"],
  // 注意：需求附录 A 里没有 BY（白俄罗斯），本项目国家表里有，所以这里补上，否则该国永远 0 命中
  BY: ["Belarus", "Belarusian", "Minsk", "Lukashenko"],
  AL: ["Albania", "Albanian", "Tirana"],
  BA: ["Bosnia", "Sarajevo"],
  MK: ["Macedonia", "Skopje"],
  ME: ["Montenegro", "Podgorica"],
  MD: ["Moldova", "Chisinau"],
  IS: ["Iceland", "Icelandic", "Reykjavik"],
  LU: ["Luxembourg"],
  MT: ["Malta", "Valletta"],
  CY: ["Cyprus", "Nicosia"],
  EE: ["Estonia", "Tallinn"],
  LV: ["Latvia", "Riga"],
  LT: ["Lithuania", "Vilnius"],
  XK: ["Kosovo", "Pristina"],
  AD: ["Andorra"],
  LI: ["Liechtenstein"],
  MC: ["Monaco"],
  SM: ["San Marino"],
  VA: ["Vatican"],
};

/**
 * 中文关键词补充（国家名 / 首都 / 领导人 / 标志性机构）。
 * 聚合数据的国际新闻以中文稿为主，没有这一层几乎永远匹配不到。
 */
const ZH_COUNTRY_KEYWORDS: Record<string, string[]> = {
  DE: ["德国", "柏林", "朔尔茨", "默茨", "德国总理", "联邦议院", "慕尼黑", "法兰克福"],
  FR: ["法国", "巴黎", "马克龙", "法国总统", "里昂", "马赛"],
  GB: ["英国", "伦敦", "英国首相", "唐宁街", "苏格兰", "英格兰", "白金汉宫"],
  IT: ["意大利", "罗马", "梅洛尼", "米兰", "那不勒斯"],
  ES: ["西班牙", "马德里", "桑切斯", "巴塞罗那", "加泰罗尼亚"],
  PL: ["波兰", "华沙", "图斯克", "克拉科夫"],
  NL: ["荷兰", "阿姆斯特丹", "海牙", "鹿特丹"],
  SE: ["瑞典", "斯德哥尔摩", "哥德堡"],
  NO: ["挪威", "奥斯陆", "卑尔根"],
  FI: ["芬兰", "赫尔辛基", "坦佩雷"],
  DK: ["丹麦", "哥本哈根"],
  IE: ["爱尔兰", "都柏林"],
  PT: ["葡萄牙", "里斯本", "波尔图"],
  GR: ["希腊", "雅典", "塞萨洛尼基"],
  CZ: ["捷克", "布拉格"],
  AT: ["奥地利", "维也纳", "萨尔茨堡"],
  CH: ["瑞士", "伯尔尼", "苏黎世", "日内瓦"],
  BE: ["比利时", "布鲁塞尔", "安特卫普"],
  HU: ["匈牙利", "布达佩斯", "欧尔班"],
  RO: ["罗马尼亚", "布加勒斯特"],
  BG: ["保加利亚", "索非亚", "索菲亚"],
  HR: ["克罗地亚", "萨格勒布", "斯普利特"],
  SK: ["斯洛伐克", "布拉迪斯拉发", "菲佐"],
  SI: ["斯洛文尼亚", "卢布尔雅那", "马里博尔"],
  RS: ["塞尔维亚", "贝尔格莱德", "武契奇", "诺维萨德"],
  UA: ["乌克兰", "基辅", "泽连斯基", "哈尔科夫", "敖德萨"],
  RU: ["俄罗斯", "莫斯科", "普京", "克里姆林宫", "圣彼得堡", "俄军", "俄乌"],
  BY: ["白俄罗斯", "明斯克", "卢卡申科"],
  AL: ["阿尔巴尼亚", "地拉那"],
  BA: ["波黑", "萨拉热窝"],
  MK: ["北马其顿", "斯科普里", "马其顿"],
  ME: ["黑山", "波德戈里察"],
  MD: ["摩尔多瓦", "基希讷乌"],
  IS: ["冰岛", "雷克雅未克"],
  LU: ["卢森堡"],
  MT: ["马耳他", "瓦莱塔"],
  CY: ["塞浦路斯", "尼科西亚"],
  EE: ["爱沙尼亚", "塔林"],
  LV: ["拉脱维亚", "里加"],
  LT: ["立陶宛", "维尔纽斯"],
  XK: ["科索沃", "普里什蒂纳"],
  AD: ["安道尔"],
  LI: ["列支敦士登"],
  MC: ["摩纳哥"],
  SM: ["圣马力诺"],
  VA: ["梵蒂冈", "教皇", "教宗", "方济各"],
};

/** 最终使用的关键词表 = 需求给的英文关键词 + 中文补充（同一国家的关键词合并去重） */
export const COUNTRY_KEYWORDS: Record<string, string[]> = Object.fromEntries(
  Object.entries(BASE_COUNTRY_KEYWORDS).map(([code, words]) => [
    code,
    [...new Set([...(ZH_COUNTRY_KEYWORDS[code] ?? []), ...words])],
  ]),
);

/** 附录 B：需求给定的主流媒体域名（原样保留） */
export const COUNTRY_DOMAINS: Record<string, string[]> = {
  DE: ["spiegel.de", "zeit.de", "faz.net", "sueddeutsche.de", "welt.de", "handelsblatt.com", "dw.com"],
  FR: ["lemonde.fr", "lefigaro.fr", "liberation.fr", "france24.com", "rfi.fr"],
  GB: ["bbc.co.uk", "theguardian.com", "telegraph.co.uk", "skynews.com", "independent.co.uk"],
  IT: ["corriere.it", "repubblica.it", "ansa.it", "lastampa.it"],
  ES: ["elpais.com", "elmundo.es", "abc.es", "lavanguardia.com"],
  PL: ["wyborcza.pl", "rp.pl", "fakt.pl", "polityka.pl"],
  NL: ["nrc.nl", "telegraaf.nl", "volkskrant.nl", "ad.nl"],
  SE: ["dn.se", "svd.se", "aftonbladet.se", "expressen.se"],
  NO: ["vg.no", "aftenposten.no", "nrk.no", "dagbladet.no"],
  FI: ["hs.fi", "yle.fi", "is.fi", "iltalehti.fi"],
  DK: ["politiken.dk", "berlingske.dk", "jyllands-posten.dk", "dr.dk"],
  IE: ["irishtimes.com", "independent.ie", "rte.ie"],
  PT: ["publico.pt", "dn.pt", "expresso.pt"],
  GR: ["kathimerini.gr", "tovima.gr", "naftemporiki.gr"],
  CZ: ["idnes.cz", "lidovky.cz", "aktualne.cz"],
  AT: ["derstandard.at", "diepresse.com", "kurier.at", "orf.at"],
  CH: ["nzz.ch", "tagesanzeiger.ch", "swissinfo.ch"],
  BE: ["standaard.be", "lesoir.be", "hln.be", "rtbf.be"],
  HU: ["index.hu", "origo.hu", "nepszava.hu"],
  RO: ["adevarul.ro", "digi24.ro", "hotnews.ro"],
  BG: ["dnevnik.bg", "24chasa.bg", "novinite.com"],
  HR: ["jutarnji.hr", "vecernji.hr", "index.hr"],
  SK: ["sme.sk", "pravda.sk", "aktuality.sk"],
  SI: ["delo.si", "dnevnik.si", "rtvslo.si"],
  RS: ["politika.rs", "b92.net", "blic.rs"],
  UA: ["kyivpost.com", "pravda.com.ua", "unian.info"],
  RU: ["rt.com", "tass.com", "themoscowtimes.com"],
  // 同样补上需求附录 B 缺失的白俄罗斯主流媒体域名
  BY: ["belta.by", "onliner.by", "nashaniva.com"],
};

/** 聚合数据新闻条目（只列本项目用到的字段） */
export type JuheArticle = {
  uniquekey?: string;
  title?: string;
  date?: string;
  category?: string;
  author_name?: string;
  url?: string;
  thumbnail_pic_s?: string;
  is_content?: string;
};

export type JuheQueryMode = "keyword" | "domain" | "both" | "mock";

export type JuheMatch = {
  article: JuheArticle;
  /** 命中的关键词（第一级） */
  keyword: string | null;
  /** 命中的域名（第二级） */
  domain: string | null;
};

const hasCjk = (text: string) => /[\u3400-\u9fff\uf900-\ufaff]/.test(text);

/**
 * 关键词匹配：返回命中的关键词（用于诊断），未命中返回 null。
 * 拉丁关键词用词边界，CJK 关键词用子串。
 */
export function matchKeyword(title: string, keywords: string[]): string | null {
  if (!title) return null;
  const lowerTitle = title.toLowerCase();
  for (const keyword of keywords) {
    if (!keyword) continue;
    const lowerKeyword = keyword.toLowerCase();
    if (hasCjk(keyword)) {
      if (title.includes(keyword)) return keyword;
    } else {
      // 允许关键词里带空格/连字符（如 "St Petersburg"、"De Croo"）
      const escaped = lowerKeyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i");
      if (pattern.test(lowerTitle)) return keyword;
    }
  }
  return null;
}

/** 域名匹配：url 或 author_name 里出现任一域名即命中 */
export function matchDomain(
  article: Pick<JuheArticle, "url" | "author_name">,
  domains: string[],
): string | null {
  const haystack = `${article.url ?? ""} ${article.author_name ?? ""}`.toLowerCase();
  if (!haystack.trim()) return null;
  for (const domain of domains) {
    if (domain && haystack.includes(domain.toLowerCase())) return domain;
  }
  return null;
}

/** 把日期串解析成时间戳（"2026-09-27 08:47:15"；解析失败返回 0，排到最后） */
export function parseJuheDate(value: string | undefined | null): number {
  if (!value) return 0;
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(value.trim());
  if (match) {
    const [, year, month, day, hour, minute, second] = match;
    // 聚合数据给的是「北京时间」的墙上时间，没有时区；按本地时间解析即可保证排序与显示一致
    return new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
    ).getTime();
  }
  const fallback = Date.parse(value);
  return Number.isNaN(fallback) ? 0 : fallback;
}

/** "2026-09-27 08:47:15" → "2026-09-27T08:47:15"（保留同样的墙上时间，且是合法 ISO 串） */
export function toIsoLocalDateTime(value: string | undefined | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(trimmed);
  if (match) return `${match[1]}T${match[2]}`;
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

/**
 * 两级过滤 + 合并去重 + 按时间倒序。
 *
 * @param articles 国际新闻池
 * @param countryCode ISO alpha-2
 * @param options.strictDate 只保留「date 落在指定日期」的稿件（默认关闭）
 */
export function filterJuheArticles(
  articles: JuheArticle[],
  countryCode: string,
  options: { strictDate?: string } = {},
): { matches: JuheMatch[]; queryMode: Exclude<JuheQueryMode, "mock"> | null } {
  const code = (countryCode ?? "").trim().toUpperCase();
  const keywords = COUNTRY_KEYWORDS[code] ?? [];
  const domains = COUNTRY_DOMAINS[code] ?? [];

  const byKey = new Map<string, JuheMatch>();
  const order: string[] = [];

  for (const article of articles) {
    const keyword = matchKeyword(String(article.title ?? ""), keywords);
    const domain = matchDomain(article, domains);
    if (!keyword && !domain) continue;

    // 指定日期时只保留当天的稿件（聚合数据只有当前新闻池，历史日期不该拿今天新闻冒充）
    if (options.strictDate) {
      const datePart = String(article.date ?? "").slice(0, 10);
      if (datePart !== options.strictDate) continue;
    }

    const key =
      article.uniquekey?.trim() ||
      `${article.url ?? ""}|${article.title ?? ""}` ||
      `${byKey.size}`;
    if (byKey.has(key)) continue;
    byKey.set(key, { article, keyword, domain });
    order.push(key);
  }

  const matches = order
    .map((key) => byKey.get(key)!)
    .sort((a, b) => parseJuheDate(b.article.date) - parseJuheDate(a.article.date));

  if (matches.length === 0) return { matches, queryMode: null };

  const anyKeyword = matches.some((match) => match.keyword !== null);
  const anyDomain = matches.some((match) => match.domain !== null);
  const queryMode = anyKeyword && anyDomain ? "both" : anyKeyword ? "keyword" : "domain";
  return { matches, queryMode };
}

/** 调试/自检用：某个国家的规则概览 */
export function describeCountryRules(countryCode: string) {
  const code = (countryCode ?? "").trim().toUpperCase();
  return {
    country: code,
    keywords: COUNTRY_KEYWORDS[code] ?? [],
    domains: COUNTRY_DOMAINS[code] ?? [],
  };
}
