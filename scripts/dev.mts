#!/usr/bin/env node
/**
 * dev 启动器：让开发服务器使用独立的输出目录 `.next-dev`。
 *
 * 为什么需要它：
 *   `next dev` 与 `next build` 默认共用 `.next`。生产构建会整体重写该目录，
 *   把 dev server 正在使用的 server chunk 删掉，随后任何请求都会报
 *   `Cannot find module './948.js'`（表现为接口 500、页面白屏）。
 *   我们实际踩过一次，所以这里用独立目录把两者彻底隔离：
 *   之后无论怎么交替执行 `npm run dev` / `npm run build`，甚至同时跑，都不会互相破坏。
 *
 * 说明：这里用 stdio: "inherit" 只是为了不多套一层管道，
 * Next 自身启动 server 时仍会 fork 子进程，因此启动方式与 `next dev` 完全一致。
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const nextBin = require.resolve("next/dist/bin/next");

const child = spawn(process.execPath, [nextBin, "dev", ...process.argv.slice(2)], {
  stdio: "inherit",
  // 允许调用方覆盖输出目录（例如同时再起一个不同数据源的实例做对比测试，互不干扰）
  env: { ...process.env, NEXT_DIST_DIR: process.env.NEXT_DIST_DIR || ".next-dev" },
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
