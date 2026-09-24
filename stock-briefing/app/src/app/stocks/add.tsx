import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import React, { useEffect, useState } from "react";
import { Alert, FlatList, Platform, Pressable, StyleSheet, Text, TextInput, ToastAndroid, View } from "react-native";
import { ApiRequestError } from "@/api/client";
import { useRegisteredCodes, useSearch, useStockMutations } from "@/api/hooks";
import type { ListedStock } from "@/api/types";
import { Screen } from "@/components/Screen";
import { LineHead, LineMark, StockLine } from "@/components/StockLine";
import { Button, Card, Muted } from "@/components/ui";
import { formatPct, formatQuote, isUsMarket } from "@/lib/format";
import { useRecentSearches, type RecentStock } from "@/lib/recentSearch";
import { changeColor, font, radius, slopFor, space, useTheme } from "@/theme";

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
  const { codes: registered, refresh: refreshRegistered } = useRegisteredCodes();
  const recent = useRecentSearches();
  const { register } = useStockMutations();

  useEffect(() => {
    const id = setTimeout(() => setDebounced(q), 150);
    return () => clearTimeout(id);
  }, [q]);

  // 입력이 멈추기 전(150ms)에도 "결과 없음"을 띄우지 않게
  const typing = q.trim() !== debounced.trim();
  const pending = search.pending || typing;

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
        onError: (e) => {
          // 다른 화면(상세)에서 이미 등록한 종목: 실패가 아니라 "이미 등록됨"으로 알리고 표시를 새로 받는다
          if (e instanceof ApiRequestError && e.status === 409 && e.code === "CONFLICT") {
            refreshRegistered();
            setSelected(null);
            Alert.alert("이미 등록된 종목", `${selected.name}은(는) 이미 등록되어 있습니다. 수량·평단은 종목 상세에서 바꿀 수 있습니다.`);
            return;
          }
          Alert.alert("등록 실패", e instanceof Error ? e.message : String(e));
        },
      },
    );
  };

  return (
    // 결과 줄은 다른 목록(잔고·발견)과 같은 공용 줄이라 화면 가장자리까지 (3-21). 검색칸·안내만 안쪽 여백
    <Screen scroll={false} contentStyle={{ paddingVertical: space.lg, gap: space.md }}>
      <View style={[styles.search, { borderColor: t.line, backgroundColor: t.surface, marginHorizontal: space.lg }]}>
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
          accessibilityLabel="종목 검색"
          style={[styles.input, { color: t.ink }]}
          returnKeyType="search"
        />
        {q ? (
          <Pressable onPress={() => setQ("")} accessibilityRole="button" accessibilityLabel="검색어 지우기" hitSlop={slopFor(ICON, space.xs)}>
            <Ionicons name="close-circle" size={ICON} color={t.muted} />
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
            <Pressable onPress={() => setSelected(null)} accessibilityRole="button" accessibilityLabel="선택 취소" hitSlop={slopFor(ICON, space.xs)}>
              <Ionicons name="close" size={22} color={t.muted} />
            </Pressable>
          </View>
          <Muted>보유 정보는 선택 사항입니다. 비우면 관심 종목으로 등록됩니다.</Muted>
          <View style={{ flexDirection: "row", gap: space.sm }}>
            <TextInput
              value={quantity}
              onChangeText={setQuantity}
              accessibilityLabel="보유 수량"
              placeholder="보유 수량 (주)"
              placeholderTextColor={t.muted}
              keyboardType="numeric"
              style={[styles.field, { color: t.ink, borderColor: t.line, backgroundColor: t.surfaceAlt }]}
            />
            <TextInput
              value={avgPrice}
              onChangeText={setAvgPrice}
              accessibilityLabel="평균 단가"
              placeholder={isUsMarket(selected.market) ? "평균 단가 ($)" : "평균 단가 (원)"}
              placeholderTextColor={t.muted}
              keyboardType="numeric"
              style={[styles.field, { color: t.ink, borderColor: t.line, backgroundColor: t.surfaceAlt }]}
            />
          </View>
          <Button title="등록" accessibilityLabel={`${selected.name} 등록`} onPress={submit} loading={register.isPending} />
        </Card>
      ) : q.trim().length === 0 ? (
        recent.items.length ? (
          <FlatList
            data={recent.items}
            keyExtractor={(s) => s.code}
            keyboardShouldPersistTaps="handled"
            ListHeaderComponent={
              <>
                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingBottom: space.xs, paddingHorizontal: space.lg }}>
                  <Text style={{ color: t.ink, fontSize: font.small, fontWeight: "700" }}>최근 검색</Text>
                  <Pressable onPress={recent.clear} hitSlop={slopFor(font.small * 1.35, space.sm)} accessibilityRole="button" accessibilityLabel="최근 검색 지우기">
                    <Muted>지우기</Muted>
                  </Pressable>
                </View>
                {/* 최근 검색은 시세를 들고 있지 않다 → 가격 칸을 비운다 */}
                <LineHead price="" right="등록" />
              </>
            }
            renderItem={({ item }) => <ResultRow item={item} recent registered={registered.has(item.code)} onOpen={() => open(item)} onRegister={() => setSelected({ ...item, isinCode: null, groupCode: null })} />}
          />
        ) : (
          <Muted style={{ paddingHorizontal: space.lg }}>한국·미국 종목을 한글 이름(테슬라, 애플), 티커(TSLA, AAPL), 6자리 코드로 검색합니다. 토스증권 검색을 쓰므로 토스에서 보이는 이름 그대로 치면 됩니다.</Muted>
        )
      ) : search.isError ? (
        <Text style={{ color: t.danger, paddingHorizontal: space.lg }}>{search.error instanceof Error ? search.error.message : "검색 실패"}</Text>
      ) : (
        <FlatList
          data={search.data?.results ?? []}
          // 이전 입력의 결과를 보여 주는 동안은 흐리게
          style={{ opacity: search.previous ? 0.55 : 1 }}
          keyExtractor={(s) => s.code}
          keyboardShouldPersistTaps="handled"
          ListHeaderComponent={(search.data?.results.length ?? 0) > 0 ? <LineHead right="등록" /> : null}
          // 결과가 아직 없을 때만 안내 (입력이 바뀌는 동안은 이전 결과를 그대로 둔다 — 스피너·깜빡임 없음)
          ListEmptyComponent={pending ? null : search.error ? <Text style={{ color: t.danger, paddingHorizontal: space.lg }}>토스 검색에 실패했고 앱의 종목 목록에도 없습니다. 잠시 뒤 다시 검색해 보세요.</Text> : <Muted style={{ paddingHorizontal: space.lg }}>검색 결과가 없습니다.</Muted>}
          ListFooterComponent={
            (search.data?.results.length ?? 0) === 0 ? null : search.pending ? (
              <Muted style={{ fontSize: font.tiny, paddingTop: space.xs, paddingHorizontal: space.lg }}>토스 검색 결과를 합치는 중</Muted>
            ) : search.error ? (
              <Muted style={{ fontSize: font.tiny, paddingTop: space.xs, paddingHorizontal: space.lg }}>토스 검색 실패 — 앱의 종목 목록에서 찾은 결과만 보여 줍니다</Muted>
            ) : null
          }
          renderItem={({ item }) => <ResultRow item={item} registered={registered.has(item.code)} onOpen={() => open(item)} onRegister={() => setSelected(item)} />}
        />
      )}
    </Screen>
  );
}

/** 검색 결과 한 줄 (공용 StockLine): 누르면 상세, 오른쪽 열은 등록됨 표시 또는 "등록" 버튼 */
function ResultRow({ item, registered, onOpen, onRegister, recent = false }: { item: RecentStock & Partial<ListedStock>; registered: boolean; onOpen: () => void; onRegister: () => void; recent?: boolean }) {
  const t = useTheme();
  const us = isUsMarket(item.market);
  const c = changeColor(t, item.changeRate ?? null);
  return (
    <StockLine
      name={item.name}
      nameBadge={<LineMark label={us ? "US" : "KR"} color={us ? t.accent : t.gold} />}
      sub={`${item.code} · ${item.market}`}
      badges={item.groupCode === "EF" ? <LineMark label="ETF" color={t.muted} /> : null}
      priceMissing={recent ? "" : "-"}
      price={item.price ? { value: item.price, text: formatQuote(item.price, item.currency), color: c, rate: formatPct(item.changeRate ?? null), rateColor: c } : null}
      right={
        registered ? (
          <LineMark label="등록됨" color={t.accent} />
        ) : (
          <Pressable onPress={onRegister} hitSlop={slopFor(ADD_BTN_H, space.xs)} accessibilityRole="button" accessibilityLabel={`${item.name} 등록`} style={[styles.addBtn, { borderColor: t.line }]}>
            <Ionicons name="add" size={font.body} color={t.ink} />
            <Text style={{ color: t.ink, fontSize: font.tiny, fontWeight: "600" }}>등록</Text>
          </Pressable>
        )
      }
      onPress={onOpen}
      accessibilityLabel={`${item.name}, ${item.code}${registered ? ", 등록됨" : ""}. 누르면 상세 보기`}
      // 화면 읽기 프로그램에서도 줄 안의 "등록" 버튼을 쓸 수 있게
      accessibilityActions={registered ? undefined : [{ name: "register", label: "등록" }]}
      onAccessibilityAction={(name) => {
        if (name === "register") onRegister();
      }}
    />
  );
}

/** 검색칸 아이콘(18)·줄 안 등록 버튼(28) — hitSlop 으로 44 (3-22) */
const ICON = 18;
const ADD_BTN_H = 28;

const styles = StyleSheet.create({
  addBtn: { minHeight: ADD_BTN_H, flexDirection: "row", alignItems: "center", gap: space.xxs, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.sm, paddingHorizontal: space.sm, paddingVertical: space.xs },
  search: { flexDirection: "row", alignItems: "center", gap: space.sm, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, paddingHorizontal: space.md },
  input: { flex: 1, paddingVertical: space.md, fontSize: font.body },
  field: { flex: 1, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.sm, padding: space.md, fontSize: font.body },
});

// 이 화면에서 난 렌더 오류는 앱을 끄지 않고 "다시 시도" 화면으로 (expo-router)
export { RouteErrorBoundary as ErrorBoundary } from "@/components/RouteError";
