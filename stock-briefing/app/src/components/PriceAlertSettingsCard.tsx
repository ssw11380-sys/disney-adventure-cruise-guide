import Ionicons from "@expo/vector-icons/Ionicons";
import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { PriceAlertRule } from "@/api/types";
import { confirmRemoveAlert } from "@/components/PriceAlertSheet";
import { Card, Muted, SectionTitle } from "@/components/ui";
import { usePriceAlerts } from "@/lib/priceAlertContext";
import { ALERT_TEXT, firedLine, firedSpeech, removeLabel, ruleLabel, ruleSpeech } from "@/lib/priceAlerts";
import { useNow } from "@/lib/useNow";
import { font, space, touch, useTheme } from "@/theme";

/**
 * 설정 탭 '가격 알림' 칸 (3-29, 플래그 priceAlerts — 설정 화면이 서버에 연결됐고 켜져 있을 때만 속성 없이 그린다).
 * 겉 부품은 문맥(usePriceAlerts)의 조건·지우기·종목 이름과 시계(useNow)만 읽는다 — 쿼리 클라이언트를 읽지 않는다.
 * 속 부품(PriceAlertSettingsList)은 속성만 받는다 (테스트가 속성으로 그린다)
 */
export function PriceAlertSettingsCard() {
  const { rules, remove, nameOf } = usePriceAlerts();
  const nowMs = useNow(60_000);
  const names: Record<string, string> = {};
  for (const r of rules) names[r.code] ??= nameOf(r.code);
  return <PriceAlertSettingsList rules={rules} names={names} nowMs={nowMs} onRemove={(r) => void remove(r)} />;
}

/** 모든 조건 목록 (종목 · 조건 · 오늘 울렸는지)과 지우기 — 지우기는 시트와 같은 확인 창. 여러 종목이 한 목록이라 지우기 이름표·확인 창에 종목 이름을 넣는다 */
export function PriceAlertSettingsList({ rules, names, nowMs, onRemove }: { rules: PriceAlertRule[]; names: Record<string, string>; nowMs: number; onRemove: (rule: PriceAlertRule) => void }) {
  const t = useTheme();
  return (
    <Card>
      <SectionTitle>{ALERT_TEXT.settingsTitle}</SectionTitle>
      <Muted style={{ fontSize: font.tiny }}>{ALERT_TEXT.settingsAbout}</Muted>
      {rules.length === 0 ? (
        <Text style={[styles.empty, { color: t.muted }]}>{ALERT_TEXT.settingsEmpty}</Text>
      ) : (
        rules.map((r) => {
          const name = names[r.code] ?? r.code;
          return (
            <View key={r.id} style={[styles.row, { borderTopColor: t.line }]}>
              <View accessible accessibilityLabel={`${name}, ${ruleSpeech(r)}, ${firedSpeech(r, nowMs)}`} style={styles.text}>
                <Text style={{ color: t.ink, fontSize: font.body }}>{`${name} · ${ruleLabel(r)}`}</Text>
                <Text style={{ color: t.muted, fontSize: font.small }}>{firedLine(r, nowMs)}</Text>
              </View>
              <Pressable onPress={() => confirmRemoveAlert(r, () => onRemove(r), name)} accessibilityRole="button" accessibilityLabel={removeLabel(r, name)} style={styles.remove}>
                <Ionicons name="close" size={font.h2} color={t.muted} />
              </Pressable>
            </View>
          );
        })
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  empty: { fontSize: font.small, paddingTop: space.sm },
  row: { flexDirection: "row", alignItems: "center", borderTopWidth: StyleSheet.hairlineWidth, marginTop: space.xs },
  text: { flex: 1, minWidth: 0, gap: space.xxs, paddingVertical: space.s },
  remove: { width: touch.min, minHeight: touch.min, alignItems: "center", justifyContent: "center", marginRight: -space.sm },
});
