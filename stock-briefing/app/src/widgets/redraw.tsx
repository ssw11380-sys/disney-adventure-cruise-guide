import { Platform } from "react-native";
import type { WidgetInfo } from "react-native-android-widget";
import { clearWidgetAccountData, readPnlMode, signedOutWidgetData, type WidgetData } from "./data";
import { fontScaleNow } from "./fontScale";
import { assertSessionIdentity, sessionIdentityVersion } from "@/lib/session";

/** 계정 변경의 빈 그림은 기기 저장 정리를 기다리지 않는다. 늦은 빈 그림도 다음 로그인 뒤에는 버린다. */
export function resetWidgetsForAccountChange(): void {
  const identity = sessionIdentityVersion();
  void clearWidgetAccountData();
  if (Platform.OS !== "android") return;
  void (async () => {
    try {
      const [{ getWidgetInfo, requestWidgetUpdateById }, { renderFor }, { WIDGET_NAMES }] = await Promise.all([import("react-native-android-widget"), import("./render"), import("./widgets")]);
      const now = Date.now();
      const data = signedOutWidgetData(now);
      const fontScale = fontScaleNow();
      for (const name of [WIDGET_NAMES.holdings, WIDGET_NAMES.asset, WIDGET_NAMES.briefing, WIDGET_NAMES.market]) {
        assertSessionIdentity(identity);
        const infos = await getWidgetInfo(name);
        assertSessionIdentity(identity);
        for (const info of infos) {
          // ById는 비동기 renderWidget을 기다리므로 세대 변경 오류도 아래 catch로 회수된다.
          await requestWidgetUpdateById({ widgetName: name, widgetId: info.widgetId, renderWidget: async (box) => {
            assertSessionIdentity(identity);
            const rendered = await renderFor(name, data, box, { fontScale, now, pnlMode: "cumulative" });
            assertSessionIdentity(identity);
            return rendered;
          } });
        }
      }
    } catch {
      /* 계정이 바뀌었거나 위젯 모듈을 쓸 수 없으면 다음 계정의 그림에 맡긴다. */
    }
  })();
}

/**
 * 서버를 부르지 않고 주어진 데이터로 위젯 4종(잔고·자산·브리핑·지수·환율)을 다시 그린다 (위젯 리뷰 6).
 * 위젯 2차: 실패 뒤 첫 성공(다른 위젯의 '갱신 실패'를 지움 — widgetTaskHandler)에도 쓴다.
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
