import { Platform } from "react-native";
import { loadCachedWidgetData } from "./data";
import { PAD, WIDE, WIDE_EXTRAS_MIN_DP } from "./layout";
import { readSizeLog, type SizeLog, type SizeRow, type SizeSource } from "./sizeLog";

/**
 * 설정 > 화면 정보 '공유' 글에 붙이는 홈 화면 위젯 진단 (위젯 2차 — 폴드 홈 화면이 위젯을 어떻게 두는지 폰에서 확인하려고).
 * 위젯마다 번호·지금 크기·화면·밀도와 최근에 받은 크기(sizeLog.ts — widgetFoldFit 이 켜져 있을 때 적힘)를 한 줄씩 적는다.
 * 서버로 보내지 않고, 사용자가 공유할 때만 글에 넣는다. 배치에는 쓰지 않는다 (넓은 모습은 위젯 폭 하나로만 — layout.ts wideExtrasOk).
 * 이 줄 자체를 붙일지는 앱 플래그 widgetFoldFit 이 정한다 (components/ScreenInfoCard — 꺼져 있으면 공유 글이 예전과 같다).
 * 첫 줄의 규칙은 위젯이 그릴 때 실제로 쓰는 플래그(마지막으로 받은 위젯 응답의 features.foldFit — render.tsx 와 같은 값)를 따른다:
 * 켜져 있으면 '폭 560dp 이상만', 꺼져 있으면 예전 기준(504/540/644dp)을 적고 크기 기록은 보이지 않는다(꺼진 동안 적지 않으므로, 켰다가 끈 뒤 남은 옛 줄은 헷갈리게만 한다)
 *  - 같은 이름의 위젯이 둘(번호 둘)이면 두 화면에 따로 놓은 위젯(③)
 *  - 한 번호가 좁은 화면·넓은 화면에서 모두 그려졌으면 같은 위젯이 두 화면에(①·②). 접고 펼 때 '크기 변경' 줄이 번갈아 오면 ②(화면마다 다시 그림)
 */

/** 위젯 이름 → 한글 (widgets.tsx WIDGET_NAMES 와 같은 값) */
const LABELS: Record<string, string> = { Holdings: "잔고", Asset: "자산", Briefing: "브리핑", Market: "지수·환율" };
const BY: Record<SizeSource, string> = { add: "추가", resize: "크기 변경", update: "주기", click: "누름", app: "앱" };
/** 두 화면의 짧은 변이 이 비율 넘게 다르면 다른 화면 (폴드8 바깥 ↔ 안쪽은 30% 넘게, 폰을 돌린 것은 10~20%) */
const DISPLAY_DIFF = 0.25;
/** 위젯이 쓰는 넓은 모습 규칙 (첫 줄). 꺼짐 = 예전 WIDE 기준의 위젯 폭: 평가금액 칸(한 열 480 + 좌우 여백) · 지수 옆 칸 · 두 열(한 열 300 × 2 + 사이 + 좌우 여백) */
const RULE_ON = `넓은 모습은 폭 ${WIDE_EXTRAS_MIN_DP}dp 이상만`;
const RULE_OFF = `넓은 모습은 예전 기준(평가금액 칸 ${WIDE.valueMin + PAD * 2}dp·지수 옆 칸 ${WIDE.boardMin}dp·두 열 ${WIDE.columnMin * 2 + WIDE.columnGap + PAD * 2}dp 이상) · 크기 기록 안 함(widgetFoldFit 꺼짐)`;

export interface WidgetNow {
  /** 위젯 이름 (WIDGET_NAMES 값) */
  name: string;
  widgetId: number;
  width: number;
  height: number;
  screenInfo?: { screenWidthDp?: number; screenHeightDp?: number; density?: number } | null;
}

/** 지난 시간 (고정 시계 테스트용 순수 함수) */
function ago(at: number, now: number): string {
  const m = Math.max(0, Math.floor((now - at) / 60_000));
  if (m < 1) return "방금";
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}시간 전` : `${Math.floor(h / 24)}일 전`;
}

const screenText = (w: number | undefined, h: number | undefined) => (w && h ? `화면 ${Math.round(w)}×${Math.round(h)}` : "화면 모름");

/** 기록 줄들이 두 화면(짧은 변이 25% 넘게 다름)에서 그려졌는지 */
function twoScreens(rows: readonly SizeRow[]): boolean {
  const sides = rows.flatMap((r) => (r.sw && r.sh ? [Math.min(r.sw, r.sh)] : []));
  if (sides.length < 2) return false;
  const lo = Math.min(...sides);
  const hi = Math.max(...sides);
  return (hi - lo) / hi > DISPLAY_DIFF;
}

/**
 * 공유 글 줄 (순수 함수). foldFit: 위젯이 그릴 때 쓰는 widgetFoldFit (마지막 위젯 응답의 features.foldFit).
 * 꺼져 있으면 첫 줄에 예전 기준을 적고, 위젯 줄에는 크기 기록을 넣지 않는다 (꺼진 동안은 적지 않으므로 남은 줄은 옛것뿐)
 */
export function widgetReportLines(list: readonly WidgetNow[], log: SizeLog, now: number, foldFit: boolean): string[] {
  const count = Object.entries(LABELS).map(([name, label]) => `${label} ${list.filter((w) => w.name === name).length}개`);
  const lines = [`[위젯] ${count.join(" · ")} · ${foldFit ? RULE_ON : RULE_OFF}`];
  for (const w of list) {
    const s = w.screenInfo;
    const density = typeof s?.density === "number" ? ` · 밀도 ${Number(s.density.toFixed(3))}` : "";
    const rows = log[String(w.widgetId)] ?? [];
    const recent = rows.length
      ? `최근 ${[...rows]
          .reverse()
          .map((r) => `${BY[r.by]} ${r.w}×${r.h} (${screenText(r.sw, r.sh)}) ${ago(r.at, now)}`)
          .join(" / ")}${twoScreens(rows) ? " · 두 화면에서 그려짐" : ""}`
      : "기록 없음";
    lines.push(`[위젯] ${LABELS[w.name] ?? w.name} #${w.widgetId}: 지금 ${w.width}×${w.height}dp (${screenText(s?.screenWidthDp, s?.screenHeightDp)}${density})${foldFit ? ` · ${recent}` : ""}`);
  }
  return lines;
}

/**
 * 홈 화면 위젯을 읽어 진단 줄을 만든다. 안드로이드가 아니거나 위젯 모듈이 없으면(개발 클라이언트 등) 빈 목록.
 * 규칙은 위젯이 마지막으로 그린 데이터의 플래그로 (앱 플래그와 잠깐 다를 수 있다 — 위젯 응답을 새로 받기 전)
 */
export async function widgetReport(now = Date.now()): Promise<string[]> {
  try {
    if (Platform.OS !== "android") return [];
    const { getWidgetInfo } = await import("react-native-android-widget");
    const list: WidgetNow[] = [];
    for (const name of Object.keys(LABELS)) {
      for (const i of await getWidgetInfo(name)) list.push({ name, widgetId: i.widgetId, width: i.width, height: i.height, screenInfo: i.screenInfo });
    }
    // 못 읽으면 꺼짐으로 (그림도 저장한 값이 없으면 꺼짐 기준으로 그린다)
    const foldFit = await loadCachedWidgetData().then((d) => d.features.foldFit === true, () => false);
    return widgetReportLines(list, foldFit ? await readSizeLog() : {}, now, foldFit);
  } catch {
    return [];
  }
}
