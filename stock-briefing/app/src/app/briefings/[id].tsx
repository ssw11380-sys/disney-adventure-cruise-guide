import { router, Stack, useLocalSearchParams } from "expo-router";
import React, { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useBriefing, useBriefings } from "@/api/hooks";
import { StaleBanner } from "@/components/Freshness";
import { CardsSkeleton } from "@/components/Skeleton";
import { BriefingSources } from "@/components/BriefingSources";
import { MarkdownView } from "@/components/MarkdownView";
import { Screen } from "@/components/Screen";
import { Badge, Card, ChangeText, ErrorView, Muted, Row, SectionTitle, Segmented } from "@/components/ui";
import { afterMarketLabel, formatDateKo, formatPct, formatPrice, SESSION_LABEL } from "@/lib/format";
import { parseBriefingId, viewState } from "@/lib/freshness";
import { font, space, useTheme } from "@/theme";

/** 브리핑 상세: 요약/상세 토글, 당시 시세 스냅샷, 같은 종목 지난 브리핑 날짜 목록 */
export default function BriefingDetailScreen() {
  const t = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  // 잘못된 딥링크(briefings/abc, briefings/0)는 요청하지 않고 안내만 한다
  const numId = parseBriefingId(id);
  const b = useBriefing(numId ?? 0);
  const [mode, setMode] = useState<"summary" | "detail">("detail");
  const history = useBriefings({ code: b.data?.code, limit: 30 }, !!b.data?.code);

  if (numId === null) return <Screen><ErrorView error={new Error("브리핑 주소가 올바르지 않습니다")} retryLabel="브리핑 목록으로" onRetry={() => router.dismissTo("/briefings")} /></Screen>;
  const view = viewState(b);
  if (view === "loading") return <Screen><CardsSkeleton count={2} /></Screen>;
  if (view === "error") return <Screen><ErrorView error={b.error} onRetry={() => void b.refetch()} /></Screen>;
  const d = b.data!;
  const q = d.data?.quote ?? null;
  const failed = d.status === "failed";

  return (
    <Screen disclaimer top={<StaleBanner query={b} />}>
      <Stack.Screen options={{ title: `${d.name ?? d.code} · ${SESSION_LABEL[d.session]}` }} />
      <View style={{ gap: 2, paddingHorizontal: space.lg, paddingTop: space.md }}>
        <Pressable onPress={() => router.push(`/stocks/${d.code}`)} accessibilityRole="link">
          <Text style={{ color: t.ink, fontSize: font.title, fontWeight: "700" }}>{d.name ?? d.code}</Text>
        </Pressable>
        <Muted>
          {formatDateKo(d.date)} {SESSION_LABEL[d.session]} 브리핑 · {formatDateKo(d.createdAt, true)} 생성
        </Muted>
        <View style={{ flexDirection: "row", gap: space.sm, marginTop: space.xs }}>
          {failed ? <Badge tone="bad">생성 실패</Badge> : null}
          {d.missing.length ? <Badge tone="warn">미확인 {d.missing.length}건</Badge> : null}
        </View>
      </View>

      {q ? (
        <Card>
          <Row label="브리핑 시점 가격" value={formatPrice(q.price, q.currency)} />
          <Row label="전일 대비" value={<ChangeText value={q.change} text={`${formatPrice(q.change, q.currency, { sign: true })} (${formatPct(q.changeRate)})`} style={{ fontSize: font.small }} />} />
          {q.afterMarket ? <Row label={`${afterMarketLabel(q.afterMarket)} 가격`} value={<ChangeText value={q.afterMarket.change} text={`${formatPrice(q.afterMarket.price, q.currency)} (${formatPct(q.afterMarket.changeRate)})`} style={{ fontSize: font.small }} />} /> : null}
          {d.data?.holding ? <Row label="보유 손익" value={<ChangeText value={d.data.holding.profit} text={`${formatPrice(d.data.holding.profit, q.currency, { sign: true })} (${formatPct(d.data.holding.profitRate)})`} style={{ fontSize: font.small }} />} /> : null}
        </Card>
      ) : null}

      {failed ? (
        <Card>
          <Text style={{ color: t.danger }}>{d.error ?? d.summary}</Text>
        </Card>
      ) : (
        <>
          <Segmented
            options={[
              { value: "summary", label: "요약" },
              { value: "detail", label: "상세" },
            ]}
            value={mode}
            onChange={setMode}
          />
          <Card>
            {mode === "summary" ? (
              d.summary.split("\n").map((line, i) => (
                <Text key={i} style={{ color: t.ink, fontSize: font.body, lineHeight: 23 }}>
                  {line}
                </Text>
              ))
            ) : (
              <MarkdownView>{d.detail}</MarkdownView>
            )}
            {d.missing.length ? <Muted>데이터 미확인: {d.missing.join(", ")}</Muted> : null}
          </Card>
        </>
      )}

      <BriefingSources data={d.data} />

      {history.data && history.data.length > 1 ? (
        <View>
          <SectionTitle style={{ paddingHorizontal: space.lg, paddingTop: space.sm }}>지난 브리핑</SectionTitle>
          <View>
            {history.data
              .filter((h) => h.id !== d.id)
              .map((h) => (
                <Pressable key={h.id} onPress={() => router.replace(`/briefings/${h.id}`)} accessibilityRole="link" style={({ pressed }) => [styles.historyRow, { backgroundColor: pressed ? t.surfaceAlt : t.surface, borderColor: t.line }]}>
                  <Text style={{ color: t.ink, fontSize: font.small }}>
                    {formatDateKo(h.date)} {SESSION_LABEL[h.session]}
                  </Text>
                  <Muted numberOfLines={1} style={{ flex: 1, marginLeft: space.md }}>
                    {h.status === "failed" ? "생성 실패" : h.summary.split("\n")[0]}
                  </Muted>
                </Pressable>
              ))}
          </View>
        </View>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  historyRow: { flexDirection: "row", alignItems: "center", paddingHorizontal: space.lg, paddingVertical: space.md, borderBottomWidth: StyleSheet.hairlineWidth },
});

// 이 화면에서 난 렌더 오류는 앱을 끄지 않고 "다시 시도" 화면으로 (expo-router)
export { RouteErrorBoundary as ErrorBoundary } from "@/components/RouteError";
