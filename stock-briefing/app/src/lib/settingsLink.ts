import { router } from "expo-router";
import { useUx } from "@/lib/uxFlags";

/**
 * 오류 화면·끊김 띠의 '설정 열기' (3-24, 기능 플래그 emptyGuide): 설정 탭을 열고 '서버 연결' 칸을 펼쳐 보이는 곳까지 스크롤한다.
 * 설정 화면은 주소 검색어 open=server 를 보고 칸을 펼친다. at(누른 시각)은 같은 요청을 두 번 눌러도 다시 펼치게 한다
 * (사용자가 칸을 접은 뒤 다른 화면에서 또 누른 경우)
 */
export const OPEN_SERVER = "server";

export function serverSettingsParams(now = Date.now()): { open: string; at: string } {
  return { open: OPEN_SERVER, at: String(now) };
}

type Nav = Pick<typeof router, "canDismiss" | "dismissTo" | "navigate">;

/**
 * 설정 탭으로. 종목 상세·비중·브리핑 상세처럼 루트 스택에 쌓인 화면 위에서 navigate 하면 탭 묶음 (tabs) 전체가 하나 더 쌓인다
 * (이름이 다른 NAVIGATE 는 새로 쌓음 → 뒤로 가기가 새 탭 → 상세 → 원래 탭 순이 되고 탭 화면이 둘). 그래서 스택 위면 기존 탭까지 닫고(dismissTo),
 * 탭 안(잔고·브리핑·발견)이면 탭만 바꾼다(navigate — 탭 안에서 dismissTo 는 처리되지 않음). 알림으로 여는 탭 경로와 같은 규칙 (NotificationBridge, BH-50).
 * 어느 쪽인지는 누르는 순간의 내비게이션 상태로 정한다 (같은 부품이 탭 안 칸·스택 화면 양쪽에 쓰인다 — 넓은 창 브리핑 본문 등)
 */
export function openServerSettings(nav: Nav = router): void {
  const href = { pathname: "/settings", params: serverSettingsParams() } as never;
  if (nav.canDismiss()) nav.dismissTo(href);
  else nav.navigate(href);
}

/**
 * 오류 화면(ErrorView)·끊김 띠(StaleBanner)에 넘길 '설정 열기' 속성. 연결 오류 안내(lib/uxFlags connectionGuide)가 꺼져 있으면 null —
 * 속성 자체를 넘기지 않아 지금 화면과 한 글자도 같다 (`<ErrorView ... {...guide} />`)
 */
export function useSettingsGuide(): { onOpenSettings: () => void } | null {
  return useUx().connectionGuide ? GUIDE_PROPS : null;
}
const GUIDE_PROPS = Object.freeze({ onOpenSettings: () => openServerSettings() });

/** 설정 화면이 받은 검색어에서 이번에 펼칠 요청 (없으면 null) — 같은 요청이면 같은 값 */
export function serverOpenRequest(params: { open?: string | string[]; at?: string | string[] }): string | null {
  const open = Array.isArray(params.open) ? params.open[0] : params.open;
  if (open !== OPEN_SERVER) return null;
  const at = Array.isArray(params.at) ? params.at[0] : params.at;
  return at ?? OPEN_SERVER;
}
