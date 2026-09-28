#!/usr/bin/env node
/**
 * 清理 Next.js 构建产物：删除工作目录下所有 `.next*` 目录（.next / .next-dev / .next-dev-* 等）。
 *
 *   npm run clean
 *
 * 为什么需要它：dev 与 build 的输出目录虽然已经隔离（见 scripts/dev.mts），
 * 但一旦有人绕过 `npm run dev` 直接跑 `next dev`（distDir 会退回 `.next`），
 * 而 `.next` 里恰好是我方生产构建的产物，就会出现「页面 200 但 CSS/JS 全 404」的坏状态。
 * 这种时候最快的修法就是清干净再起。
 */

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const cwd = process.cwd();
const targets = readdirSync(cwd).filter(
  (name) => name.startsWith(".next") && statSync(join(cwd, name)).isDirectory(),
);

if (targets.length === 0) {
  console.log("没有需要清理的 .next* 目录");
} else {
  for (const name of targets) {
    const path = join(cwd, name);
    if (!existsSync(path)) continue;
    rmSync(path, { recursive: true, force: true });
    console.log(`已删除 ${name}`);
  }
}

console.log(`\n清理完成，共 ${targets.length} 个目录。下一步：npm run dev`);
