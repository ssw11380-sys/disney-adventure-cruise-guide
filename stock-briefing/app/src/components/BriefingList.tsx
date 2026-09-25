import React from "react";
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import type { Briefing } from "@/api/types";
import { sentence, speakRate } from "@/lib/a11y";
import { briefingWhen } from "@/lib/briefingPick";
import { formatDateKo, formatPct, SESSION_LABEL, shownSign } from "@/lib/format";
import { changeColor, font, fontCap, radius, slopFor, space, touch, useTheme } from "@/theme";
import { foldBriefings as FB } from "@/tokens";
import { MarkdownView } from "./MarkdownView";
import { Badge } from "./ui";

/**
 * 넓은 창 브리핑 탭의 부품 (3-42 웨이브 D, 기능 플래그 foldLayout — 접은 화면은 쓰지 않는다).
 *  - Pills: 한 줄에 여럿 놓는 알약 모양 선택 (변동 큰 순|등록순, 한 줄|요약|상세, 요약|상세)
 *  - BriefingRow: 2단 목록 한 줄 56 (미확인 점 · 이름 · 바로 옆 등락률 · 시각 / 요약 한 줄)
 *  - BriefingTile: 펼친 폴드8 세로 카드 격자의 한 칸 (이름 · 등락률 · 시각 / 요약 최대 3줄)
 *  - ListNotice: 목록 위 안내 한 줄 (휴장·정렬 기준)
 * 숫자(등락률·시각)는 줄이지 않고, 모자라면 이름만 말줄임한다
 */

export function Pills<T extends string>({ options, value, onChange, label, style }: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void; label: string; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  return (
    <View style={[styles.pills, { borderColor: t.lineStrong }, style]} accessibilityRole="tablist" accessibilityLabel={label}>
      {options.map((o, i) => {
        const active = o.value === value;
        return (
          <Pressable
            key={o.value}
            onPress={() => onChange(o.value)}
            accessibilityRole="tab"
            accessibilityLabel={o.label}
            accessibilityState={{ selected: active }}
            // 보이는 높이 34 → 위아래로 넓혀 44 (옆 칸과는 붙어 있어 좌우는 넓히지 않는다)
            hitSlop={PILL_SLOP}
            style={({ pressed }) => [styles.pill, i > 0 && { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: t.lineStrong }, { backgroundColor: active ? t.surfaceAlt : pressed ? t.surface : "transparent" }]}
          >
            <Text style={{ color: active ? t.ink : t.muted, fontSize: font.body, fontWeight: active ? "700" : "500" }} numberOfLines={1} maxFontSizeMultiplier={fontCap.chrome}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const PILL_SLOP = slopFor(FB.pillH);

/**
 * 목록 위 안내 한 줄 (휴장 · 정렬 기준 · 등락률 못 받음을 ' · ' 로 이어 한 줄에). 폭이 모자라면 안내 묶음째 다음 줄로 —
 * 한 안내의 가운데(예: '변동 큰 순 =' / '전일 대비 …')에서 줄이 꺾이지 않게
 */
export function ListNotice({ items }: { items: string[] }) {
  const t = useTheme();
  return (
    <View style={[styles.notice, { backgroundColor: t.bg, borderBottomColor: t.line }]}>
      {items.map((s, i) => (
        <Text key={s} style={{ color: t.muted, fontSize: font.tiny }} maxFontSizeMultiplier={fontCap.row}>
          {i > 0 ? `· ${s}` : s}
        </Text>
      ))}
    </View>
  );
}

/** 등락률 글자 (보이는 값으로 색, 값 없으면 숨김). 줄 글자 상한(140%)을 따른다 */
function Rate({ value, size }: { value: number | null | undefined; size: number }) {
  const t = useTheme();
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const text = formatPct(value);
  return (
    <Text style={[styles.num, { color: changeColor(t, shownSign(value, text)), fontSize: size, fontWeight: "700", flexShrink: 0 }]} maxFontSizeMultiplier={fontCap.row}>
      {text}
    </Text>
  );
}

/** 변동 큰 순 1~3위 표시 ('변동 큰 종목' 카드 대신 — 넓은 창) */
function RankMark({ n }: { n: number }) {
  const t = useTheme();
  return (
    <View style={[styles.rank, { borderColor: t.lineStrong }]}>
      <Text style={[styles.num, { color: t.sub, fontSize: font.tiny, fontWeight: "700" }]} maxFontSizeMultiplier={fontCap.row}>
        {n}
      </Text>
    </View>
  );
}

function Dot() {
  const t = useTheme();
  return <View style={[styles.dot, { backgroundColor: t.accent }]} />;
}

interface ItemProps {
  briefing: Briefing;
  /** 종목 이름 (브리핑에 없으면 코드) */
  name: string;
  /** 오늘 등락률 (모르면 undefined·null → 숨김) */
  rate?: number | null;
  /** 변동 큰 순 1~3위 (아니면 없음) */
  rank?: number;
  /** 아직 읽지 않은 브리핑 */
  unread: boolean;
  /** 지금 고른 브리핑 (2단 오른쪽에 보이는 것 / 접고 펴기 전에 보던 것) */
  selected: boolean;
  onPress: () => void;
}

/** 화면 읽기 한 문장: "읽지 않음, 변동 큰 순 1위, 퀀티넘, 6.00% 상승, 9월 25일 (금) 오전 브리핑, 요약 …" */
export function briefingItemSpeech(p: Pick<ItemProps, "briefing" | "name" | "rate" | "rank" | "unread">, line: string): string {
  const b = p.briefing;
  return sentence([
    p.unread ? "읽지 않음" : null,
    p.rank ? `변동 큰 순 ${p.rank}위` : null,
    p.name,
    speakRate(p.rate),
    `${formatDateKo(b.date)} ${SESSION_LABEL[b.session]} 브리핑`,
    b.status === "failed" ? "생성 실패" : b.missing.length ? "일부 데이터 없음" : null,
    line,
  ]);
}

const firstLine = (b: Briefing) => (b.status === "failed" ? (b.error ?? b.summary) : (b.summary.split("\n").find((l) => l.trim()) ?? ""));

/** 2단 목록 한 줄 (56). 누르면 오른쪽 칸만 바뀐다 */
export function BriefingRow(p: ItemProps) {
  const t = useTheme();
  const b = p.briefing;
  const failed = b.status === "failed";
  const line = firstLine(b);
  return (
    <Pressable
      onPress={p.onPress}
      accessibilityRole="button"
      accessibilityLabel={briefingItemSpeech(p, line)}
      accessibilityState={{ selected: p.selected }}
      style={({ pressed }) => [styles.row, { borderBottomColor: t.line, backgroundColor: p.selected || pressed ? t.surfaceAlt : t.surface }]}
    >
      {p.selected ? <View style={[styles.selBar, { backgroundColor: t.accent }]} /> : null}
      <View style={styles.line1}>
        {p.rank ? <RankMark n={p.rank} /> : null}
        {p.unread ? <Dot /> : null}
        <Text style={[styles.name, { color: t.ink, fontSize: font.body }]} numberOfLines={1} maxFontSizeMultiplier={fontCap.row}>
          {p.name}
        </Text>
        <Rate value={p.rate} size={font.body} />
        {failed ? <Badge tone="bad">생성 실패</Badge> : null}
        <Text style={[styles.when, { color: t.muted }]} maxFontSizeMultiplier={fontCap.row}>
          {briefingWhen(b)}
        </Text>
      </View>
      <Text style={{ color: failed ? t.danger : t.sub, fontSize: font.small, lineHeight: LINE2 }} numberOfLines={1} maxFontSizeMultiplier={fontCap.row}>
        {line}
      </Text>
    </Pressable>
  );
}

/**
 * 카드 격자 한 칸. 누르면 전체 화면 브리핑.
 * '상세' 보기의 본문(마크다운)은 누르는 영역 밖에 둔다 — 화면 읽기가 본문을 따로 읽고, 본문 속 링크가 카드 누르기와 겹치지 않게
 * (폰 BriefingCard 와 같은 방식). 한 줄·요약 보기는 카드 전체가 누르는 영역이다
 */
export function BriefingTile(p: ItemProps & { mode: "line" | "summary" | "detail"; width: number }) {
  const t = useTheme();
  const b = p.briefing;
  const failed = b.status === "failed";
  const lines = b.summary.split("\n").filter((l) => l.trim());
  const detail = p.mode === "detail" && !failed;
  const head = (
    <View style={styles.line1}>
      {p.rank ? <RankMark n={p.rank} /> : null}
      {p.unread ? <Dot /> : null}
      <Text style={[styles.name, { color: t.ink, fontSize: font.h2 }]} numberOfLines={1} maxFontSizeMultiplier={fontCap.row}>
        {p.name}
      </Text>
      <Rate value={p.rate} size={font.body} />
      {failed ? <Badge tone="bad">생성 실패</Badge> : b.missing.length && p.mode === "detail" ? <Badge>일부 데이터 없음</Badge> : null}
      <Text style={[styles.when, { color: t.muted }]} maxFontSizeMultiplier={fontCap.row}>
        {briefingWhen(b)}
      </Text>
    </View>
  );
  // 카드 테두리·강조 막대 (강조 막대만큼 안쪽 여백을 줄여 글자 위치는 그대로)
  const frame = (pressed: boolean) => [
    { width: p.width, backgroundColor: pressed ? t.surfaceAlt : t.surface, borderColor: p.selected ? t.accent : t.line },
    p.selected && { borderLeftWidth: FB.selBar, paddingLeft: space.md - FB.selBar },
  ];
  const selected = p.selected ? { selected: true } : undefined;
  if (detail) {
    return (
      <View style={[styles.tile, frame(false)]}>
        <Pressable
          onPress={p.onPress}
          accessibilityRole="link"
          accessibilityLabel={briefingItemSpeech(p, "")}
          accessibilityState={selected}
          style={({ pressed }) => [styles.tileHead, pressed && { backgroundColor: t.surfaceAlt }]}
        >
          {head}
        </Pressable>
        <MarkdownView>{b.detail}</MarkdownView>
      </View>
    );
  }
  return (
    <Pressable
      onPress={p.onPress}
      accessibilityRole="link"
      accessibilityLabel={briefingItemSpeech(p, failed ? firstLine(b) : p.mode === "line" ? (lines[0] ?? "") : lines.join(" "))}
      accessibilityState={selected}
      style={({ pressed }) => [styles.tile, frame(pressed)]}
    >
      {head}
      {failed ? (
        <Text style={{ color: t.danger, fontSize: font.small }}>{firstLine(b)}</Text>
      ) : (
        <Text style={{ color: t.sub, fontSize: font.body, lineHeight: TILE_LINE }} numberOfLines={p.mode === "line" ? 1 : FB.cardLines}>
          {p.mode === "line" ? (lines[0] ?? "") : lines.join("\n")}
        </Text>
      )}
    </Pressable>
  );
}

/** 요약 한 줄(12) 줄 간격 · 카드 요약(14) 줄 간격 — 글자 크기 × 약 1.45 */
const LINE2 = Math.round(font.small * 1.45);
const TILE_LINE = Math.round(font.body * 1.5);

const styles = StyleSheet.create({
  pills: { flexDirection: "row", borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, overflow: "hidden", flexShrink: 0 },
  pill: { minHeight: FB.pillH, minWidth: FB.pillMinW, paddingHorizontal: space.md, alignItems: "center", justifyContent: "center" },
  notice: { minHeight: FB.noticeH, flexDirection: "row", flexWrap: "wrap", alignItems: "center", alignContent: "center", columnGap: space.xs, paddingHorizontal: space.md, paddingVertical: space.xxs, borderBottomWidth: StyleSheet.hairlineWidth },
  num: { fontVariant: ["tabular-nums"] },
  // 높이는 최소만: 큰 글씨(140%)에서 숫자가 칸 밖으로 넘치지 않게 글자만큼 커진다
  rank: { minWidth: FB.rank, minHeight: FB.rank, paddingHorizontal: space.xxs, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.sm, alignItems: "center", justifyContent: "center", flexShrink: 0 },
  dot: { width: FB.dot, height: FB.dot, borderRadius: FB.dot / 2, flexShrink: 0 },
  row: { minHeight: FB.rowH, justifyContent: "center", gap: space.xxs, paddingLeft: space.lg, paddingRight: space.md, paddingVertical: space.s, borderBottomWidth: StyleSheet.hairlineWidth },
  selBar: { position: "absolute", left: 0, top: 0, bottom: 0, width: FB.selBar },
  line1: { flexDirection: "row", alignItems: "center", gap: space.s },
  name: { fontWeight: "700", flexShrink: 1 },
  when: { marginLeft: "auto", fontSize: font.small, flexShrink: 0, paddingLeft: space.xs },
  tile: { minHeight: touch.min, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.lg, paddingHorizontal: space.md, paddingTop: space.sm, paddingBottom: space.md, gap: space.xs },
  /** '상세' 보기 카드의 누르는 머리 줄 (44 이상) */
  tileHead: { minHeight: touch.min, justifyContent: "center", borderRadius: radius.sm },
});
