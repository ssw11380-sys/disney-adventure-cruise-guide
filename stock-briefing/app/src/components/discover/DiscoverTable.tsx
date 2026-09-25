import React, { memo } from "react";
import { Pressable, StyleSheet, Text, View, type TextStyle } from "react-native";
import type { DiscoverStock } from "@/api/types";
import { FlashPrice } from "@/components/FlashPrice";
import { LineMark } from "@/components/StockLine";
import { TableHead } from "@/components/ui";
import { sentence, speakAmount, speakRate } from "@/lib/a11y";
import { DISCOVER_GAP, DISCOVER_PAD, type DiscoverColKey, type DiscoverMetric, type DiscoverTableCols } from "@/lib/discoverColumns";
import { formatKrwCompact, formatMoney, formatPct, formatQuoteDisplay, formatVolume } from "@/lib/format";
import { changeColor, font, fontCap, space, useTheme } from "@/theme";
import { foldScreens } from "@/tokens";
import type { HoldingMark } from "./DiscoverRow";

/**
 * 발견 순위 표 (3-42 웨이브 E): 넓은 창 + 기능 플래그 foldLayout 에서만 쓴다 (좁은 창은 지금의 DiscoverRow 두 줄 목록 그대로).
 * 한 줄 44 표: 순위 | 종목 | 현재가 | 등락률 | 거래대금 | 거래량 | 시가총액 | 보유 — 보일 열은 폭으로 고른다 (lib/discoverColumns).
 *  - 숫자는 말줄임 없이 한 줄 (칸이 좁으면 글자를 줄인다). 이름만 말줄임
 *  - 미국 종목 금액은 설정 '해외주식 원화 표시'(showKrw)를 따른다 (DiscoverRow 와 같은 표기)
 *  - 화면 읽기는 한 줄을 한 문장으로 (보이는 열만)
 */

/** 한 줄 높이 = 누르는 크기 44 (글자는 fontCap.row 까지만 커져 한 줄에 들어간다) */
const rowH = foldScreens.tableRowH;
/** 숫자 칸: 좁으면 이 비율까지 줄여 한 줄에 다 보인다 (말줄임 없이) */
const FIT = { numberOfLines: 1, adjustsFontSizeToFit: true, minimumFontScale: 0.6, maxFontSizeMultiplier: fontCap.row } as const;
const HEAD: Record<DiscoverColKey, string> = { price: "현재가", rate: "등락률", tradingValue: "거래대금", volume: "거래량", marketCap: "시가총액", mark: "보유" };
const ADD_WATCH_ACTION = [{ name: "longpress", label: "관심 종목에 추가" }];

/** 표 머리: 줄과 같은 열 폭. emphasis 는 지금 순위의 기준 열 (글자를 진하게) */
export function DiscoverTableHead({ table, emphasis }: { table: DiscoverTableCols; emphasis?: DiscoverColKey }) {
  const t = useTheme();
  const th = (on: boolean): TextStyle[] => [styles.th, { color: on ? t.ink : t.muted, fontWeight: on ? "700" : "500" }];
  return (
    <TableHead style={styles.head}>
      <Text style={[th(false), { width: table.rank }]} {...FIT}>
        순위
      </Text>
      <Text style={[th(false), styles.nameHead]} {...FIT}>
        종목
      </Text>
      {table.cols.map((c) => (
        <Text key={c.key} style={[th(c.key === emphasis), { width: c.width, textAlign: c.key === "mark" ? "center" : "right" }]} {...FIT}>
          {HEAD[c.key]}
        </Text>
      ))}
    </TableHead>
  );
}

/** 금액(거래대금·시가총액) 표기: 미국 종목은 설정에 따라 달러 또는 원화 환산 */
function money(v: number | null | undefined, usd: boolean, krw: boolean, fxRate: number | null | undefined): string {
  if (v === null || v === undefined) return "-";
  return krw ? formatKrwCompact(v * fxRate!, "KRW") : formatKrwCompact(v, usd ? "USD" : "KRW");
}

export const DiscoverTableRow = memo(function DiscoverTableRow({
  item,
  rank,
  table,
  metric,
  mark,
  showKrw,
  fxRate,
  onPress,
  onLongPress,
}: {
  item: DiscoverStock;
  rank: number;
  table: DiscoverTableCols;
  /** 지금 분류의 값 (그 열은 진한 글자, 나머지 값은 보조 글자) */
  metric: DiscoverMetric;
  mark: HoldingMark;
  showKrw: boolean;
  fxRate: number | null | undefined;
  onPress: (item: DiscoverStock) => void;
  onLongPress?: (item: DiscoverStock) => void;
}) {
  const t = useTheme();
  const c = changeColor(t, item.change);
  const usd = item.currency === "USD";
  const krw = usd && showKrw && !!fxRate;
  const suspended = item.suspended === true;
  const text: Record<Exclude<DiscoverColKey, "mark">, string> = {
    price: formatQuoteDisplay(item.price, item.currency, fxRate, showKrw),
    rate: formatPct(item.changeRate),
    tradingValue: money(item.tradingValue, usd, krw, fxRate),
    volume: formatVolume(item.volume),
    marketCap: money(item.marketCap, usd, krw, fxRate),
  };
  const shown = new Set(table.cols.map((col) => col.key));
  const markTag = mark ? <LineMark label={mark} color={mark === "보유" ? t.gold : t.accent} /> : null;
  const cell = (key: DiscoverColKey, width: number) => {
    if (key === "mark")
      return (
        <View key={key} style={[styles.markCell, { width }]}>
          {markTag}
        </View>
      );
    if (key === "price")
      return (
        <View key={key} style={[styles.num, { width }]}>
          <FlashPrice value={item.price} text={text.price} style={[styles.price, { color: c }]} maxScale={fontCap.row} fit />
        </View>
      );
    const color = key === "rate" ? c : key === metric ? t.ink : t.sub;
    return (
      <Text key={key} style={[styles.value, { width, color }]} {...FIT}>
        {text[key]}
      </Text>
    );
  };
  return (
    <Pressable
      onPress={() => onPress(item)}
      onLongPress={onLongPress ? () => onLongPress(item) : undefined}
      delayLongPress={350}
      accessibilityRole="button"
      accessibilityLabel={sentence([
        `${rank}위`,
        item.name,
        mark,
        item.newlyListed ? "신규상장" : null,
        suspended ? "거래정지" : null,
        `현재가 ${speakAmount(formatMoney(item.price, item.currency, fxRate, showKrw))}`,
        speakRate(item.changeRate),
        shown.has("tradingValue") && text.tradingValue !== "-" ? `거래대금 ${speakAmount(text.tradingValue)}` : null,
        shown.has("volume") && text.volume !== "-" ? `거래량 ${text.volume}주` : null,
        shown.has("marketCap") && text.marketCap !== "-" ? `시가총액 ${speakAmount(text.marketCap)}` : null,
      ])}
      // 화면 읽기의 길게 누르기 안내를 "관심 종목에 추가"로
      accessibilityActions={onLongPress ? ADD_WATCH_ACTION : undefined}
      onAccessibilityAction={onLongPress ? (e) => e.nativeEvent.actionName === "longpress" && onLongPress(item) : undefined}
      style={({ pressed }) => [styles.row, { height: rowH, backgroundColor: pressed ? t.surfaceAlt : t.surface, borderBottomColor: t.line }]}
    >
      <Text style={[styles.rank, { width: table.rank, color: rank <= 3 ? t.ink : t.muted }]} numberOfLines={1} maxFontSizeMultiplier={1.2}>
        {rank}
      </Text>
      <View style={styles.name}>
        <Text style={[styles.nameText, { color: t.ink }]} numberOfLines={1} maxFontSizeMultiplier={fontCap.row}>
          {item.name}
        </Text>
        {table.inlineMark ? markTag : null}
        {item.newlyListed ? <LineMark label="신규상장" color={t.muted} /> : null}
        {suspended ? <LineMark label="거래정지" color={t.muted} /> : null}
      </View>
      {table.cols.map((col) => cell(col.key, col.width))}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  head: { height: foldScreens.tableHeadH, paddingVertical: 0, paddingHorizontal: DISCOVER_PAD, gap: DISCOVER_GAP },
  th: { fontSize: font.tiny },
  nameHead: { flex: 1, textAlign: "left" },
  row: { flexDirection: "row", alignItems: "center", paddingHorizontal: DISCOVER_PAD, gap: DISCOVER_GAP, borderBottomWidth: StyleSheet.hairlineWidth },
  rank: { fontSize: font.small, fontWeight: "800", fontVariant: ["tabular-nums"] },
  // 이름은 남는 폭을 모두 쓰고, 넘치면 이름만 말줄임 (표시는 줄이지 않는다)
  name: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: space.xs },
  nameText: { fontSize: font.body, fontWeight: "600", flexShrink: 1 },
  num: { alignItems: "flex-end" },
  price: { fontSize: font.h2, fontWeight: "700", fontVariant: ["tabular-nums"] },
  value: { fontSize: font.body, textAlign: "right", fontVariant: ["tabular-nums"] },
  markCell: { alignItems: "center" },
});
