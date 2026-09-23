import React, { memo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { DiscoverStock } from "@/api/types";
import { FlashPrice } from "@/components/FlashPrice";
import { formatKrwCompact, formatPct, formatQuoteDisplay, formatVolume } from "@/lib/format";
import { changeColor, font, space, useTheme } from "@/theme";

/** 발견 목록 한 줄의 높이 (FlatList getItemLayout 용) */
export const DISCOVER_ROW_H = 58;
export const DISCOVER_COL = { rank: 30, price: 100, right: 86 } as const;

export type HoldingMark = "보유" | "관심" | null;

/**
 * 순위·테마 종목 한 줄 (증권사 순위 화면처럼 4열):
 *  순위 | 종목명 / 코드·보유·관심 | 현재가 / 등락률 | 거래대금(또는 거래량) / 보조 값
 * 누르면 종목 상세, 길게 누르면 관심 추가. showKrw 면 미국 종목 금액을 원화로 환산한다.
 */
export const DiscoverRow = memo(function DiscoverRow({
  item,
  rank,
  metric,
  mark,
  showKrw,
  fxRate,
  onPress,
  onLongPress,
}: {
  item: DiscoverStock;
  rank?: number;
  /** 오른쪽 열에 보일 값 */
  metric: "tradingValue" | "volume";
  mark: HoldingMark;
  showKrw: boolean;
  fxRate: number | null | undefined;
  onPress: (item: DiscoverStock) => void;
  onLongPress?: (item: DiscoverStock) => void;
}) {
  const t = useTheme();
  const c = changeColor(t, item.change);
  const usd = item.currency === "USD";
  // 거래정지는 출처 표시로만 (거래량 0 이어도 거래 가능한 코넥스 종목·장 시작 전 목록이 있다)
  const suspended = item.suspended === true;
  const krw = usd && showKrw && !!fxRate;
  const tv = item.tradingValue;
  const main =
    metric === "volume"
      ? formatVolume(item.volume)
      : tv === null
        ? "-"
        : krw
          ? formatKrwCompact(tv * fxRate!, "KRW")
          : formatKrwCompact(tv, usd ? "USD" : "KRW");
  // 보조 값: 거래대금 열이면 거래량, 거래량 열이면 거래대금
  const sub =
    metric === "volume"
      ? tv === null
        ? ""
        : krw
          ? formatKrwCompact(tv * fxRate!, "KRW")
          : formatKrwCompact(tv, usd ? "USD" : "KRW")
      : item.volume === null
        ? ""
        : `${formatVolume(item.volume)}주`;
  return (
    <Pressable
      onPress={() => onPress(item)}
      onLongPress={onLongPress ? () => onLongPress(item) : undefined}
      delayLongPress={350}
      accessibilityRole="button"
      accessibilityLabel={`${rank ? `${rank}위 ` : ""}${item.name} ${formatPct(item.changeRate)}`}
      style={({ pressed }) => [styles.row, { backgroundColor: pressed ? t.surfaceAlt : t.surface, borderBottomColor: t.line }]}
    >
      {rank !== undefined ? (
        <Text style={[styles.rank, { color: rank <= 3 ? t.ink : t.muted }]} numberOfLines={1} maxFontSizeMultiplier={1.2}>
          {rank}
        </Text>
      ) : null}
      <View style={styles.name}>
        <Text style={{ color: t.ink, fontSize: font.body, fontWeight: "600" }} numberOfLines={1}>
          {item.name}
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <Text style={{ color: t.muted, fontSize: font.tiny, fontVariant: ["tabular-nums"] }} numberOfLines={1}>
            {item.code}
          </Text>
          {mark ? (
            <Text style={[styles.mark, { color: mark === "보유" ? t.gold : t.accent, borderColor: mark === "보유" ? t.gold : t.accent }]}>{mark}</Text>
          ) : null}
          {item.newlyListed ? <Text style={[styles.mark, { color: t.muted, borderColor: t.lineStrong }]}>신규상장</Text> : null}
          {suspended ? <Text style={[styles.mark, { color: t.muted, borderColor: t.lineStrong }]}>거래정지</Text> : null}
        </View>
      </View>
      <View style={[styles.num, { width: DISCOVER_COL.price }]}>
        <FlashPrice value={item.price} text={formatQuoteDisplay(item.price, item.currency, fxRate, showKrw)} style={[styles.main, { color: c }]} />
        <Text style={[styles.sub, { color: c }]}>{formatPct(item.changeRate)}</Text>
      </View>
      <View style={[styles.num, { width: DISCOVER_COL.right }]}>
        <Text style={[styles.main, { color: t.ink }]} numberOfLines={1} adjustsFontSizeToFit>
          {main}
        </Text>
        <Text style={[styles.sub, { color: t.muted }]} numberOfLines={1}>
          {sub}
        </Text>
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", height: DISCOVER_ROW_H, paddingHorizontal: space.lg, borderBottomWidth: StyleSheet.hairlineWidth },
  rank: { width: DISCOVER_COL.rank, fontSize: font.small, fontWeight: "800", fontVariant: ["tabular-nums"] },
  name: { flex: 1, gap: 2, paddingRight: space.sm },
  mark: { fontSize: 9, fontWeight: "800", borderWidth: 1, borderRadius: 2, paddingHorizontal: 3, lineHeight: 12, overflow: "hidden" },
  num: { alignItems: "flex-end", gap: 2 },
  main: { fontSize: font.body, fontWeight: "700", fontVariant: ["tabular-nums"] },
  sub: { fontSize: font.small, fontVariant: ["tabular-nums"] },
});
