import React from "react";
import { Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle } from "react-native";
import { font, space, useTheme } from "@/theme";
import { FlashPrice } from "./FlashPrice";
import { TableHead } from "./ui";

/**
 * 종목 한 줄 (3-21): 잔고·발견·테마·검색이 같은 모양·같은 열 폭을 쓴다 → 현재가 열의 오른쪽 끝이 화면마다 같다.
 *  [순위] | 종목명 / 보조 줄(코드·수량·배지) | 현재가 / 등락률 | 오른쪽 열(화면마다: 평가손익·거래대금·등록)
 * 높이는 LINE_H 로 고정 (FlatList getItemLayout 에 그대로 쓴다)
 */
export const LINE_COL = { rank: 30, price: 100, right: 108 } as const;
export const LINE_H = 58;
/** 고정 높이 줄(발견)이 큰 글씨에서 겹치지 않게 글자 확대 상한 (3-22 에서 다시 본다) */
const MAX_SCALE = 1.4;
/** 표 머리의 현재가 열 문구 (모든 화면 같은 말) */
export const PRICE_HEAD = "현재가·등락률";

export interface LinePrice {
  value: number | null | undefined;
  text: string;
  color: string;
  rate: string;
  rateColor: string;
  /** 실시간 체결 중 (초록 점) */
  live?: boolean;
}

export function StockLine({
  rank,
  name,
  nameBadge,
  sub,
  badges,
  price,
  priceMissing = "-",
  right,
  onPress,
  onLongPress,
  accessibilityLabel,
  accessibilityActions,
  onAccessibilityAction,
  fixedHeight = false,
}: {
  rank?: number;
  name: string;
  /** 이름 앞 작은 표시 (US/KR) */
  nameBadge?: React.ReactNode;
  /** 이름 아래 줄 (코드·수량·평단) */
  sub?: string;
  /** 보조 줄 뒤 표시 (보유·관심·신규상장) */
  badges?: React.ReactNode;
  price: LinePrice | null;
  /** 시세가 없을 때 현재가 열 문구 */
  priceMissing?: string;
  /** 오른쪽 열 (폭 LINE_COL.right, 오른쪽 맞춤) */
  right?: React.ReactNode;
  onPress: () => void;
  onLongPress?: () => void;
  accessibilityLabel?: string;
  accessibilityActions?: { name: string; label?: string }[];
  onAccessibilityAction?: (name: string) => void;
  /** 높이를 LINE_H 로 고정 (FlatList getItemLayout 을 쓰는 목록). 아니면 최소 높이만 — 큰 글씨에서 줄이 늘어난다 */
  fixedHeight?: boolean;
}) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={350}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityActions={accessibilityActions}
      onAccessibilityAction={onAccessibilityAction ? (e) => onAccessibilityAction(e.nativeEvent.actionName) : undefined}
      style={({ pressed }) => [styles.row, fixedHeight ? { height: LINE_H } : { minHeight: LINE_H, paddingVertical: space.s }, { backgroundColor: pressed ? t.surfaceAlt : t.surface, borderBottomColor: t.line }]}
    >
      {rank !== undefined ? (
        <Text style={[styles.rank, { color: rank <= 3 ? t.ink : t.muted }]} numberOfLines={1} maxFontSizeMultiplier={1.2}>
          {rank}
        </Text>
      ) : null}
      <View style={styles.name}>
        <View style={styles.inline}>
          {nameBadge}
          <Text style={{ color: t.ink, fontSize: font.body, fontWeight: "600", flexShrink: 1 }} numberOfLines={1} maxFontSizeMultiplier={MAX_SCALE}>
            {name}
          </Text>
        </View>
        {sub || badges ? (
          // 표시가 여럿이어도 현재가 열을 넘지 않게 자른다
          <View style={[styles.inline, { overflow: "hidden" }]}>
            {sub ? (
              <Text style={{ color: t.muted, fontSize: font.small, fontVariant: ["tabular-nums"], flexShrink: 1 }} numberOfLines={1} maxFontSizeMultiplier={MAX_SCALE}>
                {sub}
              </Text>
            ) : null}
            {badges}
          </View>
        ) : null}
      </View>
      <View style={[styles.num, { width: LINE_COL.price }]}>
        {price ? (
          <>
            <View style={styles.inline}>
              {price.live ? <View style={[styles.live, { backgroundColor: t.live }]} /> : null}
              <FlashPrice value={price.value} text={price.text} style={[styles.main, { color: price.color }]} maxScale={MAX_SCALE} />
            </View>
            <Text style={[styles.sub, { color: price.rateColor }]} maxFontSizeMultiplier={MAX_SCALE}>
              {price.rate}
            </Text>
          </>
        ) : (
          <Text style={{ color: t.muted, fontSize: font.small }}>{priceMissing}</Text>
        )}
      </View>
      <View style={[styles.num, { width: LINE_COL.right }]}>{right}</View>
    </Pressable>
  );
}

/** 오른쪽 열의 두 줄 숫자 (위: 굵게, 아래: 작게) */
export function LineValue({ main, mainColor, sub, subColor }: { main: string; mainColor: string; sub?: string; subColor?: string }) {
  const t = useTheme();
  return (
    <>
      <Text style={[styles.main, { color: mainColor }]} numberOfLines={1} adjustsFontSizeToFit maxFontSizeMultiplier={MAX_SCALE}>
        {main}
      </Text>
      {sub !== undefined ? (
        <Text style={[styles.sub, { color: subColor ?? t.muted }]} numberOfLines={1} maxFontSizeMultiplier={MAX_SCALE}>
          {sub}
        </Text>
      ) : null}
    </>
  );
}

/** 작은 테두리 표시 (US·KR·보유·관심·신규상장·거래정지) */
export function LineMark({ label, color }: { label: string; color: string }) {
  return <Text style={[styles.mark, { color, borderColor: color }]}>{label}</Text>;
}

/** 표 머리: 종목 행과 같은 열 폭. 가운데 열 문구는 PRICE_HEAD 로 고정 */
export function LineHead({ rank, name = "종목명", price, right }: { rank?: boolean; name?: React.ReactNode; price?: React.ReactNode; right?: React.ReactNode }) {
  const t = useTheme();
  const th: StyleProp<TextStyle> = [styles.th, { color: t.muted }];
  const cell = (node: React.ReactNode, align: "left" | "right") => (typeof node === "string" ? <Text style={[th, { textAlign: align }]} numberOfLines={1}>{node}</Text> : node);
  return (
    <TableHead>
      {rank ? <Text style={[th, { width: LINE_COL.rank }]}>순위</Text> : null}
      <View style={{ flex: 1 }}>{cell(name, "left")}</View>
      <View style={{ width: LINE_COL.price }}>{cell(price ?? PRICE_HEAD, "right")}</View>
      <View style={{ width: LINE_COL.right }}>{cell(right ?? "", "right")}</View>
    </TableHead>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", paddingHorizontal: space.lg, borderBottomWidth: StyleSheet.hairlineWidth },
  rank: { width: LINE_COL.rank, fontSize: font.small, fontWeight: "800", fontVariant: ["tabular-nums"] },
  name: { flex: 1, gap: space.xxs, paddingRight: space.sm },
  inline: { flexDirection: "row", alignItems: "center", gap: space.xs },
  mark: { fontSize: font.tiny, fontWeight: "800", borderWidth: 1, borderRadius: 2, paddingHorizontal: space.xs, lineHeight: 14, overflow: "hidden", flexShrink: 0 },
  num: { alignItems: "flex-end", gap: space.xxs },
  main: { fontSize: font.body, fontWeight: "700", fontVariant: ["tabular-nums"] },
  sub: { fontSize: font.small, fontVariant: ["tabular-nums"] },
  live: { width: 4, height: 4, borderRadius: 2 },
  th: { fontSize: font.tiny, fontWeight: "500" },
});
