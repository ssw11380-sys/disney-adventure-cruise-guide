import { Ionicons } from "@expo/vector-icons";
import React, { useState } from "react";
import { Linking, Pressable, StyleSheet, Text, useWindowDimensions, View, type StyleProp, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAnalysis, useStockMutations, useStockNews } from "@/api/hooks";
import type { AnalysisKind, Briefing, Disclosure, NewsItem } from "@/api/types";
import { BriefingCard } from "@/components/BriefingCard";
import { FlashPrice } from "@/components/FlashPrice";
import { MarkdownView } from "@/components/MarkdownView";
import { Button, Card, ErrorView, LiveDot, Loading, Muted, SectionTitle, Stat } from "@/components/ui";
import { chunkRows, detailHeaderLayout, fillChartHeight, HEAD_PAD, markdownPreview } from "@/lib/detailLayout";
import { formatDateKo, relativeTime } from "@/lib/format";
import { analysisView } from "@/lib/freshness";
import { navLabel, navSpeech, type HoldingsNav } from "@/lib/holdingsNav";
import { font, fontCap, radius, slopFor, space, touch, useTheme } from "@/theme";
import { foldDetail } from "@/tokens";

/**
 * 종목 상세 조각 (stocks/[code]/index 가 쓴다). 휴대폰 화면 조각(52주 막대·AI 분석 탭·뉴스·공시 탭)은 예전 화면에서 옮겨 온 그대로이고,
 * 나머지는 넓은 창 배치(3-42 웨이브 C, 기능 플래그 foldLayout)에서만 쓴다: 합친 머리 · 시세표 격자 · 칸에 맞춘 차트 · 아랫줄 세 칸
 */

// ── 휴대폰 화면에서 옮겨 온 조각 (그리는 결과는 예전과 같다) ──

/** 52주 위치 막대: 저가 ~ 고가 사이 현재가 위치 */
export function Range52({ range, low, high, color }: { range: number; low: string; high: string; color: string }) {
  const t = useTheme();
  return (
    <View style={{ gap: space.xxs, marginTop: space.s }}>
      <View style={[styles.rangeTrack, { backgroundColor: t.surfaceAlt }]}>
        <View style={[styles.rangeKnob, { left: `${Math.round(range * 100)}%`, backgroundColor: color }]} />
      </View>
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <Text style={sub(t.muted)}>52주 저 {low}</Text>
        <Text style={sub(t.muted)}>{Math.round(range * 100)}%</Text>
        <Text style={sub(t.muted)}>고 {high}</Text>
      </View>
    </View>
  );
}

/**
 * requested=false: 발견 탭 등에서 잠깐 들여다보는 미등록 종목 — AI 분석은 눌렀을 때만 만든다 (비용·시간).
 * 이미 받아 둔 분석(캐시)이 있으면 누르지 않아도 보여 준다.
 * preview: 넓은 창 오른쪽 칸의 미리보기 — 앞 몇 줄만 보이고 '더 보기'로 전체 (휴대폰 화면은 쓰지 않는다)
 */
export function AnalysisTab({ code, kind, requested, onRequest, preview = false }: { code: string; kind: AnalysisKind; requested: boolean; onRequest: (kind: AnalysisKind) => void; preview?: boolean }) {
  const t = useTheme();
  const a = useAnalysis(code, kind, requested);
  const { refreshAnalysis } = useStockMutations();
  const [more, setMore] = useState(false);
  // 갱신 실패는 조회 오류와 따로: 이전 분석은 두고 실패를 알린다 (AI-01)
  const { state, refreshError } = analysisView({ requested, query: a, refresh: refreshAnalysis, code, kind });
  if (state === "ask")
    return (
      <Card>
        <Muted>관심 종목이 아니라 AI 분석을 미리 만들지 않았습니다.</Muted>
        <Button title="AI 분석 만들기" icon="sparkles" onPress={() => onRequest(kind)} />
      </Card>
    );
  if (state === "loading") return <Card><Loading label="분석 생성 중" /></Card>;
  if (state === "error") return <Card><ErrorView error={a.error} onRetry={() => void a.refetch()} /></Card>;
  const d = a.data!;
  return (
    <Card>
      {refreshError ? (
        <Text style={{ color: t.danger, fontSize: font.small }} accessibilityRole="alert" accessibilityLiveRegion="polite">
          {refreshError}
        </Text>
      ) : null}
      {preview && !more ? (
        <Text style={{ color: t.ink, fontSize: font.body, lineHeight: PREVIEW_LINE }} numberOfLines={foldDetail.previewLines}>
          {markdownPreview(d.content)}
        </Text>
      ) : (
        <MarkdownView>{d.content}</MarkdownView>
      )}
      {d.missing.length ? <Muted>데이터 미확인: {d.missing.join(", ")}</Muted> : null}
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Muted>
          {formatDateKo(d.createdAt, true)} 기준
        </Muted>
        {preview ? <MoreToggle open={more} onPress={() => setMore((m) => !m)} label="분석" /> : null}
        <Button title={refreshError ? "다시 시도" : "갱신"} variant="secondary" icon="refresh" compact onPress={() => refreshAnalysis.mutate({ code, kind })} />
      </View>
    </Card>
  );
}

/** 뉴스 줄들 (누르면 기사 열기) */
export function NewsItems({ items }: { items: NewsItem[] }) {
  const t = useTheme();
  return (
    <>
      {items.map((item, i) => (
        <Pressable key={`${item.url}-${i}`} onPress={() => void Linking.openURL(item.url)} accessibilityRole="link" accessibilityLabel={`뉴스: ${item.title}, ${item.source ?? ""} ${relativeTime(item.publishedAt) || formatDateKo(item.publishedAt)}`} style={[styles.newsItem, { borderTopColor: t.line, borderTopWidth: i === 0 ? 0 : StyleSheet.hairlineWidth }]}>
          <Text style={{ color: t.ink, fontSize: font.body, lineHeight: 20 }} numberOfLines={2}>{item.title}</Text>
          <Muted>
            {item.source ?? ""} · {relativeTime(item.publishedAt) || formatDateKo(item.publishedAt)}
          </Muted>
        </Pressable>
      ))}
    </>
  );
}

/** 공시 줄들 (누르면 공시 원문) */
export function DisclosureItems({ items }: { items: Disclosure[] }) {
  const t = useTheme();
  return (
    <>
      {items.map((item, i) => (
        <Pressable key={item.receiptNo} onPress={() => void Linking.openURL(item.url)} accessibilityRole="link" accessibilityLabel={`공시: ${item.title}, ${item.filer}, ${formatDateKo(item.filedAt)}`} style={[styles.newsItem, { borderTopColor: t.line, borderTopWidth: i === 0 ? 0 : StyleSheet.hairlineWidth }]}>
          <Text style={{ color: t.ink, fontSize: font.body }}>{item.title}</Text>
          <Muted>
            {item.filer} · {formatDateKo(item.filedAt)}
          </Muted>
        </Pressable>
      ))}
    </>
  );
}

export function NewsTab({ code, us }: { code: string; us: boolean }) {
  const t = useTheme();
  const n = useStockNews(code);
  if (n.isLoading) return <Card><Loading /></Card>;
  if (n.isError) return <Card><ErrorView error={n.error} onRetry={() => void n.refetch()} /></Card>;
  const d = n.data!;
  return (
    <View style={{ gap: space.md }}>
      <Card>
        <SectionTitle>뉴스</SectionTitle>
        {d.newsError ? <Text style={{ color: t.danger, fontSize: font.small }}>{d.newsError}</Text> : null}
        {d.news.length === 0 && !d.newsError ? <Muted>최근 뉴스 없음</Muted> : null}
        <NewsItems items={d.news} />
      </Card>
      <Card>
        <SectionTitle>{us ? "공시 (SEC)" : "공시 (DART)"}</SectionTitle>
        {d.disclosuresError ? <Muted>{d.disclosuresError}</Muted> : null}
        {d.disclosures.length === 0 && !d.disclosuresError ? <Muted>최근 30일 공시 없음</Muted> : null}
        <DisclosureItems items={d.disclosures} />
      </Card>
    </View>
  );
}

// ── 넓은 창 배치 조각 ──

/** 시세표 한 칸의 속성 (ui 의 Stat 에 그대로 넘긴다) */
export interface StatProps {
  label: string;
  value: string;
  change?: number | null;
}

/** 시세표 격자: 한 줄에 cols 칸씩 (가로 먼저). 모자란 칸은 빈 칸으로 채워 열을 맞춘다. 항목명은 왼쪽, 값은 오른쪽 */
export function PairGrid({ items, cols }: { items: StatProps[]; cols: number }) {
  return (
    <View>
      {chunkRows(items, cols).map((row, r) => (
        <View key={r} style={styles.gridRow}>
          {row.map((s, i) => (
            <View key={s.label + i} style={styles.cell}>
              <Stat {...s} />
            </View>
          ))}
          {Array.from({ length: cols - row.length }, (_, k) => (
            <View key={`pad-${k}`} style={styles.cell} />
          ))}
        </View>
      ))}
    </View>
  );
}

/** 시세표 한 줄 목록 (칸 하나 = 세로 목록) */
export function StatList({ items }: { items: StatProps[] }) {
  return (
    <View>
      {items.map((s, i) => (
        <View key={s.label + i} style={styles.cell}>
          <Stat {...s} />
        </View>
      ))}
    </View>
  );
}

/** 칸 제목 줄: 굵은 제목 + 오른쪽 작은 안내. 제목이 없는 칸은 같은 높이의 빈 줄 (옆 칸과 줄을 맞춘다) */
export function PaneTitle({ title, note }: { title?: string; note?: string | null }) {
  const t = useTheme();
  return (
    <View style={styles.paneTitle}>
      {title ? (
        <Text style={{ color: t.ink, fontSize: font.body, fontWeight: "700", flexShrink: 0 }} accessibilityRole="header">
          {title}
        </Text>
      ) : (
        <Text style={{ fontSize: font.body }} importantForAccessibility="no" accessibilityElementsHidden>
          {" "}
        </Text>
      )}
      {/* 안내는 좁은 칸에서 한 줄로 줄어든다 (숫자가 아닌 설명 글) */}
      {note ? (
        <Text style={{ color: t.muted, fontSize: font.tiny, flexShrink: 1, textAlign: "right" }} numberOfLines={1}>
          {note}
        </Text>
      ) : null}
    </View>
  );
}

/** 여러 칸 시세표 (폴드8 펼침 세로: 내 보유 | 시세 | 시세 | 시세 + 52주). 칸마다 위에서 아래로 */
export function StatColumns({ columns }: { columns: { key: string; title?: string; note?: string | null; body: React.ReactNode }[] }) {
  return (
    <View style={styles.columns}>
      {columns.map((c) => (
        <View key={c.key} style={styles.column}>
          <PaneTitle title={c.title} note={c.note} />
          {c.body}
        </View>
      ))}
    </View>
  );
}

/** '더 보기 / 접기' (누르는 영역 44) */
export function MoreToggle({ open, onPress, label, count }: { open: boolean; onPress: () => void; label: string; count?: number }) {
  const t = useTheme();
  const text = open ? "접기" : count ? `더 보기 ${count}` : "더 보기";
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${label} ${open ? "접기" : "더 보기"}`} accessibilityState={{ expanded: open }} hitSlop={slopFor(font.small * 1.35, space.xs)} style={styles.more}>
      <Text style={{ color: t.accent, fontSize: font.small, fontWeight: "600" }}>{text}</Text>
      <Ionicons name={open ? "chevron-up" : "chevron-down"} size={font.small} color={t.accent} />
    </Pressable>
  );
}

/** 최근 브리핑 목록 (넓은 창의 '브리핑' 탭, 아랫줄 첫 칸). max 를 주면 앞의 max 장만 보이고 '더 보기'로 나머지 */
export function BriefingList({ query, max }: { query: { data?: Briefing[]; isLoading: boolean; isError: boolean; error: unknown; refetch: () => unknown }; max?: number }) {
  const [open, setOpen] = useState(false);
  if (query.isLoading) return <Card><Loading /></Card>;
  if (query.isError) return <Card><ErrorView error={query.error} onRetry={() => void query.refetch()} /></Card>;
  const list = query.data ?? [];
  if (!list.length) return <Card><Muted>최근 브리핑이 없습니다</Muted></Card>;
  const shown = max && !open ? list.slice(0, max) : list;
  return (
    <View style={{ gap: space.sm }}>
      {shown.map((b) => (
        <BriefingCard key={b.id} briefing={b} mode="summary" showName={false} />
      ))}
      {max && list.length > max ? (
        <View style={styles.moreRow}>
          <MoreToggle open={open} onPress={() => setOpen((o) => !o)} label="최근 브리핑" count={open ? undefined : list.length - max} />
        </View>
      ) : null}
    </View>
  );
}

/** 아랫줄의 뉴스·공시 두 칸 (윗줄+아랫줄 배치). 뉴스 탭과 같은 쿼리를 쓴다 */
export function NewsColumns({ code, us, divider }: { code: string; us: boolean; divider: React.ReactNode }) {
  const t = useTheme();
  const n = useStockNews(code);
  const [newsOpen, setNewsOpen] = useState(false);
  const [discOpen, setDiscOpen] = useState(false);
  const body = (fn: (d: NonNullable<typeof n.data>) => React.ReactNode) =>
    n.isLoading ? <Loading /> : n.isError ? <ErrorView error={n.error} onRetry={() => void n.refetch()} /> : n.data ? fn(n.data) : null;
  const news = (d: NonNullable<typeof n.data>) => {
    const max = foldDetail.rowsNews;
    return (
      <>
        {d.newsError ? <Text style={{ color: t.danger, fontSize: font.small }}>{d.newsError}</Text> : null}
        {d.news.length === 0 && !d.newsError ? <Muted>최근 뉴스 없음</Muted> : null}
        <NewsItems items={newsOpen ? d.news : d.news.slice(0, max)} />
        {d.news.length > max ? <MoreToggle open={newsOpen} onPress={() => setNewsOpen((o) => !o)} label="뉴스" count={newsOpen ? undefined : d.news.length - max} /> : null}
      </>
    );
  };
  const disclosures = (d: NonNullable<typeof n.data>) => {
    const max = foldDetail.rowsDisclosures;
    return (
      <>
        {d.disclosuresError ? <Muted>{d.disclosuresError}</Muted> : null}
        {d.disclosures.length === 0 && !d.disclosuresError ? <Muted>최근 30일 공시 없음</Muted> : null}
        <DisclosureItems items={discOpen ? d.disclosures : d.disclosures.slice(0, max)} />
        {d.disclosures.length > max ? <MoreToggle open={discOpen} onPress={() => setDiscOpen((o) => !o)} label="공시" count={discOpen ? undefined : d.disclosures.length - max} /> : null}
      </>
    );
  };
  return (
    <>
      <View style={styles.feedCol}>
        <PaneTitle title="뉴스" />
        {body(news)}
      </View>
      {divider}
      <View style={styles.feedCol}>
        <PaneTitle title={us ? "공시 (SEC)" : "공시 (DART)"} />
        {body(disclosures)}
      </View>
    </>
  );
}

/** 좌우 배치 왼쪽 칸 차트 둘레(기간 칩·읽기 줄·이동평균 값·지표 칩·안내·패널 여백)의 처음 어림. 실제보다 작게 잡아 재어 본 뒤 늘린다 */
const CHROME_GUESS = 120;

/**
 * 칸 높이에 맞춘 차트 패널: 패널 전체 높이가 height 가 되도록 차트 그림 높이를 정한다 (차트 전체 화면과 같은 방식 — 둘레 높이를 그려 본 뒤 잰다).
 *  - 좌우 배치: 왼쪽 칸 높이 → 차트가 스크롤 없이 칸을 채운다
 *  - 윗줄+아랫줄 배치: 옆 칸(보유·시세·AI 분석) 높이 → 윗줄에 빈 곳이 남지 않는다. 그림은 minH(기본 크기)보다 작아지지 않는다
 * height 가 아직 없으면(재기 전) CandleChart 기본 크기. 둘레는 늘어날 때만 반영한다(폭·높이가 바뀌면 새로) →
 * 십자선을 움직일 때 읽기 줄이 늘었다 줄었다 해도 차트 높이가 흔들리지 않는다
 */
export function FillChart({ height, minH = 0, render, style }: { height: number | null; minH?: number; render: (chartH: number | undefined) => React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const [boxW, setBoxW] = useState<number | null>(null);
  const [chrome, setChrome] = useState<{ key: string; h: number }>({ key: "", h: CHROME_GUESS });
  const key = height !== null && height > 0 ? `${Math.round(boxW ?? 0)}x${Math.round(height)}` : "";
  const chromeH = chrome.key === key ? chrome.h : CHROME_GUESS;
  const chartH = key ? Math.max(Math.round(minH), fillChartHeight(height!, chromeH)) : undefined;
  return (
    <View
      style={[styles.fillPanel, style]}
      onLayout={(e) => {
        const { width, height: h } = e.nativeEvent.layout;
        if (boxW === null || Math.abs(boxW - width) >= 1) setBoxW(width);
        if (chartH === undefined) return;
        const next = Math.ceil(h - chartH);
        if (next <= 0) return;
        if (chrome.key !== key || next > chrome.h + 1) setChrome({ key, h: next });
      }}
    >
      {render(chartH)}
    </View>
  );
}

// ── 합친 머리 ──

export interface HeaderQuote {
  value: number;
  price: string;
  unit: string;
  change: string;
  rate: string;
  priceColor: string;
  changeColor: string;
  rateColor: string;
  /** 화면 읽기: 가격·등락을 한 문장으로 */
  a11y: string;
}

export interface StateLine {
  text: string;
  /** 머리가 한 줄에 들어가지 않을 때 쓰는 짧은 표기 (없으면 text 그대로) */
  short?: string;
  color?: string;
  /** 초록 점 + 굵게 ('실시간') */
  live?: boolean;
}

/** 오른쪽 버튼: 보유 정보 수정 또는 (미등록 종목) 관심 추가 */
export type HeaderAction = { kind: "edit"; onPress: () => void } | { kind: "watch"; busy: boolean; onPress: () => void };

/** 머리 오른쪽 아이콘 크기 */
const HEADER_ICON = 21;

/**
 * 넓은 창 종목 상세의 합친 머리 (Stack 머리 대신): ← | 이름·코드·시장 | 가격 · 등락 | 시장 상태 | ‹ n/17 › | 수정.
 * 한 줄에 다 들어가지 않으면(좁은 폭·큰 글씨) 시장 상태 → 가격·등락 순서로 둘째 줄로 내린다 (lib/detailLayout detailHeaderLayout).
 * 이름은 '…'로 줄어들 수 있지만 숫자는 줄이지 않는다. 글자는 fontCap.chrome(150%) 까지만 커진다. 위 화면 여백을 여기서 맡는다
 */
export function DetailHeader({
  name,
  sub: subText,
  quote,
  quoteError,
  state,
  nav,
  onPrev,
  onNext,
  onBack,
  action,
}: {
  name: string;
  sub: string;
  quote: HeaderQuote | null;
  quoteError: string;
  state: StateLine[];
  nav: HoldingsNav | null;
  onPrev: () => void;
  onNext: () => void;
  onBack: () => void;
  /** 오른쪽 버튼 (지수 상세처럼 없으면 null) */
  action: HeaderAction | null;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { width: winW, fontScale } = useWindowDimensions();
  const cap = fontCap.chrome;
  const fit = (lines: string[]) =>
    detailHeaderLayout({
      width: winW - insets.left - insets.right,
      fontScale,
      name,
      sub: subText,
      price: quote?.price ?? null,
      unit: quote?.unit ?? null,
      change: quote?.change ?? null,
      rate: quote?.rate ?? null,
      state: lines,
      pager: nav ? navLabel(nav) : null,
      action: action?.kind === "watch" ? "관심 추가" : action ? null : false,
    }).tier;
  // 긴 표기로 한 줄에 들어가지 않으면 짧은 표기(기준 시각 "9/23 20:00")로 다시 어림하고, 그래도 안 되면 둘째 줄로
  const long = fit(state.map((l) => l.text));
  const useShort = long !== "one" && fit(state.map((l) => l.short ?? l.text)) === "one";
  const tier = useShort ? "one" : long;
  const lineText = (l: StateLine) => (useShort ? (l.short ?? l.text) : l.text);
  const quoteBlock = quote ? (
    <View accessible accessibilityLabel={quote.a11y} style={styles.quote}>
      <FlashPrice value={quote.value} text={quote.price} style={[styles.price, { color: quote.priceColor }]} maxScale={cap} />
      <Text style={{ color: t.muted, fontSize: font.body }} maxFontSizeMultiplier={cap}>
        {quote.unit}
      </Text>
      <Text style={[styles.change, { color: quote.changeColor }]} maxFontSizeMultiplier={cap}>
        {quote.change}
      </Text>
      <Text style={[styles.change, { color: quote.rateColor }]} maxFontSizeMultiplier={cap}>
        {quote.rate}
      </Text>
    </View>
  ) : (
    <Text style={{ color: t.danger, fontSize: font.small }} maxFontSizeMultiplier={cap}>
      {quoteError}
    </Text>
  );
  const stateBlock = state.length ? (
    <View style={tier === "one" ? styles.state : styles.stateBelow}>
      {state.map((l, i) => (
        <View key={i} style={styles.stateLine}>
          {l.live ? <LiveDot /> : null}
          <Text style={[styles.stateText, { color: l.color ?? t.muted, fontWeight: l.live ? "700" : "400" }]} maxFontSizeMultiplier={cap}>
            {lineText(l)}
          </Text>
        </View>
      ))}
    </View>
  ) : null;
  return (
    <View style={[styles.headRoot, { backgroundColor: t.surface, borderBottomColor: t.line, paddingTop: insets.top, paddingLeft: insets.left + HEAD_PAD, paddingRight: insets.right + HEAD_PAD }]}>
      <View style={styles.headRow}>
        <Pressable onPress={onBack} accessibilityRole="button" accessibilityLabel="뒤로" style={styles.icon}>
          <Ionicons name="arrow-back" size={font.title + space.xs} color={t.ink} />
        </Pressable>
        <View style={styles.headName}>
          <Text style={{ color: t.ink, fontSize: font.h2, fontWeight: "700" }} numberOfLines={1} maxFontSizeMultiplier={cap} accessibilityRole="header">
            {name}
          </Text>
          <Text style={{ color: t.muted, fontSize: font.small }} numberOfLines={1} maxFontSizeMultiplier={cap}>
            {subText}
          </Text>
        </View>
        {tier === "quoteBelow" ? null : quoteBlock}
        {tier === "one" ? stateBlock : null}
        <View style={styles.spacer} />
        {nav ? (
          <View style={[styles.pager, { borderColor: t.line }]}>
            <Pressable onPress={onPrev} disabled={!nav.prev} accessibilityRole="button" accessibilityLabel={nav.prev ? `이전 종목, ${nav.prev.name}` : "이전 종목 없음"} accessibilityState={{ disabled: !nav.prev }} style={[styles.icon, { opacity: nav.prev ? 1 : OFF_OPACITY }]}>
              <Ionicons name="chevron-back" size={font.title} color={t.ink} />
            </Pressable>
            <Text style={[styles.pagerText, { color: t.ink }]} accessibilityLabel={navSpeech(nav)} maxFontSizeMultiplier={cap}>
              {navLabel(nav)}
            </Text>
            <Pressable onPress={onNext} disabled={!nav.next} accessibilityRole="button" accessibilityLabel={nav.next ? `다음 종목, ${nav.next.name}` : "다음 종목 없음"} accessibilityState={{ disabled: !nav.next }} style={[styles.icon, { opacity: nav.next ? 1 : OFF_OPACITY }]}>
              <Ionicons name="chevron-forward" size={font.title} color={t.ink} />
            </Pressable>
          </View>
        ) : null}
        {!action ? null : action.kind === "edit" ? (
          <Pressable onPress={action.onPress} accessibilityRole="button" accessibilityLabel="보유 정보 수정" style={styles.icon}>
            <Ionicons name="create-outline" size={HEADER_ICON} color={t.ink} />
          </Pressable>
        ) : (
          <Pressable onPress={action.onPress} disabled={action.busy} accessibilityRole="button" accessibilityLabel="관심 종목에 추가" accessibilityState={{ busy: action.busy, disabled: action.busy }} style={styles.watch}>
            <Ionicons name="star-outline" size={font.title} color={t.gold} />
            <Text style={{ color: t.gold, fontSize: font.small, fontWeight: "700" }} maxFontSizeMultiplier={cap}>
              {action.busy ? "추가 중" : "관심 추가"}
            </Text>
          </Pressable>
        )}
      </View>
      {tier === "one" ? null : (
        <View style={styles.headRow2}>
          {tier === "quoteBelow" ? quoteBlock : null}
          {stateBlock}
        </View>
      )}
    </View>
  );
}

/** 꺼진 버튼 흐림 (ui 의 Button 과 같은 값) */
const OFF_OPACITY = 0.45;
/** AI 분석 미리보기 줄 높이 (브리핑 요약 줄과 같다) */
const PREVIEW_LINE = 22;

const sub = (color: string) => ({ color, fontSize: font.small, fontVariant: ["tabular-nums" as const] });

const styles = StyleSheet.create({
  newsItem: { minHeight: touch.min, paddingVertical: space.sm, gap: space.xxs },
  rangeTrack: { height: 4, borderRadius: 2, justifyContent: "center" },
  rangeKnob: { position: "absolute", width: 8, height: 12, borderRadius: 1, marginLeft: -space.xs, top: -4 },
  gridRow: { flexDirection: "row", columnGap: space.lg },
  // ui 의 Stat 은 폭 47%·늘어남이라, 가로 줄 칸에 넣으면 칸을 꽉 채운다
  cell: { flex: 1, flexDirection: "row", minWidth: 0 },
  paneTitle: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm, minHeight: touch.min - space.md, paddingBottom: space.xxs },
  columns: { flexDirection: "row", columnGap: space.lg, alignItems: "flex-start" },
  column: { flex: 1, minWidth: 0 },
  more: { flexDirection: "row", alignItems: "center", gap: space.xxs, paddingVertical: space.xs },
  moreRow: { flexDirection: "row", justifyContent: "flex-end", paddingHorizontal: space.lg },
  feedCol: { flex: 1, minWidth: 0, paddingHorizontal: space.lg, paddingVertical: space.md },
  fillPanel: { paddingHorizontal: space.md, paddingVertical: space.s, gap: space.xs },
  // 합친 머리
  headRoot: { borderBottomWidth: StyleSheet.hairlineWidth },
  headRow: { flexDirection: "row", alignItems: "center", minHeight: foldDetail.headH, columnGap: space.sm },
  icon: { width: touch.min, minHeight: touch.min, alignItems: "center", justifyContent: "center" },
  headName: { flexShrink: 1, minWidth: 0 },
  quote: { flexDirection: "row", alignItems: "baseline", columnGap: space.xs, flexShrink: 0 },
  price: { fontSize: font.hero, fontWeight: "800", letterSpacing: -0.6, fontVariant: ["tabular-nums"] },
  change: { fontSize: font.body, fontWeight: "700", fontVariant: ["tabular-nums"] },
  state: { flexShrink: 1, minWidth: 0, marginLeft: space.sm, gap: space.xxs },
  stateBelow: { flexDirection: "row", flexWrap: "wrap", columnGap: space.md, rowGap: space.xxs },
  stateLine: { flexDirection: "row", alignItems: "center", gap: space.xs },
  stateText: { fontSize: font.small, fontVariant: ["tabular-nums"] },
  spacer: { flex: 1 },
  pager: { flexDirection: "row", alignItems: "center", borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, flexShrink: 0 },
  pagerText: { fontSize: font.small, fontWeight: "600", fontVariant: ["tabular-nums"], textAlign: "center", minWidth: space.xl * 2 },
  watch: { flexDirection: "row", alignItems: "center", gap: space.xs, minHeight: touch.min, paddingHorizontal: space.xs },
  headRow2: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: space.md, rowGap: space.xxs, paddingLeft: touch.min + space.sm, paddingBottom: space.s },
});
