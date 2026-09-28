/**
 * 给独立脚本用的 .env 加载器（零依赖）。
 *
 * 为什么需要：`next dev` 会自动加载 .env / .env.local，但 `node scripts/*.mts` 不会。
 * 于是「用户在 .env.local 里配好了 Key，跑自检脚本却说没配」——很容易被误判成代码 bug。
 *
 * 规则刻意保持简单可预期：
 *   - 只读这几个文件（靠前的优先）：.env.local、.env
 *   - shell 里已存在的变量优先，不会被文件覆盖
 *   - 支持 # 注释、KEY=VALUE、去掉成对引号
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export function loadEnvFiles(files = [".env.local", ".env"], cwd = process.cwd()) {
  const loaded = [];
  for (const file of files) {
    const path = resolve(cwd, file);
    if (!existsSync(path)) continue;
    for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
    loaded.push(file);
  }
  return loaded;
}
