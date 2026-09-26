import React, { useEffect, useMemo, useState } from "react";
import { Linking, Platform, Text, View } from "react-native";
import { useMarketStatus } from "@/api/hooks";
import { useNow } from "@/lib/useNow";
import { readWidgetRefreshLog, refreshSummaryText, summarizeRefreshLog, type RefreshEntry, type RefreshSummary } from "@/lib/widgetRefreshLog";
import { font, space, useTheme } from "@/theme";
import { Button, Muted } from "./ui";

/**
 * 설정 > 표시 > 홈 화면 위젯 갱신 아래 (위젯 리뷰 2, 플래그 widgetRefreshLog): 기기에 적어 둔 자동 갱신 기록 요약
 * ('마지막 자동 갱신 10:47 · 오늘 평균 간격 18분'), 장중 1시간 넘게 자동 갱신이 없으면 경고, 이 앱 설정(앱 정보 → 배터리) 열기.
 * 기록은 lib/widgetRefreshLog (백그라운드 작업·위젯 주기 갱신이 적는다). 1분마다 다시 읽는다
 */
export function WidgetRefreshStatus() {
  const ms = useMarketStatus().data;
  // 장중: 한국(08:00~20:00)·미국 정규장 중 달력으로 열린 시장이 있음 — 이때만 1시간 넘게 멈춘 것을 경고한다
  const marketOpen = !!ms && (ms.KR.isOpen || ms.US.isOpen);
  const now = useNow(60_000);
  const [log, setLog] = useState<RefreshEntry[] | null>(null);
  useEffect(() => {
    let alive = true;
    void readWidgetRefreshLog().then((l) => {
      if (alive) setLog(l);
    });
    return () => {
      alive = false;
    };
  }, [now]);
  const summary = useMemo(() => (log ? summarizeRefreshLog(log, now, marketOpen) : null), [log, now, marketOpen]);
  return <WidgetRefreshView summary={summary} now={now} onOpenBattery={() => void openBatterySettings()} />;
}

/** 버튼 화면 읽기 이름: 무엇을 여는지와 거기서 할 일을 함께 */
const BATTERY_BUTTON_LABEL = "이 앱 설정 열기. 배터리에서 제한 없음을 고르세요";
/** 쉬운 말 안내: 버튼이 여는 화면(앱 정보)에 실제로 있는 메뉴 이름으로 — 삼성 One UI 는 '배터리', 다른 폰은 '앱 배터리 사용량' */
const BATTERY_HELP =
  "앱을 닫아 두면 위젯이 잘 안 바뀌나요? 아래 버튼을 누르면 이 앱의 정보 화면이 열려요. 거기서 배터리 → 제한 없음을 골라 주세요. (메뉴 이름이 '앱 배터리 사용량'인 폰도 있어요.)";

/**
 * 경고 글: 기록 자체가 없으면(작업이 멈춤) 절전 안내, 작업은 도는데 실패만 하면 절전 탓이 아니라 실패 사유 (통합 검증 지적)
 */
function staleText(s: RefreshSummary): string {
  if (s.failing) return `장중인데 1시간 넘게 자동 갱신이 실패하고 있습니다${s.lastError ? ` (${s.lastError})` : ""}. 휴대폰 절전 문제는 아니에요. 인터넷 연결을 확인해 주세요. 연결이 괜찮은데 계속되면 서버 문제일 수 있어요.`;
  return "장중인데 1시간 넘게 자동 갱신이 없었습니다. 휴대폰 절전 기능이 위젯 갱신을 막고 있을 수 있어요.";
}

/** 보이는 부분 (테스트용으로 따로): 요약 한 줄 · 경고 · 쉬운 말 안내 · 이 앱 설정 열기 버튼(안드로이드만) */
export function WidgetRefreshView({ summary, now, onOpenBattery }: { summary: RefreshSummary | null; now: number; onOpenBattery: () => void }) {
  const t = useTheme();
  const line = summary ? refreshSummaryText(summary, now) : "자동 갱신 기록 확인 중…";
  return (
    <View style={{ gap: space.xs, paddingTop: space.xs }}>
      <Text accessibilityLabel={`위젯 자동 갱신: ${line}`} style={{ color: t.ink, fontSize: font.small }}>
        {line}
      </Text>
      {summary?.stale ? <Text style={{ color: t.warn, fontSize: font.small, fontWeight: "600" }}>{staleText(summary)}</Text> : null}
      {Platform.OS === "android" ? (
        <>
          <Muted style={{ fontSize: font.tiny }}>{BATTERY_HELP}</Muted>
          <Button title="이 앱 설정 열기" variant="secondary" compact icon="battery-half-outline" onPress={onOpenBattery} accessibilityLabel={BATTERY_BUTTON_LABEL} />
        </>
      ) : null}
    </View>
  );
}

/**
 * 이 앱의 정보 화면(앱 정보 → 배터리 → 제한 없음)을 연다 (통합 검증 지적 — 안내 글과 같은 화면을 먼저).
 * 예전에는 모든 앱이 나오는 '배터리 최적화' 목록을 먼저 열어, 안내 글('배터리 → 제한 없음')과 화면이 맞지 않았다(One UI 목록에는 '제한 없음'이 없다).
 * 앱 정보 화면이 안 열리면(드문 기기) 배터리 최적화 목록. 둘 다 안 되면 조용히 끝난다
 */
export async function openBatterySettings(): Promise<void> {
  try {
    await Linking.openSettings();
  } catch {
    await Linking.sendIntent("android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS").catch(() => undefined);
  }
}
