import Ionicons from "@expo/vector-icons/Ionicons";
import { router } from "expo-router";
import React, { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useHealth, useJournal } from "@/api/hooks";
import type { JournalItem, JournalResponse } from "@/api/types";
import { TwoPane } from "@/components/TwoPane";
import { Button, Chip, Empty, ErrorView, Loading } from "@/components/ui";
import { beforeRecordNote, dayHeader, dayHeadSpeech, dayRealizedText, headLines, JOURNAL, periodRange, summaryView, type ListPreset } from "@/lib/journal";
import { changeColor, font, space, touch, useTheme } from "@/theme";
import { PeriodChips } from "./PeriodChips";
import { StockPickerSheet } from "./StockPickerSheet";
import { TradeDetailBody, TradeDetailSheet } from "./TradeDetail";
import { TradeRow } from "./TradeRow";

/**
 * 매매일지 '기록' 탭 (3-37): 기간·종목 칩 → (종목이면 머리 카드) → 요약 카드 → 날짜별(새것부터) 체결 줄.
 * 줄을 누르면 거래 상세 — 휴대폰은 아래 창, 폴드 가로(twoPane)는 오른쪽 칸(고른 것이 없으면 안내 한 줄).
 * 빈 화면: 토스 연동 없음 → [설정 열기], 기간 안 0건 → [기간 1년으로 보기]
 */
export function JournalList({ code, twoPane, today }: { code: string | null; twoPane: boolean; today: string }) {
  const t = useTheme();
  const [preset, setPreset] = useState<ListPreset>("1M");
  const [custom, setCustom] = useState<{ from: string; to: string } | null>(null);
  const [stock, setStock] = useState<string | null>(code);
  const [picking, setPicking] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const range = preset === "custom" && custom ? custom : periodRange(preset === "custom" ? "1M" : preset, today);
  const q = useJournal({ ...range, code: stock }, true);
  const health = useHealth();
  const data = q.data;
  const items = useMemo(() => (data?.days ?? []).flatMap((d) => d.items), [data]);
  const picked = selected ? (items.find((x) => x.key === selected) ?? null) : null;
  const stockName = stock ? (data?.head?.name ?? data?.stocks.find((s) => s.code === stock)?.name ?? stock) : null;

  const stockChip = stock ? (
    <View style={styles.stockChip}>
      <Chip label={stockName ?? stock} active icon="funnel-outline" accessibilityLabel={`종목 ${stockName ?? stock}, 바꾸기`} onPress={() => setPicking(true)} />
      <Pressable onPress={() => setStock(null)} accessibilityRole="button" accessibilityLabel={JOURNAL.clearStock} style={styles.clear}>
        <Ionicons name="close" size={font.h2} color={t.muted} />
      </Pressable>
    </View>
  ) : (
    <Chip label={JOURNAL.allStocks} icon="chevron-down" accessibilityLabel={`${JOURNAL.allStocks}, ${JOURNAL.pickStock}`} onPress={() => setPicking(true)} />
  );
  const chips = (
    <PeriodChips
      value={preset}
      custom={custom}
      today={today}
      onChange={(p, r) => {
        setPreset(p);
        if (r) setCustom(r);
      }}
      extra={stockChip}
    />
  );
  const sheet = picking ? (
    <StockPickerSheet
      stocks={data?.stocks ?? []}
      value={stock}
      onPick={(c) => {
        setStock(c);
        setPicking(false);
      }}
      onClose={() => setPicking(false)}
    />
  ) : null;

  let content: React.ReactNode;
  if (!data && q.isLoading) content = <Loading />;
  else if (!data && q.isError) content = <ErrorView error={q.error} onRetry={() => void q.refetch()} />;
  else if (!data || !data.enabled) content = <Empty title="지금은 매매일지를 쓸 수 없습니다" hint="서버에서 매매 기록이 켜져 있어야 보여요." />;
  else if (!data.days.length) {
    const noToss = health.data?.tradeRecords && !health.data.tradeRecords.toss;
    content = (
      <>
        {data.head ? <StockHead head={data.head} /> : null}
        {noToss ? (
          <Empty title={JOURNAL.emptyNoToss} action={<Button title={JOURNAL.openSettings} icon="settings-outline" variant="secondary" onPress={() => router.push("/settings" as never)} />} />
        ) : (
          <Empty title={JOURNAL.emptyNone} action={preset !== "1Y" ? <Button title={JOURNAL.emptyYear} variant="secondary" onPress={() => setPreset("1Y")} /> : undefined} />
        )}
      </>
    );
  } else content = <ListBody data={data} selected={twoPane ? selected : null} onPick={(x) => setSelected(x.key)} />;

  if (twoPane)
    return (
      <>
        <TwoPane
          insetLeft
          left={
            <ScrollView contentContainerStyle={styles.paneContent} keyboardShouldPersistTaps="handled">
              {chips}
              {content}
            </ScrollView>
          }
          right={
            picked ? (
              <ScrollView contentContainerStyle={styles.paneContent} keyboardShouldPersistTaps="handled">
                <TradeDetailBody item={picked} />
              </ScrollView>
            ) : null
          }
          empty={
            <View style={styles.hint}>
              <Text style={{ color: t.muted, fontSize: font.body }}>{JOURNAL.pickHint}</Text>
            </View>
          }
        />
        {sheet}
      </>
    );
  return (
    <>
      {chips}
      {content}
      {sheet}
      {picked ? <TradeDetailSheet item={picked} onClose={() => setSelected(null)} /> : null}
    </>
  );
}

function ListBody({ data, selected, onPick }: { data: JournalResponse; selected: string | null; onPick: (x: JournalItem) => void }) {
  const t = useTheme();
  const s = summaryView(data);
  const before = beforeRecordNote(data);
  return (
    <View>
      {data.head ? <StockHead head={data.head} /> : null}
      {before ? <Text style={[styles.note, { color: t.muted }]}>{before}</Text> : null}
      {s ? (
        <View style={[styles.card, { backgroundColor: t.surface, borderColor: t.line }]} testID="journal-summary">
          <Text style={{ color: t.muted, fontSize: font.small }}>{s.range}</Text>
          {s.lines.length ? (
            <View style={styles.sumRows}>
              <Text style={{ color: t.ink, fontSize: font.body, fontWeight: "700" }}>실현손익</Text>
              {s.lines.map((l) => (
                <View key={l.label} style={styles.sumRow} accessible accessibilityLabel={l.speech}>
                  <Text style={{ color: t.muted, fontSize: font.body }}>{l.label}</Text>
                  <Text style={[styles.sumValue, { color: changeColor(t, l.sign) }]} adjustsFontSizeToFit minimumFontScale={0.6} numberOfLines={2}>
                    {l.value}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}
          <Text style={{ color: t.sub, fontSize: font.small }}>{s.counts}</Text>
          {s.notes.map((n) => (
            <Text key={n} style={{ color: t.muted, fontSize: font.small }}>
              {n}
            </Text>
          ))}
        </View>
      ) : null}
      {data.days.map((d) => {
        const right = dayRealizedText(d.realized);
        return (
          <View key={d.date}>
            <View style={[styles.dayHead, { backgroundColor: t.bg }]} accessible accessibilityRole="header" accessibilityLabel={dayHeadSpeech(d.date, d.realized)}>
              <Text style={{ color: t.ink, fontSize: font.small, fontWeight: "700" }}>{dayHeader(d.date)}</Text>
              {right ? <Text style={{ color: t.sub, fontSize: font.small, fontVariant: ["tabular-nums"] }}>{right}</Text> : null}
            </View>
            {d.items.map((x) => (
              <TradeRow key={x.key} item={x} selected={selected === x.key} onPress={x.kind === "fill" ? onPick : undefined} />
            ))}
          </View>
        );
      })}
    </View>
  );
}

/** 이 종목 매매 기록 머리 카드 */
function StockHead({ head }: { head: NonNullable<JournalResponse["head"]> }) {
  const t = useTheme();
  return (
    <View style={[styles.card, { backgroundColor: t.surface, borderColor: t.line }]} testID="journal-stock-head">
      <Text style={{ color: t.ink, fontSize: font.h2, fontWeight: "700" }} accessibilityRole="header">{`${head.name} 매매 기록`}</Text>
      {headLines(head).map((l) => (
        <Text key={l} style={{ color: t.sub, fontSize: font.small }}>
          {l}
        </Text>
      ))}
      {head.memo ? (
        <View style={styles.memoRow}>
          <Text style={{ color: t.sub, fontSize: font.small, flex: 1 }}>{`종목 메모: ${head.memo}`}</Text>
          <Button title="수정" compact variant="secondary" accessibilityLabel="종목 메모 수정" onPress={() => router.push(`/stocks/${head.code}/edit` as never)} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  paneContent: { paddingBottom: space.xl, gap: space.sm },
  hint: { flex: 1, alignItems: "center", justifyContent: "center", padding: space.xl },
  stockChip: { flexDirection: "row", alignItems: "center" },
  clear: { width: touch.min, minHeight: touch.min, alignItems: "center", justifyContent: "center" },
  note: { fontSize: font.small, paddingHorizontal: space.lg, paddingBottom: space.xs },
  card: { borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.xs, marginBottom: space.sm },
  sumRows: { gap: space.xxs },
  sumRow: { flexDirection: "row", alignItems: "center", gap: space.md },
  sumValue: { flex: 1, fontSize: font.body, fontWeight: "700", fontVariant: ["tabular-nums"], textAlign: "right" },
  dayHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.xs },
  memoRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
});
