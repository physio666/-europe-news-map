import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";

/**
 * Provider 层共用的 HTTP 客户端（零依赖）。
 *
 * 为什么不用内置 fetch（undici）：
 *   undici 的 connectTimeout 固定 10 秒且不可配置，实测到部分境外接口 TCP 握手经常 >10s，
 *   表现成 `UND_ERR_CONNECT_TIMEOUT` —— 与业务无关却会被当成「接口挂了」。
 *   这里用 node:https 的 socket timeout 统一覆盖「建立连接 + 读取响应」两个阶段，
 *   超时完全由调用方控制。
 */

export type HttpTextResponse = { status: number; body: string };

export type HttpGetOptions = {
  timeoutMs: number;
  headers?: Record<string, string>;
};

export function httpsGetText(url: string, options: HttpGetOptions): Promise<HttpTextResponse> {
  return new Promise((resolve, reject) => {
    const isHttp = url.startsWith("http://");
    const doRequest = isHttp ? httpRequest : httpsRequest;
    const req = doRequest(
      url,
      {
        method: "GET",
        headers: { accept: "application/json", ...options.headers },
        timeout: options.timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => chunks.push(Buffer.from(chunk)));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("timeout", () => req.destroy(new Error(`请求超时（${options.timeoutMs}ms）`)));
    req.on("error", reject);
    req.end();
  });
}

/** 日志脱敏：把 URL 里的 key/token 换成 ***，避免把 AppKey 写进日志 */
export function redactUrl(url: string): string {
  return url.replace(/([?&](?:key|apikey|api_key|token)=)[^&]*/gi, "$1***");
}
