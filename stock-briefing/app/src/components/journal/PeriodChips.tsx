import { DateTimePickerAndroid } from "@react-native-community/datetimepicker";
import React, { useState } from "react";
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Button, Chip } from "@/components/ui";
import { customRangeError, dayHeader, JOURNAL, PERIODS, type ListPreset } from "@/lib/journal";
import { font, radius, space, useTheme } from "@/theme";

/**
 * 기간 칩 줄 (3-37 매매일지 기록·수익률 탭): 1주 · 1달 · 3달 · 올해 · 1년 · 직접. 가로로 밀 수 있고(줄바꿈 없음) 칩은 누르는 곳 44.
 * '직접'은 작은 창 '기간 고르기'(시작·끝 [바꾸기] — 안드로이드 날짜 고르기) → [적용]. 400일 넘으면 적용하지 않고 안내
 * extra: 칩 줄 끝에 더 붙일 것 (기록 탭의 종목 칩, 수익률 탭의 시장 칩)
 */
export function PeriodChips({
  value,
  custom,
  today,
  onChange,
  extra,
}: {
  value: ListPreset;
  custom: { from: string; to: string } | null;
  today: string;
  onChange: (preset: ListPreset, custom?: { from: string; to: string }) => void;
  extra?: React.ReactNode;
}) {
  const [picking, setPicking] = useState(false);
  return (
    <>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row} keyboardShouldPersistTaps="handled">
        {PERIODS.map((p) => (
          <Chip
            key={p.value}
            label={p.label}
            active={value === p.value}
            accessibilityLabel={`기간 ${p.label}`}
            onPress={() => (p.value === "custom" ? setPicking(true) : onChange(p.value))}
          />
        ))}
        {extra}
      </ScrollView>
      {picking ? (
        <RangeSheet
          initial={custom ?? { from: addMonths(today, -1), to: today }}
          today={today}
          onClose={() => setPicking(false)}
          onApply={(r) => {
            setPicking(false);
            onChange("custom", r);
          }}
        />
      ) : null}
    </>
  );
}

function addMonths(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
}

const toDate = (s: string) => new Date(`${s}T12:00:00`);
const fromDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** '기간 고르기' 작은 창 */
function RangeSheet({ initial, today, onClose, onApply }: { initial: { from: string; to: string }; today: string; onClose: () => void; onApply: (r: { from: string; to: string }) => void }) {
  const t = useTheme();
  const [range, setRange] = useState(initial);
  const err = customRangeError(range.from, range.to);
  const pick = (key: "from" | "to") => {
    if (Platform.OS !== "android") return;
    DateTimePickerAndroid.open({
      value: toDate(range[key]),
      mode: "date",
      maximumDate: toDate(today),
      onChange: (event, date) => {
        if (event.type !== "set" || !date) return;
        setRange((r) => ({ ...r, [key]: fromDate(date) }));
      },
    });
  };
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: t.scrim }]} onPress={onClose} accessibilityRole="button" accessibilityLabel={`${JOURNAL.pickPeriod} ${JOURNAL.close}`} />
        <View style={[styles.sheet, { backgroundColor: t.surface, borderColor: t.lineStrong }]}>
          <Text style={{ color: t.ink, fontSize: font.h2, fontWeight: "700" }} accessibilityRole="header">
            {JOURNAL.pickPeriod}
          </Text>
          {(["from", "to"] as const).map((k) => (
            <View key={k} style={styles.pickRow}>
              <Text style={{ color: t.muted, fontSize: font.body, minWidth: space.xl * 2 }}>{k === "from" ? "시작" : "끝"}</Text>
              <Text style={{ color: t.ink, fontSize: font.body, fontWeight: "700", flex: 1 }}>{dayHeader(range[k])}</Text>
              <Button title={JOURNAL.change} compact variant="secondary" accessibilityLabel={`${k === "from" ? "시작" : "끝"} 날짜 ${JOURNAL.change}`} onPress={() => pick(k)} />
            </View>
          ))}
          {err ? (
            <Text style={{ color: t.warn, fontSize: font.small }} accessibilityRole="alert">
              {err}
            </Text>
          ) : null}
          <View style={styles.actions}>
            <Button title={JOURNAL.apply} disabled={!!err} onPress={() => onApply(range)} />
            <Button title={JOURNAL.close} variant="secondary" onPress={onClose} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: space.s, paddingHorizontal: space.lg, paddingVertical: space.sm },
  backdrop: { flex: 1, justifyContent: "center", alignItems: "center", padding: space.lg },
  sheet: { width: "100%", maxWidth: 560, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.lg, padding: space.lg, gap: space.sm },
  pickRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
  actions: { gap: space.sm, paddingTop: space.xs },
});
