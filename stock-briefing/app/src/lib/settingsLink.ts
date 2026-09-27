import { router } from "expo-router";

/**
 * 오류 화면·끊김 띠의 '설정 열기' (3-24, 기능 플래그 emptyGuide): 설정 탭을 열고 '서버 연결' 칸을 펼쳐 보이는 곳까지 스크롤한다.
 * 설정 화면은 주소 검색어 open=server 를 보고 칸을 펼친다. at(누른 시각)은 같은 요청을 두 번 눌러도 다시 펼치게 한다
 * (사용자가 칸을 접은 뒤 다른 화면에서 또 누른 경우)
 */
export const OPEN_SERVER = "server";

export function serverSettingsParams(now = Date.now()): { open: string; at: string } {
  return { open: OPEN_SERVER, at: String(now) };
}

export function openServerSettings(): void {
  router.navigate({ pathname: "/settings", params: serverSettingsParams() } as never);
}

/** 설정 화면이 받은 검색어에서 이번에 펼칠 요청 (없으면 null) — 같은 요청이면 같은 값 */
export function serverOpenRequest(params: { open?: string | string[]; at?: string | string[] }): string | null {
  const open = Array.isArray(params.open) ? params.open[0] : params.open;
  if (open !== OPEN_SERVER) return null;
  const at = Array.isArray(params.at) ? params.at[0] : params.at;
  return at ?? OPEN_SERVER;
}
