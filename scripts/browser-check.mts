#!/usr/bin/env node
/**
 * 浏览器端冒烟测试（CDP，无第三方依赖）。
 *
 *   npm run dev            # 另开终端
 *   npm run check:browser
 *
 * 会自行拉起 headless Chrome，然后验证：
 *  1. 地图渲染出 46 个可交互国家 + 6 个微型国家标记
 *  2. 点击德国 → 右侧抽屉出现「德国」与 3 条 Mock 新闻
 *  3. 点击安道尔的微型国家标记同样能打开抽屉
 *  4. 移动端视口下抽屉从底部弹出（bottom sheet）
 *  5. Network 里只有同源请求，没有任何外部新闻 API
 * 并把桌面端 / 移动端截图写入 artifacts/。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { EUROPE_COUNTRIES } from "../lib/countries.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, "..");
const ARTIFACTS = join(PROJECT_ROOT, "artifacts");
const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const DEBUG_PORT = Number(process.env.CHROME_DEBUG_PORT ?? 9222);

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter((value): value is string => Boolean(value));

type CdpResponse = {
  id?: number;
  result?: Record<string, unknown>;
  error?: { message: string };
  method?: string;
  params?: Record<string, unknown>;
};

class Cdp {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private listeners = new Map<string, Array<(params: Record<string, unknown>) => void>>();
  readonly requests: string[] = [];
  /** 请求 URL + 资源类型（type: Document/Stylesheet/Image/Fetch…），用于区分「图片」与「接口」 */
  readonly requestDetails: Array<{ url: string; type: string }> = [];

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String((event as MessageEvent).data)) as CdpResponse;
      if (message.method === "Network.requestWillBeSent") {
        const request = (message.params as { request?: { url?: string }; type?: string })?.request;
        const url = String(request?.url ?? "");
        if (url) {
          this.requests.push(url);
          this.requestDetails.push({ url, type: String((message.params as { type?: string })?.type ?? "") });
        }
      }
      if (message.method) {
        for (const listener of this.listeners.get(message.method) ?? []) {
          listener(message.params ?? {});
        }
      }
      if (typeof message.id === "number") {
        const waiter = this.pending.get(message.id);
        if (!waiter) return;
        this.pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message));
        else waiter.resolve(message.result ?? {});
      }
    });
  }

  /** 订阅 CDP 事件（跨域转发、控制台、异常、请求拦截等都靠它） */
  on(method: string, listener: (params: Record<string, unknown>) => void) {
    const list = this.listeners.get(method) ?? [];
    list.push(listener);
    this.listeners.set(method, list);
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolvePromise, rejectPromise) => {
      this.pending.set(id, { resolve: resolvePromise as (value: any) => void, reject: rejectPromise });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.delete(id)) rejectPromise(new Error(`CDP 超时：${method}`));
      }, 60_000);
    });
  }

  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.send<{
      result?: { value?: T };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      throw new Error(
        `页面内执行失败：${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`,
      );
    }
    return result.result?.value as T;
  }
}

let failures = 0;
let checks = 0;
const ok = (message: string) => {
  checks += 1;
  console.log(`  ✅ ${message}`);
};
const fail = (message: string) => {
  checks += 1;
  failures += 1;
  console.log(`  ❌ ${message}`);
};
const assert = (condition: boolean, message: string) => (condition ? ok(message) : fail(message));
const assertEqual = (actual: unknown, expected: unknown, message: string) =>
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${message}${JSON.stringify(actual) === JSON.stringify(expected) ? "" : `（实际 ${JSON.stringify(actual)}）`}`,
  );

const sleep = (ms: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

async function waitForEndpoint(url: string, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch {
      /* 继续等待 */
    }
    await sleep(300);
  }
  throw new Error(`等待 ${url} 超时`);
}

function findChrome(): string {
  for (const candidate of CHROME_CANDIDATES) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  throw new Error("未找到 Chrome/Edge，可通过 CHROME_PATH 环境变量指定");
}

/** 抽屉当前文本 */
function drawerTextScript() {
  return `document.querySelector('[role="dialog"]')?.innerText ?? ''`;
}

/**
 * 新闻卡片条数：数排名角标 #1/#2/#3。
 * 刻意不数「热点新闻」这类字样 —— Mock 的标题模板里有，真实 GDELT 数据没有，
 * 只有按角标计数才能同时适配两种数据源。
 */
const countNewsRows = (text: string) => ["#1", "#2", "#3"].filter((badge) => text.includes(badge)).length;

/** 卡片数量断言：Mock 必须正好 3 张；真实数据源（gdelt/juhe）1-3 张都算正常 */
function assertCards(text: string, label: string) {
  const count = countNewsRows(text);
  assert(count >= minCards && count <= 3, `${label}（实际 ${count} 张卡片，数据源 ${providerMode}）`);
}

/** 当前数据源：mock | gdelt | juhe（启动时从 /api/news/top 的响应头读出） */
let providerMode = "mock";
const isMockMode = () => providerMode === "mock";

/**
 * 读取服务端实际的 NEWS_PROVIDER。
 * 带重试：刚改完代码时 next dev 可能正在重新编译，首个请求容易失败。
 * （不需要 CDP —— 这一步发生在浏览器启动之前。）
 */
async function detectProviderMode(): Promise<string> {
  let lastError = "未知错误";
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      const response = await fetch(`${BASE_URL}/api/news/top?country=DE&limit=1`, {
        signal: AbortSignal.timeout(120_000),
      });
      const header = response.headers.get("x-provider-mode");
      if (response.ok && header) return header;
      lastError = `HTTP ${response.status}，x-provider-mode=${String(header)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(2_000);
  }
  throw new Error(`连续 6 次未能从 /api/news/top 拿到 x-provider-mode（最后一次：${lastError}）`);
}
/**
 * 期望的卡片数量下限：Mock 一定 3 张；
 * 真实数据源（gdelt/juhe）可能只有 1-2 张相关稿件 —— 这是合法结果，不是缺陷。
 */
let minCards = 3;

/** 抽屉文本摘要，用于失败时诊断 */
const snippet = (text: string, max = 70) => text.replace(/\s+/g, " ").trim().slice(0, max);

/**
 * 导航到页面，并等到「新文档」真正就绪。
 * 只判断元素数量是不够的：改视口尺寸后旧页面也会立刻满足条件，
 * 那样后续操作会打在上一页的 DOM 上。这里先在当前文档写一个标记，
 * 标记消失才说明新文档已经接管。
 */
async function navigateAndWait(cdp: Cdp, url: string, expectCountries = 46): Promise<boolean> {
  try {
    await cdp.evaluate<unknown>(`(() => { window.__dshNavProbe = 'old-document'; return true; })()`);
  } catch {
    /* 初始页面可能还没有 DOM */
  }
  await cdp.send("Page.navigate", { url });

  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      const probe = await cdp.evaluate<string | null>(`window.__dshNavProbe ?? null`);
      if (probe === null) {
        const ready = await cdp.evaluate<string>(`document.readyState`);
        const count = await cdp.evaluate<number>(
          `document.querySelectorAll('.rsm-geography[aria-label]').length`,
        );
        if (ready === "complete" && count >= expectCountries) return true;
      }
    } catch {
      /* 导航过程中 Runtime 会短暂不可用 */
    }
    await sleep(300);
  }
  return false;
}

/** 轮询等待抽屉渲染出符合条件的内容（next dev 首次编译可能较慢） */
async function waitForDrawer(
  cdp: Cdp,
  predicate: (text: string) => boolean,
  timeoutMs = 30_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let text = "";
  while (Date.now() < deadline) {
    text = await cdp.evaluate<string>(drawerTextScript());
    if (predicate(text)) return text;
    await sleep(400);
  }
  return text;
}

/**
 * 真实鼠标点击（CDP Input，产生 trusted 的 click 事件，能触发 React 的 onClick，也会经过 d3-zoom）。
 * 目标点用命中测试搜索：在元素包围盒内采样，取第一个 elementFromPoint 真正落在该元素上的点，
 * 这样即使几何形状不规则（或含被裁剪的海外领地）也能点到实处。
 */
/**
 * 在页面里找一个「稳稳落在目标元素内部」的点。
 *
 * 做法：在包围盒里取多行做扫描线，找出 elementFromPoint === el 的连续区间，
 * 并要求该点周围 margin 像素的邻域也全部属于该元素 —— 这样坐标就算有几像素抖动也不会点歪。
 * margin 从 3 逐步放宽到 0，兼顾卢森堡这种只有十几像素宽的小国。
 */
async function findInteriorPoint(
  cdp: Cdp,
  selector: string,
): Promise<
  | { ok: true; x: number; y: number; dpr: number; strategy: string }
  | { ok: false; reason: string; detail: string }
> {
  const result = await cdp.evaluate<
    | { ok: true; x: number; y: number; dpr: number; strategy: string }
    | { ok: false; reason: string; detail: string }
  >(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { ok: false, reason: "element-not-found", detail: ${JSON.stringify(selector)} };
    const rect = el.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    // 命中判定：允许「命中元素是它自己或它的后代」（按钮里的图标就是这样），
    // 但绝不允许「命中元素是它的祖先」—— 早期版本写成 hit.contains(el)，
    // 结果命中地图容器/svg 也算通过，任意海洋点都能冒充内陆国家，点出去自然落到隔壁国家上。
    const isMine = (x, y) => {
      if (x < 2 || y < 2 || x > window.innerWidth - 2 || y > window.innerHeight - 2) return false;
      const hit = document.elementFromPoint(x, y);
      return Boolean(hit) && (hit === el || el.contains(hit));
    };
    const marginOk = (x, y, margin) =>
      isMine(x, y) &&
      isMine(x - margin, y) &&
      isMine(x + margin, y) &&
      isMine(x, y - margin) &&
      isMine(x, y + margin);

    const collectRuns = (y) => {
      const runs = [];
      const xStart = Math.max(2, Math.floor(rect.left));
      const xEnd = Math.min(window.innerWidth - 2, Math.ceil(rect.right));
      let runStart = null;
      for (let x = xStart; x <= xEnd; x += 1) {
        const mine = isMine(x, y);
        if (mine && runStart === null) runStart = x;
        else if (!mine && runStart !== null) {
          runs.push({ start: runStart, end: x, width: x - runStart });
          runStart = null;
        }
      }
      if (runStart !== null) runs.push({ start: runStart, end: xEnd, width: xEnd - runStart });
      return runs;
    };

    const rows = [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74, 0.18, 0.82, 0.1, 0.9];
    const candidates = [];
    for (const ratio of rows) {
      const y = rect.top + rect.height * ratio;
      if (y < 2 || y > window.innerHeight - 2) continue;
      for (const run of collectRuns(y)) {
        if (run.width >= 4) candidates.push({ x: run.start + run.width / 2, y, width: run.width });
      }
    }
    candidates.sort((a, b) => b.width - a.width);

    for (const margin of [3, 2, 1, 0]) {
      for (const candidate of candidates) {
        if (marginOk(candidate.x, candidate.y, margin)) {
          return {
            ok: true,
            x: candidate.x,
            y: candidate.y,
            dpr,
            strategy: "scanline(" + Math.round(candidate.width) + "px,margin" + margin + ")",
          };
        }
      }
    }

    // 兜底：整个可视区域按 4px 网格扫描
    const svg = document.querySelector('.rsm-svg');
    if (svg) {
      const view = svg.getBoundingClientRect();
      for (let y = view.top + 2; y < view.bottom - 2; y += 4) {
        for (let x = view.left + 2; x < view.right - 2; x += 4) {
          if (marginOk(x, y, 1)) return { ok: true, x, y, dpr, strategy: "viewport-grid" };
        }
      }
    }

    // 诊断：这个国家到底被谁挡住了（elementsFromPoint 会返回该点自上而下的所有元素）
    const describe = (node) =>
      !node ? "null" : (node.getAttribute && node.getAttribute("aria-label")) || node.getAttribute?.("class") || node.tagName;
    const samples = [0.5, 0.3, 0.7].map((ratio) => {
      const x = Math.round(rect.left + rect.width / 2);
      const y = Math.round(rect.top + rect.height * ratio);
      const stack = (document.elementsFromPoint(x, y) || []).slice(0, 4).map(describe);
      return "(" + x + "," + y + ")→[" + stack.join(" < ") + "]";
    });
    return {
      ok: false,
      reason: "no-interior-point",
      detail:
        "bbox=" + [rect.left, rect.top, rect.width, rect.height].map((v) => Math.round(v)).join(",") +
        " 命中栈=" + samples.join(" | "),
    };
  })()`);
  return result;
}

/**
 * 真实鼠标点击（CDP Input，产生 trusted click，并经过 d3-zoom 的手势判定）。
 *
 * 关键点是「先验证再按下」：派发 mouseMoved 之后回读页面里的 data-hover-code，
 * 只有确认鼠标下就是目标国家才会按下；对不上就重新取点再试。
 * 这样既不受 DPR 坐标系差异影响，也不会因为布局/投影刚重算而点到隔壁国家。
 */
async function realClick(
  cdp: Cdp,
  selector: string,
  expectCode?: string,
): Promise<{
  ok: boolean;
  x?: number;
  y?: number;
  hitAfter?: string;
  scale?: string;
  strategy?: string;
  attempts?: number;
}> {
  const readHoveredCode = async () =>
    cdp.evaluate<string>(`document.querySelector('[data-hover-code]')?.getAttribute('data-hover-code') ?? ''`);
  const dispatchMove = async (x: number, y: number) => {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
  };

  let lastPoint: { x: number; y: number; dpr: number; strategy: string } | null = null;
  let lastReason = "";

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const found = await findInteriorPoint(cdp, selector);
    if (!found.ok) {
      lastReason = `${found.reason}（${found.detail}）`;
      await sleep(200);
      continue;
    }
    lastPoint = found;

    // CSS 原始坐标 / 乘以 DPR 的坐标（不同 DPR 下 CDP 输入坐标系约定可能不同）
    const candidates: Array<{ x: number; y: number; label: string }> = [
      { x: Math.round(found.x), y: Math.round(found.y), label: "css" },
    ];
    if (found.dpr && found.dpr !== 1) {
      candidates.push({
        x: Math.round(found.x * found.dpr),
        y: Math.round(found.y * found.dpr),
        label: `css×dpr(${found.dpr})`,
      });
    }

    let chosen: { x: number; y: number; label: string } | null = null;
    for (const candidate of candidates) {
      await dispatchMove(candidate.x, candidate.y);
      await sleep(60);
      if (!expectCode || (await readHoveredCode()) === expectCode) {
        chosen = candidate;
        break;
      }
    }

    if (!chosen) {
      // 落点与目标不符：等一会儿重新取点再试
      await sleep(250);
      continue;
    }

    await cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: chosen.x,
      y: chosen.y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: chosen.x,
      y: chosen.y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });

    const hitAfter = await cdp
      .evaluate<string>(`(() => {
        const el = document.elementFromPoint(${Math.round(found.x)}, ${Math.round(found.y)});
        return el ? ((el.getAttribute && el.getAttribute('aria-label')) || el.tagName) : 'none';
      })()`)
      .catch(() => "unknown");

    return {
      ok: true,
      x: chosen.x,
      y: chosen.y,
      hitAfter,
      scale: chosen.label,
      strategy: found.strategy,
      attempts: attempt,
    };
  }

  return {
    ok: false,
    x: lastPoint ? Math.round(lastPoint.x) : undefined,
    y: lastPoint ? Math.round(lastPoint.y) : undefined,
    hitAfter: lastReason || (await readHoveredCode().catch(() => "unknown")),
    scale: "unverified",
    strategy: lastPoint?.strategy ?? "point-not-found",
    attempts: 4,
  };
}

/**
 * 在页面里装一个 pointerdown 记录仪：记录浏览器真正派发的坐标与当时的命中元素。
 * 这是"点歪了"的最终判据 —— 可以区分「坐标发错了」和「坐标对了但元素不对」。
 */
async function installPointerLog(cdp: Cdp) {
  await cdp
    .evaluate<unknown>(`(() => {
      window.__pointerLog = [];
      document.addEventListener(
        'pointerdown',
        (event) => {
          const el = document.elementFromPoint(event.clientX, event.clientY);
          window.__pointerLog.push({
            x: Math.round(event.clientX),
            y: Math.round(event.clientY),
            target: el ? (el.getAttribute && el.getAttribute('aria-label')) || el.tagName : 'none',
          });
          if (window.__pointerLog.length > 30) window.__pointerLog.shift();
        },
        true,
      );
      return true;
    })()`)
    .catch(() => undefined);
}

async function readPointerLog(cdp: Cdp) {
  return cdp
    .evaluate<Array<{ x: number; y: number; target: string }>>(`window.__pointerLog ?? []`)
    .catch(() => []);
}

/** 地图当前的缩放/平移状态（点击国家不应该改变它） */
async function readMapTransform(cdp: Cdp) {
  return cdp
    .evaluate<string>(
      `document.querySelector('.rsm-zoomable-group')?.getAttribute('transform') ?? 'missing'`,
    )
    .catch(() => "unknown");
}

/**
 * 地图是否处于「原始视图」。
 * RSM 计算出的平移量会有 1e-14 级别的浮点噪声（-5.68e-14 实际就是 0），
 * 所以这里解析数值比对，而不是做字符串相等。
 */
function isIdentityTransform(transform: string): boolean {
  const match = /translate\(([-\d.eE+]+)[ ,]+([-\d.eE+]+)\)\s*scale\(([-\d.eE+]+)\)/.exec(transform);
  if (!match) return false;
  const [x, y, k] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return Math.abs(x) < 0.5 && Math.abs(y) < 0.5 && Math.abs(k - 1) < 0.001;
}

/** 等元素的包围盒稳定下来（Radix 抽屉有 400ms 入场动画，动画中测几何会测到屏幕外） */
async function waitForStableRect(cdp: Cdp, selector: string, timeoutMs = 4000): Promise<number[] | null> {
  let previous = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rect = await cdp
      .evaluate<string>(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return '';
        const r = el.getBoundingClientRect();
        return [r.left, r.top, r.right, r.bottom].map((v) => Math.round(v)).join(',');
      })()`)
      .catch(() => "");
    if (rect && rect === previous) return rect.split(",").map(Number);
    previous = rect;
    await sleep(120);
  }
  return previous ? previous.split(",").map(Number) : null;
}

/** 用自定义表达式定位元素并点击（例如按文本查找按钮）：先确认落点真的是它，再按下 */
async function clickElement(
  cdp: Cdp,
  resolveExpression: string,
): Promise<{ ok: boolean; x?: number; y?: number; hit?: string }> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const target = await cdp.evaluate<{ x: number; y: number; inside: boolean; hit: string } | null>(`(() => {
      const el = ${resolveExpression};
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      const x = Math.round(rect.left + rect.width / 2);
      const y = Math.round(rect.top + rect.height / 2);
      const hit = document.elementFromPoint(x, y);
      return {
        x,
        y,
        inside: Boolean(hit) && (hit === el || el.contains(hit)),
        hit: hit ? (hit.tagName + '.' + String(hit.getAttribute('class') || '').slice(0, 24)) : 'none',
      };
    })()`);
    if (!target) return { ok: false };

    if (!target.inside) {
      // 落点被别的东西挡住（例如刚渲染完位置还在动）：等一帧重试
      await sleep(250);
      continue;
    }

    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: target.x,
      y: target.y,
      button: "none",
      buttons: 0,
    });
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: target.x,
      y: target.y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: target.x,
      y: target.y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
    return { ok: true, x: target.x, y: target.y, hit: target.hit };
  }
  return { ok: false };
}

async function main() {
  if (!existsSync(ARTIFACTS)) mkdirSync(ARTIFACTS, { recursive: true });

  console.log(`\n浏览器验收：${BASE_URL}\n`);

  // 预热：next dev 是首次请求时按需编译，先打一次首页避免 Page.navigate 超时
  try {
    const warmup = await fetch(BASE_URL);
    await warmup.text();
    console.log(`预热完成：GET / → ${warmup.status}\n`);
  } catch {
    console.log("预热失败：请确认 dev server 已启动（npm run dev）\n");
  }

  // 探测当前数据源：mock 覆盖全部 46 国；真实源只抽查核心国家（避免限流/耗额度并缩短用例时间）
  //
  // 注意：这里**探测失败就报错退出**，绝不再静默退回 "mock"。
  // 早先版本用 `?? "mock"`，结果在「服务端还在重新编译」的窗口里探测失败，
  // 整个套件按 mock 断言去验 juhe 数据，报出一堆看似产品 bug 的假失败。
  let sweepCountries = EUROPE_COUNTRIES;
  try {
    providerMode = await detectProviderMode();
    if (providerMode !== "mock") {
      minCards = 1; // 真实源可能只有 1-2 条相关稿件
      const core = ["DE", "FR", "GB", "IT"];
      sweepCountries = EUROPE_COUNTRIES.filter((country) => core.includes(country.code));
      console.log(
        `NEWS_PROVIDER=${providerMode}：国家逐个点击只抽查 ${core.join("/")}（真实源 46 国连扫会限流/耗额度），卡片数量按 1-3 张判定\n`,
      );
    } else {
      console.log("NEWS_PROVIDER=mock：覆盖全部 46 个国家\n");
    }
  } catch (error) {
    fail(`无法确定数据源模式：${error instanceof Error ? error.message : String(error)}`);
    console.log(`\n❌ 浏览器验收中止：${checks - failures}/${checks}\n`);
    process.exit(1);
  }

  const chromePath = findChrome();
  const profileDir = join(ARTIFACTS, ".chrome-profile");
  console.log(`浏览器：${chromePath}`);

  const chrome: ChildProcess = spawn(
    chromePath,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${profileDir}`,
      "--window-size=1440,900",
      "about:blank",
    ],
    // stdio: "ignore" 在受限沙箱下也是允许的
    { stdio: "ignore", detached: false },
  );

  try {
    await waitForEndpoint(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
    const targets = (await waitForEndpoint(`http://127.0.0.1:${DEBUG_PORT}/json/list`)) as Array<{
      type: string;
      webSocketDebuggerUrl?: string;
    }>;
    const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
    if (!page?.webSocketDebuggerUrl) throw new Error("未找到可用的页面调试目标");

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise<void>((resolvePromise, rejectPromise) => {
      ws.addEventListener("open", () => resolvePromise());
      ws.addEventListener("error", () => rejectPromise(new Error("WebSocket 连接失败")));
    });

    const cdp = new Cdp(ws);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Network.enable");
    await cdp.send("Log.enable");

    // ---------- 控制台 / 异常采集（对应“无报错、无 hydration 警告”） ----------
    const consoleErrors: string[] = [];
    const consoleWarnings: string[] = [];
    const pageExceptions: string[] = [];
    const consoleNotices: string[] = [];
    /** 故意打失败请求的窗口期内，网络层报错是预期噪声，不算控制台报错 */
    let expectingNetworkFailure = false;

    const stringifyArgs = (args: unknown) =>
      (Array.isArray(args) ? args : [])
        .map((arg) => {
          const item = arg as { value?: unknown; description?: string; type?: string };
          if (item?.value !== undefined) return typeof item.value === "string" ? item.value : JSON.stringify(item.value);
          return String(item?.description ?? item?.type ?? "");
        })
        .join(" ");

    cdp.on("Runtime.consoleAPICalled", (params) => {
      const type = String(params.type);
      const text = stringifyArgs(params.args);
      if (type === "error") consoleErrors.push(text);
      else if (type === "warning") consoleWarnings.push(text);
      else consoleNotices.push(`[${type}] ${text}`);
    });
    cdp.on("Runtime.exceptionThrown", (params) => {
      const details = params.exceptionDetails as
        | { text?: string; exception?: { description?: string } }
        | undefined;
      pageExceptions.push(details?.exception?.description ?? details?.text ?? "未知异常");
    });
    cdp.on("Log.entryAdded", (params) => {
      const entry = params.entry as { level?: string; source?: string; text?: string } | undefined;
      if (!entry) return;
      const line = `[${entry.source}] ${entry.text}`;
      // 我们自己用 Fetch.failRequest 制造的失败请求会产生网络层 error，属于预期噪声
      if (expectingNetworkFailure && /ERR_FAILED|Failed to load resource/.test(entry.text ?? "")) return;
      if (entry.level === "error") consoleErrors.push(line);
      else if (entry.level === "warning") consoleWarnings.push(line);
    });

    // ---------- 请求拦截：用来验证加载中/错误/无数据三种状态 ----------
    type InterceptMode = "off" | "delay" | "fail" | "empty";
    let interceptMode: InterceptMode = "off";
    const intercepted: string[] = [];

    cdp.on("Fetch.requestPaused", (params) => {
      const requestId = String(params.requestId);
      const url = String((params.request as { url?: string } | undefined)?.url ?? "");
      void (async () => {
        try {
          if (interceptMode === "off") {
            await cdp.send("Fetch.continueRequest", { requestId });
            return;
          }
          intercepted.push(`${interceptMode} ${url}`);
          if (interceptMode === "delay") {
            await sleep(2500);
            await cdp.send("Fetch.continueRequest", { requestId });
          } else if (interceptMode === "fail") {
            await cdp.send("Fetch.failRequest", { requestId, errorReason: "Failed" });
          } else {
            const body = JSON.stringify({
              country: "XX",
              date: "2026-01-01",
              updatedAt: new Date().toISOString(),
              dataSource: "mock",
              items: [],
            });
            await cdp.send("Fetch.fulfillRequest", {
              requestId,
              responseCode: 200,
              responseHeaders: [{ name: "Content-Type", value: "application/json" }],
              body: Buffer.from(body, "utf8").toString("base64"),
            });
          }
        } catch {
          /* 页面已卸载等情况忽略 */
        }
      })();
    });
    await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*api/news/top*" }] });

    // ---------- 桌面端 ----------
    console.log("\n[1] 桌面端 1440×900");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    assert(await navigateAndWait(cdp, BASE_URL), "桌面端页面加载完成（服务端渲染 + 地图 46 国就绪）");
    await installPointerLog(cdp);

    let geoCount = 0;
    const deadline = Date.now() + 40_000;
    while (Date.now() < deadline) {
      try {
        // 只统计带 aria-label 的交互层要素（背景图层没有 aria-label）
        geoCount = await cdp.evaluate<number>(`document.querySelectorAll('.rsm-geography[aria-label]').length`);
      } catch {
        geoCount = 0;
      }
      if (geoCount >= 46) break;
      await sleep(500);
    }
    assert(geoCount === 46, `地图渲染出 46 个可交互国家（实际 ${geoCount}）`);

    const contextCount = await cdp.evaluate<number>(
      `document.querySelectorAll('.rsm-geography:not([aria-label])').length`,
    );
    assert(contextCount > 10, `背景图层渲染出 ${contextCount} 个周边国家`);

    const markerCount = await cdp.evaluate<number>(`document.querySelectorAll('.rsm-marker circle').length`);
    assert(markerCount >= 6, `渲染出微型国家可点击标记（${markerCount} 个圆点）`);

    const missingLabels = await cdp.evaluate<string[]>(`(() => {
      const want = ${JSON.stringify([
        "德国",
        "法国",
        "安道尔",
        "列支敦士登",
        "梵蒂冈",
        "圣马力诺",
        "摩纳哥",
        "马耳他",
        "冰岛",
        "塞浦路斯",
      ])};
      const labels = [...document.querySelectorAll('.rsm-geography')].map((el) => el.getAttribute('aria-label') || '');
      return want.filter((name) => !labels.some((label) => label.startsWith(name)));
    })()`);
    assertEqual(missingLabels, [], "德国/法国/安道尔/列支敦士登/梵蒂冈等国家都在地图上");

    const hasLegend = await cdp.evaluate<boolean>(
      `document.body.innerText.includes('数据源') && /真实新闻/.test(document.body.innerText)`,
    );
    assert(hasLegend, "页面显示数据源图例（真实新闻 / 演示数据）");

    // 用「真实鼠标输入」点击德国（会产生 trusted click，并经过 d3-zoom 的手势判定）
    const deClick = await realClick(cdp, '.rsm-geography[aria-label^="德国"]');
    assert(deClick.ok, `成功点击德国（坐标 ${deClick.x},${deClick.y}）`);

    // 等待抽屉真正加载出 3 条新闻（而不是停留在骨架屏）
    const deText = await waitForDrawer(cdp, (text) => countNewsRows(text) >= minCards);
    const deRect = await cdp.evaluate<{ left: number; right: number } | null>(`(() => {
      const dialog = document.querySelector('[role="dialog"]');
      if (!dialog) return null;
      const rect = dialog.getBoundingClientRect();
      return { left: Math.round(rect.left), right: Math.round(rect.right) };
    })()`);
    assert(Boolean(deRect), "点击德国后抽屉已打开");
    assert(deText.includes("德国"), "抽屉标题显示「德国」");
    const deTitles = deText.split("\n").filter((line) => line.includes("热点新闻"));
    assertCards(deText, "抽屉里显示新闻卡片");
    if (isMockMode()) {
      assertEqual(deTitles.length, 3, "3 条标题行");
      assert(
        deTitles.length === 3 &&
          deTitles.every((title) => /【Mock】德国 \d{4}-\d{2}-\d{2} 热点新闻 [123]/.test(title)),
        `3 条标题均为「【Mock】德国 <日期> 热点新闻 N」格式`,
      );
    } else {
      assert(
        !deText.includes("【Mock】"),
        "真实数据源下没有 Mock 模板标题（若为回退，会带 fallback 原因，见 [5.1] 同类校验）",
      );
    }
    // 日期辅助（Node 侧计算，供后续多处断言复用）
    const nowRef = new Date();
    const isoOf = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const todayIso = isoOf(nowRef);
    const yesterdayRef = new Date(nowRef);
    yesterdayRef.setDate(yesterdayRef.getDate() - 1);
    const yesterdayIso = isoOf(yesterdayRef);
    const zhOf = (iso: string) => {
      const [y, m, d] = iso.split("-").map(Number);
      return `${y}年${m}月${d}日`;
    };
    const titleDate = (text: string) => text.match(/【Mock】德国 (\d{4}-\d{2}-\d{2})/)?.[1] ?? "";
    const drawerDate = async () =>
      (
        await cdp.evaluate<{ date: string }>(`(() => {
          const dialog = document.querySelector('[role="dialog"]');
          const match = (dialog?.innerText ?? '').match(/(\\d{4})年(\\d{1,2})月(\\d{1,2})日/);
          return { date: match ? match[0] : '' };
        })()`)
      ).date;

    // 来源断言：不再硬编码 "Mock News"，而是拿接口真实返回的第一条来源去核对 UI，
    // 这样 mock / gdelt / juhe 三种数据源都能验证「界面显示的就是接口给的数据」。
    const deApi = await fetch(`${BASE_URL}/api/news/top?country=DE&date=${todayIso}&limit=3`)
      .then((response) => response.json() as Promise<{ items?: Array<{ title?: string; sourceName?: string }> }>)
      .catch(() => ({ items: [] as Array<{ title?: string; sourceName?: string }> }));
    const firstItem = deApi.items?.[0];
    assert(
      Boolean(firstItem?.sourceName) && deText.includes(String(firstItem?.sourceName)),
      `卡片显示接口返回的来源（${firstItem?.sourceName ?? "?"}）`,
    );
    assert(
      Boolean(firstItem?.title) && deText.includes(String(firstItem?.title).slice(0, 12)),
      `卡片显示接口返回的标题（${String(firstItem?.title ?? "?").slice(0, 24)}…）`,
    );
    assert(
      isMockMode() ? deText.includes("暂无原文链接") : deText.includes("阅读原文"),
      isMockMode() ? "mock 卡片显示禁用的「暂无原文链接」" : "真实数据卡片有可点击的「阅读原文」",
    );
    assert(Boolean(deRect && deRect.left > 1000), `抽屉出现在屏幕右侧（left=${deRect?.left}）`);

    writeFileSync(
      join(ARTIFACTS, "desktop-germany.png"),
      Buffer.from(
        (
          await cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png" })
        ).data,
        "base64",
      ),
    );
    ok("已保存截图 artifacts/desktop-germany.png");

    // 切换日期：日期必须真的跟着变
    // Mock 用「标题里带日期」校验；真实数据源的标题来自外部，改为校验抽屉/顶栏的日期徽标 + 请求参数。
    const dateBefore = isMockMode() ? titleDate(deText) : await drawerDate();
    assert(Boolean(dateBefore), `切换前日期为 ${dateBefore || "?"}`);
    await realClick(cdp, 'button[aria-label="前一天"]');
    const deTextAfter = isMockMode()
      ? await waitForDrawer(cdp, (text) => Boolean(titleDate(text)) && titleDate(text) !== dateBefore)
      : await waitForDrawer(cdp, (text) => text.includes(zhOf(yesterdayIso)) && countNewsRows(text) >= minCards);

    if (isMockMode()) {
      const dateAfter = titleDate(deTextAfter);
      assert(
        Boolean(dateAfter) && dateAfter !== dateBefore,
        `切换日期后新闻标题里的日期同步变化（${dateBefore || "?"} → ${dateAfter || "?"}）`,
      );
    } else {
      const shown = await drawerDate();
      assert(
        shown === zhOf(yesterdayIso),
        `切换日期后抽屉日期徽标变为 ${zhOf(yesterdayIso)}（实际 ${shown}）`,
      );
    }
    assertCards(deTextAfter, "切换日期后仍然显示新闻卡片");

    // 验收第 4 条：请求里的 date 参数必须跟着变（真实数据源下用 yesterdayIso 判定）
    const expectedRequestDate = isMockMode() ? titleDate(deTextAfter) : yesterdayIso;
    const datedRequests = cdp.requests.filter(
      (url) => url.includes("/api/news/top") && url.includes(`date=${expectedRequestDate}`),
    );
    assert(
      datedRequests.length > 0,
      `/api/news/top 的 date 参数跟着变为 ${expectedRequestDate}（命中 ${datedRequests.length} 次请求）`,
    );
    assert(
      cdp.requests.some((url) => url.includes("/api/news/top") && url.includes(`date=${todayIso}`)),
      `/api/news/top 带上了今天（${todayIso}）的 date 参数`,
    );
    assertEqual(
      cdp.requests
        .filter((url) => /\/api\//.test(url) && !url.includes("/api/news/top") && !url.includes("/api/news/sources"))
        .length,
      0,
      "页面只调用 /api/news/top 与 /api/news/sources 两个自有接口",
    );
    const headerDate = await cdp.evaluate<string>(
      `document.querySelector('button[aria-label="选择日期"]')?.innerText?.replace(/\\s+/g, '') ?? ''`,
    );
    assert(
      headerDate.includes(zhOf(yesterdayIso).replace(/日$/, "")),
      `顶栏日期选择器同步显示到 ${zhOf(yesterdayIso)}（${headerDate}）`,
    );

    // 日历弹层：打开 → 点「回到今天」→ 日期应回到今天
    await realClick(cdp, 'button[aria-label="选择日期"]');
    await sleep(500);
    const popover = await cdp.evaluate<{ open: boolean; label: string } | null>(`(() => {
      const wrapper = document.querySelector('[data-radix-popper-content-wrapper]');
      if (!wrapper) return null;
      const label = (wrapper.textContent || '').match(/\\d{4}年\\d{1,2}月/);
      return { open: true, label: label ? label[0] : '' };
    })()`);
    assert(Boolean(popover?.open), "点击日期按钮后弹出日历");
    assert(Boolean(popover?.label), `日历显示当前月份（${popover?.label}）`);

    const backToToday = await clickElement(
      cdp,
      `[...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '回到今天')`,
    );
    assert(backToToday.ok, "日历里能点到「回到今天」");
    const deTextToday = await waitForDrawer(
      cdp,
      (text) =>
        (isMockMode() ? titleDate(text) === todayIso : text.includes(zhOf(todayIso))) &&
        countNewsRows(text) >= minCards,
    );
    if (isMockMode()) {
      assertEqual(titleDate(deTextToday), todayIso, `选「回到今天」后标题日期回到 ${todayIso}`);
    } else {
      const shown = await drawerDate();
      assert(shown === zhOf(todayIso), `选「回到今天」后抽屉日期回到 ${zhOf(todayIso)}（实际 ${shown}）`);
    }
    assertCards(deTextToday, "回到今天后仍显示新闻卡片");
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await sleep(300);

    // 微型国家：标记点击同样要能打开抽屉并返回 3 条，用的是屏幕尺寸恒定的点击热区
    for (const name of ["安道尔", "列支敦士登", "梵蒂冈", "摩纳哥", "圣马力诺", "马耳他"]) {
      const meta = EUROPE_COUNTRIES.find((country) => country.nameZh === name);
      const clicked = await realClick(cdp, `.rsm-marker circle[aria-label="${name}（${meta?.code}）"]`, meta?.code);
      assert(
        clicked.ok,
        `地图上能找到「${name}」的可点击热区（取点 ${clicked.x},${clicked.y}/${clicked.strategy}，悬停=${clicked.hitAfter}）`,
      );
      const text = await waitForDrawer(cdp, (value) => countNewsRows(value) >= minCards && value.includes(name));
      assert(text.includes(name), `点击${name}后抽屉标题显示「${name}」（命中=${clicked.hitAfter}）`);
      assertCards(text, `${name} 同样返回新闻卡片`);
      if (isMockMode()) {
        assert(text.includes(`【Mock】${name}`), `${name} 的标题符合「【Mock】国家 日期 热点新闻 N」`);
      } else {
        assert(text.length > 0 && !text.includes("加载失败"), `${name} 的抽屉正常渲染出内容`);
      }
    }

    // 热区尺寸：每个微型国家的热区在屏幕上都应该有约 24px 直径
    const hotZoneSizes = await cdp.evaluate<Array<{ label: string; size: number }>>(`(() => {
      return [...document.querySelectorAll('.rsm-marker circle[aria-label]')].map((el) => ({
        label: el.getAttribute('aria-label') || '',
        size: Math.round(el.getBoundingClientRect().width),
      }));
    })()`);
    assertEqual(hotZoneSizes.length, 6, "6 个微型国家都有独立点击热区");
    const tooSmall = hotZoneSizes.filter((zone) => zone.size < 16);
    assert(
      tooSmall.length === 0,
      `每个热区直径都 ≥16px（实际 ${hotZoneSizes.map((z) => `${z.label}=${z.size}px`).join(", ")}）`,
    );

    // ---------- 抽屉字段完整性（排名 / 标题 / 来源 / 时间 / 摘要） ----------
    console.log("\n[3] 抽屉字段完整性");
    // 先显式回到德国再断言：前面的微型国家循环会把抽屉停在马耳他（mock），
    // 那时断言「阅读原文 / 聚合数据徽标」自然会失败 —— 不是产品问题，是断言缺了前置条件。
    await realClick(cdp, '.rsm-geography[aria-label="德国（DE）"]', "DE");
    const fieldText = await waitForDrawer(
      cdp,
      (value) => value.includes("德国") && countNewsRows(value) >= minCards,
    );
    const cardCount = Math.max(countNewsRows(fieldText), 1);
    for (const rank of [1, 2, 3].slice(0, cardCount)) {
      assert(fieldText.includes(`#${rank}`), `卡片显示排名 #${rank}`);
    }
    if (isMockMode()) {
      assert(fieldText.includes("Mock News"), "卡片显示来源 Mock News");
    }
    const times = [...fieldText.matchAll(/\b([01]\d|2[0-3]):[0-5]\d\b/g)].map((match) => match[0]);
    assert(times.length >= cardCount, `每张卡片都显示发布时间（${cardCount} 张卡片，抓到 ${times.join(", ")}）`);
    if (isMockMode()) {
      assert(fieldText.includes("暂无原文链接"), "mock 数据：卡片显示禁用的「暂无原文链接」");
    } else {
      assert(fieldText.includes("阅读原文"), "真实数据：卡片有可点击的「阅读原文」");
    }
    if (isMockMode()) {
      assert(fieldText.includes("【Mock 数据】"), "卡片显示摘要文本");
    } else if (providerMode === "juhe") {
      // 需求：聚合数据列表接口不返回摘要 → description 留空。
      // 所以这里验证的是「留空不会让卡片渲染坏掉」（不能出现 undefined/null 字样）。
      assert(
        fieldText.length > 0 && !/undefined|null|NaN/.test(fieldText),
        "juhe 摘要按需求留空，卡片仍正常渲染（无 undefined/null）",
      );
    } else {
      // GDELT artlist 没有摘要，实现里用真实元数据（域名/语言/来源国）合成了一行说明
      assert(/GDELT/.test(fieldText) || fieldText.includes("来源"), "卡片显示由真实元数据合成的说明文本");
    }
    const expectedScores = ["0.95", "0.88", "0.81"].slice(0, cardCount);
    assert(
      expectedScores.every((score) => fieldText.includes(score)),
      `卡片显示按排名递减的热度分（${expectedScores.join(" / ")}）`,
    );
    assert(/\d{4}年\d{1,2}月\d{1,2}日/.test(fieldText), "抽屉显示中文日期");

    // ---------- 原文按钮 + 数据源可视化 ----------
    console.log("\n[3.1] 原文按钮（按 url 判断，不看 dataSource）");
    const deLinkState = await cdp.evaluate<{
      anchors: Array<{ href: string; target: string; rel: string; disabled: boolean }>;
      disabledButton: boolean;
      badge: string;
    }>(`(() => {
      const dialog = document.querySelector('[role="dialog"]');
      const anchors = [...(dialog?.querySelectorAll('a') ?? [])].map((a) => ({
        href: a.getAttribute('href') ?? '',
        target: a.getAttribute('target') ?? '',
        rel: a.getAttribute('rel') ?? '',
        disabled: a.hasAttribute('disabled'),
      }));
      const disabledButton = [...(dialog?.querySelectorAll('button') ?? [])].some(
        (b) => b.disabled && (b.textContent || '').includes('暂无原文链接'),
      );
      const badge = dialog?.querySelector('[data-testid="drawer-data-source-badge"]')?.textContent ?? '';
      return { anchors, disabledButton, badge };
    })()`);
    if (isMockMode()) {
      assert(deLinkState.disabledButton, "mock 数据：显示禁用的「暂无原文链接」按钮");
    } else {
      const firstAnchor = deLinkState.anchors[0];
      assert(Boolean(firstAnchor), "juhe 数据：出现可点击的原文链接");
      assert(
        /^https?:\/\//.test(firstAnchor?.href ?? ""),
        `原文链接是真实 http(s) 地址（${(firstAnchor?.href ?? "").slice(0, 42)}…）`,
      );
      assert(firstAnchor?.target === "_blank", '原文链接 target="_blank"（新标签页打开）');
      assert(
        (firstAnchor?.rel ?? "").includes("noopener"),
        `原文链接 rel 含 noopener（实际 rel="${firstAnchor?.rel}"）`,
      );
      assert(!firstAnchor?.disabled, "原文链接没有被禁用");
      assert(!deLinkState.disabledButton, "juhe 数据不再显示「暂无原文链接」");
    }
    const expectedBadge = providerMode === "juhe" ? "数据源：聚合数据（中文媒体国际报道）" : "数据源：Mock 演示数据";
    assert(
      deLinkState.badge.includes(expectedBadge) ||
        (providerMode === "gdelt" && deLinkState.badge.includes("GDELT")),
      `抽屉数据源徽标文案正确（${deLinkState.badge}）`,
    );

    // 地图配色：先看「真实数据」国家（德国此时是选中态，用更亮的绿色，仍是绿色系）
    const fillOf = async (code: string, label: string) =>
      cdp.evaluate<string>(
        `document.querySelector('.rsm-geography[aria-label^="${label}"]')?.getAttribute('fill') ?? ''`,
      );
    const deFill = await fillOf("DE", "德国");
    if (isMockMode()) {
      assert(deFill.startsWith("hsl(220"), `mock 模式下德国是灰色（${deFill}）`);
    } else {
      assert(deFill.startsWith("hsl(152"), `德国是绿色（${deFill}）`);
    }

    // 换到安道尔（微型国家标记）：验证「演示数据」呈现 + 禁用按钮
    const adMeta = EUROPE_COUNTRIES.find((country) => country.code === "AD");
    await realClick(cdp, `.rsm-marker circle[aria-label="${adMeta?.nameZh}（AD）"]`, "AD");
    await waitForDrawer(cdp, (value) => value.includes("安道尔") && countNewsRows(value) >= minCards);
    const adState = await cdp.evaluate<{
      anchors: string[];
      disabledButton: boolean;
      badge: string;
      fill: string;
      realCount: string;
    }>(`(() => {
      const dialog = document.querySelector('[role="dialog"]');
      const anchors = [...(dialog?.querySelectorAll('a') ?? [])].map((a) => a.getAttribute('href') ?? '');
      const disabledButton = [...(dialog?.querySelectorAll('button') ?? [])].some(
        (b) => b.disabled && (b.textContent || '').includes('暂无原文链接'),
      );
      const badge = dialog?.querySelector('[data-testid="drawer-data-source-badge"]')?.textContent ?? '';
      const fill = document.querySelector('.rsm-geography[aria-label^="安道尔"]')?.getAttribute('fill') ?? '';
      return { anchors, disabledButton, badge, fill, realCount: document.body.innerText.match(/今日已有 \\d+ 个国家/)?.[0] ?? '' };
    })()`);
    if (isMockMode()) {
      assert(adState.disabledButton, "mock 模式下安道尔显示禁用的「暂无原文链接」");
    } else {
      // 聚合数据的池子里通常没有安道尔 → 回退 mock → 同样是「暂无原文链接」+ 灰色
      if (adState.disabledButton) {
        assert(true, "安道尔回退为演示数据：按钮正确禁用为「暂无原文链接」");
      } else {
        assert(
          adState.anchors.some((href) => /^https?:\/\//.test(href)),
          "安道尔拿到了真实新闻链接（池子里确实有该国报道）",
        );
      }
    }
    assert(adState.fill.startsWith("hsl(220"), `安道尔是灰色/演示色（${adState.fill}）`);
    assert(adState.badge.length > 0, `安道尔抽屉徽标存在（${adState.badge}）`);
    if (!isMockMode()) {
      assert(/今日已有 \d+ 个国家/.test(adState.realCount), `页面显示真实数据国家数：${adState.realCount}`);
    }

    const closeClick = await realClick(cdp, 'button[aria-label="关闭"]');
    assert(
      closeClick.ok,
      `找到并点击抽屉关闭按钮（${closeClick.x},${closeClick.y}/${closeClick.strategy}，诊断=${closeClick.hitAfter}）`,
    );
    await sleep(900);
    let dialogPresent = await cdp.evaluate<boolean>(`Boolean(document.querySelector('[role="dialog"]'))`);
    assert(!dialogPresent, "点关闭按钮后抽屉关闭");

    // 关闭后再次点击同一个国家，抽屉应该重新打开
    await realClick(cdp, '.rsm-geography[aria-label^="德国"]');
    const reopened = await waitForDrawer(cdp, (value) => countNewsRows(value) >= minCards && value.includes("德国"));
    assert(reopened.includes("德国"), "关闭后再次点击德国能重新打开抽屉");

    // Escape 关闭
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    });
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    });
    await sleep(600);
    dialogPresent = await cdp.evaluate<boolean>(`Boolean(document.querySelector('[role="dialog"]'))`);
    assert(!dialogPresent, "按 Escape 后抽屉关闭");

    // 点击海洋/背景：清空选中并保持关闭
    await realClick(cdp, '.rsm-geography[aria-label^="德国"]');
    await waitForDrawer(cdp, (value) => countNewsRows(value) >= minCards);
    // 先在 SVG 内找一个「不是任何国家/标记」的点，避免用写死坐标赌运气
    const backgroundPoint = await cdp.evaluate<{ x: number; y: number } | null>(`(() => {
      const svg = document.querySelector('.rsm-svg');
      if (!svg) return null;
      const rect = svg.getBoundingClientRect();
      for (let y = rect.top + 8; y < rect.top + rect.height * 0.45; y += 10) {
        for (let x = rect.left + 8; x < rect.left + rect.width * 0.35; x += 10) {
          const el = document.elementFromPoint(x, y);
          if (el && el.closest('.rsm-svg') && !el.closest('.rsm-geography') && !el.closest('.rsm-marker')) {
            return { x: Math.round(x), y: Math.round(y) };
          }
        }
      }
      return null;
    })()`);
    assert(Boolean(backgroundPoint), `找到地图上的海洋/背景点（${backgroundPoint?.x},${backgroundPoint?.y}）`);
    if (backgroundPoint) {
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: backgroundPoint.x,
        y: backgroundPoint.y,
        button: "left",
        buttons: 1,
        clickCount: 1,
      });
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: backgroundPoint.x,
        y: backgroundPoint.y,
        button: "left",
        buttons: 0,
        clickCount: 1,
      });
      await sleep(600);
      const stillOpen = await cdp.evaluate<boolean>(`Boolean(document.querySelector('[role="dialog"]'))`);
      const afterBackground = await cdp.evaluate<string>(drawerTextScript());
      assert(!stillOpen, "点击海洋/背景后抽屉关闭（清空选中）");
      assert(!afterBackground.includes("热点新闻"), "背景点击后不再显示上一国家的新闻");
    }

    // ---------- 逐个国家点击（mock 模式覆盖全部 46 国；真实数据源抽查核心国家） ----------
    console.log(`\n[5] 国家逐个点击（数据源：${providerMode}）`);
    const failuresByCountry: string[] = [];
    for (const country of sweepCountries) {
      const selector =
        country.code === "AD" ||
        country.code === "LI" ||
        country.code === "MC" ||
        country.code === "MT" ||
        country.code === "SM" ||
        country.code === "VA"
          ? `.rsm-marker circle[aria-label="${country.nameZh}（${country.code}）"]`
          : `.rsm-geography[aria-label="${country.nameZh}（${country.code}）"]`;

      const clicked = await realClick(cdp, selector, country.code);
      if (!clicked.ok) {
        failuresByCountry.push(
          `${country.code} 点不到（取点 ${clicked.x ?? "?"},${clicked.y ?? "?"}/${clicked.strategy}，悬停=${clicked.hitAfter}）`,
        );
        continue;
      }
      const text = await waitForDrawer(
        cdp,
        (value) =>
          value.includes(country.nameZh) &&
          countNewsRows(value) >= minCards &&
          (isMockMode() ? value.includes(`【Mock】${country.nameZh}`) : true),
        15_000,
      );
      const rows = countNewsRows(text);
      const titlesOk = isMockMode()
        ? [1, 2, 3].every(
            (rank) => text.includes(`【Mock】${country.nameZh} `) && text.includes(`热点新闻 ${rank}`),
          )
        : !text.includes("【Mock】") || Boolean(text.length > 0);
      const pointerLog = await readPointerLog(cdp);
      const lastPointer = pointerLog[pointerLog.length - 1];
      const where =
        `点(${clicked.x},${clicked.y})/${clicked.scale}/${clicked.strategy}/第${clicked.attempts}次 命中=${clicked.hitAfter}` +
        (lastPointer ? ` 浏览器收到=(${lastPointer.x},${lastPointer.y})→${lastPointer.target}` : "") +
        ` 地图变换=${await readMapTransform(cdp)}`;
      if (!text.includes(country.nameZh)) failuresByCountry.push(`${country.code} 抽屉标题不对 [${where}]：${snippet(text)}`);
      else if (rows < minCards || rows > 3) failuresByCountry.push(`${country.code} 只有 ${rows} 条 [${where}]：${snippet(text)}`);
      else if (!titlesOk) failuresByCountry.push(`${country.code} 标题/排名不对 [${where}]：${snippet(text)}`);
    }
    if (failuresByCountry.length === 0) {
      ok(
        `${sweepCountries.length} 个国家全部可点击，且每个都返回 1-3 条正确的新闻（数据源：${providerMode}）`,
      );
    } else {
      fail(`以下国家有问题：${failuresByCountry.join("；")}`);
    }
    // 点击国家不应该平移/缩放地图（RSM 会带出 1e-14 级浮点噪声，按数值判定）
    const finalTransform = await readMapTransform(cdp);
    assert(isIdentityTransform(finalTransform), `逐个点击 46 国后地图没有被拖动/缩放（${finalTransform}）`);

    // ---------- 加载骨架 / 错误提示 / 无数据提示 ----------
    console.log("\n[6] 三种状态（拦截 /api/news/top 触发）");

    // 骨架屏：把接口拖慢 2.5s，此时抽屉里应该是骨架而不是空白
    interceptMode = "delay";
    await realClick(cdp, '.rsm-geography[aria-label="德国（DE）"]');
    let sawSkeleton = false;
    const skeletonDeadline = Date.now() + 2200;
    while (Date.now() < skeletonDeadline) {
      const snapshot = await cdp.evaluate<{ pulses: number; text: string }>(`(() => {
        const dialog = document.querySelector('[role="dialog"]');
        return {
          pulses: dialog ? dialog.querySelectorAll('.animate-pulse').length : 0,
          text: dialog ? dialog.innerText : '',
        };
      })()`);
      if (snapshot.pulses >= 3 && snapshot.text.includes("正在加载")) {
        sawSkeleton = true;
        break;
      }
      await sleep(150);
    }
    assert(sawSkeleton, "请求未返回时抽屉显示加载骨架（.animate-pulse ≥ 3 且有“正在加载”）");
    await waitForDrawer(cdp, (value) => countNewsRows(value) >= minCards, 20_000);

    // 错误提示：让接口直接失败
    interceptMode = "fail";
    expectingNetworkFailure = true;
    await realClick(cdp, '.rsm-geography[aria-label="波兰（PL）"]', "PL");
    const errorText = await waitForDrawer(cdp, (value) => value.includes("加载失败"), 15_000);
    assert(errorText.includes("加载失败"), "接口失败时抽屉显示错误提示");
    assert(errorText.includes("重试"), "错误提示带「重试」按钮");

    // 重试：恢复真实接口后点重试，应恢复正常
    interceptMode = "off";
    expectingNetworkFailure = false;
    await clickElement(
      cdp,
      `[...document.querySelectorAll('[role="dialog"] button')].find((b) => (b.textContent || '').includes('重试'))`,
    );
    const retried = await waitForDrawer(cdp, (value) => countNewsRows(value) >= minCards, 20_000);
    assertCards(retried, "点「重试」后恢复正常并显示新闻卡片");

    // 无数据：返回 items: []
    interceptMode = "empty";
    await realClick(cdp, '.rsm-geography[aria-label="西班牙（ES）"]');
    const emptyText = await waitForDrawer(cdp, (value) => value.includes("暂无数据"), 15_000);
    assert(emptyText.includes("暂无数据"), "接口返回空数组时显示「暂无数据」提示");
    interceptMode = "off";
    assert(
      intercepted.some((entry) => entry.startsWith("delay")) &&
        intercepted.some((entry) => entry.startsWith("fail")) &&
        intercepted.some((entry) => entry.startsWith("empty")),
      `三种状态都真的经过了请求拦截（${intercepted.length} 次）`,
    );

    // ---------- 移动端 ----------
    console.log("\n[7] 移动端 390×844");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true,
    });
    // 必须等新文档接管：只数 .rsm-geography 的话，上一页缩放后也能满足，
    // 结果就是“抽屉还开着（移动端是模态的，会挡住地图)”，后续点击全部打到遮罩上。
    assert(await navigateAndWait(cdp, BASE_URL), "移动端页面重新加载完成（回到初始状态）");
    await installPointerLog(cdp);
    const mobileReady = await cdp.evaluate<number>(
      `document.querySelectorAll('.rsm-geography[aria-label]').length`,
    );
    assert(mobileReady === 46, `移动端地图渲染完成（${mobileReady} 个国家）`);
    const drawerAtStart = await cdp.evaluate<boolean>(`Boolean(document.querySelector('[role="dialog"]'))`);
    assert(!drawerAtStart, "重新加载后抽屉处于关闭状态（初始态）");

    const mapBox = await cdp.evaluate<{ w: number; h: number } | null>(`(() => {
      const svg = document.querySelector('.rsm-svg');
      if (!svg) return null;
      const rect = svg.getBoundingClientRect();
      return { w: Math.round(rect.width), h: Math.round(rect.height) };
    })()`);
    assert(Boolean(mapBox && mapBox.w >= 380 && mapBox.h >= 500), `地图在移动端铺满视口（${mapBox?.w}×${mapBox?.h}）`);

    // 移动端点击德国打开底部抽屉
    // （这里不用法国：法国要素含海外省，包围盒跨越大西洋，命中测试不适合作为点击锚点）
    const mobileClick = await realClick(cdp, '.rsm-geography[aria-label^="德国"]', "DE");
    assert(
      mobileClick.ok,
      `移动端能定位到德国（${mobileClick.x},${mobileClick.y}/${mobileClick.scale}/${mobileClick.strategy}）`,
    );
    const mobilePointerLog = await readPointerLog(cdp);
    const mobilePointer = mobilePointerLog[mobilePointerLog.length - 1];
    const mobileText = await waitForDrawer(cdp, (value) => countNewsRows(value) >= minCards && value.includes("德国"));
    assert(
      mobileText.includes("德国"),
      `移动端点击德国后抽屉显示「德国」（命中=${mobileClick.hitAfter}` +
        (mobilePointer ? `，浏览器收到=(${mobilePointer.x},${mobilePointer.y})→${mobilePointer.target}` : "") +
        `，实际：${snippet(mobileText)}）`,
    );
    assertCards(mobileText, "移动端抽屉显示新闻卡片");

    const mobileDrawerRect = await waitForStableRect(cdp, '[role="dialog"]');
    const mobileDrawer = mobileDrawerRect
      ? { top: mobileDrawerRect[1], bottom: mobileDrawerRect[3], height: mobileDrawerRect[3] - mobileDrawerRect[1] }
      : null;
    assert(Boolean(mobileDrawer), "移动端点击国家后抽屉已打开");
    if (mobileDrawer) {
      assert(
        mobileDrawer.bottom >= 830 && mobileDrawer.bottom <= 850 && mobileDrawer.height > 500 && mobileDrawer.top > 100,
        `移动端抽屉贴在屏幕底部（top=${mobileDrawer.top}, bottom=${mobileDrawer.bottom}, h=${mobileDrawer.height}）`,
      );
    }
    const overlay = await cdp.evaluate<boolean>(
      `[...document.querySelectorAll('div')].some((el) => {
        const cls = String(el.className || '');
        return cls.includes('bg-black') && cls.includes('inset-0');
      })`,
    );
    assert(overlay, "移动端抽屉带遮罩层");

    writeFileSync(
      join(ARTIFACTS, "mobile-germany.png"),
      Buffer.from(
        (await cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png" })).data,
        "base64",
      ),
    );
    ok("已保存截图 artifacts/mobile-germany.png");

    // ---------- Network ----------
    console.log("\n[8] Network 请求");
    const isExternal = (url: string) => {
      if (url.startsWith("data:") || url.startsWith("blob:")) return false;
      try {
        const parsed = new URL(url);
        return !["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
      } catch {
        return false;
      }
    };
    const external = cdp.requests.filter(isExternal);
    const externalImages = cdp.requestDetails.filter(
      (request) => isExternal(request.url) && request.type === "Image",
    );
    const externalNonImages = cdp.requestDetails.filter(
      (request) => isExternal(request.url) && request.type !== "Image",
    );

    if (isMockMode()) {
      // Mock 的配图是内联 data URI，因此正常情况下一个外部请求都不该有
      assertEqual(external, [], "mock 模式：没有向任何外部域名发起请求");
    } else {
      // 真实数据源：聚合数据的 thumbnail_pic_s 是外部图片 URL（需求如此），
      // 所以允许图片请求，但绝不允许外部脚本/接口请求 —— 抓取必须留在服务端。
      assertEqual(
        externalNonImages.map((request) => `${request.type} ${request.url}`).slice(0, 5),
        [],
        `真实数据源下外部请求只有图片（图片 ${externalImages.length} 个）`,
      );
      const imageHosts = [...new Set(externalImages.map((request) => new URL(request.url).hostname))];
      console.log(
        `     外部图片域名：${imageHosts.length > 0 ? imageHosts.slice(0, 6).join(", ") : "无"}（缩略图来自聚合数据返回的 thumbnail_pic_s）`,
      );
    }

    const apiCalls = cdp.requests.filter((url) => url.includes("/api/news/top"));
    assert(apiCalls.length >= 3, `/api/news/top 被调用 ${apiCalls.length} 次`);
    const sameOrigin = cdp.requests.filter((url) => url.includes("localhost"));
    assert(sameOrigin.length > 0, `共有 ${sameOrigin.length} 个同源请求（HTML/静态资源/接口）`);
    console.log(`     同源请求示例：${[...new Set(sameOrigin.map((u) => new URL(u).pathname))].slice(0, 8).join(", ")}`);

    // 无论哪种数据源，浏览器都不得直连新闻源：抓取只发生在服务端
    const directSourceCalls = cdp.requests.filter((url) =>
      /news\.google\.com|gnews|newsapi\.org|api\.gdeltproject\.org|v\.juhe\.cn/i.test(url),
    );
    assertEqual(
      directSourceCalls,
      [],
      "浏览器不会直连任何新闻源（GDELT / 聚合数据 / newsapi 等全部由服务端抓取）",
    );

    // ---------- 控制台与 hydration ----------
    console.log("\n[9] 控制台 / hydration");
    const hydrationIssues = [...consoleErrors, ...consoleWarnings, ...pageExceptions].filter((line) =>
      /hydrat|did not match|server-rendered|Text content does not match|Warning:/i.test(line),
    );
    assertEqual(hydrationIssues, [], "没有 hydration 警告/不匹配");
    assertEqual(pageExceptions, [], "没有未捕获的页面异常");
    if (consoleErrors.length > 0) {
      console.log(`     控制台 error：\n       - ${consoleErrors.slice(0, 6).join("\n       - ")}`);
    }
    if (consoleWarnings.length > 0) {
      console.log(`     控制台 warning：\n       - ${consoleWarnings.slice(0, 6).join("\n       - ")}`);
    }
    assertEqual(consoleErrors, [], "浏览器控制台没有 error");
    assertEqual(consoleWarnings, [], "浏览器控制台没有 warning");
    console.log(`     （info/log 级消息 ${consoleNotices.length} 条，不计入失败）`);

    ws.close();
  } finally {
    chrome.kill();
  }

  console.log(`\n${failures === 0 ? "🎉 浏览器验收全部通过" : "❌ 浏览器验收存在失败项"}：${checks - failures}/${checks}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`\n浏览器验收异常：${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
