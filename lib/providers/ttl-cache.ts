/**
 * 极简 TTL 内存缓存（进程内，够用且零依赖）。
 *
 * 为什么不是 LRU / redis：本项目是单进程的 Mock→真实数据源改造，
 * 缓存的目标只是「别把 GDELT 的免费公共接口打爆」+「同一国家同一天不要重复抓」。
 *
 * 两个细节是刻意加的：
 *  1. `getOrLoad` 会合并并发请求（in-flight dedupe）——
 *     同一瞬间多个浏览器/多个国家请求不会打出多次上游调用。
 *  2. `set(key, value, ttlMs)` 允许给「上游暂时查不到」这种结果一个更短的 TTL，
 *     避免坏结果被缓存一小时，也避免每次刷新都去戳上游。
 */

export type CacheEntry<T> = { value: T; expiresAt: number };

export class TtlCache<T> {
  private readonly store = new Map<string, CacheEntry<T>>();
  private readonly inflight = new Map<string, Promise<T>>();
  private readonly defaultTtlMs: number;

  // 刻意不用 TS 的「参数属性」写法（constructor(private readonly x)）：
  // 那是需要代码生成的语法，Node 原生类型擦除（strip-only）会直接拒绝执行，
  // 而本项目希望 lib/ 下的模块既能被 Next 打包，也能被 node scripts/*.mts 直接跑。
  constructor(defaultTtlMs: number) {
    this.defaultTtlMs = defaultTtlMs;
  }

  /** 读取（过期即视为不存在并清除） */
  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T, ttlMs = this.defaultTtlMs): void {
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  /** 是否存在未过期的缓存 */
  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
    this.inflight.clear();
  }

  size(): number {
    return this.store.size;
  }

  /**
   * 命中直接返回；未命中则执行 loader，并把结果写回缓存。
   * 同一个 key 上并发的调用会共享同一个 Promise。
   */
  async getOrLoad(key: string, loader: () => Promise<T>, ttlMs = this.defaultTtlMs): Promise<T> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;

    const pending = this.inflight.get(key);
    if (pending) return pending;

    const task = (async () => {
      try {
        const value = await loader();
        this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();

    this.inflight.set(key, task);
    return task;
  }

  /** 仅用于诊断/测试：返回每个 key 的剩余毫秒数 */
  inspect(): Array<{ key: string; ttlRemainingMs: number }> {
    const now = Date.now();
    return [...this.store.entries()].map(([key, entry]) => ({
      key,
      ttlRemainingMs: Math.max(0, entry.expiresAt - now),
    }));
  }
}
