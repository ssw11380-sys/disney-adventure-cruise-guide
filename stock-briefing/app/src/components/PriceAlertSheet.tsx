import Ionicons from "@expo/vector-icons/Ionicons";
import React, { useEffect, useState } from "react";
import { Alert, Keyboard, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { PriceAlertKind, PriceAlertRule, Quote, VolumeStatus } from "@/api/types";
import { Button, Chip, Muted } from "@/components/ui";
import {
  ALERT_PER_CODE,
  ALERT_TEXT,
  currencyOfCode,
  diffText,
  firedLine,
  firedSpeech,
  isPriceKind,
  metNow,
  presetDrafts,
  quoteLine,
  quoteSpeech,
  removeConfirmText,
  rowSpeech,
  ruleLabel,
  ruleSpeech,
  stepDraft,
  validateDraft,
  volumeNote,
  VOLUME_TIMES,
  type AlertDraft,
} from "@/lib/priceAlerts";
import { useNow } from "@/lib/useNow";
import { font, fontCap, radius, space, touch, useTheme } from "@/theme";
import { priceAlert } from "@/tokens";

/**
 * 지우기 확인 창 (시트의 지우기 버튼과 설정 칸의 지우기 버튼이 같이 쓴다). 확인하면 onConfirm. 글은 순수 함수 removeConfirmText
 */
export function confirmRemoveAlert(rule: AlertDraft, onConfirm: () => void): void {
  const c = removeConfirmText(rule);
  Alert.alert(c.title, c.message, [
    { text: c.cancel, style: "cancel" },
    { text: c.ok, style: "destructive", onPress: onConfirm },
  ]);
}

/** 입력칸에 보이는 값 (원은 쉼표, 달러는 센트까지, 등락률은 그대로) */
function inputText(d: AlertDraft): string {
  if (isPriceKind(d.kind)) return d.currency === "USD" ? d.value.toFixed(2) : Math.round(d.value).toLocaleString("ko-KR");
  return String(d.value);
}

/** 입력칸 글 → 값 (쉼표·공백은 뺀다, 읽을 수 없으면 NaN → 값 오류) */
function parseInput(text: string): number {
  const s = text.replace(/[,\s]/g, "");
  return s === "" ? NaN : Number(s);
}

/**
 * 가격 알림 시트 (3-29, 플래그 priceAlerts — 속성만 받는다, 루트의 PriceAlertProvider 가 그린다).
 * 머리(가격 알림 · 이름 · 닫기) · 지금 줄 · 켜진 알림(지우기) · 새 알림 줄 하나 고르기(값은 미리 채워짐) · 고른 줄 아래 값 조절 · 아래 고정 글과 [알림 저장].
 * 휴대폰은 아래에 붙이고, 넓은 창(창 폭 ≥ 시트 최대 폭 + 좌우 여백)은 가운데 최대 560dp. 높이는 창의 85% 까지(안은 스크롤, 저장 버튼은 스크롤 밖 고정).
 * 숫자 자판이 열리면 시트를 위쪽에 붙이고 높이를 자판 위까지로 줄인다 (edge-to-edge 라 창이 자판만큼 줄어드는 동작에 기대지 않는다)
 */
export function PriceAlertSheet({
  code,
  name,
  quote,
  rules,
  volume,
  busy,
  onSave,
  onRemove,
  onClose,
}: {
  code: string;
  name: string;
  quote: Quote | null;
  /** 이 종목의 조건 */
  rules: PriceAlertRule[];
  /** 시트를 열 때 한 번 받은 거래량 상태 (받는 중·실패면 undefined·null) */
  volume: VolumeStatus | null | undefined;
  busy: boolean;
  onSave: (body: { code: string; kind: PriceAlertKind; value: number }) => void;
  onRemove: (rule: PriceAlertRule) => void;
  onClose: () => void;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const win = useWindowDimensions();
  const nowMs = useNow(60_000);
  const cur = quote?.currency ?? currencyOfCode(code);
  const presets = presetDrafts(quote, cur, volume);
  // 고른 줄과 그 값 (처음에는 아무 줄도 고르지 않음 → 저장 꺼짐)
  const [picked, setPicked] = useState<{ key: PriceAlertKind; draft: AlertDraft; text: string } | null>(null);
  // 숫자 자판 높이 (0 = 닫힘). 시트가 열려 있는 동안만 구독한다
  const [kb, setKb] = useState(0);
  useEffect(() => {
    const show = Keyboard.addListener("keyboardDidShow", (e) => setKb(e.endCoordinates.height));
    const hide = Keyboard.addListener("keyboardDidHide", () => setKb(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  const full = rules.length >= ALERT_PER_CODE;
  const draft = picked?.draft ?? null;
  const error = draft ? validateDraft(draft, rules) : null;
  const already = draft && !error ? metNow(draft, quote, volume) : false;
  const canSave = !!draft && !error && !busy;
  const wide = win.width >= priceAlert.sheetMaxW + space.xl * 2;
  const maxH = kb > 0 ? win.height - kb - insets.top - space.md * 2 : win.height * priceAlert.sheetMaxHRatio;
  const pick = (d: AlertDraft, key: PriceAlertKind) => setPicked({ key, draft: d, text: inputText(d) });
  const setDraft = (d: AlertDraft) => setPicked((p) => (p ? { ...p, draft: d, text: inputText(d) } : p));
  const type = (text: string) => setPicked((p) => (p ? { ...p, text, draft: { ...p.draft, value: parseInput(text) } } : p));

  // 고른 줄은 지금 값의 글로 (값을 바꾸면 줄 글도 바뀐다). 입력칸이 비어 읽을 수 없는 동안은 미리 채운 글
  const typed = picked && Number.isFinite(picked.draft.value) ? picked : null;
  const rowTitle = (key: PriceAlertKind, title: string) => (typed?.key === key ? ruleLabel(typed.draft) : title);
  const rowNote = (key: PriceAlertKind, note: string) => {
    if (typed?.key !== key || !quote || !isPriceKind(key)) return note;
    return diffText(typed.draft.value, quote.price);
  };

  const controls = (key: PriceAlertKind) => {
    if (!picked || picked.key !== key) return null;
    if (key === "volume")
      return (
        <View style={styles.chips}>
          {VOLUME_TIMES.map((n) => (
            <Chip key={n} label={`${n}배`} accessibilityLabel={`${n}배`} active={picked.draft.value === n} onPress={() => setDraft({ ...picked.draft, value: n })} />
          ))}
        </View>
      );
    const unit = isPriceKind(key) ? (cur === "USD" ? "달러" : "원") : "%";
    return (
      <View style={styles.stepper}>
        <Pressable onPress={() => setDraft(stepDraft(picked.draft, -1, quote))} accessibilityRole="button" accessibilityLabel="값 줄이기" style={[styles.stepBtn, { borderColor: t.lineStrong, backgroundColor: t.surfaceAlt }]}>
          <Ionicons name="remove" size={font.title} color={t.ink} />
        </Pressable>
        <TextInput
          value={picked.text}
          onChangeText={type}
          keyboardType={isPriceKind(key) && cur === "KRW" ? "number-pad" : "decimal-pad"}
          returnKeyType="done"
          accessibilityLabel="알림 값"
          maxFontSizeMultiplier={fontCap.row}
          style={[styles.input, { color: t.ink, borderColor: t.lineStrong, backgroundColor: t.bg }]}
        />
        <Pressable onPress={() => setDraft(stepDraft(picked.draft, 1, quote))} accessibilityRole="button" accessibilityLabel="값 늘리기" style={[styles.stepBtn, { borderColor: t.lineStrong, backgroundColor: t.surfaceAlt }]}>
          <Ionicons name="add" size={font.title} color={t.ink} />
        </Pressable>
        <Text style={{ color: t.muted, fontSize: font.small }}>{unit}</Text>
      </View>
    );
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={[styles.backdrop, { justifyContent: kb > 0 ? "flex-start" : wide ? "center" : "flex-end", paddingTop: kb > 0 ? insets.top + space.md : 0 }]}>
        {/* 바깥을 누르면 닫힘. 시트를 감싸면 화면 읽기가 시트 전체를 한 덩어리로 읽으므로 뒤에 따로 깐다 (정렬 시트와 같음) */}
        <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: t.scrim }]} onPress={onClose} accessibilityRole="button" accessibilityLabel="알림 시트 닫기" />
        <View
          style={[
            styles.sheet,
            wide || kb > 0 ? styles.sheetFloat : styles.sheetBottom,
            { backgroundColor: t.surface, borderColor: t.lineStrong, maxHeight: maxH, paddingBottom: kb > 0 || wide ? space.md : insets.bottom + space.md },
          ]}
        >
          <View style={styles.head}>
            <Text style={[styles.headTitle, { color: t.ink }]} accessibilityRole="header" numberOfLines={2}>
              {`가격 알림 · ${name}`}
            </Text>
            <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="닫기" style={styles.iconBtn}>
              <Ionicons name="close" size={font.title} color={t.ink} />
            </Pressable>
          </View>
          <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollBody} keyboardShouldPersistTaps="handled">
            {quote ? (
              <View accessible accessibilityLabel={quoteSpeech(quote)} style={styles.nowLine}>
                <Text style={{ color: t.sub, fontSize: font.small, fontVariant: ["tabular-nums"] }}>{quoteLine(quote)}</Text>
              </View>
            ) : (
              <Text style={[styles.nowLine, { color: t.muted, fontSize: font.small }]}>{ALERT_TEXT.noQuote}</Text>
            )}
            {rules.length ? (
              <>
                <Text style={[styles.groupHead, { color: t.muted }]} accessibilityRole="header">{`켜진 알림 ${rules.length}개`}</Text>
                {rules.map((r) => (
                  <View key={r.id} style={[styles.onRow, { borderTopColor: t.line }]}>
                    <View accessible accessibilityLabel={`${ruleSpeech(r)}, ${firedSpeech(r, nowMs)}`} style={styles.rowText}>
                      <Text style={{ color: t.ink, fontSize: font.body }}>{ruleLabel(r)}</Text>
                      <Text style={{ color: t.muted, fontSize: font.small }}>{firedLine(r, nowMs)}</Text>
                    </View>
                    <Pressable onPress={() => confirmRemoveAlert(r, () => onRemove(r))} accessibilityRole="button" accessibilityLabel={`알림 지우기, ${ruleSpeech(r)}`} style={styles.iconBtn}>
                      <Ionicons name="close" size={font.h2} color={t.muted} />
                    </Pressable>
                  </View>
                ))}
              </>
            ) : null}
            <Text style={[styles.groupHead, { color: full ? t.warn : t.muted }]} accessibilityRole="header">
              {full ? ALERT_TEXT.perCodeFull : ALERT_TEXT.newHead}
            </Text>
            {full
              ? null
              : presets.map((p) => {
                  const checked = picked?.key === p.key;
                  const d = checked && typed ? typed.draft : p.draft;
                  return (
                    <View key={p.key} style={[styles.newRow, { borderTopColor: t.line, backgroundColor: checked ? t.surfaceAlt : "transparent" }]}>
                      <Pressable
                        onPress={() => (checked ? null : pick(p.draft, p.key))}
                        accessibilityRole="radio"
                        accessibilityLabel={rowSpeech(d, quote, volume)}
                        accessibilityState={{ checked }}
                        style={styles.radioRow}
                      >
                        <Ionicons name={checked ? "radio-button-on" : "radio-button-off"} size={font.title} color={checked ? t.accent : t.muted} />
                        <View style={styles.rowText}>
                          <Text style={{ color: t.ink, fontSize: font.body, fontWeight: checked ? "700" : "400" }}>{rowTitle(p.key, p.title)}</Text>
                          <Text style={{ color: t.muted, fontSize: font.small }}>{p.key === "volume" ? volumeNote(volume) : rowNote(p.key, p.note)}</Text>
                        </View>
                      </Pressable>
                      {controls(p.key)}
                      {checked && error ? <Text style={[styles.msg, { color: t.danger }]}>{error}</Text> : null}
                      {checked && already ? <Text style={[styles.msg, { color: t.warn }]}>{ALERT_TEXT.alreadyMet}</Text> : null}
                    </View>
                  );
                })}
          </ScrollView>
          {/* 아래 고정: 글자가 커져도 스크롤 없이 [알림 저장]이 보인다 */}
          <View style={[styles.foot, { borderTopColor: t.line }]}>
            <Muted style={{ fontSize: font.tiny }}>{ALERT_TEXT.sheetFoot}</Muted>
            <Button
              title={busy ? ALERT_TEXT.saving : ALERT_TEXT.save}
              accessibilityLabel={ALERT_TEXT.save}
              disabled={!canSave}
              loading={busy}
              onPress={() => (draft && canSave ? onSave({ code, kind: draft.kind, value: draft.value }) : undefined)}
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, alignItems: "center" },
  sheet: { width: "100%", maxWidth: priceAlert.sheetMaxW, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  sheetBottom: { borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg },
  sheetFloat: { borderRadius: radius.lg },
  head: { flexDirection: "row", alignItems: "center", paddingLeft: space.lg, paddingRight: space.xs, paddingTop: space.xs },
  headTitle: { flex: 1, fontSize: font.h2, fontWeight: "700" },
  iconBtn: { width: touch.min, minHeight: touch.min, alignItems: "center", justifyContent: "center" },
  scroll: { flexGrow: 0, flexShrink: 1 },
  scrollBody: { paddingBottom: space.sm },
  nowLine: { paddingHorizontal: space.lg, paddingBottom: space.sm },
  groupHead: { fontSize: font.small, paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.xs },
  onRow: { flexDirection: "row", alignItems: "center", paddingLeft: space.lg, paddingRight: space.xs, borderTopWidth: StyleSheet.hairlineWidth },
  rowText: { flex: 1, minWidth: 0, gap: space.xxs, paddingVertical: space.s },
  newRow: { borderTopWidth: StyleSheet.hairlineWidth, paddingBottom: space.xxs },
  radioRow: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: touch.min, paddingHorizontal: space.lg },
  stepper: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingLeft: space.lg + font.title + space.md, paddingRight: space.lg, paddingBottom: space.sm },
  stepBtn: { width: touch.min, minHeight: touch.min, alignItems: "center", justifyContent: "center", borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md },
  input: { flex: 1, minWidth: 0, minHeight: touch.min, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, paddingHorizontal: space.md, fontSize: font.h2, fontWeight: "700", textAlign: "right", fontVariant: ["tabular-nums"] },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, paddingLeft: space.lg + font.title + space.md, paddingRight: space.lg, paddingTop: space.xs, paddingBottom: space.sm },
  msg: { fontSize: font.small, paddingLeft: space.lg + font.title + space.md, paddingRight: space.lg, paddingBottom: space.sm },
  foot: { gap: space.sm, paddingHorizontal: space.lg, paddingTop: space.sm, borderTopWidth: StyleSheet.hairlineWidth },
});
