import React, { useEffect, useRef, useState } from "react";
import { Linking, Pressable, StyleSheet, Text, useWindowDimensions, View, type LayoutChangeEvent, type ScrollView, type ViewStyle } from "react-native";
import { useFeature, useFeatures } from "@/api/hooks";
import type { HoldingSchedule, ScheduleFilingItem, ScheduleFilings } from "@/api/types";
import { UpcomingCard } from "@/components/AccountBriefingBody";
import { Screen } from "@/components/Screen";
import { CardsSkeleton } from "@/components/Skeleton";
import { Card, Empty, Muted, SectionTitle } from "@/components/ui";
import {
  EARNINGS_AFTER_FILING,
  EVENTS_LOADING,
  EXPAND_HINT,
  FILINGS_FAILED,
  ITEMS_HEAD,
  KR_HEAD,
  KR_NO_KEY,
  KR_NOT_YET,
  NEW_CHIP,
  OPEN_FAILED,
  OPEN_ORIGINAL,
  OPEN_ORIGINAL_SPEECH,
  SCHEDULE_OFF,
  scheduleFilingsView,
  type FilingLine,
} from "@/lib/filingAlerts";
import { useFilingViewed } from "@/lib/filingViewed";
import { useHoldingSchedule } from "@/lib/scheduleQuery";
import { useFoldLayout } from "@/lib/useFoldLayout";
import { font, radius, space, touch, useTheme } from "@/theme";

/**
 * '일정·공시' 화면 (3-38, 플래그 holdingSchedule — /schedule, 계좌 브리핑 상세 '일정·공시 모두 보기'와 새 공시 알림에서 온다).
 *  ① 다가오는 일정 — 계좌 상세 카드와 같은 글(열 때 받은 값, 서버 /api/schedule). 실적 발표일이 꺼져 있고 미국 보유가 있으면 '미국 실적은 발표된 뒤 공시(8-K 2.02)로 보입니다.'
 *  ② 최근 공시 (미국) — filingAlerts 가 켜져 있을 때. 줄을 누르면 펼침(접수 시각 한국·미국 동부 · 들어 있는 항목 · [SEC 원문 보기 (영어)])
 *  ③ 한국 공시 — DART 키 안내 한 줄 (filingAlerts 가 켜져 있을 때)
 * 폰(360·475)·펼친 세로(704)는 한 칸, 펼친 가로 2단(933)은 두 칸(왼쪽 ①③ · 오른쪽 ②). 색은 등락 색을 쓰지 않는다(공시는 등락이 아님).
 * focus = 알림에서 온 접수 번호 → 그 줄을 펼치고 화면 안으로 스크롤
 */
export function ScheduleScreen({ focus }: { focus: string | null }) {
  const on = useFeature("holdingSchedule", false);
  const flags = useFeatures();
  if (!on) {
    // 플래그를 아직 못 받았으면(알림으로 막 켠 경우) 잠깐 기다린다
    if (flags.data === undefined && flags.isFetching) return <Screen><CardsSkeleton count={2} /></Screen>;
    return (
      <Screen>
        <Empty title={SCHEDULE_OFF} />
      </Screen>
    );
  }
  return <ScheduleBody focus={focus} />;
}

function ScheduleBody({ focus }: { focus: string | null }) {
  const q = useHoldingSchedule(true);
  const fold = useFoldLayout();
  const two = fold.on && fold.twoPane;
  const scrollRef = useRef<ScrollView>(null);
  // 알림에서 온 줄의 위치: 두 칸 줄의 y + 공시 카드 y + 줄 y (한 번만 스크롤)
  const pos = useRef<{ row: number; card: number | null; line: number | null; done: boolean }>({ row: 0, card: null, line: null, done: false });
  const tryScroll = () => {
    const p = pos.current;
    if (p.done || p.card === null || p.line === null) return;
    p.done = true;
    scrollRef.current?.scrollTo({ y: Math.max(0, (two ? p.row : 0) + p.card + p.line - space.md), animated: true });
  };
  const data = q.data;
  const failed = !data && q.isError;
  const loading = !data && !failed;
  const events = loading ? (
    <Card>
      <Muted>{EVENTS_LOADING}</Muted>
    </Card>
  ) : data ? (
    <EventsPart s={data} />
  ) : null;
  const filings = failed ? (
    <Card>
      <Muted>{FILINGS_FAILED}</Muted>
    </Card>
  ) : data?.filings ? (
    <View
      onLayout={(e) => {
        pos.current.card = e.nativeEvent.layout.y;
        tryScroll();
      }}
    >
      <FilingsCard
        f={data.filings}
        focus={focus}
        onFocusLayout={(y) => {
          pos.current.line = y;
          tryScroll();
        }}
      />
    </View>
  ) : null;
  const kr = data?.filings ? <KrCard kind={data.kr.filings} /> : null;
  return (
    <Screen disclaimer scrollRef={scrollRef} refreshing={q.isRefetching} onRefresh={() => void q.refetch()}>
      {two ? (
        <View
          style={styles.cols}
          onLayout={(e: LayoutChangeEvent) => {
            pos.current.row = e.nativeEvent.layout.y;
          }}
        >
          <View style={styles.col}>
            {events}
            {kr}
          </View>
          <View style={styles.col}>{filings}</View>
        </View>
      ) : (
        <>
          {events}
          {filings}
          {kr}
        </>
      )}
    </Screen>
  );
}

/** ① 다가오는 일정 (holdingEvents 가 꺼져 있으면 없음) */
function EventsPart({ s }: { s: HoldingSchedule }) {
  const e = s.events;
  if (!e) return null;
  // 실적 발표 '예정일'은 꺼진 채(holdingEarnings) — 미국 실적은 발표 뒤 공시로 보인다는 사실 한 줄 (미국 보유가 있을 때만)
  const notes = !e.earnings && e.us > 0 ? [EARNINGS_AFTER_FILING] : [];
  return <UpcomingCard e={e} notes={notes} />;
}

/** ③ 한국 공시 */
function KrCard({ kind }: { kind: HoldingSchedule["kr"]["filings"] }) {
  return (
    <Card>
      <View accessible accessibilityLabel={`${KR_HEAD}, ${kind === "noDartKey" ? KR_NO_KEY : KR_NOT_YET}`} style={styles.head}>
        <SectionTitle>{KR_HEAD}</SectionTitle>
        <Muted>{kind === "noDartKey" ? KR_NO_KEY : KR_NOT_YET}</Muted>
      </View>
    </Card>
  );
}

/** 좁은 칸·큰 글씨는 ' · ' 묶음째 줄바꿈 (다가오는 일정과 같은 규칙) */
function useChunkRow(): ViewStyle {
  const { fontScale } = useWindowDimensions();
  const gap = fontScale >= 1.75 ? space.sm : fontScale >= 1.25 ? space.s : space.xs;
  return { flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: gap, rowGap: space.xxs };
}

/** ② 최근 공시 (미국) */
function FilingsCard({ f, focus, onFocusLayout }: { f: ScheduleFilings; focus: string | null; onFocusLayout: (y: number) => void }) {
  const [viewed, markViewed] = useFilingViewed();
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(focus ? [focus] : []));
  const v = scheduleFilingsView(f, viewed);
  // 알림에서 온 줄은 펼친 채로 열리므로 '펼쳐 봄'으로 적는다
  useEffect(() => {
    if (focus && f.items.some((i) => i.accession === focus)) markViewed(focus);
  }, [focus, f.items, markViewed]);
  const toggle = (item: ScheduleFilingItem) => {
    const next = new Set(open);
    if (next.has(item.accession)) next.delete(item.accession);
    else {
      next.add(item.accession);
      markViewed(item.accession);
    }
    setOpen(next);
  };
  return (
    <Card>
      <View accessible accessibilityLabel={`${v.title}, ${v.sub.replace(/ · /g, ", ")}${v.empty ? `, ${v.empty}` : `, ${v.lines.length + v.more}건`}`} style={styles.head}>
        <SectionTitle>{v.title}</SectionTitle>
        <Muted>{v.sub}</Muted>
        {v.empty ? <Muted style={styles.empty}>{v.empty}</Muted> : null}
      </View>
      {v.lines.map((l) => (
        <FilingRow
          key={l.line.key}
          item={l.item}
          line={l.line}
          isNew={l.isNew}
          expanded={open.has(l.item.accession)}
          onToggle={() => toggle(l.item)}
          onLayout={l.item.accession === focus ? onFocusLayout : undefined}
        />
      ))}
      {v.more > 0 ? <Muted>외 {v.more}건</Muted> : null}
      {v.notes.map((n) => (
        <Muted key={n} style={{ fontSize: font.tiny }}>
          {n}
        </Muted>
      ))}
      <View accessible accessibilityLabel={v.basisSpeech}>
        <Muted style={{ fontSize: font.tiny }}>{v.basis}</Muted>
      </View>
    </Card>
  );
}

function FilingRow({
  item,
  line,
  isNew,
  expanded,
  onToggle,
  onLayout,
}: {
  item: ScheduleFilingItem;
  line: FilingLine;
  isNew: boolean;
  expanded: boolean;
  onToggle: () => void;
  onLayout?: ((y: number) => void) | undefined;
}) {
  const t = useTheme();
  const chunkRow = useChunkRow();
  const [openFailed, setOpenFailed] = useState(false);
  const openOriginal = () => {
    setOpenFailed(false);
    // SEC 주소만 연다 (서버가 만든 주소 — 다른 곳이면 열지 않음)
    if (!/^https:\/\/www\.sec\.gov\//.test(item.url)) return setOpenFailed(true);
    Linking.openURL(item.url).catch(() => setOpenFailed(true));
  };
  return (
    <View style={[styles.row, { borderBottomColor: t.line }]} onLayout={onLayout ? (e) => onLayout(e.nativeEvent.layout.y) : undefined}>
      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityLabel={line.speech}
        accessibilityHint={EXPAND_HINT}
        accessibilityState={{ expanded }}
        style={({ pressed }) => [styles.rowHead, { backgroundColor: pressed ? t.surfaceAlt : "transparent" }]}
      >
        <View style={chunkRow}>
          <Text style={[styles.num, { color: t.sub, fontSize: font.small, fontWeight: "600" }]}>{`${line.when} ·`}</Text>
          <Text style={{ color: t.sub, fontSize: font.small }}>{item.name}</Text>
          {isNew ? (
            <View style={[styles.chip, { borderColor: t.accent }]}>
              <Text style={{ color: t.accent, fontSize: font.tiny, fontWeight: "600" }}>{NEW_CHIP}</Text>
            </View>
          ) : null}
        </View>
        <Text style={{ color: t.ink, fontSize: font.body }}>{line.title}</Text>
      </Pressable>
      {expanded ? (
        <View style={styles.detail}>
          <View accessible accessibilityLabel={line.timeSpeech}>
            <Muted>{line.time}</Muted>
          </View>
          {item.detail.length ? (
            <>
              <Text style={{ color: t.muted, fontSize: font.small }}>{ITEMS_HEAD}</Text>
              {item.detail.map((d) => (
                <View key={d} accessible accessibilityLabel={d}>
                  <Muted>{` · ${d}`}</Muted>
                </View>
              ))}
            </>
          ) : null}
          {item.note ? <Muted>{item.note}</Muted> : null}
          <Pressable onPress={openOriginal} accessibilityRole="link" accessibilityLabel={OPEN_ORIGINAL_SPEECH} style={({ pressed }) => [styles.open, { backgroundColor: pressed ? t.surfaceAlt : "transparent" }]}>
            <Text style={{ color: t.accent, fontSize: font.body, fontWeight: "600" }}>{OPEN_ORIGINAL}</Text>
          </Pressable>
          {openFailed ? <Text style={{ color: t.danger, fontSize: font.small }}>{OPEN_FAILED}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  cols: { flexDirection: "row", alignItems: "flex-start", gap: space.sm },
  col: { flex: 1, minWidth: 0, gap: space.sm },
  head: { gap: space.xxs },
  empty: { marginTop: space.xs },
  row: { borderBottomWidth: StyleSheet.hairlineWidth, paddingBottom: space.xs },
  rowHead: { minHeight: touch.min, justifyContent: "center", paddingVertical: space.xs, gap: space.xxs },
  num: { fontVariant: ["tabular-nums"] },
  chip: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.sm, paddingHorizontal: space.xs },
  detail: { gap: space.xxs, paddingBottom: space.xs },
  open: { minHeight: touch.min, justifyContent: "center" },
});
