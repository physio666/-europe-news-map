/**
 * Node 原生解析钩子：让 `npm run check:providers` 这类脚本能直接跑应用代码。
 *
 * 需要它是因为应用代码是「打包器风格」的写法，而 `node scripts/*.mts` 是原生执行：
 *   1. `@/lib/xxx`  —— tsconfig 路径别名，Node 不认；
 *   2. `./scoring`  —— 无扩展名的相对导入，Node 的 ESM 要求写全扩展名。
 * 这里补上这两件事，其余一律交回 Node 默认流程，绝不自作聪明：
 *   - 只接受真实存在的「文件」；
 *   - 不介入 node_modules 里的包；
 *   - 不指定 format，让 .ts 继续走 Node 的类型擦除。
 */

import { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// 本文件位于 <root>/scripts/loader/ 下
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const NODE_MODULES_SEGMENT = `${path.sep}node_modules${path.sep}`;

const SUFFIXES = ["", ".ts", ".tsx", ".mts", ".js", ".mjs", "/index.ts", "/index.tsx", "/index.js"];

function firstExistingFile(basePath) {
  for (const suffix of SUFFIXES) {
    const candidate = basePath + suffix;
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* 继续尝试下一个后缀 */
    }
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  const isAlias = specifier === "@" || specifier.startsWith("@/");
  const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
  if (!isAlias && !isRelative) return nextResolve(specifier, context);
  // 已经带扩展名的相对导入交给默认流程（node_modules 内部也走这里）
  if (/\.[cm]?[jt]sx?$/.test(specifier)) return nextResolve(specifier, context);

  let basePath = null;
  if (isAlias) {
    basePath = path.join(projectRoot, specifier === "@" ? "" : specifier.slice(2));
  } else if (context.parentURL?.startsWith("file:")) {
    const parentDir = path.dirname(fileURLToPath(context.parentURL));
    if (!`${parentDir}${path.sep}`.includes(NODE_MODULES_SEGMENT)) {
      basePath = path.resolve(parentDir, specifier);
    }
  }
  if (!basePath) return nextResolve(specifier, context);

  const resolved = firstExistingFile(basePath);
  if (!resolved) return nextResolve(specifier, context);

  return { url: pathToFileURL(resolved).href, shortCircuit: true };
}
