import Ionicons from "@expo/vector-icons/Ionicons";
import React, { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useJournalTax } from "@/api/hooks";
import type { JournalTax } from "@/api/types";
import { TwoPane } from "@/components/TwoPane";
import { Chip, Empty, ErrorView, Loading } from "@/components/ui";
import { krTaxLine, perSellNone, TAX, TAX_RETRY_MAX, taxItemLines, taxView } from "@/lib/journal";
import { changeColor, font, radius, space, touch, useTheme } from "@/theme";

/**
 * 매매일지 '양도세 추정' 탭 (3-37, 참고용 — 세무 조언이 아님). 맨 위 '참고용 추정' 상자(늘 보임, 닫을 수 없음) →
 * 해외주식 합계(결제일 기준 연도) · 기본공제 · 과세 대상 · 세율 · 예상 세액(추정) → 빠진 매도·받는 중 → 평균 구매가를 추정한 매도(합계에 들어 있음 —
 * 합계 줄·아래 줄에 '추정 포함', 따로 상자에 종목·건수·까닭) → 매도별 계산 → 계산 기준 7줄(늘 펼침 — 마지막 줄이 확인 필요 규칙) → 국내 주식 → 고지.
 * 사고판 순서를 몰라(순서 추정) 합계에서 뺀 매도는 빠진 매도 상자(까닭 + 추정 양도차익 한 줄)와 매도별 계산 끝('합계에서 뺌')에 따로 보인다.
 * 확인이 필요한 매도(그해 주문 내역으로 설명되지 않는 변화가 있던 종목)는 숫자 없이 '확인이 필요한 매도' 상자에 매도마다 한 줄 + 토스증권 앱 안내 (검토 반영 10차).
 * 환율을 받는 중이면 1분마다 5번까지 다시 묻고(useJournalTax), 그래도 받는 중이면 빠진 매도로 보여 준다. 폴드 가로는 왼쪽 합계·기준 | 오른쪽 매도별 계산
 */
export function TaxView({ twoPane, thisYear }: { twoPane: boolean; thisYear: number }) {
  const t = useTheme();
  const [year, setYear] = useState<number>(thisYear);
  const q = useJournalTax(year, true);
  const d = q.data;
  const retriesDone = q.tries >= TAX_RETRY_MAX;
  let main: React.ReactNode;
  if (!d && q.isLoading) main = <Loading />;
  else if (!d && q.isError) main = <ErrorView error={q.error} onRetry={() => void q.refetch()} />;
  else if (!d || !d.enabled) main = <Empty title="지금은 양도세 추정을 볼 수 없습니다" />;
  else main = <TaxBody d={d} retriesDone={retriesDone} year={year} onYear={setYear} split={twoPane} />;
  const notice = <Notice />;
  if (twoPane && d?.enabled)
    return (
      <TwoPane
        insetLeft
        left={
          <ScrollView contentContainerStyle={styles.pane}>
            {notice}
            {main}
          </ScrollView>
        }
        right={
          d.items?.length || d.uncertainItems?.length ? (
            <ScrollView contentContainerStyle={styles.pane}>
              <PerSell d={d} alwaysOpen />
            </ScrollView>
          ) : null
        }
        // 계산에 넣은 매도가 없으면 오른쪽을 빈 채로 두지 않고 한 줄 (까닭은 왼쪽 '빠진 매도' 상자)
        empty={
          <View style={styles.emptyPane} testID="tax-per-sell-none">
            <Text style={{ color: t.muted, fontSize: font.body, textAlign: "center" }}>{perSellNone(year)}</Text>
          </View>
        }
      />
    );
  return (
    <>
      {notice}
      {main}
    </>
  );
}

/** 맨 위 상자 (늘 보임, 닫을 수 없음) */
function Notice() {
  const t = useTheme();
  return (
    <View style={[styles.notice, { borderColor: t.lineStrong, backgroundColor: t.surfaceAlt }]} accessible accessibilityRole="text" accessibilityLabel={TAX.notice} testID="tax-notice">
      <Ionicons name="information-circle-outline" size={font.h2} color={t.accent} />
      <Text style={{ color: t.ink, fontSize: font.small, flex: 1 }}>{TAX.notice}</Text>
    </View>
  );
}

function TaxBody({ d, retriesDone, year, onYear, split }: { d: JournalTax; retriesDone: boolean; year: number; onYear: (y: number) => void; split: boolean }) {
  const t = useTheme();
  const v = taxView(d, retriesDone);
  if (!v) return null;
  const years = d.years ?? [year];
  return (
    <View style={styles.gap}>
      <View style={[styles.card, { backgroundColor: t.surface, borderColor: t.line }]} testID="tax-totals">
        <View style={styles.titleRow}>
          <Text style={{ color: t.ink, fontSize: font.h2, fontWeight: "700", flexShrink: 1 }} accessibilityRole="header">
            {v.title}
          </Text>
          {years.length > 1 ? (
            <View style={styles.years}>
              {years.map((y) => (
                <Chip key={y} label={`${y}년`} active={y === year} onPress={() => onYear(y)} />
              ))}
            </View>
          ) : null}
        </View>
        <Text style={{ color: t.muted, fontSize: font.small }}>{TAX.period}</Text>
        {v.rows.map((r) => (
          <View key={r.label} style={[styles.kv, { borderBottomColor: t.line }]} accessible accessibilityLabel={r.speech}>
            <Text style={{ color: r.strong ? t.ink : t.muted, fontSize: font.small, fontWeight: r.strong ? "700" : "400", flexShrink: 1 }}>{r.label}</Text>
            <Text style={[styles.value, { color: r.sign !== undefined ? changeColor(t, r.sign) : t.ink, fontSize: r.strong ? font.h2 : font.small }]} adjustsFontSizeToFit minimumFontScale={0.6} numberOfLines={2}>
              {r.value}
            </Text>
          </View>
        ))}
        <Text style={{ color: t.sub, fontSize: font.small }}>{v.sub}</Text>
        {v.zeroNote ? <Text style={{ color: t.sub, fontSize: font.small }}>{v.zeroNote}</Text> : null}
      </View>
      {v.pending ? (
        <View style={[styles.box, { borderColor: t.lineStrong }]} accessibilityRole="alert" testID="tax-pending">
          <Ionicons name="time-outline" size={font.body} color={t.muted} />
          <Text style={{ color: t.sub, fontSize: font.small, flex: 1 }}>{v.pending}</Text>
        </View>
      ) : null}
      {v.excluded ? (
        <View style={[styles.box, styles.col, { borderColor: t.warn }]} testID="tax-excluded">
          <Text style={{ color: t.warn, fontSize: font.small, fontWeight: "700" }}>{v.excluded.title}</Text>
          {v.excluded.lines.map((l) => (
            <Text key={l} style={{ color: t.sub, fontSize: font.small }}>
              {l}
            </Text>
          ))}
        </View>
      ) : null}
      {v.unexplained ? (
        <View style={[styles.box, styles.col, { borderColor: t.warn }]} testID="tax-unexplained">
          <Text style={{ color: t.warn, fontSize: font.small, fontWeight: "700" }}>{v.unexplained.title}</Text>
          {v.unexplained.lines.map((l, i) => (
            <Text key={`${i}:${l}`} style={{ color: t.sub, fontSize: font.small }}>
              {l}
            </Text>
          ))}
          <Text style={{ color: t.muted, fontSize: font.small }}>{v.unexplained.note}</Text>
        </View>
      ) : null}
      {v.estimated ? (
        <View style={[styles.box, styles.col, { borderColor: t.lineStrong }]} testID="tax-estimated">
          <Text style={{ color: t.ink, fontSize: font.small, fontWeight: "700" }}>{v.estimated.title}</Text>
          {v.estimated.lines.map((l) => (
            <Text key={l} style={{ color: t.sub, fontSize: font.small }}>
              {l}
            </Text>
          ))}
        </View>
      ) : null}
      {split ? null : <PerSell d={d} />}
      <View style={[styles.card, { backgroundColor: t.surface, borderColor: t.line }]}>
        <Text style={{ color: t.ink, fontSize: font.body, fontWeight: "700" }} accessibilityRole="header">
          {TAX.rulesTitle}
        </Text>
        {TAX.rules.map((r, i) => (
          <Text key={r} style={{ color: t.muted, fontSize: font.small }}>
            {`${i + 1}. ${r}`}
          </Text>
        ))}
      </View>
      <View style={[styles.card, { backgroundColor: t.surface, borderColor: t.line }]} testID="tax-kr">
        <Text style={{ color: t.ink, fontSize: font.body, fontWeight: "700" }} accessibilityRole="header">
          {TAX.krTitle}
        </Text>
        <Text style={{ color: t.sub, fontSize: font.small }}>{TAX.krAssumption}</Text>
        <Text style={{ color: t.sub, fontSize: font.small }}>{krTaxLine(d)}</Text>
      </View>
      <Text style={[styles.foot, { color: t.muted }]}>{TAX.notAdvice}</Text>
    </View>
  );
}

/** 매도별 계산 (휴대폰은 접힌 채 '매도별 계산 보기 ▾', 폴드 가로 오른쪽 칸은 늘 펼침) */
function PerSell({ d, alwaysOpen = false }: { d: JournalTax; alwaysOpen?: boolean }) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  // 합계에 넣은 매도 뒤에 합계에서 뺀(순서를 모름) 매도를 '합계에서 뺌'으로
  const items = [...(d.items ?? []).map((x) => ({ x, outside: false })), ...(d.uncertainItems ?? []).map((x) => ({ x, outside: true }))];
  if (!items.length) return null;
  const shown = alwaysOpen || open;
  return (
    <View style={[styles.card, { backgroundColor: t.surface, borderColor: t.line }]} testID="tax-per-sell">
      {alwaysOpen ? (
        <Text style={{ color: t.ink, fontSize: font.body, fontWeight: "700" }} accessibilityRole="header">
          {TAX.perSell.replace(" 보기", "")}
        </Text>
      ) : (
        <Pressable onPress={() => setOpen(!open)} accessibilityRole="button" accessibilityLabel={TAX.perSell} accessibilityState={{ expanded: open }} style={styles.toggle}>
          <Text style={{ color: t.accent, fontSize: font.small, fontWeight: "700" }}>{TAX.perSell}</Text>
          <Ionicons name={open ? "chevron-up" : "chevron-down"} size={font.small} color={t.accent} />
        </Pressable>
      )}
      {shown
        ? items.map(({ x, outside }) => {
            const [a, b] = taxItemLines(x, outside);
            return (
              <View key={x.key} style={[styles.sell, { borderTopColor: t.line }]} accessible accessibilityLabel={`${a}, ${b}`}>
                <Text style={{ color: t.sub, fontSize: font.small }}>{a}</Text>
                <Text style={{ color: t.ink, fontSize: font.small, fontVariant: ["tabular-nums"] }}>{b}</Text>
              </View>
            );
          })
        : null}
    </View>
  );
}

const styles = StyleSheet.create({
  pane: { paddingBottom: space.xl, gap: space.sm },
  gap: { gap: space.sm },
  notice: { flexDirection: "row", alignItems: "flex-start", gap: space.sm, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, marginHorizontal: space.lg, marginTop: space.sm, padding: space.md },
  card: { borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.xs },
  titleRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: space.sm },
  years: { flexDirection: "row", gap: space.s },
  kv: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", columnGap: space.md, paddingVertical: space.s, borderBottomWidth: StyleSheet.hairlineWidth },
  value: { marginLeft: "auto", fontWeight: "700", fontVariant: ["tabular-nums"], textAlign: "right" },
  box: { flexDirection: "row", alignItems: "flex-start", gap: space.sm, borderWidth: 1, borderRadius: radius.md, marginHorizontal: space.lg, padding: space.md },
  col: { flexDirection: "column", gap: space.xxs },
  toggle: { flexDirection: "row", alignItems: "center", gap: space.xxs, minHeight: touch.min },
  sell: { borderTopWidth: StyleSheet.hairlineWidth, paddingVertical: space.s, gap: space.xxs },
  foot: { fontSize: font.small, textAlign: "center", paddingHorizontal: space.lg },
  emptyPane: { flex: 1, alignItems: "center", justifyContent: "center", padding: space.xl },
});
