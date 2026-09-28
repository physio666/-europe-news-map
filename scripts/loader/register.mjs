/** 注册 `@/` 别名解析钩子：node --import ./scripts/loader/register.mjs ... */
import { register } from "node:module";

// register(specifier, parentURL)：用 URL 相对定位，避免把 URL 再当路径拼一次
register(new URL("./alias-hooks.mjs", import.meta.url));
