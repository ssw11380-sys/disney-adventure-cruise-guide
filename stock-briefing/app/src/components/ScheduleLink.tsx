import { router } from "expo-router";
import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useFeature } from "@/api/hooks";
import { sentence } from "@/lib/a11y";
import { freshCount, SCHEDULE_LINK, SCHEDULE_LINK_SPEECH, scheduleFilingsView } from "@/lib/filingAlerts";
import { useFilingViewed } from "@/lib/filingViewed";
import { useCachedSchedule } from "@/lib/scheduleQuery";
import { useChunkRow } from "@/lib/useChunkRow";
import { font, space, touch, useTheme } from "@/theme";

/**
 * 계좌 브리핑 상세 '다가오는 일정' 카드(없으면 '오늘 일정' 카드) 맨 아래 '일정·공시 모두 보기 ›' 한 줄 (3-38, 플래그 holdingSchedule — 부르는 쪽이 거름).
 * 누르는 줄 44dp 이상, 글자색 accent·굵기 600. 새 공시(서버가 처음 본 뒤 24시간 · 이 기기에서 아직 펼쳐 보지 않음)가 있으면 오른쪽에 흐린 '· 새 공시 2건'
 * ('·'는 링크 글 묶음 끝에 붙여 200% 에서 둘째 줄이 '·'로 시작하지 않게, 묶음 안 공백은 줄바꿈 없는 공백) —
 * '일정·공시' 화면을 이미 받아 둔 경우에만 센다 (이 줄 때문에 새 요청을 만들지 않음). filingAlerts 가 꺼져 있으면 붙이지 않는다
 */
export function ScheduleLink() {
  const t = useTheme();
  const filingsOn = useFeature("filingAlerts", false);
  const cached = useCachedSchedule();
  const [viewed] = useFilingViewed();
  const fresh = filingsOn && cached?.filings ? scheduleFilingsView(cached.filings, viewed).fresh : 0;
  const count = freshCount(fresh);
  const chunkRow = useChunkRow();
  const link = { color: t.accent, fontSize: font.body, fontWeight: "600" as const };
  const muted = { color: t.muted, fontSize: font.small, fontWeight: "400" as const };
  return (
    <Pressable
      onPress={() => router.push("/schedule")}
      accessibilityRole="button"
      accessibilityLabel={sentence([SCHEDULE_LINK_SPEECH, count])}
      style={({ pressed }) => [styles.row, { minHeight: touch.min, borderTopColor: t.line, backgroundColor: pressed ? t.surfaceAlt : "transparent" }]}
    >
      {/* 좁은 칸·큰 글씨는 묶음째 줄바꿈 (다가오는 일정 줄과 같은 규칙) */}
      <View style={[chunkRow, styles.baseline]}>
        {count ? (
          <>
            {/* '·'는 앞 묶음(링크 글) 끝에 흐린 글로 — 다음 줄이 '·'로 시작하지 않게 */}
            <Text style={link}>
              {SCHEDULE_LINK}
              <Text style={muted}>{"\u00a0·"}</Text>
            </Text>
            {/* 새 공시 수는 흐린 글, '›'는 그 묶음 끝에 붙여 홀로 줄바꿈되지 않게 */}
            <Text style={muted}>
              {count.replace(/ /g, "\u00a0")}
              <Text style={link}>{"\u00a0›"}</Text>
            </Text>
          </>
        ) : (
          <Text style={link}>{`${SCHEDULE_LINK} ›`}</Text>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { justifyContent: "center", borderTopWidth: StyleSheet.hairlineWidth, marginTop: space.xs, paddingVertical: space.s },
  baseline: { alignItems: "baseline" },
});
