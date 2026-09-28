# 欧洲每日新闻热点地图

> 覆盖 **46 个欧洲国家/地区**的交互式新闻热度看板：悬停高亮国家、点击即看当日 Top 3 热点，支持按日期回溯。
> 地图按数据源上色——**绿色 = 真实新闻**（聚合数据中文国际报道 / GDELT），**灰色 = 演示数据**，
> 一眼看出哪些国家真有新闻。Next.js 14 App Router + TypeScript + Tailwind + shadcn/ui + react-simple-maps + d3-geo。

覆盖 **46 个欧洲国家/地区**（ISO 3166-1 alpha-2）的每日新闻热点地图：点选国家即可查看当天的 Top 3 热点新闻，支持按日期切换，桌面端为右侧抽屉、移动端为底部抽屉。

> **数据源可切换**（`NEWS_PROVIDER`，见下文「数据源」一节）：
> - `mock`（默认）：本项目的 MockProvider，零外网依赖、数据完全确定
> - `juhe`：聚合数据「新闻头条」国际新闻池，关键词 + 来源域名两级过滤
> - `gdelt`：GDELT DOC 2.0 公开 API 的真实新闻
>
> 任一真实源失败 / 过滤后为空都会**自动回退 Mock**；浏览器只请求同源 API，抓取永远发生在服务端。


---

## 部署到 Vercel（免费 + 永久公网地址）

完整的逐步流程见 **[DEPLOY.md](./DEPLOY.md)**（从建 GitHub 仓库到 Vercel 导入、环境变量、验证清单、免费额度注意事项）。

一句话版：

```powershell
# 1) 本地仓库已就绪（git init + 首次提交已完成）
git remote add origin https://github.com/<你的用户名>/europe-news-map.git
git push -u origin main        # 若本机连不上 github.com，见 DEPLOY.md「步骤 2 的两种走法」

# 2) 在 https://vercel.com/new 导入该仓库（Framework 自动识别为 Next.js）

# 3) 在 Vercel → Settings → Environment Variables 添加：
#    NEWS_PROVIDER = juhe
#    JUHE_NEWS_KEY = 你的聚合数据 AppKey      ← 只填在 Vercel，绝不提交进仓库

# 4) 点 Deploy（改过环境变量后记得 Redeploy），拿到 https://<项目名>.vercel.app
```

> 部署前已在代码里处理好的三件事：两个 API 路由声明 `runtime = "nodejs"`（Provider 用 `node:https`）、
> `preferredRegion = "hkg1"`（香港节点，离聚合数据与国内读者最近）、
> 聚合数据的 `http://` 缩略图会被 HTTPS 页面按混合内容拦掉 —— 现在只保留 `https` 图片。

---

## 快速开始

```bash
npm install
npm run dev
# 打开 http://localhost:3000
```

可选的自检脚本（需要 dev server 正在运行）：

```bash
npm run verify          # 接口 + 数据 + 参数校验（自动适配 mock/gdelt，24 项）
npm run check:providers # Provider 层离线自检：解析/兜底/缓存/节流/映射（81 项，不联网）
npm run check:gdelt     # 真要连 GDELT 的实时检查（DE FR GB IT，遵守限流逐个查）
npm run check:browser   # headless Chrome 端到端验收（96 项，mock 模式，自动截图到 artifacts/）
npm run geo:build       # 重新生成 public/geo/*.geojson
npm run typecheck       # tsc --noEmit
npm run build           # 生产构建（输出到 .next，与 dev 的 .next-dev 互不干扰）
npm run clean           # 清掉 .next / .next-dev*
```

> **dev 与 build 的输出目录是分开的**：`npm run dev` 通过 `scripts/dev.mts` 注入
> `NEXT_DIST_DIR=.next-dev`，生产构建仍用 `.next`。
> 这样两者可以随意交替执行、甚至同时运行 —— 否则 `next build` 会重写 dev 正在使用的
> server chunk，之后所有请求都会 500（`Cannot find module './948.js'`）。我们实际踩过一次，
> 所以把它做成结构上不可能发生。

> `scripts/*.mts` 直接用 Node 原生 TypeScript 执行（Node ≥ 22.18 / 23 默认支持类型擦除）。
> 其中需要 import 应用代码（带 `@/` 别名）的脚本会用 `scripts/loader/` 下的解析钩子补上别名
> —— 40 行、零依赖，因此仍然没有引入 tsx / ts-node。

---

## 数据源：mock / gdelt / juhe

用环境变量切换，**默认 mock**（模板见 `.env.example`）：

```bash
# .env.local
NEWS_PROVIDER=juhe
JUHE_NEWS_KEY=你的聚合数据AppKey
```

| 模式 | 行为 |
| --- | --- |
| `mock` | MockProvider：确定性的 3 条假数据，零外网依赖 |
| `gdelt` | GdeltProvider：GDELT DOC 2.0 公开 API 的真实新闻（无需 Key） |
| `juhe` | JuheProvider：聚合数据「新闻头条」国际新闻池 + 关键词/域名两级过滤（需要 `JUHE_NEWS_KEY`） |

三种真实源遵守同一约定：**请求失败 / 解析失败 / 过滤后 0 条 → 自动回退 Mock**，
`dataSource` 变回 `mock`，并在 `X-Fallback-Reason` 响应头（百分号编码）里给出可诊断的原因。

### JuheProvider 的关键实现（聚合数据）

该接口**不支持按国家查询**，只能拉 `type=guoji` 拿到一个国际新闻池，所以重点是「过滤」与「省额度」。

1. **两级过滤 + 合并去重**（`lib/juhe-filters.ts`）：一级按关键词匹配 `title`，二级按域名匹配
   `url`/`author_name`；合并后按 `uniquekey` 去重、按 `date` 倒序取前 N。
   `queryMode` 说明结果构成：`keyword` / `domain` / `both`（回退 Mock 时是 `mock`）。
2. **⚠️ 补了中文关键词（需求附录 A 只有英文）**：聚合数据是中文平台，`type=guoji` 的国际新闻绝大多数是
   **中文稿**——标题写「德国」「柏林」「默茨」，不是 `Germany`/`Berlin`/`Scholz`。
   照抄英文词表几乎永远 0 命中、全程回退 Mock。实测第一条真实结果就是
   「媒体：默茨短短两周大败三次…」，正是靠中文关键词才命中。
3. **⚠️ 附录 A/B 漏了 BY（白俄罗斯）**：46 国里只有 45 个有关键词。已补
   `Belarus/Minsk/Lukashenko/白俄罗斯/明斯克/卢卡申科` 与 `belta.by` 等域名（自检断言 46/46 覆盖）。
4. **⚠️ 关键词匹配改用词边界**：需求写的是「包含任一关键词」，但裸子串会让 `UK` 命中 `Ukraine`
   （把乌克兰新闻算成英国）。拉丁关键词走 `\b` 词边界，中文关键词仍走子串。
5. **额度保护（免费仅 50 次/天）三层**：
   - **新闻池缓存（1 小时，全国家共享）**：46 个国家各查一次只花 **1 次**上游额度，而不是 46 次 ——
     这一层比 per-country 缓存更关键；
   - per-country 结果缓存：key = `国家|日期`，TTL 1 小时（需求要求），命中直接返回、不碰上游；
   - 全局串行 + 上游调用间隔 ≥3 秒，外加当日调用上限保护（默认 45 次，超了回退并说明原因）。
     响应头 `X-Juhe-Stats`（`pool=cached;country=miss;size=30;matched=2;pages=2;calls=1`）
     一眼就能确认额度保护是否生效 —— 实测 DE+FR+GB+IT 只花了 1 次上游调用。
6. **一次最多翻 2 页**：第 1 页没有目标国家的稿子才翻第 2 页（`JUHE_MAX_PAGES`），命中即停。
7. **历史日期**：该接口只有当前新闻池、无法回溯，因此请求非今天的日期时会额外做日期校验，
   没有当天稿件就回退并说明「无法回溯历史日期」，绝不拿今天的新闻冒充历史日期
   （`strictDate` 可关闭，即完全按需求的两级过滤执行）。
8. **错误码**：`lib/juhe-error-codes.ts` 把 `error_code` 翻成人话，并区分**配置类**
   （10001/10002/10003…需换 Key）与**额度类**（10011/10012/10013，等明天）。
   注意聚合数据**永远返回 HTTP 200**，「HTTP 200」绝不等于「查到了新闻」。
9. **Key 安全**：只从 `JUHE_NEWS_KEY` 读取，未配置时**不发请求**直接回退；日志 URL 做 `key=***` 脱敏；
   前端永远接触不到 Key。
10. **配图**：`imageUrl ← thumbnail_pic_s`（需求要求）。代价是浏览器会加载外部图片 CDN，
    与 Mock 版「零外部请求」不同 —— 验收脚本已按数据源分别断言
    （mock：零外部请求；真实源：外部请求**只能是图片**，且绝不直连任何新闻 API）。

### ⚠️ 数据源覆盖限制（不是 bug）

聚合数据的「新闻头条」接口只提供**中文媒体的国际报道**（`type=guoji`），所以：

- **大国通常有数据**：德国、法国、英国、俄罗斯、乌克兰、波兰等常见于中文国际报道的国家，
  关键词/域名过滤能命中，`dataSource=juhe`，地图显示**绿色**。
- **小国和部分中等国家会回退 mock**：安道尔、列支敦士登、梵蒂冈、摩纳哥、圣马力诺、马耳他，
  以及冰岛、卢森堡、黑山这类在中文稿里很少出现的国家，过滤后为 0 条 → **按设计自动回退 MockProvider**，
  `dataSource=mock`，地图显示**灰色**，卡片按钮显示「暂无原文链接」（因为 Mock 的 url 是 `#`）。
- 这是**数据源覆盖限制**，不是 bug：接口本身不支持按国家查询，只能从国际新闻池里筛。

**如需覆盖更多国家**，可以换数据源（`NEWS_PROVIDER`）：

| 数据源 | 覆盖特点 | 代价 |
| --- | --- | --- |
| `juhe`（聚合数据，当前） | 中文媒体国际报道，大国命中好、小国常回退 | 需要 AppKey，免费额度约 50 次/天 |
| `gdelt` | 全球媒体索引，按 FIPS 国家过滤，覆盖国家多 | 官方限流「每 5 秒 1 次」，网络不稳时会回退 |
| `gnews` / 其他 | 按国家/语言查询的付费或限额 API，覆盖更全 | 需要 Key 与额度预算；接入方式与 juhe 相同（只改 Provider 层） |

### 数据源可视化（地图绿/灰 + 徽标）

- **地图配色**：<span>🟢</span> 绿 = 真实新闻（聚合数据）；<span>⚪</span> 灰 = 演示数据（Mock，含真实源失败后的回退）；
  浅色 = 本次会话尚未查询（不谎称是 mock，也不假装有数据）。
- **`GET /api/news/sources?date=YYYY-MM-DD`** 返回全部国家的数据源状态：
  `{ date, provider, countries: { DE: { dataSource: "juhe", itemCount: 2 }, AD: { dataSource: "mock", itemCount: 3 }, … }, summary }`。
  **它不发起任何上游请求**（响应头 `X-Upstream-Calls: 0`）：服务端只记录「用户真的点过哪些国家」，
  未点过的国家一律 `unknown` —— 否则为了统计把 46 个国家都查一遍，会瞬间打光 50 次/天的免费额度。
- **点击国家后地图颜色与统计同步刷新**：前端在新闻落地后重新拉一次快照（纯读缓存，零成本）。
- **徽标文案**：`数据源：聚合数据（中文媒体国际报道）` / `数据源：Mock 演示数据`（顶栏与抽屉同步显示）。
- **「阅读原文」按钮按 `item.url` 判断，不看 dataSource**：真实链接 →
  `<a href target="_blank" rel="noopener noreferrer">阅读原文</a>` 可跳转；
  `url` 为空或 `#` → 真正的 `<button disabled>`「暂无原文链接」，而不是给 `<a>` 挂 onClick 拦截。

### GdeltProvider 的关键实现（都是实测踩出来的）

1. **国家代码必须先转 FIPS**：`lib/gdelt-country-codes.ts` 维护 ISO alpha-2 → FIPS 10-4
   （DE→GM、GB→UK、CZ→EZ、RU→RS…46 国全覆盖）。查不到映射就报错走兜底，**绝不把 ISO 代码直接丢给 GDELT**（那会静默查到别的国家）。
2. **需求文档里的 `locationcc:` 运算符实测被 API 拒绝**：返回 HTTP 200 + 纯文本
   `One or more of your keywords were too short, too long or too common: (locationcc:gm)` ——
   它被当成关键字而不是运算符，永远拿不到数据。默认改用官方运算符 `sourcecountry:<FIPS>`，
   第二个策略退化为人名关键词（`"Germany"`），小国没有本国媒体被索引时靠它补位。
   想自己验证/换回可用 `GDELT_QUERY_TEMPLATES` 覆盖（例如 `locationcc:{fips},sourcecountry:{fips}`），不必改代码。
3. **限流是硬约束**：GDELT 要求「每 5 秒最多 1 次」，超限时返回 **200 + 纯文本提示**（不是 JSON、也不是 429）。
   实现里有**全局串行节流器**（默认 5.2s，跨国家共用同一节奏），并把非 JSON 响应当作**可重试错误**而不是「没有新闻」。
4. **用 `node:https` 而不是 `fetch`**：undici（Node 内置 fetch）的 connectTimeout 固定 10s，
   实测到 GDELT 的 TCP 握手经常 >10s，表现为 `UND_ERR_CONNECT_TIMEOUT`（与业务无关）。
   改用 `node:https` 后，socket 超时统一覆盖「建连 + 读响应」两个阶段，并配合重试。
5. **缓存**：key = `国家|日期`，TTL **1 小时**；并发请求合并（in-flight dedupe）；
   「上游确实没有文章」额外写 5 分钟短负缓存，避免反复戳免费公共接口。
6. **字段映射**：`title`←title、`sourceName`←domain、`publishedAt`←seendate（`20250926T120000Z` → ISO）、
   `url`←url、`score` 沿用 0.95/0.88/0.81；
   `imageUrl` **留空**——artlist 里的 `socialimage` 会让浏览器去请求外部图片，破坏「Network 里只有同源请求」这条验收；
   `description` 用真实元数据合成一行（`GDELT 实时索引 · 来源 spiegel.de · Germany · German`），
   因为 artlist 不提供摘要，这样比把标题重复一遍更有信息量。
7. **Top 3 怎么选**：取 20 条后清洗（丢脏数据、按标题+URL 去重）→ 优先让来源域名分散（不会三条都来自同一家）→ 取前 3。
8. **时间窗口**：`date` 是今天时用规格要求的 `timespan=1d`；历史/未来日期改用
   `startdatetime`/`enddatetime` 显式区间 —— 否则日期选择器形同虚设（选 9 月 1 日却返回最近 24 小时）。

### 环境变量一览

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `NEWS_PROVIDER` | `mock` | `mock` \| `gdelt` |
| `GDELT_API_BASE` | 官方 DOC 2.0 端点 | 便于走代理或指向镜像 |
| `GDELT_TIMEOUT_MS` | `12000` | 单次请求 socket 超时（连接+读取） |
| `GDELT_TOTAL_BUDGET_MS` | `30000` | 一次取数总预算，超了直接回退（= 用户最长等待时间） |
| `GDELT_MIN_INTERVAL_MS` | `5200` | 全局最小请求间隔，遵守 GDELT 的「每 5 秒 1 次」 |
| `GDELT_MAX_ATTEMPTS` | `3` | 单策略重试次数 |
| `GDELT_QUERY_TEMPLATES` | `sourcecountry:{fips},"{name}"` | 查询策略，逗号分隔，支持 `{fips}`/`{name}` 占位符 |

---

## 技术栈

| 层 | 选型 |
| --- | --- |
| 框架 | Next.js 14.2（App Router）+ React 18 + TypeScript（strict） |
| 样式 | Tailwind CSS 3.4 + shadcn/ui（组件以源码形式放在 `components/ui`） |
| 地图 | react-simple-maps 3 + d3-geo 3（`geoAzimuthalEqualArea` + `fitExtent`） |
| 地图数据 | Natural Earth 1:50m，经 `world-atlas` 转换并补上 `ISO_A2` 属性 |
| 交互原语 | Radix UI（Dialog / Popover / Slot）、lucide-react 图标 |
| 数据源 | 自实现的 `MockProvider`（确定性、无网络、无 Key） |

---

## 目录结构

```
app/
  layout.tsx                     根布局（深色主题、中文 metadata、系统字体栈）
  page.tsx                       服务端组件：请求时确定「今天」并传给客户端组件
  icon.svg                       favicon（避免 /favicon.ico 404 污染控制台）
  globals.css                    Tailwind + shadcn 主题变量 + 地图配色 token
  api/news/top/route.ts          GET /api/news/top
components/
  HomePageClient.tsx             首页客户端编排：日期状态 + 选中国家 + 抽屉开合
  EuropeMap.tsx                  欧洲地图（投影适配、悬停、点击、缩放、微型国家热区、图例）
  NewsDrawer.tsx                 右侧/底部抽屉（加载骨架 / 错误 / 无数据 / 正常四态）
  NewsCard.tsx                   新闻卡片 + 骨架屏
  DatePicker.tsx                 Popover + 自绘日历（不依赖 react-day-picker）
  ui/                            shadcn/ui 组件：button / card / sheet / badge / skeleton / popover
lib/
  countries.ts                   46 个国家的唯一事实来源（中文名、numeric、首都坐标、别名）
  providers/types.ts             NewsItem / NewsProvider / TopNewsResponse 契约
  providers/mock-provider.ts     MockProvider 实现
  providers/index.ts             提供者工厂（将来换真实数据源只改这里）
  geo.ts                         投影构建、视野框、GeoJSON 加载与类型
  heat.ts                        国旗 emoji、Mock 热度配色、图例
  date.ts                        日期纯函数（校验 / 加减 / 日历网格 / 中文格式化）
  hash.ts                        FNV-1a + mulberry32（Mock 数据确定性的基础）
  use-top-news.ts                拉取 /api/news/top 的 hook（竞态与取消处理）
  use-media-query.ts             移动端判定（决定抽屉方向）
scripts/
  build-geo.mts                  由 world-atlas 生成 public/geo/*.geojson
  verify.mts                     接口与数据自检
  browser-check.mts              headless Chrome 端到端验收（CDP，零依赖）
public/geo/
  europe.geojson                 46 个目标国家（含 ISO_A2）
  europe-context.geojson         27 个周边国家（土耳其、高加索、北非…），仅作背景
```

---

## 接口

### `GET /api/news/top?country=DE&date=2026-09-26&limit=3`

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `country` | 是 | ISO 3166-1 alpha-2，大小写均可；必须是 46 个目标国家之一 |
| `date` | 否 | `YYYY-MM-DD`，默认今天；会做真实日历校验（`2026-13-01`、`2026-02-30` 一律 400） |
| `limit` | 否 | 1–10 的整数，默认 3 |

成功响应：

```json
{
  "country": "DE",
  "date": "2026-09-26",
  "updatedAt": "2026-09-26T08:31:07.412Z",
  "dataSource": "mock",
  "items": [
    {
      "rank": 1,
      "title": "【Mock】德国 2026-09-26 热点新闻 1",
      "sourceName": "Mock News",
      "publishedAt": "2026-09-26T06:40:00",
      "url": "#",
      "description": "【Mock 数据】德国今日关注度最高的话题是“能源价格与冬季供暖方案”…",
      "imageUrl": "data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D…",
      "score": 0.95
    }
  ]
}
```

错误响应统一为 `{ "error": "unsupported_country", "message": "…" }` 并返回 400。

### MockProvider 的确定性

`lib/providers/mock-provider.ts` 用 `FNV-1a(country|date)` 作为种子驱动 `mulberry32`，
因此**同一国家 + 同一天的结果完全一致**（连摘要里的话题、配图渐变、发布时间都一样），
刷新页面、重启服务、并发请求都不会变。唯一随请求变化的是 `updatedAt`（请求时刻）。

- 3 条新闻的 `score` 固定为 `0.95 / 0.88 / 0.81`（排名递减）
- 来源固定 `Mock News`，`url` 固定 `#`，`publishedAt` 一定落在请求当天
- 配图是**内联 SVG data URI**，所以卡片有图可看却不会产生任何网络请求

---

## 地图数据是怎么来的

`npm run geo:build` 把 `world-atlas/countries-50m.json`（Natural Earth 1:50m TopoJSON）转成 GeoJSON，并给每个要素补上 `properties.iso_a2`。三个关键点：

1. **alpha-2 映射**：Natural Earth 的要素 id 是 ISO 3166-1 **numeric**（法国、挪威、科索沃等还会出现 `-99`），
   所以脚本按「名称优先、numeric 兜底」匹配 `lib/countries.ts`，并在最后断言 46/46 全覆盖，缺一个就报错退出。
   `npm run verify` 还会做一次**语义校验**：把每个国家的首都坐标放进它自己要素的包围盒里比对，
   一旦映射串位（例如 Slovakia ↔ Slovenia）立刻报错 —— 只数「有没有 46 个」是不够的。
2. **微型国家**：安道尔、列支敦士登、摩纳哥、马耳他、圣马力诺、梵蒂冈在 1:50m 里都有真实多边形，
   但在全欧洲视野下只有零点几像素。因此前端为这 6 个国家渲染**固定屏幕尺寸的圆点标记**，
   并在其上方叠一个 **24px 直径的透明点击热区**（`fill="transparent"` 参与命中测试，`fill="none"` 不参与），
   半径随缩放反向缩放，任何缩放级别下都是舒适的可点目标。
   脚本仍保留兜底逻辑：若某个国家在源数据里缺失，就用首都坐标生成一个可见多边形。
3. **投影与构图**：视野框固定为经度 -25°..45°、纬度 33°..72°，用 `geoAzimuthalEqualArea().clipAngle(89.5)`
   再 `fitExtent` 到容器实际像素。**不对数据求包围盒**，否则俄罗斯（跨 180° 经线）、挪威（含斯瓦尔巴）、
   法国/荷兰/葡萄牙（含海外领地）会把整个欧洲压成一个小点。

> ⚠️ **视野框的绕向必须正确**（本轮审查修掉的真 bug）：d3-geo 对球面多边形按右手法则判定内外，
> 绕向反了会被理解成「整个地球挖掉这个框」的补集，`fitExtent` 就会把大半个球面塞进画布。
> 实测后果是**整张欧洲地图缩小约 6 倍**（德国只有 31×34 px、卢森堡 3×3 px），所有小国都点不到。
> `createEuropeFrame()` 现在用 `geoArea()` 自检：球面面积超过半个地球就反转绕向，不依赖人脑记方向。

地图配色是「Mock 热度」分级（同样由 `哈希(国家|日期)` 决定），切换日期时整张图的冷热分布会变化，
未选中时悬停变琥珀色、选中变青色（微型国家标记同步变色）。

---

## 交互与响应式

| 场景 | 行为 |
| --- | --- |
| 悬停国家 | 高亮 + 跟随鼠标的提示气泡（中文名、英文名、代码、Mock 热度） |
| 点击国家 | 地图高亮，桌面端右侧抽屉滑出，移动端底部抽屉弹出 |
| 点击其他 | 直接切换国家并刷新数据；点击海洋/背景则清空选中并关闭抽屉 |
| 缩放平移 | 滚轮/双指缩放（最大 16×）、拖拽平移，缩放后出现「重置视图」按钮 |
| 顶栏日期 | 前后一天箭头 + 日历弹层（周一起始、今天高亮、昨天/回到今天快捷键） |
| 切换日期 | 重新请求 `/api/news/top`，标题里的日期随之变化 |
| 加载 / 出错 / 空 | 骨架屏 3 张 / 错误提示 + 重试 / 「暂无数据」三种状态 |
| 移动端 | 地图铺满视口，抽屉从底部升起（74vh，带遮罩），点遮罩关闭 |
| 桌面端 | 抽屉打开时地图自动让出 420px 宽度（ResizeObserver 触发投影重新适配），日期选择器始终可见 |

**一个容易踩的坑（已修）**：桌面端的抽屉是非模态 Radix Dialog，默认会在任何 panel 外的
`pointerdown` 上关闭自己 —— 那样用户就没法「保持抽屉打开去改日期」了。`NewsDrawer.tsx` 里对
桌面端 `onInteractOutside` / `onFocusOutside` 做了 `preventDefault()`，关不关由地图点击决定。

**另一个坑（已修）**：d3-zoom 会在拖拽后拦截 `click` 事件，用 `onClick` 选国家会偶发失效；
所以国家选择走 `onPointerDown` + `onPointerUp` 并自带 6px 位移阈值，微小手抖不会被误判成拖拽。

---

## 本轮审查修复的真问题

| 问题 | 现象 | 修法 |
| --- | --- | --- |
| **地图整体缩小约 6 倍** | 德国只有 31×34 px、卢森堡 3×3 px，安道尔/圣马力诺/摩纳哥/梵蒂冈的多边形不到 1 像素，**小国根本点不到** | `lib/geo.ts` 的 `createEuropeFrame()` 用 `geoArea() > 2π` 判定绕向并反转视野框（修完德国 132×147 px、卢森堡 12×14 px） |
| **生产环境必然 hydration 报错** | `useState(() => todayIsoDate())` 会在 `next build` 静态预渲染时把**构建当天**的日期烤进 HTML，用户隔天访问时客户端日期与 HTML 不一致 | `app/page.tsx` 拆成服务端组件：请求时算 `initialDate` 传给客户端组件（并加 `force-dynamic`），挂载后再按浏览器本地时区静默校正一次 |
| **小国缺少舒适点击目标** | 热区只有 11px 直径 | 微型国家改为 **24px 透明热区**（`fill="transparent"`），并随缩放反向缩放 |
| **抽屉关闭按钮无稳定无障碍名** | 只有 `<span class="sr-only">`，自动化与读屏都不易稳定定位 | `components/ui/sheet.tsx` 加上 `aria-label="关闭"` |
| **favicon 404 污染控制台** | `/favicon.ico` 404 → 控制台 error | 新增 `app/icon.svg` |
| 桌面抽屉会被外部点击关掉 | 无法「保持抽屉打开去改日期」 | `NewsDrawer.tsx` 对桌面端 `onInteractOutside`/`onFocusOutside` 做 `preventDefault()` |
| 国家点击偶发失效 | d3-zoom 拖拽后拦截 `click` | 改用 `onPointerDown`+`onPointerUp` + 6px 位移阈值 |

---

## 验收结果

三套脚本（Next 14.2.35 / Node 24.20 / Chrome headless 1440×900 与 390×844）：

```
npm run check:providers → 🎉 全部通过：81/81   （离线：FIPS 映射、URL、解析、去重、限流重试、缓存、兜底、Mock 回归）
npm run verify          → 🎉 全部通过：24/24   （mock 模式与 gdelt 模式都跑过，自动适配断言）
npm run check:browser   → 🎉 浏览器验收全部通过：97/97  （mock 模式）
npm run build           → ✓ Compiled successfully
```

`npm run check:browser` 逐条对应验收标准（真实 CDP 鼠标输入，不是合成事件）：

| # | 验收标准 | 脚本怎么验的 |
| --- | --- | --- |
| 1 | 点击任意国家都有响应 | **46 个国家逐个真实鼠标点击**，每个都断言抽屉标题 + 「浏览器实际收到的坐标与命中元素」 |
| 2 | 每个国家都返回 3 条 Mock 新闻 | 46 × 3 条标题/排名/来源/分数逐条比对，`verify` 侧再独立跑一遍 API |
| 3 | 抽屉字段完整 | 断言 `#1/#2/#3`、`Mock News`、`HH:mm` 时间、`【Mock 数据】` 摘要、`0.95/0.88/0.81`、中文日期 |
| 4 | 日期切换带动 `date` 参数与标题 | 断言请求 URL 出现 `date=<新日期>`、标题日期同步变化、日历「回到今天」回退 |
| 5 | 移动端地图全屏 + 底部抽屉 | 390×844 视口下量 SVG 390×739、抽屉 top=219/bottom=844（等动画结束再量）且带遮罩 |
| 6 | Network 只有 `/api/news/top` | 抓全部请求：无外部域名、无 `news.google.com`/`newsapi`/`gdelt`，同源请求仅 HTML/静态资源/`/geo/*` |
| 7 | 无控制台报错、无 hydration 警告 | 订阅 `Runtime.consoleAPICalled` + `Runtime.exceptionThrown` + `Log.entryAdded`，断言 error/warning/异常**全部为空**（自造的失败请求噪声单独豁免） |

另外还覆盖了：抽屉开合生命周期（关闭按钮 / Escape / 再次点击重开 / 点海洋关闭并清空选中）、
**加载骨架 → 错误提示 → 重试 → 无数据**四种状态（用 CDP `Fetch` 拦截 `/api/news/top` 分别延迟、失败、返回空数组触发）、
46 国点击后地图仍处于原始视图（没有被误拖动/缩放）。

截图由脚本自动写入 `artifacts/desktop-germany.png` 与 `artifacts/mobile-germany.png`。

### 本机对 GDELT 的实测情况（重要）

本机（沙箱出口 IP）**能连通 GDELT，但极不稳定**：TCP 握手经常超过 10 秒，且该 IP 被 GDELT 限流
（`HTTP 429` 与「每 5 秒 1 次」的纯文本提示交替出现）。因此在这里**无法稳定演示 `dataSource=gdelt`**：

```
$env:NEWS_PROVIDER="gdelt"; npm run dev
npm run check:gdelt -- DE
  ⚠️  DE  dataSource=mock（回退）  条数=3
      兜底原因：GDELT 查询未成功（DE …）：被 GDELT 限流（HTTP 429 或 200+限流提示…）
```

这恰恰验证了兜底链路：**接口返回 200、3 条新闻、前端不报错，并给出可诊断的原因**（不是 500、不是空列表）。
在住宅网络上（无共享 IP 限流）预期可直接拿到真实数据，用 `npm run check:gdelt` 一键确认即可。

`check:providers` 之所以要写 81 项离线断言，就是因为这台机器没法稳定连 GDELT：
映射、URL、解析、限流重试、缓存、兜底这些逻辑必须能**确定性**地被验证，而不是靠外网运气。

---

## 接别的真实数据源要改什么

GDELT 已经接完，再换一个源同样只动 Provider 层：

1. 新建 `lib/providers/<new>-provider.ts`，实现同一个接口：

   ```ts
   type NewsProvider = {
     getTopNews(countryCode: string, date: string, limit: number): Promise<NewsItem[]>;
   };
   ```

2. 在 `lib/providers/index.ts` 的 `getProviderId()` / `resolveTopNews()` 里加一个分支。
3. `app/api/news/top/route.ts`、页面、抽屉、卡片**一行都不用改**（前端只认 `dataSource` 字段与 3 张卡片）。

提醒：`NewsItem.imageUrl` 现在允许内联 data URI；换成远程图片时记得同步配置 `next.config.mjs` 的
`images.remotePatterns`（当前刻意留空，以便从配置层面保证不会偷偷发出外部请求）。
