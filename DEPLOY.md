# 部署到 Vercel（免费 + 永久公网地址）

把本项目从本地搬到 Vercel，拿到类似 `https://europe-news-map.vercel.app` 的永久地址。
全程用免费额度（Hobby 计划），不需要信用卡。

> **本机网络情况（已实测）**：`api.github.com` / `vercel.com` / `api.vercel.com` / `v.juhe.cn` 均可访问，
> 但 **`github.com` 直连超时** → 本机 `git push` 可能失败。Vercel 是从 GitHub **服务器端**拉代码，
> 所以只要代码进了 GitHub，你的机器能不能直连 github.com 都不影响部署。见下方「步骤 2 的两种走法」。

---

## 附：仓库 / 项目简介文案（可直接复制）

建仓库或填 Vercel 项目描述时，直接从下面挑一条粘贴。

**GitHub 仓库 About（中文一行，推荐）**

```
覆盖 46 个欧洲国家/地区的每日新闻热点地图：点选国家查看当日 Top 3 热点新闻，支持聚合数据 / GDELT 真实新闻与 Mock 自动兜底。
```

**GitHub 仓库 About（英文一行）**

```
Interactive daily news heat map of 46 European countries — click a country to see its top 3 stories. Next.js 14, real news via Juhe / GDELT with automatic mock fallback.
```

**GitHub Topics（标签，逐个小写英文，空格换成进入下一个）**

```
nextjs  typescript  tailwindcss  shadcn-ui  react-simple-maps  d3-geo  geojson  data-visualization  news-aggregator  europe  map  vercel
```

**Vercel 项目描述（短）**

```
欧洲每日新闻热点地图 · 46 国 Top 3 热点 · Next.js 14
```

**README / 作品集用的两段版本**

```
欧洲每日新闻热点地图是一个可交互的欧洲新闻热度看板：地图上覆盖 46 个欧洲国家/地区，
鼠标悬停高亮并显示国名，点击国家即从右侧（桌面）或底部（移动端）抽屉展开当日 Top 3 热点新闻，
支持按日期回溯。地图按数据源上色——绿色代表聚合数据抓到的真实中文国际报道，
灰色代表演示数据，一眼就能看出哪些国家真有新闻。

技术上是一套「三数据源 + 自动兜底」的工程实现：聚合数据（中文媒体国际报道，
关键词与来源域名两级过滤）、GDELT（按 FIPS 国家代码过滤）与确定性 Mock，
任一真实源失败或过滤后为空都自动回退 Mock，前端始终有内容且不报错。
地图数据由脚本从 Natural Earth 1:50m 生成（补 ISO_A2 属性、24px 微型国家点击热区），
地图投影按容器像素实时 fit；针对聚合数据 50 次/天的免费额度做了三层节流与共享缓存保护。
配套 75 项离线自检与 107 项浏览器端到端验收，覆盖交互、响应式、控制台与无障碍。
```

---

## 前置检查清单（本地已就绪）

| 项目 | 状态 |
| --- | --- |
| git 仓库 | ✅ 已 `git init -b main` 并完成首次提交（`0d9d1f5`，62 个文件） |
| `.env.local`（含 AppKey） | ✅ 已被 `.gitignore` 忽略，**不会**上传（已用 `git check-ignore` 验证） |
| 硬编码密钥 | ✅ 全项目扫过，无 AppKey 明文 |
| `package-lock.json` | ✅ 已提交，Vercel 会按锁文件安装 |
| 运行时 | ✅ 两个 API 路由都声明了 `runtime = "nodejs"`（Provider 用 `node:https`，Edge 跑不了） |
| 就近区域 | ✅ 声明了 `preferredRegion = "hkg1"`（香港，离聚合数据与国内读者最近） |
| HTTPS 混合内容 | ✅ 已修：聚合数据的 `http://` 缩略图会被浏览器拦截，现在只保留 `https` 图片 |

### 仓库现状（截至 2026-10-07）

GitHub 上的仓库**已经建好并且是 public**：`https://github.com/physio666/-europe-news-map`
（2026-09-28 创建，描述已填好），但它**至今是空的**（GitHub API `"size": 0`）——
本地 4 个提交从未推上去（`git rev-parse @{u}` 报 `no upstream configured`）。
所以你现在只差「步骤 2 的一次 push」，不需要再建仓库。

两个需要注意的细节：

1. **仓库名带一个前导连字符**（`-europe-news-map`，多半是当初手滑），URL 合法但不美观。
   想改：仓库页 → **Settings** → **Repository name** 改成 `europe-news-map` → GitHub 会自动跳转旧地址。
2. **原来的 `origin` 指向第三方加速代理** `https://ghfast.top/https://github.com/...`。
   这类代理只加速**下载**、**不能 push**，而且会让你的登录凭据经过第三方。
   已改为直连 `https://github.com/...`（本机 `github.com:443` 实测可达）。

---

## 步骤 1：在 GitHub 上建一个空仓库

> 你的仓库已存在（见上），这一步可以跳过。以下是**给别人的**完整流程，也便于你重建时参考。

1. 打开 <https://github.com/new>
2. **Repository name**：`europe-news-map`（不要以连字符开头）
3. **Public / Private 都可以**（Vercel 免费计划两种都支持；私有仓库也能部署）
4. **不要**勾选 `Add a README file` / `.gitignore` / `license`（本地已有内容，勾了会冲突）
5. 点 **Create repository**

建好后页面会显示仓库地址，形如：
`https://github.com/<你的用户名>/europe-news-map.git`

---

## 步骤 2：把本地代码推上去

### 走法 A：本机能直连 github.com（推荐，你现在的情况）

```powershell
cd "C:\Users\physio\Documents\deepseek harness\europe-news-map"

# 指向真实仓库（去掉第三方加速前缀）
git remote set-url origin https://github.com/physio666/-europe-news-map.git

git push -u origin main
```

首次推送会弹窗要求登录 GitHub（推荐用 **Git Credential Manager** 的浏览器授权；
或者用 **Personal Access Token** 当作密码，Token 在
<https://github.com/settings/tokens> → Generate new token (classic) → 勾 `repo`）。

> ⚠️ **不要把 Token 粘贴到聊天窗口**。如果 `git push` 反复失败、提示认证问题，
> 用 `cred_hint` 这类凭据助手流程处理，而不是把 Token 发出来。

### 走法 B：本机连不上 github.com

任选其一：

1. **GitHub Desktop / VS Code 的 GitHub 集成**：它们走 `api.github.com`（本机可访问），
   在图形界面里 Add local repository → Publish repository 即可。
2. **换用能访问 GitHub 的网络**（代理/VPN）后执行走法 A 的两条命令。
3. **让 `git` 走 HTTPS 代理**（如果你有代理端口，例如 7890）：
   ```powershell
   git config --global http.proxy http://127.0.0.1:7890
   git push -u origin main
   git config --global --unset http.proxy     # 推完可以撤掉
   ```
4. **通过网页上传**：GitHub 仓库页 → `Add file` → `Upload files`，把整个项目目录拖进去
   （**先确认本地没有把 `.env.local` 拖进去**；网页上传无法执行 `.gitignore`，这一步必须自己检查）。

> ⚠️ **`ghfast.top` 这类加速代理不能用来 push**：它只加速下载（clone/fetch），
> 而且会把你的登录凭据经手第三方。`git push` 必须直连 `github.com`
> （或走你自己的代理，见上面第 3 条）。曾经配过的代理地址可以这样去掉：
> ```powershell
> git remote set-url origin https://github.com/physio666/-europe-news-map.git
> ```

推送成功后刷新仓库页面，应能看到 `app/ components/ lib/ public/ scripts/` 等目录。

---

## 步骤 3：在 Vercel 导入项目

1. 打开 <https://vercel.com/signup>，**用 GitHub 账号登录**（Sign up with GitHub）——免费 Hobby 计划
2. 进入 <https://vercel.com/new>
3. 在 **Import Git Repository** 列表里找到 `europe-news-map`，点 **Import**
   - 首次需要点 `Configure GitHub App` 授权 Vercel 读取你的仓库（可只授权这一个仓库）
4. **Configure Project** 页面保持默认即可，Vercel 会自动识别为 Next.js：

   | 配置项 | 值 |
   | --- | --- |
   | Framework Preset | `Next.js`（自动识别） |
   | Root Directory | `./`（如果仓库根目录就是本项目，保持默认） |
   | Build Command | 默认 `next build`（**不要**改成 `npm run dev`） |
   | Output Directory | 默认 `.next` |
   | Install Command | 默认 `npm install` |
   | Node.js Version | `20.x` 或 `22.x` 都行（项目在 Node 24 上开发，20/22 兼容） |

   > 本项目 **不需要** `vercel.json`。`npm run dev` 里的 `.next-dev` 隔离逻辑只用于本地开发，
   > Vercel 跑的是 `next build`，输出目录自然回到 `.next`，两者互不干扰。

5. **先别急着点 Deploy** —— 先把环境变量填好（下一步）。如果已经点了也没事，
   之后补上环境变量再 Redeploy 即可。

---

## 步骤 4：设置环境变量（关键）

### 4.1 需要设置哪些

| 变量名 | 值 | 必填 | 说明 |
| --- | --- | --- | --- |
| `NEWS_PROVIDER` | `newsdata` | ✅ | 数据源：`mock` \| `newsdata` \| `juhe` \| `gdelt`。不填默认 `mock`（全站演示数据） |
| `NEWSDATA_API_KEY` | 你的 NewsData.io API Key | ✅（用 newsdata 时） | **只填在 Vercel，绝不写进代码或仓库**；免费层 200 credits/天 |
| `JUHE_NEWS_KEY` | 你的聚合数据 AppKey | ✅（用 juhe 时） | **只填在 Vercel，绝不写进代码或仓库** |

以下都是**可选**调优项（不填即用括号里的默认值）：

| 变量名 | 默认 | 说明 |
| --- | --- | --- |
| `NEWSDATA_CATEGORY` | `top` | 头条分类（留空则不传 category） |
| `NEWSDATA_SIZE` | `10` | 每次向上游要多少条（免费层上限 10） |
| `NEWSDATA_CACHE_TTL_MS` | `3600000` | per-country 结果缓存 TTL（key = 国家\|日期，省 credit 的关键） |
| `NEWSDATA_MIN_INTERVAL_MS` | `1000` | 全局最小请求间隔（全局串行） |
| `NEWSDATA_DAILY_LIMIT` | `200` | 当日上游调用上限保护 |
| `NEWSDATA_TIMEOUT_MS` | `12000` | 单次请求超时 |
| `NEWSDATA_FAILURE_COOLDOWN_MS` | `60000` | 上游失败后的短路时长 |
| `JUHE_NEWS_TYPE` | `guoji` | 分类 |
| `JUHE_PAGE` / `JUHE_PAGE_SIZE` | `1` / `30` | 分页（page 最大 50，page_size 最大 30） |
| `JUHE_MIN_INTERVAL_MS` | `3000` | 全局最小请求间隔（保护 50 次/天额度） |
| `JUHE_POOL_TTL_MS` | `3600000` | 新闻池缓存 TTL，全国家共享 |
| `JUHE_MAX_PAGES` | `2` | 一次取数最多翻几页 |
| `JUHE_DAILY_LIMIT` | `45` | 当日上游调用上限保护 |
| `JUHE_TIMEOUT_MS` | `10000` | 单次请求超时 |
| `GDELT_*` | 见 `.env.example` | 切到 GDELT 时才需要 |

### 4.2 在 Vercel Dashboard 里设置（推荐）

1. 进入项目 → **Settings** → 左侧 **Environment Variables**
2. 逐条添加：
   - **Key**：`NEWS_PROVIDER`，**Value**：`newsdata`（或 `juhe`）
   - **Key**：`NEWSDATA_API_KEY`，**Value**：你的 NewsData.io API Key（用 newsdata 时）
   - **Key**：`JUHE_NEWS_KEY`，**Value**：你的 AppKey（用 juhe 时；粘贴后即为「加密存储」）
3. 每条变量的 **Environments** 勾选：**Production**（想让它对 PR 预览部署也生效就再勾 **Preview**）
4. 点 **Save**
5. 回到 **Deployments** 标签 → 最新一次部署右侧 **⋯** → **Redeploy**
   （环境变量只在**构建/部署时**注入，改完必须重新部署才生效）

> ⚠️ **实测坑：Development 勾不上，这是正常的**
>
> 如果发现 Environments 里 **Development 无法和 Production/Preview 同时勾选**，原因是这个变量被标成了
> **Sensitive**（或团队开启了「Enforce Sensitive Environment Variables」）。Vercel 官方明确说明：
>
> > Sensitive variables can only target Production and Preview. If Development is selected, the switch is disabled.
> > That's by design: your local `vercel env pull` flow needs readable values, so Development-scoped variables stay regular.
> > —— *Sensitive Env Vars · Vercel Academy*
>
> 逻辑上说得通：Development 环境变量的作用是让 `vercel env pull` 把值**拉到本地明文文件**，
> 而 Sensitive 是「只写不可读」，两者天然冲突。
>
> **而且你根本不需要 Development**：Vercel 的 Development 环境只服务于 `vercel dev` 与 `vercel env pull`；
> 本地跑的是 `npm run dev` + 项目里的 `.env.local`，Vercel 的环境变量不会注入到本地进程。
> 所以**只勾 Production 就是完整正确的配置**，不会影响任何功能。
> 若确实想让 `vercel env pull` 也能拿到，官方建议是**再建一个同名变量、不勾 Sensitive、只勾 Development**。
>
> 💡 **`JUHE_NEWS_KEY` 建议不要勾 Sensitive**：Sensitive 一旦保存就永久无法再读出（连你自己也不能），
> 以后连后台都复制不出来（只能重新申请 key）。个人项目 + 本地 `.env.local` 已有副本，收益很小。

### 4.3 用 Vercel CLI 设置（可选，适合习惯命令行的场景）

```powershell
cd "C:\Users\physio\Documents\deepseek harness\europe-news-map"
npx vercel login                       # 浏览器授权
npx vercel link                        # 关联到刚建的 Vercel 项目

# 按环境分别添加（这里只加 production，需要预览部署就再来一次 --preview 用 preview）
npx vercel env add NEWS_PROVIDER production
npx vercel env add NEWSDATA_API_KEY production
npx vercel env add JUHE_NEWS_KEY production

npx vercel --prod                      # 重新部署到生产
```

### 4.4 如果不想用聚合数据

- 想全站演示数据（零外部依赖、不会因额度耗尽而回退）：
  把 `NEWS_PROVIDER` 设为 `mock`，`NEWSDATA_API_KEY` / `JUHE_NEWS_KEY` 可以留空。
- 想换 NewsData.io：把 `NEWS_PROVIDER` 设为 `newsdata` 并填 `NEWSDATA_API_KEY`
  （免费层 200 credits/天、每次请求 1 credit；**支持按国家查询**，覆盖范围比聚合数据广，
  小国也可能有数据；免费层只能查最新新闻，选历史日期会按设计回退 Mock）。
- 想换 GDELT：把 `NEWS_PROVIDER` 设为 `gdelt`（**不需要任何 Key**，但官方限流严格，
  国内访问 GDELT 不稳定，函数侧超时会自动回退 Mock，页面不会报错）。

---

## 步骤 5：部署并验证

点 **Deploy** 后等约 1–3 分钟，成功后你会拿到两个地址：

- **生产地址（永久）**：`https://<项目名>.vercel.app`
- 每次 push 到 `main` 都会自动重新部署，地址不变

部署后在浏览器打开生产地址，按这个清单确认（和本地验收同样的检查点）：

1. 首页出现欧洲地图（46 个国家）
2. 点 **德国** → 抽屉里是真实新闻（聚合数据），地图上德国是**绿色**
3. 「阅读原文」按钮可点击，且**在新标签页**打开 163.com 等原文
4. 点 **安道尔** → 抽屉显示「数据源：Mock 演示数据」，按钮是禁用的「暂无原文链接」，地图上是**灰色**
5. 顶栏徽标显示「数据源：聚合数据（中文媒体国际报道）」
6. F12 控制台**没有红色报错**

也可以用命令行验证接口（把域名换成你的）：

```powershell
# 数据源模式 + 数据源（应返回 juhe）
curl.exe -s -D - -o NUL "https://<你的域名>.vercel.app/api/news/top?country=DE&limit=3" |
  Select-String -Pattern "HTTP/|x-provider-mode|x-data-source|x-query-mode|x-juhe-stats"

# 数据源快照（应返回 200，且 X-Upstream-Calls: 0）
curl.exe -s "https://<你的域名>.vercel.app/api/news/sources" | Select-Object -First 1
```

---

## 免费额度与线上注意事项（重要，别踩）

1. **聚合数据免费额度 50 次/天**，项目内已有三层保护（全局 3 秒节流、新闻池 1 小时共享缓存、
   当日 45 次上限保护）。但注意：**Vercel 无服务器函数是多实例的**，
   每个实例各有一份内存缓存 → 实例数越多，理论上消耗额度越快。
   - 个人演示/小流量完全够用；
   - 如果要跑公开流量，建议二选一：把 `JUHE_DAILY_LIMIT` 调小（例如 20）以硬性保额，
     或接入 Vercel KV / Upstash Redis 把缓存与「已查询国家」记录变成跨实例共享
     （代码上只需替换 `lib/providers/ttl-cache.ts` 的实现，Provider 不用改）。
2. **`/api/news/sources` 的快照状态也是每实例内存**：不同实例可能看到不同的绿/灰分布。
   这不会报错，只是地图上绿色国家数可能在不同请求间略有差异（本地单实例不会出现）。
3. **Vercel 函数默认超时**：Hobby 计划单次函数最长 60 秒。项目里聚合数据的
   单次请求超时是 10 秒、总预算受当日上限保护，不会顶到 60 秒。
4. **`.env.local` 永远不会被部署**：Vercel 只用你在 Dashboard 里设置的环境变量。
   本地继续用 `.env.local` 开发，两边互不影响。
5. **不要在 Vercel 上跑 `mock→juhe` 之外的折腾**：改完环境变量记得 **Redeploy**，
   否则旧部署仍用旧变量（这是最常见的「明明配了却不生效」原因）。
6. **绑定自有域名（可选）**：项目 → Settings → Domains → 添加你的域名并按其提示配置 DNS。
   免费计划支持绑定自有域名并自动签发 HTTPS 证书。

---

## 常见问题

**Q: 部署成功但地图上全是灰色 / 数据是 Mock？**
检查三件事：① `NEWS_PROVIDER` 是否设为 `juhe`；② `JUHE_NEWS_KEY` 是否正确；
③ 改完变量后是否 **Redeploy**。也可以在浏览器里看 `/api/news/top?country=DE` 的
`x-fallback-reason` 响应头（百分号编码的原因说明），它会直接告诉你是不是 Key 无效、
额度用尽、或该国当天确实没有匹配稿件（这属于数据源覆盖限制，不是 bug）。

**Q: 构建失败提示 Node 版本 / 类型错误？**
Vercel 项目 → Settings → General → **Node.js Version** 选 `20.x` 或 `22.x`；
本地先跑 `npm run typecheck`（应为 0 错误）和 `npm run build`（本地已通过）。

**Q: 想先不改仓库、只用命令行直接部署？**
可以（但不推荐，因为拿不到「push 自动部署」的好处）：
`npx vercel` 交互式部署 → 之后再 `npx vercel --prod` 发布生产环境。

**Q: 以后怎么更新线上版本？**
```powershell
git add -A
git commit -m "描述这次改动"
git push            # main 分支一推，Vercel 自动重新部署
```
