import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { AccountBriefing } from "@/api/types";
import { accountCardSpeech } from "@/lib/accountBriefing";
import { briefingWhen } from "@/lib/briefingPick";
import { KR_PREVIOUS_DAY_LINE, US_PREVIOUS_DAY_LINE } from "@/lib/briefingDigest";
import { formatDateKo, formatPct, formatWon, SESSION_LABEL, shownSign } from "@/lib/format";
import { changeColor, font, fontCap, space, touch, useTheme } from "@/theme";
import { foldBriefings as FB } from "@/tokens";
import { Badge, Card, Muted } from "./ui";

/**
 * 브리핑 탭 맨 위 '내 계좌 브리핑' 카드 (3-31): 가장 최근 계좌 브리핑의 당일 손익·총 평가금액·기여 1위.
 * 누르면 계좌 브리핑 화면. 숫자는 서버가 계산한 값 그대로 (앱 잔고 화면과 같은 기준)
 */
export function AccountBriefingCard({ briefing, selected = false }: { briefing: AccountBriefing; /** 넓은 창에서 보던 계좌 브리핑 (3-42 접고 펴기 이어 보기). 기본 false = 지금 모양 그대로 */ selected?: boolean }) {
  const t = useTheme();
  const h = briefing.headline;
  const top = h?.top[0] ?? null;
  const failed = briefing.status === "failed" || !h;
  return (
    <Card style={selected ? { borderLeftWidth: FB.selBar, borderLeftColor: t.accent, paddingLeft: space.lg - FB.selBar } : undefined}>
      <Pressable onPress={() => router.push(`/briefings/account/${briefing.id}`)} {...(selected ? { accessibilityState: { selected: true } } : {})} accessibilityRole="link" accessibilityLabel={accountCardSpeech(briefing)} style={styles.press}>
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
            {h.krPreviousDay ? <Muted>{KR_PREVIOUS_DAY_LINE}</Muted> : null}
            {h.usPreviousDay ? <Muted>{US_PREVIOUS_DAY_LINE}</Muted> : null}
            {briefing.template ? <Muted style={{ fontSize: font.tiny }}>숫자로 만든 기본 설명 · 매매 권유가 아닙니다</Muted> : <Muted style={{ fontSize: font.tiny }}>무엇이 계좌를 움직였는지 · 매매 권유가 아닙니다</Muted>}
          </>
        )}
      </Pressable>
    </Card>
  );
}

/**
 * 넓은 창 브리핑 목록 맨 위 '내 계좌 브리핑' 줄 60 (3-42 웨이브 D, 기능 플래그 foldLayout — 접은 화면은 위 카드 그대로).
 * 1줄: 지갑 · 내 계좌 브리핑 · (기본 설명) · 날짜 ›  /  2줄: 당일 손익·등락률 · 기여 1위 이름·금액 (숫자는 줄이지 않고 길면 다음 줄로)
 * 2단에서는 누르면 오른쪽 칸에 계좌 브리핑(role button), 카드 격자에서는 전체 화면(role link)
 */
export function AccountBriefingRow({ briefing, selected, onPress, role }: { briefing: AccountBriefing; selected: boolean; onPress: () => void; role: "button" | "link" }) {
  const t = useTheme();
  const h = briefing.headline;
  const top = h?.top[0] ?? null;
  const failed = briefing.status === "failed" || !h;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole={role}
      accessibilityLabel={accountCardSpeech(briefing)}
      // 카드 격자(link)에서도 고른 줄이면 '선택됨'을 알린다 (같은 격자의 카드·폰 카드와 같게)
      accessibilityState={role === "button" ? { selected } : selected ? { selected: true } : undefined}
      style={({ pressed }) => [styles.row, { borderBottomColor: t.line, backgroundColor: selected || pressed ? t.surfaceAlt : t.surface }]}
    >
      {selected ? <View style={[styles.selBar, { backgroundColor: t.accent }]} /> : null}
      <View style={styles.rowHead}>
        <Ionicons name="wallet-outline" size={ROW_ICON} color={t.gold} />
        <Text style={{ color: t.ink, fontSize: font.body, fontWeight: "700", flexShrink: 1 }} numberOfLines={1} maxFontSizeMultiplier={fontCap.row}>
          내 계좌 브리핑
        </Text>
        {!failed && briefing.template ? <Badge>기본 설명</Badge> : null}
        <Text style={[styles.rowWhen, { color: t.muted }]} maxFontSizeMultiplier={fontCap.row}>
          {briefingWhen(briefing)}
        </Text>
        <Ionicons name="chevron-forward" size={ROW_ICON - 2} color={t.muted} />
      </View>
      {failed ? (
        <Text style={{ color: t.danger, fontSize: font.small }} maxFontSizeMultiplier={fontCap.row}>
          생성 실패 · {briefing.summary}
        </Text>
      ) : (
        // 두 묶음(당일 손익 · 기여 1위)을 따로 두어, 폭이 모자라면 묶음째 다음 줄로 (금액 가운데에서 줄이 꺾이지 않게)
        <View style={styles.rowNums}>
          <Text style={{ color: t.sub, fontSize: font.small }} maxFontSizeMultiplier={fontCap.row}>
            당일{" "}
            <Text style={[styles.num, { color: changeColor(t, shownSign(h.dayPnl, formatWon(h.dayPnl, { sign: true }))), fontSize: font.body, fontWeight: "700" }]}>{formatWon(h.dayPnl, { sign: true })}</Text>
            {h.dayRate !== null ? <Text style={[styles.num, { color: changeColor(t, shownSign(h.dayRate, formatPct(h.dayRate))) }]}> {formatPct(h.dayRate)}</Text> : null}
            {/* 구분점은 앞 묶음 끝에 (줄이 넘어가도 새 줄이 '·'로 시작하지 않게 — 목록 위 안내와 같은 규칙) */}
            {top ? " ·" : null}
          </Text>
          {top ? (
            <Text style={{ color: t.sub, fontSize: font.small }} maxFontSizeMultiplier={fontCap.row}>
              {"기여 1위 "}
              <Text style={{ color: t.ink }}>{top.name}</Text>{" "}
              <Text style={[styles.num, { color: changeColor(t, shownSign(top.amount, formatWon(top.amount, { sign: true }))) }]}>{formatWon(top.amount, { sign: true })}</Text>
            </Text>
          ) : null}
        </View>
      )}
    </Pressable>
  );
}

/** 계좌 줄 아이콘 (글자 14 줄에 맞춤) */
const ROW_ICON = 18;

const styles = StyleSheet.create({
  row: { minHeight: FB.accountRowH, justifyContent: "center", gap: space.xxs, paddingLeft: space.lg, paddingRight: space.md, paddingVertical: space.s, borderBottomWidth: StyleSheet.hairlineWidth },
  selBar: { position: "absolute", left: 0, top: 0, bottom: 0, width: FB.selBar },
  rowHead: { flexDirection: "row", alignItems: "center", gap: space.s },
  rowWhen: { marginLeft: "auto", fontSize: font.small, flexShrink: 0 },
  rowNums: { flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", columnGap: space.xs },
  press: { minHeight: touch.min, gap: space.sm },
  head: { flexDirection: "row", alignItems: "center", gap: space.xs, flexWrap: "wrap" },
  when: { flexGrow: 1, textAlign: "right" },
  nums: { flexDirection: "row", flexWrap: "wrap", gap: space.md },
  col: { flexGrow: 1, flexBasis: 140, gap: space.xxs },
  big: { fontSize: font.title, fontWeight: "700", fontVariant: ["tabular-nums"] },
  num: { fontVariant: ["tabular-nums"] },
  failed: { flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" },
});
