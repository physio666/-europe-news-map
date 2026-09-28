import { HomePageClient } from "@/components/HomePageClient";
import { todayIsoDate } from "@/lib/date";
import { getProviderId } from "@/lib/providers";

/**
 * 服务端组件：只负责在**请求时**确定「今天」，其余交互交给客户端组件。
 *
 * 为什么要这么拆：
 *  1. `todayIsoDate()` 如果在客户端组件里用 useState 初始化，`next build` 静态预渲染时
 *     会把「构建当天」的日期写进 HTML，用户隔天访问时客户端算出的日期与 HTML 不一致，
 *     直接触发 React hydration mismatch 报错。由服务端在请求时给出 initialDate，
 *     服务端输出与客户端首次渲染就是同一个字符串。
 *  2. 因此页面必须是动态渲染（force-dynamic），否则 initialDate 会停留在构建时刻。
 *  3. 客户端挂载后会用浏览器本地时区再校正一次（见 HomePageClient），
 *     保证跨时区用户看到的「今天」也是对的，且这次更新发生在 hydration 之后，不会报错。
 */
export const dynamic = "force-dynamic";

export default function Page() {
  // providerMode 由服务端读取（NEWS_PROVIDER），用于顶栏展示当前配置的数据源
  return <HomePageClient initialDate={todayIsoDate()} providerMode={getProviderId()} />;
}
