import { router } from "expo-router";
import React from "react";
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { useFeature } from "@/api/hooks";
import { Muted } from "@/components/ui";
import { sentence } from "@/lib/a11y";
import { freshSuffix, SCHEDULE_LINK, SCHEDULE_LINK_SPEECH, scheduleFilingsView } from "@/lib/filingAlerts";
import { useFilingViewed } from "@/lib/filingViewed";
import { useCachedSchedule } from "@/lib/scheduleQuery";
import { font, space, touch, useTheme } from "@/theme";

/**
 * 계좌 브리핑 상세 '다가오는 일정' 카드(없으면 '오늘 일정' 카드) 맨 아래 '일정·공시 모두 보기 ›' 한 줄 (3-38, 플래그 holdingSchedule — 부르는 쪽이 거름).
 * 누르는 줄 44dp 이상, 글자색 accent·굵기 600. 새 공시(서버가 처음 본 뒤 24시간 · 이 기기에서 아직 펼쳐 보지 않음)가 있으면 오른쪽에 흐린 '· 새 공시 2건' —
 * '일정·공시' 화면을 이미 받아 둔 경우에만 센다 (이 줄 때문에 새 요청을 만들지 않음). filingAlerts 가 꺼져 있으면 붙이지 않는다
 */
export function ScheduleLink() {
  const t = useTheme();
  const { fontScale } = useWindowDimensions();
  const filingsOn = useFeature("filingAlerts", false);
  const cached = useCachedSchedule();
  const [viewed] = useFilingViewed();
  const fresh = filingsOn && cached?.filings ? scheduleFilingsView(cached.filings, viewed).fresh : 0;
  const suffix = freshSuffix(fresh);
  const gap = fontScale >= 1.75 ? space.sm : fontScale >= 1.25 ? space.s : space.xs;
  return (
    <Pressable
      onPress={() => router.push("/schedule")}
      accessibilityRole="button"
      accessibilityLabel={sentence([SCHEDULE_LINK_SPEECH, suffix ? `새 공시 ${fresh}건` : null])}
      style={({ pressed }) => [styles.row, { minHeight: touch.min, borderTopColor: t.line, backgroundColor: pressed ? t.surfaceAlt : "transparent" }]}
    >
      {/* 좁은 칸·큰 글씨는 묶음째 줄바꿈 (다가오는 일정 줄과 같은 규칙) */}
      <View style={[styles.chunks, { columnGap: gap }]}>
        <Text style={{ color: t.accent, fontSize: font.body, fontWeight: "600" }}>{`${SCHEDULE_LINK} ›`}</Text>
        {suffix ? <Muted>{suffix}</Muted> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { justifyContent: "center", borderTopWidth: StyleSheet.hairlineWidth, marginTop: space.xs, paddingVertical: space.s },
  chunks: { flexDirection: "row", flexWrap: "wrap", alignItems: "baseline" },
});
