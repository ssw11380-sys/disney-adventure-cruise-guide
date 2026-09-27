import Ionicons from "@expo/vector-icons/Ionicons";
import { router } from "expo-router";
import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { Briefing } from "@/api/types";
import { formatDateKo, formatPct, SESSION_LABEL } from "@/lib/format";
import { font, slopFor, space, useTheme } from "@/theme";
import { foldBriefings as FB } from "@/tokens";
import { sentence, speakRate } from "@/lib/a11y";
import { AI_TAG } from "@/lib/disclaimer";
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
  aiTag = false,
}: {
  briefing: Briefing;
  mode: "line" | "summary" | "detail";
  showName?: boolean;
  /** 오늘 등락률 (브리핑 탭 '변동 큰 순'일 때) */
  rate?: number | null;
  /** 넓은 창에서 보던 브리핑 (3-42 접고 펴기 이어 보기 — 접은 화면에서 이 카드를 강조). 기본 false = 지금 모양 그대로 */
  selected?: boolean;
  /** 날짜 줄 끝에 '· AI가 쓴 글' 조각 (브리핑 2차 6, 플래그 briefingSafeWording — 부르는 곳이 플래그를 읽어 넘긴다). 실패 브리핑에는 붙이지 않는다. 기본 false = 지금 그대로 */
  aiTag?: boolean;
}) {
  const t = useTheme();
  const failed = briefing.status === "failed";
  const ai = aiTag && !failed;
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
          ai ? AI_TAG : null,
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
          {ai ? (
            // 날짜 줄 끝 '· AI가 쓴 글': 한 줄에 들어가면 같은 줄, 오른쪽 배지 때문에 좁으면 조각째 다음 줄로 ('AI가 쓴' / '글' 처럼 꺾이지 않게)
            <View style={styles.dateRow}>
              <Muted>
                {formatDateKo(briefing.date)} {SESSION_LABEL[briefing.session]} 브리핑
              </Muted>
              <Muted>· {AI_TAG}</Muted>
            </View>
          ) : (
            <Muted>
              {formatDateKo(briefing.date)} {SESSION_LABEL[briefing.session]} 브리핑
            </Muted>
          )}
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
  // 조각 사이 간격은 글자 한 칸쯤 ('브리핑 · AI가 쓴 글')
  dateRow: { flexDirection: "row", flexWrap: "wrap", columnGap: space.xs },
});
