import { Platform } from "react-native";
import type { WidgetInfo } from "react-native-android-widget";
import { readPnlMode, type WidgetData } from "./data";
import { fontScaleNow } from "./fontScale";

/**
 * 서버를 부르지 않고 주어진 데이터로 위젯 4종(잔고·자산·브리핑·지수·환율)을 다시 그린다 (위젯 리뷰 6).
 * 위젯 2차: 실패 뒤 첫 성공(다른 위젯의 '갱신 실패'를 지움 — widgetTaskHandler)과, 앱이 떠 있을 때 접고 폈을 때(그 화면 크기로 — WidgetBridge)도 쓴다.
 * 백그라운드 갱신이 연달아 실패했을 때 쓴다: loadWidgetData 가 실패하면 돌려주는 값(마지막으로 받은 숫자 + error)을 그대로 그려
 * 위젯이 스스로 갱신하다 실패했을 때와 같은 '갱신 실패 · …'·'지연'이 보이게 한다 — 예전에는 조용히 끝나 30분 넘게 멀쩡해 보였다.
 * 위젯이 없으면 아무 일도 없다. Android 전용, 라이트·다크 두 벌 (refresh.tsx 의 앱 즉시 갱신과 같은 그리기).
 * 그리는 모듈은 부를 때 읽는다 — 백그라운드 작업 모듈(lib/backgroundBriefings)이 위젯 부품을 미리 읽지 않게
 */
export async function redrawAllWidgets(data: WidgetData, now = Date.now()): Promise<void> {
  if (Platform.OS !== "android") return;
  try {
    const [{ requestWidgetUpdate }, { renderFor }, { WIDGET_NAMES }] = await Promise.all([import("react-native-android-widget"), import("./render"), import("./widgets")]);
    const pnlMode = await readPnlMode();
    const fontScale = fontScaleNow();
    for (const name of [WIDGET_NAMES.holdings, WIDGET_NAMES.asset, WIDGET_NAMES.briefing, WIDGET_NAMES.market]) {
      await requestWidgetUpdate({ widgetName: name, renderWidget: (info: WidgetInfo) => renderFor(name, data, info, { fontScale, now, pnlMode }) });
    }
  } catch {
    /* 위젯 모듈이 없는 빌드(개발 클라이언트 등)에서는 무시 */
  }
}
