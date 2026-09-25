import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { Briefing } from "@/api/types";
import { formatDateKo, formatPct, SESSION_LABEL } from "@/lib/format";
import { font, slopFor, space, useTheme } from "@/theme";
import { foldBriefings as FB } from "@/tokens";
import { sentence, speakRate } from "@/lib/a11y";
import { MarkdownView } from "./MarkdownView";
import { Badge, Card, ChangeText, Muted } from "./ui";

/**
 * 브리핑 카드. mode=line 이면 첫 줄만, summary 면 3줄 요약, detail 이면 마크다운 전체.
 * 제목을 누르면 브리핑 상세 화면으로.
 */
export function BriefingCard({
  briefing,
  mode,
  showName = true,
  rate,
  selected = false,
}: {
  briefing: Briefing;
  mode: "line" | "summary" | "detail";
  showName?: boolean;
  /** 오늘 등락률 (브리핑 탭 '변동 큰 순'일 때) */
  rate?: number | null;
  /** 넓은 창에서 보던 브리핑 (3-42 접고 펴기 이어 보기 — 접은 화면에서 이 카드를 강조). 기본 false = 지금 모양 그대로 */
  selected?: boolean;
}) {
  const t = useTheme();
  const failed = briefing.status === "failed";
  const lines = briefing.summary.split("\n").filter(Boolean);
  return (
    <Card style={selected ? { borderLeftWidth: FB.selBar, borderLeftColor: t.accent, paddingLeft: space.lg - FB.selBar } : undefined}>
      <Pressable
        onPress={() => router.push(`/briefings/${briefing.id}`)}
        {...(selected ? { accessibilityState: { selected: true } } : {})}
        accessibilityRole="link"
        accessibilityLabel={sentence([
          showName ? (briefing.name ?? briefing.code) : null,
          `${formatDateKo(briefing.date)} ${SESSION_LABEL[briefing.session]} 브리핑`,
          rate !== undefined ? speakRate(rate) : null,
          failed ? "생성 실패" : briefing.missing.length ? "일부 데이터 없음" : null,
        ])}
        // 100% 배치는 그대로, 누르는 영역만 44 로 (이름이 없으면 날짜 한 줄 약 17)
        hitSlop={showName ? NAMED_HEAD_SLOP : DATE_HEAD_SLOP}
        style={styles.header}
      >
        <View style={{ flex: 1, gap: space.xxs }}>
          {showName ? (
            <Text style={{ color: t.ink, fontSize: font.h2, fontWeight: "700" }}>
              {briefing.name ?? briefing.code}
            </Text>
          ) : null}
          <Muted>
            {formatDateKo(briefing.date)} {SESSION_LABEL[briefing.session]} 브리핑
          </Muted>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          {rate !== undefined ? <ChangeText value={rate} text={formatPct(rate)} style={{ fontSize: font.small, fontWeight: "600" }} /> : null}
          {failed ? <Badge tone="bad">생성 실패</Badge> : briefing.missing.length ? <Badge>일부 데이터 없음</Badge> : null}
          <Ionicons name="chevron-forward" size={18} color={t.muted} />
        </View>
      </Pressable>
      {failed ? (
        <Text style={{ color: t.danger, fontSize: font.small }}>{briefing.error ?? briefing.summary}</Text>
      ) : mode === "line" ? (
        <Text style={{ color: t.ink, fontSize: font.body, lineHeight: 22 }} numberOfLines={1}>
          {lines[0] ?? ""}
        </Text>
      ) : mode === "summary" ? (
        <View style={{ gap: space.xs }}>
          {lines.map((line, i) => (
            <Text key={i} style={{ color: t.ink, fontSize: font.body, lineHeight: 22 }}>
              {line}
            </Text>
          ))}
        </View>
      ) : (
        <MarkdownView>{briefing.detail}</MarkdownView>
      )}
      {!failed && briefing.missing.length > 0 && mode === "detail" ? <Muted>데이터 미확인: {briefing.missing.join(", ")}</Muted> : null}
    </Card>
  );
}

/** 카드 머리의 보이는 높이: 이름+날짜 두 줄 약 40, 날짜만 약 17 */
const NAMED_HEAD_SLOP = slopFor(40);
const DATE_HEAD_SLOP = slopFor(17);

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", gap: space.sm },
});
