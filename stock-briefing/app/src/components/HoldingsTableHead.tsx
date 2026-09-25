import { Ionicons } from "@expo/vector-icons";
import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { COL_LABEL, COL_SORT, type ColumnPlan } from "@/lib/holdingsColumns";
import type { SortKey } from "@/lib/settings";
import { font, fontCap, layout, space, touch } from "@/tokens";
import { useTheme } from "@/theme";
import { ColDivider } from "./HoldingsTable";

/**
 * 넓은 잔고 표의 머리 (3-42 웨이브 B, 기능 플래그 foldLayout). 구역(보유·관심)마다 하나, 스크롤해도 위에 고정된다.
 *  - 이름 칸: "보유 17" + "등록순 ▾"(누르면 정렬 창 — 휴대폰 화면의 정렬 버튼과 같다)
 *  - 숫자 열 이름: 누르면 그 정렬로 바꾼다 (설정의 정렬 값 그대로 — lib/holdingsColumns COL_SORT). 정렬이 없는 열은 글자만
 *  - 머리 높이가 누르는 크기 44(layout.headH)라 정렬 칸은 hitSlop 없이 머리를 채운다. 머리는 위에 고정되고 바로 아래가 종목 줄이라,
 *    아래로 넓히면 줄 윗가장자리를 누를 때 정렬이 바뀐다 (3-22 휴대폰 머리와 같은 까닭) → 아래로는 넓히지 않는다
 *  - 글자는 표 줄과 같은 확대 상한(fontCap.row 140%): 고정 폭 열의 머리가 아래 숫자보다 커지지 않게
 */
export function TableHeadRow({
  plan,
  title,
  sort,
  sortLabel,
  onSort,
  onOpenSort,
}: {
  plan: ColumnPlan;
  title: string;
  sort: SortKey;
  sortLabel: string;
  onSort: (k: SortKey) => void;
  onOpenSort: () => void;
}) {
  const t = useTheme();
  return (
    <View style={[styles.head, { minHeight: layout.headH, paddingHorizontal: plan.pad, backgroundColor: t.surfaceAlt, borderColor: t.line }]}>
      <View style={[styles.headName, { width: plan.nameW }]}>
        <Text
          style={{ color: t.ink, fontSize: font.h2, fontWeight: "700", flexShrink: 1 }}
          accessibilityRole="header"
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.7}
          maxFontSizeMultiplier={fontCap.row}
        >
          {title}
        </Text>
        <Pressable onPress={onOpenSort} hitSlop={HEAD_SLOP} accessibilityRole="button" accessibilityLabel={`정렬 바꾸기, 지금 ${sortLabel}`} style={styles.sortBtn}>
          <Text style={{ color: t.muted, fontSize: font.small }} numberOfLines={1} maxFontSizeMultiplier={fontCap.row}>
            {sortLabel}
          </Text>
          <Ionicons name="chevron-down" size={font.small} color={t.muted} />
        </Pressable>
      </View>
      {plan.cols.map((c) => {
        const key = COL_SORT[c.key];
        const active = key !== undefined && key === sort;
        const label = (
          <View style={styles.headCell}>
            <Text
              style={{ color: active ? t.ink : t.muted, fontSize: font.small, fontWeight: active ? "700" : "500", textAlign: "right", flexShrink: 1 }}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.7}
              maxFontSizeMultiplier={fontCap.row}
            >
              {COL_LABEL[c.key]}
            </Text>
            {active ? <Ionicons name="caret-down" size={font.tiny} color={t.ink} /> : null}
          </View>
        );
        return (
          <React.Fragment key={c.key}>
            {c.divider ? <ColDivider /> : null}
            {key ? (
              <Pressable
                onPress={() => onSort(key)}
                hitSlop={HEAD_SLOP}
                accessibilityRole="button"
                accessibilityLabel={`${COL_LABEL[c.key]}순 정렬`}
                accessibilityState={{ selected: active }}
                style={[styles.headTap, { width: c.width }]}
              >
                {label}
              </Pressable>
            ) : (
              <View style={[styles.headTap, { width: c.width }]}>{label}</View>
            )}
          </React.Fragment>
        );
      })}
    </View>
  );
}

/**
 * 정렬 칸 hitSlop: 머리(44)는 아래 구분선(머리카락 두께)만큼 보이는 높이가 44 에 모자라 위로만 그만큼 넓힌다.
 * 아래는 0 — 바로 밑이 종목 줄이다. 좌우도 0 (옆 열 이름과 겹치지 않게. 폭은 열 폭·정렬 버튼 최소 폭 44 로 지킨다)
 */
const HEAD_SLOP = { top: Math.ceil(StyleSheet.hairlineWidth), bottom: 0, left: 0, right: 0 };

const styles = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "stretch", borderBottomWidth: StyleSheet.hairlineWidth },
  headName: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingRight: space.sm },
  // 정렬 버튼: 두 글자 정렬 이름("이름 ▾"·"시장 ▾")도 누르는 폭 44 이상
  sortBtn: { flexDirection: "row", alignItems: "center", gap: space.xxs, alignSelf: "stretch", flexShrink: 0, minWidth: touch.min },
  headTap: { justifyContent: "center" },
  headCell: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: space.xxs },
});
