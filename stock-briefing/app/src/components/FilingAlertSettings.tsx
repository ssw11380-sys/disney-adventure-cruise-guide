import React, { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useFeature, useHealth } from "@/api/hooks";
import { Muted, Toggle } from "@/components/ui";
import { KR_NO_KEY, KR_NOT_YET, lastAlertLine, SETTING_ABOUT, SETTING_DEVICE_OFF, SETTING_MUTED, SETTING_TITLE, settingQuiet } from "@/lib/filingAlerts";
import { filingAlertsEnabled, readFilingLog, setFilingAlertsEnabled } from "@/lib/filingSeen";
import { font, space, useTheme } from "@/theme";

/**
 * 설정 > 알림 카드의 '공시 알림' 줄 (3-38, 플래그 filingAlerts — 꺼져 있으면 아무것도 그리지 않아 카드가 지금과 같다).
 * 스위치 값은 이 기기에 저장 (기본 켬 — '브리핑 알림' 스위치와 같은 성격). 위 '브리핑 알림'(이 기기 알림)이 꺼져 있으면 흐리게 + 안내.
 * '마지막 공시 알림 … · SEC에 올라온 뒤 …'는 폰 확인(20분 기준)을 위한 사실 기록 (기기 안 최근 20건)
 */
export function FilingAlertSettings({
  deviceOn,
  quiet,
  mutedCount,
}: {
  /** 이 기기 브리핑 알림(푸시·백그라운드 확인)이 켜져 있는지 */
  deviceOn: boolean;
  /** 조용한 시간 (켜져 있을 때만) */
  quiet: { start: string; end: string } | null;
  /** 종목별 알림에서 끈 종목 수 */
  mutedCount: number;
}) {
  const on = useFeature("filingAlerts", false);
  if (!on) return null;
  return <FilingAlertRows deviceOn={deviceOn} quiet={quiet} mutedCount={mutedCount} />;
}

function FilingAlertRows({ deviceOn, quiet, mutedCount }: { deviceOn: boolean; quiet: { start: string; end: string } | null; mutedCount: number }) {
  const t = useTheme();
  const health = useHealth();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [last, setLast] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void Promise.all([filingAlertsEnabled(), readFilingLog()]).then(([e, log]) => {
      if (!alive) return;
      setEnabled(e);
      setLast(lastAlertLine(log));
    });
    return () => {
      alive = false;
    };
  }, []);
  // DART 키가 있는 서버는 /health sources.financials 가 'dart(한국)' 로 시작한다 — 모르면 키 없음 글(지금 서버의 사실)
  const dartKey = /^dart/.test(health.data?.sources?.["financials"] ?? "");
  const toggle = (v: boolean) => {
    setEnabled(v);
    void setFilingAlertsEnabled(v);
  };
  return (
    <View style={styles.block}>
      <View style={styles.switchRow}>
        <Text style={{ color: deviceOn ? t.ink : t.muted, fontSize: font.body, flex: 1 }}>{SETTING_TITLE}</Text>
        <Toggle value={enabled ?? true} onValueChange={toggle} disabled={!deviceOn || enabled === null} accessibilityLabel={SETTING_TITLE} />
      </View>
      <Muted style={styles.note}>{SETTING_ABOUT}</Muted>
      {!deviceOn ? <Muted style={styles.note}>{SETTING_DEVICE_OFF}</Muted> : null}
      {quiet ? <Muted style={styles.note}>{settingQuiet(quiet.start, quiet.end)}</Muted> : null}
      {mutedCount > 0 ? <Muted style={styles.note}>{SETTING_MUTED}</Muted> : null}
      <Muted style={styles.note}>{dartKey ? KR_NOT_YET : KR_NO_KEY}</Muted>
      {last ? <Muted style={styles.note}>{last}</Muted> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  block: { gap: space.xxs },
  switchRow: { flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: space.xs },
  note: { fontSize: font.tiny },
});
