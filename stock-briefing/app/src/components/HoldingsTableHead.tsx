import { Ionicons } from "@expo/vector-icons";
import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { COL_LABEL, COL_SORT, type ColumnPlan } from "@/lib/holdingsColumns";
import type { SortKey } from "@/lib/settings";
import { font, layout, slopFor, space } from "@/tokens";
import { useTheme } from "@/theme";
import { ColDivider } from "./HoldingsTable";

/**
 * 넓은 잔고 표의 머리 (3-42 웨이브 B, 기능 플래그 foldLayout). 구역(보유·관심)마다 하나, 스크롤해도 위에 고정된다.
 *  - 이름 칸: "보유 17" + "등록순 ▾"(누르면 정렬 창 — 휴대폰 화면의 정렬 버튼과 같다)
 *  - 숫자 열 이름: 누르면 그 정렬로 바꾼다 (설정의 정렬 값 그대로 — lib/holdingsColumns COL_SORT). 정렬이 없는 열은 글자만
 *  - 누르는 칸은 머리 높이(layout.headH 40)를 채우고 hitSlop 으로 44 (위는 계좌 띠, 아래는 첫 줄이라 2dp 씩만 넓힌다)
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
        <Text style={{ color: t.ink, fontSize: font.h2, fontWeight: "700", flexShrink: 1 }} accessibilityRole="header" numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
          {title}
        </Text>
        <Pressable onPress={onOpenSort} hitSlop={HEAD_SLOP} accessibilityRole="button" accessibilityLabel={`정렬 바꾸기, 지금 ${sortLabel}`} style={styles.sortBtn}>
          <Text style={{ color: t.muted, fontSize: font.small }} numberOfLines={1}>
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
            <Text style={{ color: active ? t.ink : t.muted, fontSize: font.small, fontWeight: active ? "700" : "500", textAlign: "right", flexShrink: 1 }} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
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
 * 정렬 칸 hitSlop: 누르는 칸의 보이는 높이는 머리 높이에서 아래 구분선(1)을 뺀 값이라, 그만큼 여유를 두고 44 로 채운다
 * (머리 40 → 보이는 39 + 위아래 3 = 45)
 */
const HEAD_SLOP = slopFor(layout.headH - space.xxs);

const styles = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "stretch", borderBottomWidth: StyleSheet.hairlineWidth },
  headName: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingRight: space.sm },
  sortBtn: { flexDirection: "row", alignItems: "center", gap: space.xxs, alignSelf: "stretch", flexShrink: 0 },
  headTap: { justifyContent: "center" },
  headCell: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: space.xxs },
});
