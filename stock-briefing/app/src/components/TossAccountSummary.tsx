import React, { useEffect, useState } from "react";
import { router, useLocalSearchParams } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useTossAccountSnapshot } from "@/api/hooks";
import { ApiRequestError } from "@/api/client";
import type { TossAccountSnapshotBody } from "@/api/types";
import { formatNumber, formatPrice } from "@/lib/format";
import { useSettings } from "@/lib/settings";
import { tossSnapshotNotice, tossSnapshotRange, tossSnapshotTime } from "@/lib/tossAccountSnapshot";
import { useNow } from "@/lib/useNow";
import { font, fontCap, space, touch, useTheme } from "@/theme";

/** 기능이 켜진 주인의 홈에서만 장착한다. 원본 계좌와 앱 시세 합계를 섞지 않는다. */
export function TossAccountSummary({ children }: { children: React.ReactNode }) {
  const { valuation } = useLocalSearchParams<{ valuation?: string }>();
  const q = useTossAccountSnapshot();
  const { afterCost, showKrw } = useSettings();
  const now = useNow(30_000);
  const denied = q.error instanceof ApiRequestError && (q.error.status === 401 || q.error.status === 403);
  return <TossAccountSummaryView body={denied ? undefined : q.data} failed={q.isError} afterCost={afterCost} showKrw={showKrw} now={now}
    requestedView={valuation === "live" ? "live" : undefined}>{children}</TossAccountSummaryView>;
}

export function TossAccountSummaryView({ body, failed, afterCost, showKrw, now, children, requestedView }: {
  body: TossAccountSnapshotBody | undefined;
  failed: boolean;
  afterCost: boolean;
  showKrw: boolean;
  now: number;
  children: React.ReactNode;
  requestedView?: "live";
}) {
  const t = useTheme();
  const [view, setView] = useState<"toss" | "live">(requestedView ?? "toss");
  const [lastRequest, setLastRequest] = useState(requestedView);
  // 새 링크의 기준을 그리는 순간 반영해 이전 탭의 금액이 한 번 나타나지 않게 한다.
  if (requestedView !== lastRequest) {
    setLastRequest(requestedView);
    if (requestedView) setView(requestedView);
  }
  useEffect(() => {
    if (!requestedView) return;
    // 요청을 소비해야 같은 위젯을 다시 눌러도 현재 선택과 관계없이 같은 평가 기준으로 열린다.
    router.setParams({ valuation: undefined });
  }, [requestedView]);
  const snap = body?.on ? body.snapshot : null;
  const notice = tossSnapshotNotice(body, failed, now);
  const amount = snap ? (afterCost ? snap.net : snap.gross) : null;
  const reference = amount && snap?.displayFx && Number.isFinite(snap.displayFx.usdKrw) && snap.displayFx.usdKrw > 0
    ? amount.krw + amount.usd * snap.displayFx.usdKrw : null;
  return (
    <View style={{ backgroundColor: t.surface }}>
      <View style={styles.tabs}>
        {(["toss", "live"] as const).map((key) => {
          const label = key === "toss" ? "토스 계좌" : "실시간 평가";
          return <Pressable key={key} accessibilityRole="tab" accessibilityLabel={`${label} 보기`} accessibilityState={{ selected: view === key }}
            onPress={() => setView(key)} style={[styles.tab, { borderBottomColor: view === key ? t.accent : t.line }]}>
            <Text maxFontSizeMultiplier={fontCap.chrome} style={{ color: view === key ? t.accent : t.muted, fontSize: font.body, fontWeight: "700" }}>{label}</Text>
          </Pressable>;
        })}
      </View>
      {view === "toss" ? (
        <View style={styles.body}>
          <Text accessibilityRole="header" style={{ color: t.ink, fontSize: font.body, fontWeight: "700" }}>토스 주식 평가금액</Text>
          {notice ? <Text style={{ color: failed || snap ? t.warn : t.muted, fontSize: font.small }}>{notice}</Text> : null}
          {snap && amount ? <>
            <Text style={{ color: t.muted, fontSize: font.small }}>{afterCost ? "토스 수수료·세금 차감 후" : "토스 수수료·세금 차감 전"}</Text>
            <View style={styles.amounts}>
              <Amount label="원화" value={formatPrice(amount.krw, "KRW")} />
              <Amount label="달러" value={formatPrice(amount.usd, "USD")} />
            </View>
            {showKrw && reference !== null ? <View style={{ gap: space.xxs }}>
              <Text style={{ color: t.sub, fontSize: font.body }}>원화 환산(참고) {formatPrice(reference, "KRW")}</Text>
              <Text style={{ color: t.muted, fontSize: font.tiny }}>앱 표시 환율 {formatNumber(snap.displayFx!.usdKrw, 2)}원 · {tossSnapshotTime(snap.displayFx!.receivedAt)} 확인. 토스 앱의 최종 원화 합계와 다를 수 있습니다.</Text>
            </View> : showKrw && amount.usd !== 0 ? <Text style={{ color: t.muted, fontSize: font.small }}>환율을 확인하지 못해 통화별 원본 금액만 표시합니다.</Text> : null}
            <Text style={{ color: t.sub, fontSize: font.small }}>전체 연동 {snap.accountCount}개 계좌 · 보유 {snap.holdingCount}종목 · 현금·예수금 제외</Text>
            {snap.excludedHoldingCount > 0 ? <Text style={{ color: t.sub, fontSize: font.small }}>앱 동기화에서 제외한 {snap.excludedHoldingCount}종목도 포함합니다.</Text> : null}
            <Text style={{ color: t.muted, fontSize: font.tiny }}>토스 계좌 수신: {tossSnapshotRange(snap.receivedFrom, snap.receivedAt)} (한국 시각). 시세 기준 시각과는 다릅니다.</Text>
            <Text style={{ color: t.muted, fontSize: font.tiny }}>아래 종목·비중·위젯·보고서는 앱 시세 기준입니다. 토스 계좌 평가와 범위·금액이 다를 수 있습니다.</Text>
          </> : null}
        </View>
      ) : <View style={styles.liveNote}><Text style={{ color: t.muted, fontSize: font.small }}>앱에 등록한 보유 종목을 현재 시세로 평가합니다.</Text></View>}
      {view === "live" || !snap ? children : null}
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
  tabs: { flexDirection: "row", flexWrap: "wrap", paddingHorizontal: space.lg, gap: space.lg },
  tab: { minHeight: touch.min, justifyContent: "center", paddingVertical: space.sm, borderBottomWidth: StyleSheet.hairlineWidth },
  body: { paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.s },
  amounts: { flexDirection: "row", flexWrap: "wrap", gap: space.xl },
  amount: { gap: space.xxs, flexShrink: 1 },
  liveNote: { paddingHorizontal: space.lg, paddingTop: space.sm },
});
