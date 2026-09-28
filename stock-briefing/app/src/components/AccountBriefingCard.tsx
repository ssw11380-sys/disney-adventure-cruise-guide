import Ionicons from "@expo/vector-icons/Ionicons";
import { router } from "expo-router";
import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { AccountBriefing } from "@/api/types";
import { accountCardSpeech, accountHolidayLines, briefingTime, contributorsHead } from "@/lib/accountBriefing";
import { sinceLine } from "@/lib/accountSinceLast";
import { weekLine } from "@/lib/holdingEvents";
import { briefingWhen } from "@/lib/briefingPick";
import { KR_PREVIOUS_DAY_LINE, krPreviousDayLine, usPreviousDayLine } from "@/lib/briefingDigest";
import { formatDateKo, formatPct, formatWon, SESSION_LABEL, shownSign } from "@/lib/format";
import { viewDateOf } from "@/lib/marketSummary";
import { useNow } from "@/lib/useNow";
import { changeColor, font, fontCap, space, touch, useTheme } from "@/theme";
import { foldBriefings as FB } from "@/tokens";
import { Badge, Card, Muted } from "./ui";

/**
 * 브리핑 탭 맨 위 '내 계좌 브리핑' 카드 (3-31): 가장 최근 계좌 브리핑의 당일 손익·총 평가금액·기여 1위.
 * 누르면 계좌 브리핑 화면. 숫자는 서버가 계산한 값 그대로 (앱 잔고 화면과 같은 기준).
 * trim(브리핑 2차 4, 플래그 briefingTrim — 탭에서 읽어 넘김): 한국 휴장 줄에 브리핑 날짜('9/25(금) 한국 휴장 · …'), 끝줄 '숫자로 만든 요약 · …'
 * contributors(브리핑 2차 3, 플래그 moversMerge — 탭이 '합치기 가능'일 때만 넘김): '기여 1위 …' 줄 대신 기여 상위 묶음(ContributorsBlock)
 * timeMark(3-32, 플래그 numberBasis — 탭이 읽어 넘김): '당일 손익' 이름 뒤 ' · 08:38 기준' (실패·기여 상위 묶음이 있으면 더하지 않음 — 묶음 머리에 이미 시각)
 */
export function AccountBriefingCard({
  briefing,
  selected = false,
  trim = false,
  contributors = false,
  since = false,
  week = false,
  timeMark = false,
}: {
  briefing: AccountBriefing;
  /** 넓은 창에서 보던 계좌 브리핑 (3-42 접고 펴기 이어 보기). 기본 false = 지금 모양 그대로 */
  selected?: boolean;
  /** 브리핑 2차 4 (플래그 briefingTrim). 기본 false = 지금 글 그대로 */
  trim?: boolean;
  /** 브리핑 2차 3 (플래그 moversMerge): 기여 상위 묶음. 기본 false = 지금 '기여 1위' 줄 그대로 */
  contributors?: boolean;
  /** 브리핑 3차 3 (플래그 accountSinceLast): 숫자 아래 '9/25(금) 오전보다 총 평가 …' 한 줄. 기본 false = 지금 그대로 */
  since?: boolean;
  /** 브리핑 3차 5 (플래그 holdingEvents): '이번 주 일정 · …' 한 줄 (그 주 첫 오전 브리핑에 일정이 있을 때만). 기본 false = 지금 그대로 */
  week?: boolean;
  /** 3-32 (플래그 numberBasis): 숫자의 시각 'HH:MM 기준'. 기본 false = 지금 그대로 */
  timeMark?: boolean;
}) {
  const t = useTheme();
  const h = briefing.headline;
  const block = contributors && !!h && h.top.length > 0;
  const top = block ? null : (h?.top[0] ?? null);
  const failed = briefing.status === "failed" || !h;
  const hhmm = timeMark && !failed && !block ? briefingTime(briefing.createdAt) : "";
  return (
    <Card style={selected ? { borderLeftWidth: FB.selBar, borderLeftColor: t.accent, paddingLeft: space.lg - FB.selBar } : undefined}>
      <Pressable
        onPress={() => router.push(`/briefings/account/${briefing.id}`)}
        {...(selected ? { accessibilityState: { selected: true } } : {})}
        accessibilityRole="link"
        accessibilityLabel={accountCardSpeech(briefing, { ...(block ? { trim, contributors: true } : hhmm ? { trim, time: true } : { trim }), ...(since ? { since: true } : {}), ...(week ? { week: true } : {}) })}
        style={styles.press}
      >
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
                <Muted>{hhmm ? `당일 손익 · ${hhmm} 기준` : "당일 손익"}</Muted>
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
            {block ? <ContributorsBlock briefing={briefing} /> : null}
            {/* 기여 묶음 뒤에 (묶음 머리의 'HH:MM 기준'이 이 줄의 시각으로 읽히지 않게, 당일 손익 묶음을 가르지 않게) */}
            {since ? <SinceLineText briefing={briefing} /> : null}
            {week ? <WeekLineText briefing={briefing} /> : null}
            {h.krPreviousDay ? <Muted>{trim ? krPreviousDayLine(briefing.date) : KR_PREVIOUS_DAY_LINE}</Muted> : null}
            {h.usPreviousDay ? <Muted>{usPreviousDayLine(briefing.date, h.usHolidayDate)}</Muted> : null}
            {trim ? (
              <Muted style={{ fontSize: font.tiny }}>{briefing.template ? "숫자로 만든 요약 · 매매 권유가 아닙니다" : "숫자로 만든 요약 · 설명은 AI가 쓴 글 · 매매 권유가 아닙니다"}</Muted>
            ) : briefing.template ? (
              <Muted style={{ fontSize: font.tiny }}>숫자로 만든 기본 설명 · 매매 권유가 아닙니다</Muted>
            ) : (
              <Muted style={{ fontSize: font.tiny }}>무엇이 계좌를 움직였는지 · 매매 권유가 아닙니다</Muted>
            )}
          </>
        )}
      </Pressable>
    </Card>
  );
}

/**
 * 넓은 창 브리핑 목록 맨 위 '내 계좌 브리핑' 줄 60 (3-42 웨이브 D, 기능 플래그 foldLayout — 접은 화면은 위 카드 그대로).
 * 1줄: 지갑 · 내 계좌 브리핑 · (기본 설명) · 날짜 ›  /  2줄: 당일 손익·등락률 · 기여 1위 이름·금액 (숫자는 줄이지 않고 길면 다음 줄로)
 * 2단에서는 누르면 오른쪽 칸에 계좌 브리핑(role button), 카드 격자에서는 전체 화면(role link).
 * trim(브리핑 2차 4, 플래그 briefingTrim): 배지 '기본 설명' → '숫자 요약', 화면 읽기의 한국 휴장 날짜
 * 브리핑 2차 2·3 (접은 화면 맨 위 묶음 — 플래그 briefingCompactTop·moversMerge, 탭이 읽어 넘김. 모두 기본값이면 지금 넓은 창 모양·문장 그대로):
 *  - holidayLines: 숫자 줄 아래(기여 상위 묶음이 있으면 그 아래) 휴장 줄 한국 → 미국 (accountHolidayLines — 브리핑 날짜가 오늘이 아니면 날짜 모양)
 *  - contributors: 둘째 줄의 '· 기여 1위 …' 묶음 대신 기여 상위 묶음(ContributorsBlock)
 * timeMark(3-32, 플래그 numberBasis — 탭이 읽어 넘김): 둘째 줄 끝에 '08:38 기준' 묶음 (실패·기여 상위 묶음이 있으면 더하지 않음). 새 줄은 만들지 않는다
 */
export function AccountBriefingRow({
  briefing,
  selected,
  onPress,
  role,
  trim = false,
  holidayLines = false,
  contributors = false,
  since = false,
  week = false,
  timeMark = false,
}: {
  briefing: AccountBriefing;
  selected: boolean;
  onPress: () => void;
  role: "button" | "link";
  /** 브리핑 2차 4 (플래그 briefingTrim). 기본 false = 지금 글 그대로 */
  trim?: boolean;
  /** 브리핑 2차 2 (플래그 briefingCompactTop): 휴장 줄. 기본 false = 지금 그대로(줄 없음) */
  holidayLines?: boolean;
  /** 브리핑 2차 3 (플래그 moversMerge, 접은 화면만): 기여 상위 묶음. 기본 false = 지금 '기여 1위' 묶음 그대로 */
  contributors?: boolean;
  /** 브리핑 3차 3 (플래그 accountSinceLast — 접은 화면·카드 격자만, 2단 계좌 줄은 넘기지 않음): 숫자 줄 아래 '9/25(금) 오전보다 총 평가 …'. 기본 false = 지금 그대로 */
  since?: boolean;
  /** 브리핑 3차 5 (플래그 holdingEvents — 접은 화면·카드 격자만, 2단 계좌 줄은 넘기지 않음): '이번 주 일정 · …' 한 줄. 기본 false = 지금 그대로 */
  week?: boolean;
  /** 3-32 (플래그 numberBasis): 둘째 줄 끝 'HH:MM 기준'. 기본 false = 지금 그대로 */
  timeMark?: boolean;
}) {
  const t = useTheme();
  const today = viewDateOf(new Date(useNow(60_000)));
  const h = briefing.headline;
  const block = contributors && !!h && h.top.length > 0;
  const top = block ? null : (h?.top[0] ?? null);
  const failed = briefing.status === "failed" || !h;
  const holidays = holidayLines && !failed ? accountHolidayLines(briefing, { trim, today }) : [];
  const hhmm = timeMark && !failed && !block ? briefingTime(briefing.createdAt) : "";
  // 옵션을 쓰지 않으면 예전 문장 그대로 (옵션 칸 자체를 넘기지 않는다)
  const speechOpts = { trim, ...(block ? { contributors: true } : {}), ...(holidayLines ? { today } : {}), ...(since ? { since: true } : {}), ...(week ? { week: true } : {}), ...(hhmm ? { time: true } : {}) };
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole={role}
      accessibilityLabel={accountCardSpeech(briefing, speechOpts)}
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
        {!failed && briefing.template ? <Badge>{trim ? "숫자 요약" : "기본 설명"}</Badge> : null}
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
            {top || hhmm ? " ·" : null}
          </Text>
          {top ? (
            <Text style={{ color: t.sub, fontSize: font.small }} maxFontSizeMultiplier={fontCap.row}>
              {"기여 1위 "}
              <Text style={{ color: t.ink }}>{top.name}</Text>{" "}
              <Text style={[styles.num, { color: changeColor(t, shownSign(top.amount, formatWon(top.amount, { sign: true }))) }]}>{formatWon(top.amount, { sign: true })}</Text>
              {hhmm ? " ·" : null}
            </Text>
          ) : null}
          {/* 3-32 숫자의 시각 (numberBasis): 마지막 묶음 뒤 새 묶음 — 폭이 모자라면 묶음째 다음 줄로 */}
          {hhmm ? (
            <Text style={{ color: t.muted, fontSize: font.tiny }} maxFontSizeMultiplier={fontCap.row}>
              {`${hhmm} 기준`}
            </Text>
          ) : null}
        </View>
      )}
      {block && !failed ? <ContributorsBlock briefing={briefing} /> : null}
      {/* 기여 묶음 뒤, 휴장 줄 앞 (당일 손익 묶음을 가르지 않게) */}
      {since && !failed ? <SinceLineText briefing={briefing} cap={fontCap.row} /> : null}
      {week && !failed ? <WeekLineText briefing={briefing} cap={fontCap.row} /> : null}
      {holidays.map((l) => (
        <Text key={l.text} style={{ color: t.muted, fontSize: font.small }} maxFontSizeMultiplier={fontCap.row}>
          {l.text}
        </Text>
      ))}
    </Pressable>
  );
}

/**
 * 기여 상위 묶음 (브리핑 2차 3, 플래그 moversMerge — 접은 화면 큰 계좌 카드와 계좌 줄이 같이 씀).
 * 머리 '당일 손익 기여 상위 (오른 종목)' | 'HH:MM 기준', 그 아래 서버가 보낸 기여 상위(같은 방향 최대 3개) 한 줄씩: 이름 | 원화 금액.
 * 등락률·순위 번호는 넣지 않는다(목록의 '지금' 등락률·변동 큰 순 순위와 헷갈리지 않게). 금액은 줄이지 않고(adjustsFontSizeToFit 없음)
 * 폭이 모자라면 이름만 말줄임. 누르는 곳이 따로 없다 (줄·카드 전체가 링크 하나). 종목이 없으면 그리지 않는다
 */
export function ContributorsBlock({ briefing }: { briefing: AccountBriefing }) {
  const t = useTheme();
  const h = briefing.headline;
  if (!h || h.top.length === 0) return null;
  const time = briefingTime(briefing.createdAt);
  return (
    <View style={styles.contrib}>
      <View style={styles.contribHead}>
        <Text style={{ color: t.muted, fontSize: font.small, flexShrink: 1 }} maxFontSizeMultiplier={fontCap.row}>
          {contributorsHead(h.dayPnl)}
        </Text>
        {time ? (
          <Text style={[styles.contribTime, { color: t.muted }]} maxFontSizeMultiplier={fontCap.row}>
            {`${time} 기준`}
          </Text>
        ) : null}
      </View>
      {h.top.map((c) => {
        const amount = formatWon(c.amount, { sign: true });
        return (
          <View key={c.code} style={styles.contribRow}>
            <Text style={[styles.contribName, { color: t.ink }]} numberOfLines={1} maxFontSizeMultiplier={fontCap.row}>
              {c.name}
            </Text>
            <Text style={[styles.contribAmount, { color: changeColor(t, shownSign(c.amount, amount)) }]} numberOfLines={1} maxFontSizeMultiplier={fontCap.row}>
              {amount}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

/**
 * 브리핑 3차 3 (플래그 accountSinceLast): '9/25(금) 오전보다 총 평가 +544,322원 · 수량 바뀐 종목 2' 한 줄 (비교가 저장된 브리핑만, 없으면 그리지 않음).
 * 묶음(총 평가 변화 · 'N종목 빼고 비교' · 수량)을 따로 두어 좁으면 묶음째 다음 줄로 (구분점은 앞 묶음 끝에).
 * 금액만 보이는 부호의 등락 색. 누르는 곳이 따로 없다 (줄·카드 전체가 링크 하나)
 */
export function SinceLineText({ briefing, cap }: { briefing: AccountBriefing; cap?: number }) {
  const t = useTheme();
  const l = sinceLine(briefing);
  if (!l) return null;
  const rest = [l.left, l.qty].filter((x): x is string => x !== null);
  return (
    <View style={styles.rowNums}>
      <Text style={{ color: t.sub, fontSize: font.small }} maxFontSizeMultiplier={cap}>
        {l.head} <Text style={[styles.num, { color: changeColor(t, l.sign) }]}>{l.amount}</Text>
        {rest.length ? " ·" : null}
      </Text>
      {rest.map((x, i) => (
        <Text key={x} style={{ color: t.sub, fontSize: font.small }} maxFontSizeMultiplier={cap}>
          {i < rest.length - 1 ? `${x} ·` : x}
        </Text>
      ))}
    </View>
  );
}

/**
 * 브리핑 3차 5 (플래그 holdingEvents): '이번 주 일정 · 마이크로소프트 실적 10/29(목) · 메타 실적 10/29(목) 외 1건' 한 줄
 * (headline.week — 그 주 첫 오전 계좌 브리핑이고 이번 주 일정이 있을 때만, 없으면 그리지 않음). 묶음째 다음 줄로(구분점은 앞 묶음 끝에 — 그 앞은 줄바꿈 없는 공백).
 * 색 없음. 누르는 곳이 따로 없다 (줄·카드 전체가 링크 하나 — 누르면 상세의 '다가오는 일정')
 */
export function WeekLineText({ briefing, cap }: { briefing: AccountBriefing; cap?: number }) {
  const t = useTheme();
  const l = weekLine(briefing);
  if (!l) return null;
  return (
    <View style={styles.rowNums}>
      {l.parts.map((p, i) => (
        <Text key={i} style={{ color: i === 0 ? t.muted : t.sub, fontSize: font.small }} maxFontSizeMultiplier={cap}>
          {i < l.parts.length - 1 ? `${p}\u00a0·` : p}
        </Text>
      ))}
    </View>
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
  // 기여 상위 묶음 (브리핑 2차 3): 줄 사이는 좁게, 머리는 좁으면 '기준' 시각을 다음 줄 오른쪽으로
  contrib: { gap: space.xxs },
  contribHead: { flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", columnGap: space.sm },
  contribTime: { marginLeft: "auto", fontSize: font.small, flexShrink: 0 },
  contribRow: { flexDirection: "row", alignItems: "baseline", gap: space.sm },
  contribName: { flex: 1, fontSize: font.small, fontWeight: "600" },
  contribAmount: { flexShrink: 0, fontSize: font.small, fontVariant: ["tabular-nums"] },
});
