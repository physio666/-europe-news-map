/**
 * 聚合数据（Juhe）错误码 → 可读说明。
 *
 * 聚合数据的约定：HTTP 永远是 200，业务结果看 `error_code`：
 *   error_code === 0  → 成功，数据在 result.data
 *   error_code !== 0  → 失败，`reason` 里是服务端的原文说明
 * 所以「HTTP 200」绝不等于「查到了新闻」，必须看 error_code。
 *
 * 这里把常见错误码翻译成人话，并区分「配置问题」和「额度问题」——
 * 这两类原因对使用者的下一步动作完全不同（换 Key vs 等明天）。
 */

export const JUHE_ERROR_CODES: Record<number, string> = {
  10001: "无效的请求KEY",
  10002: "该KEY无请求权限",
  10003: "KEY过期",
  10004: "错误的OPENID",
  10005: "应用未审核超时",
  10007: "未知的请求源",
  10008: "被禁止的IP",
  10009: "被禁止的KEY",
  10011: "当前IP请求超过限制",
  10012: "请求超过次数限制",
  10013: "测试KEY超过请求限制",
};

/** 额度类错误码：属于「今天别再试了」的情况，回退后应提示等额度恢复 */
const QUOTA_ERROR_CODES = new Set([10011, 10012, 10013]);

/** 配置类错误码：Key 本身有问题，改配置才能好 */
const CONFIG_ERROR_CODES = new Set([10001, 10002, 10003, 10005, 10007, 10008, 10009]);

export type JuheErrorKind = "quota" | "config" | "business" | "unknown";

export function juheErrorKind(code: number): JuheErrorKind {
  if (QUOTA_ERROR_CODES.has(code)) return "quota";
  if (CONFIG_ERROR_CODES.has(code)) return "config";
  if (code !== 0) return "business";
  return "unknown";
}

/** 给使用者看的建议（配合 check:juhe / 响应头的可读原因） */
export function juheErrorHint(code: number): string {
  switch (juheErrorKind(code)) {
    case "quota":
      return "该 Key 当日额度已用尽（免费额度约 50 次/天），已改用 Mock 数据，请明天再试或升级套餐";
    case "config":
      return "请检查 JUHE_NEWS_KEY 是否正确、是否已申请「新闻头条」接口权限";
    default:
      return "聚合数据返回业务错误，已回退 Mock";
  }
}

/** 拼一句完整的错误说明：错误码 + 官方文案 + 我们的建议 */
export function describeJuheError(code: number, reason?: string | null): string {
  const text = JUHE_ERROR_CODES[code] ?? (reason?.trim() || `未知错误码 ${code}`);
  const parts = [`聚合数据错误码 ${code}：${text}`];
  if (reason && reason.trim() && reason.trim() !== text) parts.push(`官方说明「${reason.trim()}」`);
  parts.push(juheErrorHint(code));
  return parts.join("；");
}
