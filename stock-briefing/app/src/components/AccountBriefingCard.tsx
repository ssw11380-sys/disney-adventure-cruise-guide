import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { AccountBriefing } from "@/api/types";
import { accountCardSpeech } from "@/lib/accountBriefing";
import { formatDateKo, formatPct, formatWon, SESSION_LABEL } from "@/lib/format";
import { changeColor, font, space, touch, useTheme } from "@/theme";
import { Badge, Card, Muted } from "./ui";

/**
 * 브리핑 탭 맨 위 '내 계좌 브리핑' 카드 (3-31): 가장 최근 계좌 브리핑의 당일 손익·총 평가금액·기여 1위.
 * 누르면 계좌 브리핑 화면. 숫자는 서버가 계산한 값 그대로 (앱 잔고 화면과 같은 기준)
 */
export function AccountBriefingCard({ briefing }: { briefing: AccountBriefing }) {
  const t = useTheme();
  const h = briefing.headline;
  const top = h?.top[0] ?? null;
  const failed = briefing.status === "failed" || !h;
  return (
    <Card>
      <Pressable onPress={() => router.push(`/briefings/account/${briefing.id}`)} accessibilityRole="link" accessibilityLabel={accountCardSpeech(briefing)} style={styles.press}>
        <View style={styles.head}>
          <Ionicons name="wallet-outline" size={18} color={t.accent} />
          <Text style={{ color: t.ink, fontSize: font.h2, fontWeight: "700", flexShrink: 1 }}>내 계좌 브리핑</Text>
          <Muted style={styles.when}>
            {formatDateKo(briefing.date)} {SESSION_LABEL[briefing.session]}
          </Muted>
          <Ionicons name="chevron-forward" size={18} color={t.muted} />
        </View>
        {failed ? (
          <View style={styles.failed}>
            <Badge tone="bad">생성 실패</Badge>
            <Text style={{ color: t.danger, fontSize: font.small, flexShrink: 1 }}>{briefing.summary}</Text>
          </View>
        ) : (
          <>
            <View style={styles.nums}>
              <View style={styles.col}>
                <Muted>당일 손익</Muted>
                <Text style={[styles.big, { color: changeColor(t, h.dayPnl) }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>
                  {formatWon(h.dayPnl, { sign: true })}
                </Text>
                {h.dayRate !== null ? <Text style={[styles.num, { color: changeColor(t, h.dayRate), fontSize: font.small }]}>{formatPct(h.dayRate)}</Text> : null}
              </View>
              <View style={styles.col}>
                <Muted>총 평가금액</Muted>
                <Text style={[styles.big, { color: t.ink }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>
                  {formatWon(h.totalValue)}
                </Text>
                <Muted>보유 {h.holdings}종목</Muted>
              </View>
            </View>
            {top ? (
              <Text style={{ color: t.sub, fontSize: font.small }}>
                기여 1위 <Text style={{ color: t.ink, fontWeight: "700" }}>{top.name}</Text>{" "}
                <Text style={[styles.num, { color: changeColor(t, top.amount) }]}>{formatWon(top.amount, { sign: true })}</Text>
                {top.changeRate !== null ? <Text style={[styles.num, { color: changeColor(t, top.changeRate) }]}> ({formatPct(top.changeRate)})</Text> : null}
              </Text>
            ) : null}
            {briefing.template ? <Muted style={{ fontSize: font.tiny }}>숫자로 만든 기본 설명 · 매매 권유가 아닙니다</Muted> : <Muted style={{ fontSize: font.tiny }}>무엇이 계좌를 움직였는지 · 매매 권유가 아닙니다</Muted>}
          </>
        )}
      </Pressable>
    </Card>
  );
}

const styles = StyleSheet.create({
  press: { minHeight: touch.min, gap: space.sm },
  head: { flexDirection: "row", alignItems: "center", gap: space.xs, flexWrap: "wrap" },
  when: { flexGrow: 1, textAlign: "right" },
  nums: { flexDirection: "row", flexWrap: "wrap", gap: space.md },
  col: { flexGrow: 1, flexBasis: 140, gap: space.xxs },
  big: { fontSize: font.title, fontWeight: "700", fontVariant: ["tabular-nums"] },
  num: { fontVariant: ["tabular-nums"] },
  failed: { flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" },
});
