import React from "react";
import { Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
import type { ColKey, ColumnPlan } from "@/lib/holdingsColumns";
import { isBigText } from "@/lib/textScale";
// 고정 값(글자·간격·크기)은 순수 모듈 tokens 에서 바로 (휴대폰 줄 StockRow 가 이 파일을 불러오므로 테스트의 theme 가짜 모듈과 상관없게)
import { font, fontCap, layout, space, touch } from "@/tokens";
import { useFontScale, useTheme } from "@/theme";
import { FlashPrice } from "./FlashPrice";

/**
 * 넓은 잔고 표 (3-42 웨이브 B, 기능 플래그 foldLayout — 잔고 탭이 넓은 창에서만 쓴다).
 * 한 줄 44dp: 종목 | 현재가 · 등락률 ‖ 평가손익 · 수익률 ‖ 당일손익 · 평가금액 · 비중 · 평단 · 수량 (열은 lib/holdingsColumns pickCols 가 고른다).
 * 숫자가 벽처럼 보이지 않게: 굵은 16 은 현재가·평가손익 두 칸뿐, 나머지는 보통 굵기 14. 평가금액·평단·비중은 색을 쓰지 않는다.
 * 줄무늬(t.zebra)와 묶음 사이 세로선으로 줄과 묶음을 나눈다. 숫자는 말줄임 없이 — 칸이 모자라면 글자를 줄인다(열 폭은 글자 배율만큼 넓혀 두었다).
 * 값 계산·화면 읽기 문장은 StockRow 가 휴대폰 줄과 같은 함수로 만들어 넘긴다 (이 파일은 그리기만).
 */

/** 숫자 칸: 칸이 좁으면 이 비율까지 글자를 줄여 한 줄에 다 보인다 (말줄임 없이) */
const FIT = { numberOfLines: 1, adjustsFontSizeToFit: true, minimumFontScale: 0.6, maxFontSizeMultiplier: fontCap.row } as const;

export interface TableCell {
  text: string;
  color: string;
  /** 굵은 16 (현재가·평가손익만) */
  strong?: boolean;
  /** 작은 안내 글자 ("합계 제외") */
  note?: boolean;
}

export interface TablePrice {
  value: number | null | undefined;
  text: string;
  color: string;
  /** 초록 점 (지금 열린 세션에서 실시간 갱신 중) */
  live: boolean;
}

export interface TableWeight {
  /** 비중 % (소수 첫째 자리). 없으면 '-' */
  pct: number | null;
  /** 막대 길이 비율 (가장 큰 비중 = 1) */
  rel: number;
  /** 막대 색 (국내·해외: 비중 보기의 국내 0번·해외 1번 조각 색) */
  color: string;
}

/** 묶음 사이 구분선 칸 (가운데 세로선). 화면 읽기에서는 건너뛴다 */
export function ColDivider() {
  const t = useTheme();
  return (
    <View style={styles.gap} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
      <View style={[styles.gapLine, { backgroundColor: t.line }]} />
    </View>
  );
}

/** 표 한 줄 (보유·관심) */
export function TableLine({
  plan,
  zebra,
  name,
  badge,
  price,
  priceMissing,
  cells,
  weight,
  onPress,
  onLongPress,
  onLayout,
  accessibilityLabel,
  accessibilityActions,
  onAccessibilityAction,
}: {
  plan: ColumnPlan;
  /** 짝수 줄 바탕 (줄무늬) */
  zebra: boolean;
  name: string;
  badge: React.ReactNode;
  price: TablePrice | null;
  priceMissing: string;
  cells: Partial<Record<ColKey, TableCell>>;
  weight: TableWeight | null;
  onPress: () => void;
  onLongPress?: () => void;
  onLayout?: (e: LayoutChangeEvent) => void;
  accessibilityLabel: string;
  accessibilityActions?: { name: string; label?: string }[];
  onAccessibilityAction?: (name: string) => void;
}) {
  const t = useTheme();
  // 큰 글씨에서만 이름을 두 줄까지 (100% 는 한 줄 말줄임 — 휴대폰 줄과 같다). 줄 높이는 최소 44 라 글자만큼 늘어난다
  const bigText = isBigText(useFontScale());
  const cell = (key: ColKey) => {
    if (key === "price") {
      return price ? (
        <View style={styles.inline}>
          {price.live ? <View style={[styles.live, { backgroundColor: t.live }]} /> : null}
          <FlashPrice value={price.value} text={price.text} style={[styles.strong, { color: price.color }]} maxScale={fontCap.row} fit />
        </View>
      ) : (
        <Text style={[styles.note, { color: t.muted }]} {...FIT}>
          {priceMissing}
        </Text>
      );
    }
    if (key === "weight") {
      if (!weight || weight.pct === null) return <Text style={[styles.num, { color: t.muted }]} {...FIT}>-</Text>;
      return (
        <View style={styles.inline}>
          <View style={[styles.track, { backgroundColor: t.line }]}>
            <View style={[styles.bar, { width: Math.max(1, Math.round(layout.weightBarW * Math.min(1, weight.rel))), backgroundColor: weight.color }]} />
          </View>
          <Text style={[styles.num, { color: t.sub }]} {...FIT}>
            {weight.pct.toFixed(1)}%
          </Text>
        </View>
      );
    }
    const c = cells[key];
    if (!c) return <Text style={[styles.num, { color: t.muted }]} {...FIT}>-</Text>;
    return (
      <Text style={[c.strong ? styles.strong : c.note ? styles.note : styles.num, { color: c.color }]} {...FIT}>
        {c.text}
      </Text>
    );
  };
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      onLayout={onLayout}
      delayLongPress={350}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityActions={accessibilityActions}
      onAccessibilityAction={onAccessibilityAction ? (e) => onAccessibilityAction(e.nativeEvent.actionName) : undefined}
      style={({ pressed }) => [styles.row, { minHeight: layout.rowH, paddingHorizontal: plan.pad, backgroundColor: pressed ? t.surfaceAlt : zebra ? t.zebra : t.surface }]}
    >
      <View style={[styles.name, { width: plan.nameW }]}>
        {badge}
        <Text style={{ color: t.ink, fontSize: font.body, fontWeight: "600", flexShrink: 1 }} numberOfLines={bigText ? 2 : 1} maxFontSizeMultiplier={fontCap.row}>
          {name}
        </Text>
      </View>
      {plan.cols.map((c) => (
        <React.Fragment key={c.key}>
          {c.divider ? <ColDivider /> : null}
          <View style={[styles.cell, { width: c.width }]}>{cell(c.key)}</View>
        </React.Fragment>
      ))}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // 한 줄 표: 높이는 최소 44(layout.rowH = touch.min), 큰 글씨면 글자만큼 늘어난다
  row: { flexDirection: "row", alignItems: "center", minHeight: touch.min },
  name: { flexDirection: "row", alignItems: "center", gap: space.xs, paddingRight: space.sm },
  inline: { flexDirection: "row", alignItems: "center", gap: space.xs, maxWidth: "100%" },
  cell: { alignItems: "flex-end", justifyContent: "center" },
  strong: { fontSize: font.h2, fontWeight: "700", fontVariant: ["tabular-nums"] },
  num: { fontSize: font.body, fontVariant: ["tabular-nums"] },
  note: { fontSize: font.small },
  live: { width: 4, height: 4, borderRadius: 2 },
  track: { width: layout.weightBarW, height: layout.weightBarH, borderRadius: 2, overflow: "hidden", flexShrink: 0 },
  bar: { height: layout.weightBarH, borderRadius: 2 },
  gap: { width: layout.colGap, alignSelf: "stretch", alignItems: "center" },
  gapLine: { width: StyleSheet.hairlineWidth, flex: 1 },
});
