/** 32 位 FNV-1a 哈希：同一输入永远得到同一输出（Mock 数据稳定性的基础） */
export function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** 由种子生成的确定性伪随机数发生器（mulberry32），保证刷新/多进程结果一致 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 从数组中确定性取一个元素 */
export function pick<T>(items: readonly T[], rand: () => number): T {
  return items[Math.floor(rand() * items.length) % items.length];
}
