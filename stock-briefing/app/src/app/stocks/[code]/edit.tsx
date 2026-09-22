import { router, useLocalSearchParams } from "expo-router";
import React, { useState } from "react";
import { Alert, StyleSheet, Text, TextInput, View } from "react-native";
import { useStock, useStockMutations } from "@/api/hooks";
import type { RegisteredStock } from "@/api/types";
import { Screen } from "@/components/Screen";
import { Button, Card, ErrorView, Loading, Muted } from "@/components/ui";
import { font, radius, space, useTheme } from "@/theme";

/** 보유 수량/평단/메모 수정, 삭제 */
export default function EditStockScreen() {
  const { code } = useLocalSearchParams<{ code: string }>();
  const stock = useStock(code ?? "");
  if (!code) return null;
  if (stock.isLoading) return <Screen><Loading /></Screen>;
  if (stock.isError || !stock.data) return <Screen><ErrorView error={stock.error ?? new Error("종목을 찾을 수 없습니다")} onRetry={() => void stock.refetch()} /></Screen>;
  // key 로 종목이 바뀌면 폼 상태를 새로 만든다 (effect 로 setState 하지 않기 위함)
  return <EditForm key={`${stock.data.code}:${stock.data.updatedAt}`} stock={stock.data} />;
}

function EditForm({ stock }: { stock: RegisteredStock }) {
  const t = useTheme();
  const { update, remove } = useStockMutations();
  const [quantity, setQuantity] = useState(stock.quantity?.toString() ?? "");
  const [avgPrice, setAvgPrice] = useState(stock.avgPrice?.toString() ?? "");
  const [memo, setMemo] = useState(stock.memo ?? "");

  const save = () => {
    const qty = quantity.trim() ? Number(quantity.replace(/,/g, "")) : null;
    const avg = avgPrice.trim() ? Number(avgPrice.replace(/,/g, "")) : null;
    if ((qty !== null && !(qty > 0)) || (avg !== null && !(avg > 0))) {
      Alert.alert("입력 확인", "수량과 평균 단가는 0보다 큰 숫자여야 합니다.");
      return;
    }
    update.mutate(
      { code: stock.code, quantity: qty, avgPrice: avg, memo: memo.trim() || null },
      { onSuccess: () => router.back(), onError: (e) => Alert.alert("저장 실패", e instanceof Error ? e.message : String(e)) },
    );
  };

  const confirmRemove = () => {
    Alert.alert("종목 삭제", `${stock.name} 을(를) 목록에서 삭제할까요? 지난 브리핑은 남습니다.`, [
      { text: "취소", style: "cancel" },
      {
        text: "삭제",
        style: "destructive",
        onPress: () =>
          remove.mutate(stock.code, {
            onSuccess: () => router.dismissTo("/"),
            onError: (e) => Alert.alert("삭제 실패", e instanceof Error ? e.message : String(e)),
          }),
      },
    ]);
  };

  return (
    <Screen>
      <Card>
        <Text style={{ color: t.ink, fontSize: font.h2, fontWeight: "700" }}>
          {stock.name} <Muted>{stock.code}</Muted>
        </Text>
        <Muted>비우면 관심 종목으로 바뀝니다.</Muted>
        <View style={{ flexDirection: "row", gap: space.sm }}>
          <TextInput value={quantity} onChangeText={setQuantity} placeholder="보유 수량 (주)" placeholderTextColor={t.muted} keyboardType="numeric" style={[styles.field, { color: t.ink, borderColor: t.line, backgroundColor: t.surfaceAlt }]} />
          <TextInput value={avgPrice} onChangeText={setAvgPrice} placeholder="평균 단가 (원)" placeholderTextColor={t.muted} keyboardType="numeric" style={[styles.field, { color: t.ink, borderColor: t.line, backgroundColor: t.surfaceAlt }]} />
        </View>
        <TextInput value={memo} onChangeText={setMemo} placeholder="메모 (선택)" placeholderTextColor={t.muted} multiline style={[styles.field, { color: t.ink, borderColor: t.line, backgroundColor: t.surfaceAlt, minHeight: 72 }]} />
        <Button title="저장" onPress={save} loading={update.isPending} />
      </Card>
      <Button title="목록에서 삭제" variant="danger" onPress={confirmRemove} loading={remove.isPending} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  field: { flex: 1, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.sm, padding: space.md, fontSize: font.body },
});
