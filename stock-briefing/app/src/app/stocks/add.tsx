import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import React, { useEffect, useState } from "react";
import { Alert, FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useSearch, useStockMutations } from "@/api/hooks";
import type { ListedStock } from "@/api/types";
import { Screen } from "@/components/Screen";
import { Badge, Button, Card, Loading, Muted } from "@/components/ui";
import { isUsMarket } from "@/lib/format";
import { font, radius, space, useTheme } from "@/theme";

/** 종목 등록: 검색 → 선택 → 수량/평단(선택) → 등록 */
export default function AddStockScreen() {
  const t = useTheme();
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [selected, setSelected] = useState<ListedStock | null>(null);
  const [quantity, setQuantity] = useState("");
  const [avgPrice, setAvgPrice] = useState("");
  const search = useSearch(debounced);
  const { register } = useStockMutations();

  useEffect(() => {
    const id = setTimeout(() => setDebounced(q), 300);
    return () => clearTimeout(id);
  }, [q]);

  const submit = () => {
    if (!selected) return;
    const qty = quantity.trim() ? Number(quantity.replace(/,/g, "")) : null;
    const avg = avgPrice.trim() ? Number(avgPrice.replace(/,/g, "")) : null;
    if ((qty !== null && !(qty > 0)) || (avg !== null && !(avg > 0))) {
      Alert.alert("입력 확인", "수량과 평균 단가는 0보다 큰 숫자여야 합니다.");
      return;
    }
    register.mutate(
      { code: selected.code, quantity: qty, avgPrice: avg },
      {
        onSuccess: () => router.back(),
        onError: (e) => Alert.alert("등록 실패", e instanceof Error ? e.message : String(e)),
      },
    );
  };

  return (
    <Screen scroll={false} contentStyle={{ padding: space.lg, gap: space.md }}>
      <View style={[styles.search, { borderColor: t.line, backgroundColor: t.surface }]}>
        <Ionicons name="search" size={18} color={t.muted} />
        <TextInput
          value={q}
          onChangeText={(v) => {
            setQ(v);
            setSelected(null);
          }}
          placeholder="종목명·코드·미국 티커 (예: SK하이닉스, 000660, AAPL)"
          placeholderTextColor={t.muted}
          autoFocus
          autoCorrect={false}
          style={[styles.input, { color: t.ink }]}
          returnKeyType="search"
        />
        {q ? (
          <Pressable onPress={() => setQ("")} accessibilityLabel="지우기">
            <Ionicons name="close-circle" size={18} color={t.muted} />
          </Pressable>
        ) : null}
      </View>

      {selected ? (
        <Card>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <View>
              <Text style={{ color: t.ink, fontSize: font.h2, fontWeight: "700" }}>{selected.name}</Text>
              <Muted>
                {selected.code} · {selected.market}
              </Muted>
            </View>
            <Pressable onPress={() => setSelected(null)} accessibilityLabel="선택 취소">
              <Ionicons name="close" size={22} color={t.muted} />
            </Pressable>
          </View>
          <Muted>보유 정보는 선택 사항입니다. 비우면 관심 종목으로 등록됩니다.</Muted>
          <View style={{ flexDirection: "row", gap: space.sm }}>
            <TextInput
              value={quantity}
              onChangeText={setQuantity}
              placeholder="보유 수량 (주)"
              placeholderTextColor={t.muted}
              keyboardType="numeric"
              style={[styles.field, { color: t.ink, borderColor: t.line, backgroundColor: t.surfaceAlt }]}
            />
            <TextInput
              value={avgPrice}
              onChangeText={setAvgPrice}
              placeholder={isUsMarket(selected.market) ? "평균 단가 ($)" : "평균 단가 (원)"}
              placeholderTextColor={t.muted}
              keyboardType="numeric"
              style={[styles.field, { color: t.ink, borderColor: t.line, backgroundColor: t.surfaceAlt }]}
            />
          </View>
          <Button title="등록" onPress={submit} loading={register.isPending} />
        </Card>
      ) : debounced.trim().length === 0 ? (
        <Muted>한국·미국 종목을 한글 이름(테슬라, 애플), 티커(TSLA, AAPL), 6자리 코드로 검색합니다. 토스증권 검색을 쓰므로 토스에서 보이는 이름 그대로 치면 됩니다.</Muted>
      ) : search.isLoading ? (
        <Loading />
      ) : search.isError ? (
        <Text style={{ color: t.danger }}>{search.error instanceof Error ? search.error.message : "검색 실패"}</Text>
      ) : (
        <FlatList
          data={search.data?.results ?? []}
          keyExtractor={(s) => s.code}
          keyboardShouldPersistTaps="handled"
          ItemSeparatorComponent={() => <View style={{ height: space.xs }} />}
          ListEmptyComponent={<Muted>검색 결과가 없습니다.</Muted>}
          renderItem={({ item }) => (
            <Pressable onPress={() => setSelected(item)} accessibilityRole="button" style={({ pressed }) => [styles.result, { backgroundColor: pressed ? t.surfaceAlt : t.surface, borderColor: t.line }]}>
              <View style={{ flex: 1 }}>
                <Text style={{ color: t.ink, fontSize: font.body, fontWeight: "600" }}>{item.name}</Text>
                <Muted>
                  {item.code} · {item.market}
                </Muted>
              </View>
              {isUsMarket(item.market) ? <Badge tone="warn">미국 · $</Badge> : null}
              {item.groupCode === "EF" ? <Badge>ETF</Badge> : null}
            </Pressable>
          )}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  search: { flexDirection: "row", alignItems: "center", gap: space.sm, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, paddingHorizontal: space.md },
  input: { flex: 1, paddingVertical: 12, fontSize: font.body },
  field: { flex: 1, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.sm, padding: space.md, fontSize: font.body },
  result: { flexDirection: "row", alignItems: "center", gap: space.md, padding: space.md, borderRadius: radius.sm, borderWidth: StyleSheet.hairlineWidth },
});
