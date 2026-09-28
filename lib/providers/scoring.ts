/**
 * 排名 → 热度分，Mock 与 GDELT 共用同一套规则，避免两个数据源分数口径不一致。
 * 需求固定：0.95 / 0.88 / 0.81，超过 3 条时按 0.07 继续递减。
 */
export const RANK_SCORES = [0.95, 0.88, 0.81] as const;

export function scoreForRank(rank: number): number {
  const fixed = RANK_SCORES[rank - 1];
  if (typeof fixed === "number") return fixed;
  return Math.max(0.5, Number((0.81 - (rank - 3) * 0.07).toFixed(2)));
}
