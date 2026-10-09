import React, { useEffect, useState } from "react";
import { router, useLocalSearchParams, useNavigationContainerRef } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useTossAccountSnapshot } from "@/api/hooks";
import { ApiRequestError } from "@/api/client";
import type { TossAccountSnapshotBody } from "@/api/types";
import { formatNumber, formatPct, formatPrice } from "@/lib/format";
import { sentence, speakProfit, speakRate } from "@/lib/a11y";
import { useSettings } from "@/lib/settings";
import { tossSnapshotNotice, tossSnapshotRange, tossSnapshotTime, tossSnapshotValuation } from "@/lib/tossAccountSnapshot";
import { useNow } from "@/lib/useNow";
import { changeColor, font, fontCap, space, touch, useTheme } from "@/theme";

/** 계좌 대표 금액은 토스 수신 평가만 사용한다. 시세 추정은 별도로 펼쳐 본다. */
/** onThemes: 내 종목 테마 화면 열기 (3-35, 플래그 holdingThemes) — 없으면 지금 나무 그대로 */
/** onJournal: 매매일지 열기 (3-37, 플래그 tradeJournal · tradeRecords) — 없으면 지금 나무 그대로 */
export function TossAccountSummary({ children, onAllocation, onThemes, onJournal, focused = false }: { children: React.ReactNode; onAllocation?: () => void; onThemes?: () => void; onJournal?: () => void; focused?: boolean }) {
  const { valuation } = useLocalSearchParams<{ valuation?: string }>();
  const q = useTossAccountSnapshot();
  const { afterCost, showKrw } = useSettings();
  const now = useNow(30_000);
  const denied = q.error instanceof ApiRequestError && (q.error.status === 401 || q.error.status === 403);
  return <TossAccountSummaryView body={denied ? undefined : q.data} failed={q.isError} afterCost={afterCost} showKrw={showKrw} now={now}
    onAllocation={denied ? undefined : onAllocation} {...(onThemes && !denied ? { onThemes } : null)} {...(onJournal && !denied ? { onJournal } : null)} focused={focused}
    requestedView={valuation === "live" || valuation === "account" ? valuation : undefined}>{denied ? null : children}</TossAccountSummaryView>;
}

export function TossAccountSummaryView({ body, failed, afterCost, showKrw, now, children, requestedView, onAllocation, onThemes, onJournal, focused = false }: {
  body: TossAccountSnapshotBody | undefined;
  failed: boolean;
  afterCost: boolean;
  showKrw: boolean;
  now: number;
  children: React.ReactNode;
  requestedView?: "live" | "account";
  onAllocation?: () => void;
  /** 3-35 (플래그 holdingThemes): '종목 비중 보기' 옆 '내 종목 테마 보기'. 없으면 지금 그대로 */
  onThemes?: () => void;
  /** 3-37 (플래그 tradeJournal · tradeRecords): '내 종목 테마 보기' 뒤 '매매일지 보기' (요약이 계좌 패널·띠의 [매매일지]를 접어 두므로). 없으면 지금 그대로 */
  onJournal?: () => void;
  focused?: boolean;
}) {
  const t = useTheme();
  const navigation = useNavigationContainerRef();
  const [estimateOpen, setEstimateOpen] = useState(false);
  const [basisOpen, setBasisOpen] = useState(false);
  const [lastRequest, setLastRequest] = useState(requestedView);
  // 새 계좌 링크와 예전 위젯의 live 링크도 계좌 대표 금액으로 돌아온다.
  if (requestedView !== lastRequest) {
    setLastRequest(requestedView);
    if (requestedView) { setEstimateOpen(false); setBasisOpen(false); }
  }
  useEffect(() => {
    if (!requestedView) return;
    let active = true;
    let consumed = false;
    const consume = () => {
      if (!active || consumed || !navigation.isReady()) return;
      consumed = true;
      // 같은 위젯을 다시 눌러도 평가 기준을 적용한다. 앱 재시작 직후에는 루트 준비 뒤에만 요청을 지운다.
      router.setParams({ valuation: undefined });
    };
    const unsubscribe = navigation.addListener("ready", consume);
    consume();
    return () => { active = false; unsubscribe(); };
  }, [requestedView, navigation]);
  const snap = body?.on ? body.snapshot : null;
  const notice = tossSnapshotNotice(body, failed, now);
  const amount = snap ? (afterCost ? snap.net : snap.gross) : null;
  const valuation = snap ? tossSnapshotValuation(snap, afterCost) : null;
  // 서버에서 기능을 끄거나 이전 서버에 연결하면 기존 화면을 유지한다.
  if (body?.on === false && !failed) return <>{children}</>;
  if (focused) return <View style={{ backgroundColor: t.surface }}>
    <View style={styles.body}>
      <Text accessibilityRole="header" style={{ color: t.ink, fontSize: font.body, fontWeight: "700" }}>토스 주식 평가금액</Text>
      {notice ? <Text style={{ color: failed || snap ? t.warn : t.muted, fontSize: font.small }}>{notice}</Text> : null}
      {snap && amount && valuation ? <>
        <Text style={{ color: t.sub, fontSize: font.small }}>{afterCost ? "수수료·세금 차감 후" : "수수료·세금 차감 전"} · 현금·예수금 제외</Text>
        {showKrw && valuation.evaluationKrw !== null ? <>
          <Text style={{ color: t.sub, fontSize: font.small }}>원화 환산(참고)</Text>
          <Text maxFontSizeMultiplier={fontCap.row} style={{ color: t.ink, fontSize: font.hero, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{formatPrice(valuation.evaluationKrw, "KRW")}</Text>
        </> : <>
          <View style={styles.amounts}><Amount label="원화" value={formatPrice(amount.krw, "KRW")} /><Amount label="달러" value={formatPrice(amount.usd, "USD")} /></View>
          {showKrw ? <Text style={{ color: t.warn, fontSize: font.small }}>환율·평가금액 확인 불가 · 통화별 원본만 표시</Text> : <Text style={{ color: t.sub, fontSize: font.small }}>원화 환산 꺼짐 · 통화별 원본 평가금액</Text>}
        </>}
        {showKrw ? <>
          <View style={{ gap: space.xxs }} accessible accessibilityLabel={sentence(["계좌 기준 평가손익 참고", valuation.profitKrw === null ? "확인 불가" : speakProfit(formatPrice(valuation.profitKrw, "KRW"), valuation.profitKrw), valuation.profitRate === null ? null : `수익률 ${speakRate(valuation.profitRate)}`])}>
            <Text style={{ color: t.sub, fontSize: font.small }}>계좌 기준 평가손익(참고)</Text>
            <View style={styles.profitLine}>
              <Text maxFontSizeMultiplier={fontCap.row} style={{ color: valuation.profitKrw === null ? t.muted : changeColor(t, valuation.profitKrw), fontSize: font.title, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{valuation.profitKrw === null ? "확인 불가" : formatPrice(valuation.profitKrw, "KRW", { sign: true })}</Text>
              {valuation.profitKrw !== null ? <Text style={{ color: t.sub, fontSize: font.small }}>수익률 {valuation.profitRate === null ? "계산 불가 (매입금액 0원)" : formatPct(valuation.profitRate)}</Text> : null}
            </View>
          </View>
          {valuation.unavailable ? <Text style={{ color: t.warn, fontSize: font.small }}>{valuation.unavailable}</Text> : <Text style={{ color: valuation.estimatedHoldingCount ? t.warn : t.muted, fontSize: font.small }}>{valuation.estimatedHoldingCount ? `추정 원가 ${valuation.estimatedHoldingCount}종목 포함 · ` : ""}토스 원화 손익과 차이 가능</Text>}
        </> : null}
        <Text style={{ color: t.muted, fontSize: font.tiny }}>계좌 수신 {tossSnapshotTime(snap.receivedAt)} (한국 시각)</Text>
        {snap.excludedHoldingCount > 0 ? <Text style={{ color: t.warn, fontSize: font.small }}>계좌 합계에는 앱 동기화 제외 {snap.excludedHoldingCount}종목도 포함</Text> : null}
      </> : null}
      <View style={styles.profitLine}>
        {snap ? <Pressable accessibilityRole="button" accessibilityLabel={basisOpen ? "금액·계산 기준 접기" : "금액·계산 기준 펼치기"} accessibilityState={{ expanded: basisOpen }} onPress={() => { setBasisOpen(!basisOpen); setEstimateOpen(false); }} style={styles.action}>
          <Text style={{ color: t.accent, fontSize: font.small }}>{basisOpen ? "금액·계산 기준 접기" : "금액·계산 기준 보기"}</Text>
        </Pressable> : null}
        {onAllocation ? <Pressable accessibilityRole="button" accessibilityLabel="종목 시세 기준 비중 보기" onPress={onAllocation} style={styles.action}><Text style={{ color: t.accent, fontSize: font.small }}>종목 비중 보기</Text></Pressable> : null}
        {onThemes ? <Pressable accessibilityRole="button" accessibilityLabel="내 종목 테마 보기" onPress={onThemes} style={styles.action}><Text style={{ color: t.accent, fontSize: font.small }}>내 종목 테마 보기</Text></Pressable> : null}
        {onJournal ? <Pressable accessibilityRole="button" accessibilityLabel="매매일지 보기" onPress={onJournal} style={styles.action}><Text style={{ color: t.accent, fontSize: font.small }}>매매일지 보기</Text></Pressable> : null}
      </View>
      {basisOpen && snap && amount && valuation ? <View style={[styles.details, { borderColor: t.line }]}>
        <Text style={{ color: t.sub, fontSize: font.small }}>토스 수신 원본 · {afterCost ? "수수료·세금 차감 후" : "수수료·세금 차감 전"}</Text>
        {showKrw && valuation.evaluationKrw !== null ? <View style={styles.amounts}><Amount label="원화" value={formatPrice(amount.krw, "KRW")} /><Amount label="달러" value={formatPrice(amount.usd, "USD")} /></View> : null}
        {valuation.costKrw !== null ? <Text style={{ color: t.sub, fontSize: font.small }}>매입금액 {formatPrice(valuation.costKrw, "KRW")}</Text> : null}
        <Text style={{ color: t.muted, fontSize: font.small }}>평가손익은 같은 계좌 동기화의 평가금액 − 원화 매입금액입니다. 환율·원가·비용·반올림 기준에 따라 토스 화면의 원화 손익과 다를 수 있습니다.</Text>
        {amount.usd !== 0 && snap.displayFx ? <Text style={{ color: t.muted, fontSize: font.small }}>앱 표시 환율 {formatNumber(snap.displayFx.usdKrw, 2)}원 · {tossSnapshotTime(snap.displayFx.receivedAt)} 확인. 토스 앱의 최종 원화 합계와 다를 수 있습니다.</Text> : null}
        <Text style={{ color: t.sub, fontSize: font.small }}>전체 연동 {snap.accountCount}개 계좌 · 보유 {snap.holdingCount}종목 · 현금·예수금 제외</Text>
        <Text style={{ color: t.muted, fontSize: font.small }}>계좌 대표 금액은 토스에서 받은 평가 기준입니다. 시세 갱신으로 이 계좌 금액을 다시 계산하지 않습니다.</Text>
        <Text style={{ color: t.muted, fontSize: font.small }}>토스 계좌 수신 구간: {tossSnapshotRange(snap.receivedFrom, snap.receivedAt)} (한국 시각). 시세 기준 시각과는 다릅니다.</Text>
        <Text style={{ color: t.muted, fontSize: font.small }}>아래 종목·비중은 종목 시세 기준 추정값입니다. 보고서는 작성 당시 시세 기준이며 계좌 금액과 다를 수 있습니다.</Text>
      </View> : null}
      {(basisOpen || !snap) && children ? <>
        <Pressable accessibilityRole="button" accessibilityLabel={estimateOpen ? "시간외 시세 기준 추정 접기" : "시간외 시세 기준 추정 보기"} accessibilityState={{ expanded: estimateOpen }} onPress={() => setEstimateOpen(!estimateOpen)} style={styles.action}>
          <Text style={{ color: t.accent, fontSize: font.small }}>{estimateOpen ? "시간외 시세 기준 추정 접기" : "시간외 시세 기준 추정 보기"}</Text>
        </Pressable>
        {estimateOpen ? <Text style={{ color: t.warn, fontSize: font.small }}>아래는 시간외 시세를 포함해 다시 계산한 추정 평가입니다. 토스 계좌의 평가손익과 다를 수 있습니다.</Text> : null}
      </> : null}
    </View>
    {estimateOpen && (basisOpen || !snap) ? children : null}
    <View style={[styles.listNote, { borderTopColor: t.line }]}><Text style={{ color: t.muted, fontSize: font.small }}>종목별 금액·손익·비중은 시세 기준 추정값입니다.</Text></View>
  </View>;
  return (
    <View style={{ backgroundColor: t.surface }}>
        <View style={styles.body}>
          <Text accessibilityRole="header" style={{ color: t.ink, fontSize: font.body, fontWeight: "700" }}>토스 주식 평가금액</Text>
          {notice ? <Text style={{ color: failed || snap ? t.warn : t.muted, fontSize: font.small }}>{notice}</Text> : null}
          {snap && amount ? <>
            <Text style={{ color: t.muted, fontSize: font.small }}>{afterCost ? "토스 수수료·세금 차감 후" : "토스 수수료·세금 차감 전"}</Text>
            {showKrw && valuation ? <View style={{ gap: space.s }}>
              {valuation.evaluationKrw !== null ? <Text maxFontSizeMultiplier={fontCap.row} style={{ color: t.ink, fontSize: font.title, fontWeight: "700", fontVariant: ["tabular-nums"] }}>원화 환산(참고) {formatPrice(valuation.evaluationKrw, "KRW")}</Text> : null}
              <View style={{ gap: space.xxs }} accessible accessibilityLabel={sentence([
                "계좌 기준 평가손익 참고", valuation.profitKrw === null ? "확인 불가" : speakProfit(formatPrice(valuation.profitKrw, "KRW"), valuation.profitKrw),
                valuation.profitRate === null ? null : `수익률 ${speakRate(valuation.profitRate)}`,
              ])}>
                <Text style={{ color: t.sub, fontSize: font.small }}>계좌 기준 평가손익(참고)</Text>
                <Text maxFontSizeMultiplier={fontCap.row} style={{ color: valuation.profitKrw === null ? t.muted : changeColor(t, valuation.profitKrw), fontSize: font.title, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{valuation.profitKrw === null ? "확인 불가" : formatPrice(valuation.profitKrw, "KRW", { sign: true })}</Text>
                {valuation.profitKrw !== null ? <Text style={{ color: t.sub, fontSize: font.small }}>수익률 {valuation.profitRate === null ? "계산 불가 (매입금액 0원)" : formatPct(valuation.profitRate)}</Text> : null}
              </View>
              {valuation.costKrw !== null ? <Text style={{ color: t.sub, fontSize: font.small }}>매입금액 {formatPrice(valuation.costKrw, "KRW")}</Text> : null}
              {valuation.unavailable ? <Text style={{ color: t.warn, fontSize: font.small }}>{valuation.unavailable}</Text> : <Text style={{ color: t.muted, fontSize: font.tiny }}>같은 계좌 동기화의 평가금액 − 원화 매입금액입니다.{valuation.estimatedHoldingCount ? ` ${valuation.estimatedHoldingCount}종목의 추정 원가를 포함합니다.` : ""} 환율·원가·비용·반올림 기준에 따라 토스 화면의 원화 손익과 다를 수 있습니다.</Text>}
            </View> : !showKrw ? <Text style={{ color: t.muted, fontSize: font.small }}>계좌 기준 원화 손익은 설정에서 원화 환산을 켜면 확인할 수 있습니다.</Text> : null}
            <View style={styles.amounts}>
              <Amount label="원화" value={formatPrice(amount.krw, "KRW")} />
              <Amount label="달러" value={formatPrice(amount.usd, "USD")} />
            </View>
            {showKrw && amount.usd !== 0 ? valuation?.evaluationKrw !== null && snap.displayFx ?
              <Text style={{ color: t.muted, fontSize: font.tiny }}>앱 표시 환율 {formatNumber(snap.displayFx.usdKrw, 2)}원 · {tossSnapshotTime(snap.displayFx.receivedAt)} 확인. 토스 앱의 최종 원화 합계와 다를 수 있습니다.</Text>
              : <Text style={{ color: t.muted, fontSize: font.small }}>환율을 확인하지 못해 통화별 원본 금액만 표시합니다.</Text> : null}
            <Text style={{ color: t.muted, fontSize: font.small }}>계좌 대표 금액은 토스에서 받은 평가 기준입니다. 시세 갱신으로 이 계좌 금액을 다시 계산하지 않습니다.</Text>
            <Text style={{ color: t.sub, fontSize: font.small }}>전체 연동 {snap.accountCount}개 계좌 · 보유 {snap.holdingCount}종목 · 현금·예수금 제외</Text>
            {snap.excludedHoldingCount > 0 ? <Text style={{ color: t.sub, fontSize: font.small }}>앱 동기화에서 제외한 {snap.excludedHoldingCount}종목도 포함합니다.</Text> : null}
            <Text style={{ color: t.muted, fontSize: font.tiny }}>토스 계좌 수신: {tossSnapshotRange(snap.receivedFrom, snap.receivedAt)} (한국 시각). 시세 기준 시각과는 다릅니다.</Text>
            <Text style={{ color: t.muted, fontSize: font.tiny }}>아래 종목·비중은 종목 시세 기준 추정값입니다. 보고서는 작성 당시 시세 기준이며 계좌 금액과 다를 수 있습니다.</Text>
          </> : null}
          {onAllocation ? <Pressable accessibilityRole="button" accessibilityLabel="종목 시세 기준 비중 보기" onPress={onAllocation} style={styles.action}>
            <Text style={{ color: t.accent, fontSize: font.small }}>종목 비중 보기 · 시세 기준</Text>
          </Pressable> : null}
          {onThemes ? <Pressable accessibilityRole="button" accessibilityLabel="내 종목 테마 보기" onPress={onThemes} style={styles.action}>
            <Text style={{ color: t.accent, fontSize: font.small }}>내 종목 테마 보기</Text>
          </Pressable> : null}
          {onJournal ? <Pressable accessibilityRole="button" accessibilityLabel="매매일지 보기" onPress={onJournal} style={styles.action}>
            <Text style={{ color: t.accent, fontSize: font.small }}>매매일지 보기</Text>
          </Pressable> : null}
        </View>
      {children ? <View style={{ borderTopColor: t.line, borderTopWidth: StyleSheet.hairlineWidth }}>
        <Pressable accessibilityRole="button" accessibilityLabel={estimateOpen ? "시간외 시세 기준 추정 접기" : "시간외 시세 기준 추정 보기"}
          accessibilityState={{ expanded: estimateOpen }} onPress={() => setEstimateOpen(!estimateOpen)} style={styles.estimateButton}>
          <Text maxFontSizeMultiplier={fontCap.chrome} style={{ color: t.sub, fontSize: font.small }}>{estimateOpen ? "시간외 시세 기준 추정 접기" : "시간외 시세 기준 추정 보기"}</Text>
        </Pressable>
        {estimateOpen ? <>
          <View style={styles.liveNote}><Text style={{ color: t.warn, fontSize: font.small }}>아래는 시간외 시세를 포함해 다시 계산한 추정 평가입니다. 토스 계좌의 평가손익과 다를 수 있습니다.</Text></View>
          {children}
        </> : null}
      </View> : null}
    </View>
  );
}

function Amount({ label, value }: { label: string; value: string }) {
  const t = useTheme();
  return <View style={styles.amount} accessible accessibilityLabel={`${label} 평가금액 ${value}`}>
    <Text style={{ color: t.muted, fontSize: font.small }}>{label}</Text>
    <Text maxFontSizeMultiplier={fontCap.row} style={{ color: t.ink, fontSize: font.title, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{value}</Text>
  </View>;
}

const styles = StyleSheet.create({
  profitLine: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: space.xl, rowGap: space.xxs },
  details: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: space.sm, gap: space.sm },
  listNote: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: space.lg, paddingVertical: space.sm },
  action: { minHeight: touch.min, justifyContent: "center", paddingVertical: space.sm, alignSelf: "flex-start" },
  estimateButton: { minHeight: touch.min, justifyContent: "center", paddingHorizontal: space.lg, paddingVertical: space.sm },
  body: { paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.s },
  amounts: { flexDirection: "row", flexWrap: "wrap", gap: space.xl },
  amount: { gap: space.xxs, flexShrink: 1 },
  liveNote: { paddingHorizontal: space.lg, paddingTop: space.sm },
});
