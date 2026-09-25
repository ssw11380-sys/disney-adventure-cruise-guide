import React, { useEffect, useMemo, useState } from "react";
import { Linking, Platform, Text, View } from "react-native";
import { useMarketStatus } from "@/api/hooks";
import { useNow } from "@/lib/useNow";
import { readWidgetRefreshLog, refreshSummaryText, summarizeRefreshLog, type RefreshEntry, type RefreshSummary } from "@/lib/widgetRefreshLog";
import { font, space, useTheme } from "@/theme";
import { Button, Muted } from "./ui";

/**
 * 설정 > 표시 > 홈 화면 위젯 갱신 아래 (위젯 리뷰 2, 플래그 widgetRefreshLog): 기기에 적어 둔 자동 갱신 기록 요약
 * ('마지막 자동 갱신 10:47 · 오늘 평균 간격 18분'), 장중 1시간 넘게 자동 갱신이 없으면 경고, 배터리 설정 열기.
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

/** 보이는 부분 (테스트용으로 따로): 요약 한 줄 · 경고 · 쉬운 말 안내 · 배터리 설정 버튼(안드로이드만) */
export function WidgetRefreshView({ summary, now, onOpenBattery }: { summary: RefreshSummary | null; now: number; onOpenBattery: () => void }) {
  const t = useTheme();
  const line = summary ? refreshSummaryText(summary, now) : "자동 갱신 기록 확인 중…";
  return (
    <View style={{ gap: space.xs, paddingTop: space.xs }}>
      <Text accessibilityLabel={`위젯 자동 갱신: ${line}`} style={{ color: t.ink, fontSize: font.small }}>
        {line}
      </Text>
      {summary?.stale ? (
        <Text style={{ color: t.warn, fontSize: font.small, fontWeight: "600" }}>장중인데 1시간 넘게 자동 갱신이 없었습니다. 휴대폰 절전 기능이 위젯 갱신을 막고 있을 수 있어요.</Text>
      ) : null}
      {Platform.OS === "android" ? (
        <>
          <Muted style={{ fontSize: font.tiny }}>앱을 닫아 두면 위젯이 잘 안 바뀌나요? 휴대폰 설정에서 이 앱을 배터리 사용량 → 제한 없음으로 바꿔 주세요.</Muted>
          <Button title="배터리 설정 열기" variant="secondary" compact icon="battery-half-outline" onPress={onOpenBattery} accessibilityLabel="배터리 설정 열기" />
        </>
      ) : null}
    </View>
  );
}

/**
 * 안드로이드 배터리 최적화 설정 화면을 연다 (앱 목록에서 이 앱을 '제한 없음'·'최적화 안 함'으로).
 * 기기가 그 화면을 모르면(제조사마다 다름) 이 앱의 설정 화면(앱 정보 → 배터리)
 */
export async function openBatterySettings(): Promise<void> {
  try {
    await Linking.sendIntent("android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS");
  } catch {
    await Linking.openSettings().catch(() => undefined);
  }
}
