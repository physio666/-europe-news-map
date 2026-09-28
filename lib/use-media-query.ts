"use client";

import * as React from "react";

const MOBILE_QUERY = "(max-width: 767px)";

/** 是否为移动端视口（用于决定抽屉方向：右侧 / 底部） */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = React.useState(false);

  React.useEffect(() => {
    const mql = window.matchMedia(MOBILE_QUERY);
    const update = () => setIsMobile(mql.matches);
    update();
    mql.addEventListener("change", update);
    return () => mql.removeEventListener("change", update);
  }, []);

  return isMobile;
}
