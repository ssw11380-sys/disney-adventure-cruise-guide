import React, { useEffect, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useSaveTradeNote } from "@/api/hooks";
import type { JournalItem } from "@/api/types";
import { Button } from "@/components/ui";
import { afterBuyText, calcRows, clampNote, detailRows, JOURNAL, NOTE_MAX, noteLength, type DetailRow } from "@/lib/journal";
import { changeColor, font, radius, space, useTheme } from "@/theme";

/**
 * 거래 상세 (3-37): 체결 · 수량 · 평균 체결가 · 금액 · 주문 상태, 매도는 '실현손익 계산'(판매 금액 − 평균 구매가 × 수량 = 실현손익 · 수수료·세금 · 원화로는)과
 * 계산 방법·출발한 기록, 매수는 '이 매수 뒤 평균 구매가'. 아래 메모(200자, 서버에 저장 — 저장 뒤 '메모를 저장했어요.' 3초, 실패하면 입력 그대로 두고 안내).
 * 휴대폰은 아래에서 올라오는 창(TradeDetailSheet), 폴드 가로 2단은 오른쪽 칸(TradeDetailBody 그대로), 폴드 세로는 가운데 창(최대 560dp)
 */
export function TradeDetailBody({ item, onClose }: { item: JournalItem; onClose?: () => void }) {
  const t = useTheme();
  const sell = item.side === "SELL";
  const calc = sell ? calcRows(item) : null;
  const after = sell ? null : afterBuyText(item);
  return (
    <View style={styles.body}>
      <Text style={{ color: t.ink, fontSize: font.title, fontWeight: "800" }} accessibilityRole="header">
        {`${item.name} ${sell ? "매도" : "매수"}`}
      </Text>
      <Rows rows={detailRows(item)} />
      {calc ? (
        <View style={styles.section}>
          <Text style={{ color: t.ink, fontSize: font.h2, fontWeight: "700" }} accessibilityRole="header">
            실현손익 계산
          </Text>
          <Rows rows={calc.rows} />
          {calc.notes.map((n) => (
            <Text key={n} style={{ color: t.muted, fontSize: font.small }}>
              {n}
            </Text>
          ))}
        </View>
      ) : null}
      {after ? <Text style={{ color: t.sub, fontSize: font.body }}>{after}</Text> : null}
      {item.orderId ? <NoteEditor item={item} /> : null}
      {onClose ? <Button title={JOURNAL.close} variant="secondary" onPress={onClose} /> : null}
    </View>
  );
}

function Rows({ rows }: { rows: DetailRow[] }) {
  const t = useTheme();
  return (
    <View>
      {rows.map((r) => (
        <View key={r.label} style={[styles.kv, { borderBottomColor: t.line }]} accessible accessibilityLabel={`${r.label} ${r.value}`}>
          <Text style={[styles.kvLabel, { color: t.muted }]}>{r.label}</Text>
          <Text style={[styles.kvValue, { color: r.sign !== undefined ? changeColor(t, r.sign) : t.ink }]}>{r.value}</Text>
        </View>
      ))}
    </View>
  );
}

/** 메모 입력: 200자에서 멈춘다. 저장 결과는 화면 읽기가 바로 읽는 알림 영역 */
function NoteEditor({ item }: { item: JournalItem }) {
  const t = useTheme();
  const save = useSaveTradeNote();
  const [text, setText] = useState(item.note ?? "");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 다른 거래를 고르면 그 거래의 메모로 다시 시작한다
  const [forKey, setForKey] = useState(item.key);
  if (forKey !== item.key) {
    setForKey(item.key);
    setText(item.note ?? "");
    setMsg(null);
  }
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const submit = (value: string) => {
    if (!item.orderId || save.isPending) return;
    save.mutate(
      { account: item.account, orderId: item.orderId, note: value },
      {
        onSuccess: (r) => {
          setText(r.note ?? "");
          setMsg({ ok: true, text: JOURNAL.noteSaved });
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => setMsg(null), 3_000);
        },
        // 실패하면 입력은 그대로 둔다
        onError: () => setMsg({ ok: false, text: JOURNAL.noteFailed }),
      },
    );
  };
  return (
    <View style={styles.section}>
      <Text style={{ color: t.ink, fontSize: font.h2, fontWeight: "700" }} accessibilityRole="header">
        {JOURNAL.noteTitle}
      </Text>
      <TextInput
        value={text}
        onChangeText={(v) => setText(clampNote(v))}
        placeholder={JOURNAL.notePlaceholder}
        multiline
        textAlignVertical="top"
        placeholderTextColor={t.muted}
        accessibilityLabel={JOURNAL.noteA11y}
        style={[styles.input, { color: t.ink, borderColor: t.lineStrong, backgroundColor: t.surfaceAlt }]}
        testID="note-input"
      />
      <View style={styles.noteBar}>
        <Text style={{ color: t.muted, fontSize: font.small, flex: 1 }}>{`${noteLength(text)}/${NOTE_MAX}`}</Text>
        <Button title={JOURNAL.noteClear} compact variant="secondary" accessibilityLabel="메모 지우기" disabled={save.isPending || (!text && !item.note)} onPress={() => submit("")} />
        <Button title={JOURNAL.noteSave} compact accessibilityLabel="메모 저장" loading={save.isPending} onPress={() => submit(text)} />
      </View>
      {msg ? (
        <Text style={{ color: msg.ok ? t.accent : t.warn, fontSize: font.small }} accessibilityRole="alert" accessibilityLiveRegion="polite">
          {msg.text}
        </Text>
      ) : null}
    </View>
  );
}

/** 휴대폰: 아래에서 올라오는 창 · 넓은 세로 창: 가운데 창 (최대 560dp) */
export function TradeDetailSheet({ item, onClose }: { item: JournalItem; onClose: () => void }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const win = useWindowDimensions();
  const wide = win.width >= 560 + space.xl * 2;
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={[styles.backdrop, { justifyContent: wide ? "center" : "flex-end" }]}>
        <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: t.scrim }]} onPress={onClose} accessibilityRole="button" accessibilityLabel={`거래 상세 ${JOURNAL.close}`} />
        <View
          style={[styles.sheet, wide ? styles.sheetFloat : styles.sheetBottom, { backgroundColor: t.surface, borderColor: t.lineStrong, maxHeight: win.height * 0.85, paddingBottom: wide ? space.lg : insets.bottom + space.lg }]}
          testID="trade-detail-sheet"
        >
          <ScrollView keyboardShouldPersistTaps="handled">
            <TradeDetailBody item={item} onClose={onClose} />
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  body: { gap: space.md, padding: space.lg },
  section: { gap: space.xs },
  kv: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", columnGap: space.md, rowGap: space.xxs, paddingVertical: space.s, borderBottomWidth: StyleSheet.hairlineWidth },
  kvLabel: { fontSize: font.small, flexShrink: 1 },
  kvValue: { fontSize: font.small, fontWeight: "700", fontVariant: ["tabular-nums"], marginLeft: "auto", textAlign: "right" },
  // 여러 줄 (200자가 한 줄로 밀리지 않게) — 최소 44, 네 줄쯤까지 늘어난다
  input: { minHeight: 44, maxHeight: 120, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.sm, paddingHorizontal: space.sm, paddingVertical: space.s, fontSize: font.body },
  noteBar: { flexDirection: "row", alignItems: "center", gap: space.sm },
  backdrop: { flex: 1, alignItems: "center" },
  sheet: { width: "100%", maxWidth: 560, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  sheetBottom: { borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg },
  sheetFloat: { borderRadius: radius.lg },
});
