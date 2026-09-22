import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import React, { useMemo } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { useStocks } from "@/api/hooks";
import { Screen } from "@/components/Screen";
import { StockRow } from "@/components/StockRow";
import { Button, Card, ChangeText, Empty, ErrorView, Loading, Muted } from "@/components/ui";
import { formatPct, formatWon } from "@/lib/format";
import { font, space, useTheme } from "@/theme";

/** 홈: 등록 종목 목록 + 보유 합계 */
export default function StocksScreen() {
  const t = useTheme();
  const { data, isLoading, isError, error, refetch, isRefetching } = useStocks();

  const total = useMemo(() => {
    const held = (data ?? []).filter((s) => s.evaluation);
    if (held.length === 0) return null;
    const marketValue = held.reduce((a, s) => a + s.evaluation!.marketValue, 0);
    const costBasis = held.reduce((a, s) => a + s.evaluation!.costBasis, 0);
    const profit = marketValue - costBasis;
    return { marketValue, costBasis, profit, profitRate: costBasis > 0 ? (profit / costBasis) * 100 : 0, count: held.length };
  }, [data]);

  const addButton = (
    <Pressable onPress={() => router.push("/stocks/add")} accessibilityRole="button" accessibilityLabel="종목 등록" style={[styles.fab, { backgroundColor: t.accent }]}>
      <Ionicons name="add" size={28} color={t.accentInk} />
    </Pressable>
  );

  if (isLoading) return <Screen><Loading label="종목 불러오는 중" /></Screen>;
  if (isError) return <Screen><ErrorView error={error} onRetry={() => void refetch()} /></Screen>;

  return (
    <Screen scroll={false}>
      <FlatList
        data={data ?? []}
        keyExtractor={(s) => s.code}
        contentContainerStyle={styles.list}
        refreshing={isRefetching}
        onRefresh={() => void refetch()}
        ListHeaderComponent={
          total ? (
            <Card style={{ marginBottom: space.sm }}>
              <Muted>보유 {total.count}종목 평가금액</Muted>
              <Text style={{ color: t.ink, fontSize: font.title, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{formatWon(total.marketValue)}</Text>
              <ChangeText value={total.profit} text={`${formatWon(total.profit, { sign: true })} (${formatPct(total.profitRate)}) · 매입 ${formatWon(total.costBasis)}`} style={{ fontSize: font.small }} />
            </Card>
          ) : null
        }
        renderItem={({ item }) => <StockRow stock={item} onPress={() => router.push(`/stocks/${item.code}`)} />}
        ItemSeparatorComponent={() => <View style={{ height: space.sm }} />}
        ListEmptyComponent={
          <Empty
            title="등록된 종목이 없습니다"
            hint="종목명이나 코드로 검색해서 보유/관심 종목을 등록하면 매일 오전·오후 브리핑을 받습니다."
            action={<Button title="종목 등록" icon="add" onPress={() => router.push("/stocks/add")} />}
          />
        }
      />
      {(data?.length ?? 0) > 0 ? addButton : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { padding: space.lg, paddingBottom: 96 },
  fab: {
    position: "absolute",
    right: space.lg,
    bottom: 56,
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
    elevation: 4,
    shadowColor: "#000",
    shadowOpacity: 0.2,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
  },
});
