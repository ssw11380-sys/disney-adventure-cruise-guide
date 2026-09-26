import { Platform } from "react-native";
import { launcherOf, narrowScreen, readFrames, shortSide, type DeviceMemo, type FrameMemo, type ScreenLike } from "./frame";

/**
 * 설정 > 화면 정보 '공유' 글에 붙이는 홈 화면 위젯 진단 (위젯 2차 — 폴드 홈 화면이 위젯을 어떻게 두는지 폰에서 확인하려고).
 * 위젯마다 번호·지금 크기·화면·밀도와 크기 기억(widgets/frame.ts)을 한 줄씩 적는다. 서버로 보내지 않고, 사용자가 공유할 때만 글에 넣는다.
 *  - 같은 이름의 위젯이 두 화면에 하나씩(번호 둘)이면 두 화면에 따로 놓은 위젯(③), 하나인데 좁은·넓은 화면 기억이 둘 다 있으면 같은 위젯이 두 화면에(①·②)
 *  - '같은 크기 알림'이 좁은·넓은 화면 모두에 있으면 ②(화면마다), 없으면 ①처럼 보임
 */

/** 위젯 이름 → 한글 (widgets.tsx WIDGET_NAMES 와 같은 값) */
const LABELS: Record<string, string> = { Holdings: "잔고", Asset: "자산", Briefing: "브리핑", Market: "지수·환율" };

export interface WidgetSeen {
  /** 위젯 이름 (WIDGET_NAMES 값) */
  name: string;
  widgetId: number;
  width: number;
  height: number;
  screenInfo?: (ScreenLike & { densityDpi?: number }) | null;
  memo: FrameMemo | null;
}

/** 지난 시간 (고정 시계 테스트용 순수 함수) */
function ago(at: number, now: number): string {
  const m = Math.max(0, Math.floor((now - at) / 60_000));
  if (m < 1) return "방금";
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}시간 전` : `${Math.floor(h / 24)}일 전`;
}

const KIND_TEXT = { one: "한 화면에서만 봄", range: "한 그림을 두 화면이 같이 쓰는 것처럼 보임(①)", perScreen: "화면마다 다시 그림(②)" } as const;

/** 공유 글 줄 (순수 함수) */
export function widgetReportLines(list: readonly WidgetSeen[], device: DeviceMemo, now: number): string[] {
  const count = Object.entries(LABELS).map(([name, label]) => `${label} ${list.filter((w) => w.name === name).length}개`);
  const lines = [`[위젯] ${count.join(" · ")}`, `[위젯] 넓은 화면(짧은 변 600dp 이상)을 본 때: ${device.big !== undefined ? ago(device.big, now) : "없음"}`];
  for (const w of list) {
    const s = w.screenInfo;
    const sw = shortSide(s);
    const screen = sw !== null ? `화면 ${Math.round(s!.screenWidthDp!)}×${Math.round(s!.screenHeightDp!)}${typeof s?.density === "number" ? ` · 밀도 ${Number(s.density.toFixed(3))}` : ""}` : "화면 모름";
    const rows = (w.memo?.seen ?? []).map(
      (r) =>
        `${narrowScreen(r.sw) ? "좁은" : "넓은"} 화면(${Math.round(r.sw)}) ${r.o === "p" ? "세로" : "가로"} ${r.w}×${r.h}${r.t ? " 런처 확인" : ""}${r.r !== undefined ? ` · 같은 크기 알림 ${ago(r.r, now)}` : ""} · ${ago(r.at, now)}`,
    );
    const memo = w.memo ? `기억 ${rows.length ? rows.join(" / ") : "없음"} · 판단 ${KIND_TEXT[launcherOf(w.memo)]}` : "기억 없음";
    lines.push(`[위젯] ${LABELS[w.name] ?? w.name} #${w.widgetId}: 지금 ${w.width}×${w.height}dp (${screen}) · ${memo}`);
  }
  return lines;
}

/** 홈 화면 위젯을 읽어 진단 줄을 만든다. 안드로이드가 아니거나 위젯 모듈이 없으면(개발 클라이언트 등) 빈 목록 */
export async function widgetReport(now = Date.now()): Promise<string[]> {
  try {
    if (Platform.OS !== "android") return [];
    const { getWidgetInfo } = await import("react-native-android-widget");
    const list: Omit<WidgetSeen, "memo">[] = [];
    for (const name of Object.keys(LABELS)) {
      for (const i of await getWidgetInfo(name)) list.push({ name, widgetId: i.widgetId, width: i.width, height: i.height, screenInfo: i.screenInfo });
    }
    const frames = await readFrames(list.map((w) => w.widgetId));
    return widgetReportLines(
      list.map((w) => ({ ...w, memo: frames?.memos.get(w.widgetId) ?? null })),
      frames?.device ?? {},
      now,
    );
  } catch {
    return [];
  }
}
