import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import React, { useEffect, useState } from "react";
import { Alert, FlatList, Platform, Pressable, StyleSheet, Text, TextInput, ToastAndroid, View } from "react-native";
import { useRegisteredCodes, useSearch, useStockMutations } from "@/api/hooks";
import type { ListedStock } from "@/api/types";
import { Screen } from "@/components/Screen";
import { Badge, Button, Card, ChangeText, Muted } from "@/components/ui";
import { formatPct, formatPrice, isUsMarket } from "@/lib/format";
import { useRecentSearches, type RecentStock } from "@/lib/recentSearch";
import { font, radius, space, useTheme } from "@/theme";

/**
 * 종목 검색: 결과를 누르면 바로 상세·차트로, 오른쪽 "등록"으로 수량/평단(선택)을 넣어 등록 (3-18).
 * 종목 마스터 결과를 먼저 보여 주고 토스 검색 결과가 오면 합친다. 최근 연 종목 10개는 빈 검색창에 보인다
 */
export default function AddStockScreen() {
  const t = useTheme();
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [selected, setSelected] = useState<ListedStock | null>(null);
  const [quantity, setQuantity] = useState("");
  const [avgPrice, setAvgPrice] = useState("");
  const search = useSearch(debounced);
  const registered = useRegisteredCodes();
  const recent = useRecentSearches();
  const { register } = useStockMutations();

  useEffect(() => {
    const id = setTimeout(() => setDebounced(q), 150);
    return () => clearTimeout(id);
  }, [q]);

  const open = (s: RecentStock) => {
    recent.add(s);
    router.push(`/stocks/${s.code}`);
  };

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
        onSuccess: () => {
          if (Platform.OS === "android") ToastAndroid.show(`${selected.name} 등록됨`, ToastAndroid.SHORT);
          router.back();
        },
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
      ) : q.trim().length === 0 ? (
        recent.items.length ? (
          <View style={{ gap: space.xs }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              <Text style={{ color: t.ink, fontSize: font.small, fontWeight: "700" }}>최근 검색</Text>
              <Pressable onPress={recent.clear} hitSlop={8} accessibilityRole="button" accessibilityLabel="최근 검색 지우기">
                <Muted>지우기</Muted>
              </Pressable>
            </View>
            {recent.items.map((item) => (
              <ResultRow key={item.code} item={item} registered={registered.has(item.code)} onOpen={() => open(item)} onRegister={() => setSelected({ ...item, isinCode: null, groupCode: null })} />
            ))}
          </View>
        ) : (
          <Muted>한국·미국 종목을 한글 이름(테슬라, 애플), 티커(TSLA, AAPL), 6자리 코드로 검색합니다. 토스증권 검색을 쓰므로 토스에서 보이는 이름 그대로 치면 됩니다.</Muted>
        )
      ) : search.isError ? (
        <Text style={{ color: t.danger }}>{search.error instanceof Error ? search.error.message : "검색 실패"}</Text>
      ) : (
        <FlatList
          data={search.data?.results ?? []}
          keyExtractor={(s) => s.code}
          keyboardShouldPersistTaps="handled"
          ItemSeparatorComponent={() => <View style={{ height: space.xs }} />}
          // 결과가 아직 없을 때만 안내 (입력이 바뀌는 동안은 이전 결과를 그대로 둔다 — 스피너·깜빡임 없음)
          ListEmptyComponent={search.pending ? null : <Muted>검색 결과가 없습니다.</Muted>}
          ListFooterComponent={search.pending && (search.data?.results.length ?? 0) > 0 ? <Muted style={{ fontSize: font.tiny, paddingTop: space.xs }}>토스 검색 결과를 합치는 중</Muted> : null}
          renderItem={({ item }) => <ResultRow item={item} registered={registered.has(item.code)} onOpen={() => open(item)} onRegister={() => setSelected(item)} />}
        />
      )}
    </Screen>
  );
}

/** 검색 결과 한 줄: 누르면 상세, 오른쪽은 등록됨 표시 또는 "등록" 버튼 */
function ResultRow({ item, registered, onOpen, onRegister }: { item: RecentStock & Partial<ListedStock>; registered: boolean; onOpen: () => void; onRegister: () => void }) {
  const t = useTheme();
  return (
    <Pressable onPress={onOpen} accessibilityRole="button" accessibilityLabel={`${item.name} 상세 보기`} style={({ pressed }) => [styles.result, { backgroundColor: pressed ? t.surfaceAlt : t.surface, borderColor: t.line }]}>
      <View style={{ flex: 1 }}>
        <Text style={{ color: t.ink, fontSize: font.body, fontWeight: "600" }} numberOfLines={1}>
          {item.name}
        </Text>
        <Muted>
          {item.code} · {item.market}
        </Muted>
      </View>
      {item.price ? (
        <View style={{ alignItems: "flex-end" }}>
          <Text style={{ color: t.ink, fontSize: font.small, fontWeight: "600", fontVariant: ["tabular-nums"] }}>{formatPrice(item.price, item.currency)}</Text>
          <ChangeText value={item.changeRate ?? null} text={formatPct(item.changeRate ?? null)} style={{ fontSize: font.tiny }} />
        </View>
      ) : null}
      {isUsMarket(item.market) ? <Badge tone="warn">미국 · $</Badge> : null}
      {item.groupCode === "EF" ? <Badge>ETF</Badge> : null}
      {registered ? (
        <Badge tone="good">등록됨</Badge>
      ) : (
        <Pressable onPress={onRegister} hitSlop={8} accessibilityRole="button" accessibilityLabel={`${item.name} 등록`} style={[styles.addBtn, { borderColor: t.line }]}>
          <Ionicons name="add" size={16} color={t.ink} />
          <Text style={{ color: t.ink, fontSize: font.tiny, fontWeight: "600" }}>등록</Text>
        </Pressable>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  addBtn: { flexDirection: "row", alignItems: "center", gap: 2, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.sm, paddingHorizontal: space.sm, paddingVertical: 4 },
  search: { flexDirection: "row", alignItems: "center", gap: space.sm, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, paddingHorizontal: space.md },
  input: { flex: 1, paddingVertical: 12, fontSize: font.body },
  field: { flex: 1, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.sm, padding: space.md, fontSize: font.body },
  result: { flexDirection: "row", alignItems: "center", gap: space.md, padding: space.md, borderRadius: radius.sm, borderWidth: StyleSheet.hairlineWidth },
});

// 이 화면에서 난 렌더 오류는 앱을 끄지 않고 "다시 시도" 화면으로 (expo-router)
export { RouteErrorBoundary as ErrorBoundary } from "@/components/RouteError";
