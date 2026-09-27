import type { Health } from "@/api/types";
import { formatDateKo } from "@/lib/format";

/**
 * 첫 실행 안내 한 화면(app/welcome, 기능 플래그 firstRun)의 글 (순수 함수 — 테스트가 문구를 본다).
 * 세 가지만: 홈 화면 위젯 추가법 · 알림 권한 · 토스증권 연동 상태. 서버 주소·토큰 입력 단계는 넣지 않는다 (토큰은 APK 에 있다 — 로드맵 3-24)
 */

/** 위젯 이름은 홈 화면 위젯 목록에 보이는 이름 그대로 (app.json) */
export const WIDGET_NAMES = ["내 종목 시세", "오늘의 브리핑", "총 평가금액", "지수·환율"] as const;

export const WIDGET_STEPS = [
  "홈 화면의 빈 곳을 길게 누릅니다",
  "'위젯'을 누르고 목록에서 '주식 브리핑'을 찾습니다",
  `${WIDGET_NAMES.map((n) => `'${n}'`).join(" · ")} 중 하나를 길게 눌러 홈 화면에 놓습니다`,
] as const;

export type Tone = "good" | "warn" | "muted";

/**
 * 알림 권한 한 줄 + 누를 버튼. status 는 expo-notifications 권한 상태(granted·denied·undetermined), 모르면 null.
 * 다시 물을 수 없게 거절된 경우(canAskAgain=false)는 버튼 대신 휴대폰 설정 경로를 알려 준다
 */
export function notifyLine(status: string | null, canAskAgain: boolean): { text: string; tone: Tone; ask: boolean } {
  // 권한만으로는 브리핑 알림이 오지 않는다 (알림 등록은 설정 > 알림 '브리핑 알림' 스위치가 한다) — 켜진 것으로 오해하지 않게 분명히 적는다
  if (status === "granted") return { text: "권한 허용됨 · 브리핑 알림을 받으려면 설정 > 알림에서 '브리핑 알림'을 켜세요 (이미 켰다면 그대로 옵니다)", tone: "good", ask: false };
  if (status === null) return { text: "알림 권한을 확인하지 못했습니다 · 설정 > 알림에서 확인할 수 있습니다", tone: "muted", ask: false };
  if (status === "denied" && !canAskAgain) return { text: "꺼져 있음 · 휴대폰 설정 > 애플리케이션 > 주식 브리핑 > 알림에서 켤 수 있습니다", tone: "warn", ask: false };
  return { text: "아직 허용하지 않음 · 허용한 뒤 설정 > 알림에서 '브리핑 알림'을 켜면 받습니다", tone: "warn", ask: true };
}

/** 토스증권 연동 상태 한 줄 (서버 /health 에서) */
export function tossLine(h: { data?: Health; isError: boolean }): { text: string; tone: Tone } {
  if (!h.data) return h.isError ? { text: "서버에 연결되지 않아 확인하지 못했습니다", tone: "warn" } : { text: "확인 중…", tone: "muted" };
  if (h.data.limited) return { text: "서버 연결이 끝나면 확인할 수 있습니다", tone: "muted" };
  const s = h.data.tossOpenApi;
  if (!s) return { text: "이 서버는 연동 상태를 알려 주지 않습니다", tone: "muted" };
  if (!s.configured) return { text: "연결되지 않음 · 종목은 검색해서 직접 추가할 수 있습니다", tone: "muted" };
  const parts = ["연결됨"];
  if (s.sync?.lastRunAt) parts.push(`마지막 동기화 ${formatDateKo(s.sync.lastRunAt, true)}`);
  if (s.sync?.lastChanges) parts.push(`보유 ${s.sync.lastChanges.holdings}종목 자동 등록`);
  return { text: parts.join(" · "), tone: "good" };
}
