import React, { useEffect, useRef, useState } from "react";
import { Linking, Pressable, StyleSheet, Text, View, type LayoutChangeEvent, type ScrollView } from "react-native";
import { useFeature, useFeatures } from "@/api/hooks";
import type { HoldingSchedule, ScheduleFilingItem, ScheduleFilings } from "@/api/types";
import { UpcomingCard } from "@/components/AccountBriefingBody";
import { Screen } from "@/components/Screen";
import { CardsSkeleton } from "@/components/Skeleton";
import { Card, Empty, Muted, SectionTitle } from "@/components/ui";
import {
  EARNINGS_AFTER_FILING,
  EVENTS_FAILED_SCREEN,
  EVENTS_LOADING,
  EXPAND_HINT,
  FILINGS_FAILED,
  FILINGS_HEAD,
  ITEMS_HEAD,
  KR_HEAD,
  KR_IN_ACCOUNT,
  KR_NO_KEY,
  KR_NOT_YET,
  NEW_CHIP,
  OPEN_FAILED,
  OPEN_ORIGINAL,
  OPEN_ORIGINAL_SPEECH,
  SCHEDULE_OFF,
  scheduleFailedText,
  scheduleFilingsView,
  titleChunks,
  type FilingLine,
} from "@/lib/filingAlerts";
import { useFilingViewed } from "@/lib/filingViewed";
import { EVENTS_HEAD } from "@/lib/holdingEvents";
import { useHoldingSchedule } from "@/lib/scheduleQuery";
import { useChunkRow } from "@/lib/useChunkRow";
import { useFoldLayout } from "@/lib/useFoldLayout";
import { font, radius, space, touch, useTheme } from "@/theme";

/**
 * '일정·공시' 화면 (3-38, 플래그 holdingSchedule — /schedule, 계좌 브리핑 상세 '일정·공시 모두 보기'와 새 공시 알림에서 온다).
 *  ① 다가오는 일정 — 계좌 상세 카드와 같은 글(열 때 받은 값, 서버 /api/schedule). 실적 발표일이 꺼져 있고 미국 보유가 있고 ② 가 보일 때
 *     '미국 실적은 발표된 뒤 공시(8-K 2.02)로 보입니다.'
 *  ② 최근 공시 (미국) — filingAlerts 가 켜져 있을 때. 줄을 누르면 펼침(접수 시각 한국·미국 동부 · 들어 있는 항목 · [SEC 원문 보기 (영어)])
 *  ③ 한국 공시 — DART 키 안내 + 국내 공시는 계좌 상세 '오늘 일정' 카드에 있다는 한 줄 (filingAlerts 가 켜져 있을 때)
 *  받지 못하면: 요청 전체가 실패하면 '일정·공시를 받지 못했습니다 …' 한 줄(서버가 공시를 꺼 두었으면 '일정을 …'), 서버가 한쪽만 실패하면 그 칸에 한 줄
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
  // 요청이 실패했을 때 어느 칸을 받지 못했는지 밝히는 데만 쓴다 (앱이 마지막으로 받은 서버 플래그 — 모르면 둘 다)
  const eventsFlag = useFeature("holdingEvents", false);
  const filingsFlag = useFeature("filingAlerts", false);
  const fold = useFoldLayout();
  const two = fold.on && fold.twoPane;
  const scrollRef = useRef<ScrollView>(null);
  // 알림에서 온 줄의 위치: 두 칸 줄의 y + 공시 카드 y + 줄 y (셋 다 잰 뒤 한 번만 스크롤 — 두 칸이면 두 칸 줄 y 도 기다린다)
  const pos = useRef<{ row: number | null; card: number | null; line: number | null; done: boolean }>({ row: null, card: null, line: null, done: false });
  const tryScroll = () => {
    const p = pos.current;
    if (p.done || p.card === null || p.line === null || (two && p.row === null)) return;
    p.done = true;
    scrollRef.current?.scrollTo({ y: Math.max(0, (two ? (p.row ?? 0) : 0) + p.card + p.line - space.md), animated: true });
  };
  const data = q.data;
  const failed = !data && q.isError;
  const loading = !data && !failed;
  // 요청 전체가 실패: 일정도 같은 요청이라 '일정·공시를 받지 못했습니다' 한 줄 (배당락일 카드가 말없이 사라지지 않게)
  if (failed) {
    const text = scheduleFailedText(eventsFlag, filingsFlag);
    return (
      <Screen disclaimer refreshing={q.isRefetching} onRefresh={() => void q.refetch()}>
        <Card>
          <View accessible accessibilityLabel={text}>
            <Muted>{text}</Muted>
          </View>
        </Card>
      </Screen>
    );
  }
  const events = loading ? (
    <Card>
      <Muted>{EVENTS_LOADING}</Muted>
    </Card>
  ) : data?.events ? (
    <EventsPart s={data} />
  ) : data?.eventsFailed ? (
    <PartFailed title={EVENTS_HEAD} text={EVENTS_FAILED_SCREEN} />
  ) : null;
  const filings = data?.filingsFailed && !data.filings ? (
    <PartFailed title={FILINGS_HEAD} text={FILINGS_FAILED} />
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
  // 한국 공시 칸: 공시가 켜져 있을 때 (국내 보유가 없다고 알 때는 계좌 상세 안내를 빼고 DART 한 줄만)
  const kr = data?.filings || data?.filingsFailed ? <KrCard kind={data.kr.filings} account={!(data.events && data.events.kr === 0)} /> : null;
  // 서버가 일정·공시 둘 다 꺼 두었으면(holdingEvents·filingAlerts 끔) 빈 화면 대신 한 줄
  if (data && !data.events && !data.filings && !data.eventsFailed && !data.filingsFailed) {
    return (
      <Screen>
        <Empty title={SCHEDULE_OFF} />
      </Screen>
    );
  }
  return (
    <Screen disclaimer scrollRef={scrollRef} refreshing={q.isRefetching} onRefresh={() => void q.refetch()}>
      {two ? (
        <View
          style={styles.cols}
          onLayout={(e: LayoutChangeEvent) => {
            pos.current.row = e.nativeEvent.layout.y;
            tryScroll();
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
  // 실적 발표 '예정일'은 꺼진 채(holdingEarnings) — 미국 실적은 발표 뒤 공시로 보인다는 사실 한 줄 (미국 보유가 있고 이 화면에 공시 칸이 있을 때만)
  const notes = !e.earnings && e.us > 0 && s.filings ? [EARNINGS_AFTER_FILING] : [];
  return <UpcomingCard e={e} notes={notes} />;
}

/** 서버가 한쪽만 받지 못했을 때 그 칸 (제목 + 한 줄) */
function PartFailed({ title, text }: { title: string; text: string }) {
  return (
    <Card>
      <View accessible accessibilityLabel={`${title}, ${text}`} style={styles.head}>
        <SectionTitle>{title}</SectionTitle>
        <Muted>{text}</Muted>
      </View>
    </Card>
  );
}

/** ③ 한국 공시 — DART 키 안내 + (account) 국내 공시는 계좌 상세 '오늘 일정' 카드에 있다는 한 줄 ('모두 보기'에서 국내 공시가 사라진 것처럼 보이지 않게) */
function KrCard({ kind, account }: { kind: HoldingSchedule["kr"]["filings"]; account: boolean }) {
  const lines = [kind === "noDartKey" ? KR_NO_KEY : KR_NOT_YET, account ? KR_IN_ACCOUNT : null].filter((x): x is string => x !== null);
  return (
    <Card>
      <View accessible accessibilityLabel={[KR_HEAD, ...lines].join(", ")} style={styles.head}>
        <SectionTitle>{KR_HEAD}</SectionTitle>
        {lines.map((l) => (
          <Muted key={l}>{l}</Muted>
        ))}
      </View>
    </Card>
  );
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
  // 좁은 칸·큰 글씨는 ' · ' 묶음째 줄바꿈 (다가오는 일정과 같은 규칙) + 칩과 가운데 맞춤
  const chunkBase = useChunkRow();
  const chunkRow = [chunkBase, styles.chunkExtra];
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
        {/* 제목은 '이름' + '(서식 번호)' 두 묶음 — 좁은 칸·큰 글씨에서 서식 번호가 묶음째 다음 줄로 */}
        <View style={styles.title}>
          {titleChunks(line.title).map((p, i) => (
            <Text key={i} style={{ color: t.ink, fontSize: font.body }}>
              {p}
            </Text>
          ))}
        </View>
      </Pressable>
      {expanded ? (
        <View style={styles.detail}>
          {/* 접수 시각: '한국 …'·'미국 동부 …' 묶음째 줄바꿈 (날짜와 시각이 다른 줄로 갈라지지 않게, '·'는 앞 묶음 끝) */}
          <View accessible accessibilityLabel={line.timeSpeech} style={chunkBase}>
            {line.timeParts.map((p) => (
              <Muted key={p}>{p}</Muted>
            ))}
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
  chunkExtra: { alignItems: "center", rowGap: space.xxs },
  title: { flexDirection: "row", flexWrap: "wrap" },
  chip: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.sm, paddingHorizontal: space.xs },
  detail: { gap: space.xxs, paddingBottom: space.xs },
  open: { minHeight: touch.min, justifyContent: "center" },
});
