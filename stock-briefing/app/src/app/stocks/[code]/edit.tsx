import { router, useLocalSearchParams } from "expo-router";
import React, { useState } from "react";
import { Alert, StyleSheet, Text, TextInput, View } from "react-native";
import { useStock, useStockMutations } from "@/api/hooks";
import type { RegisteredStock } from "@/api/types";
import { Screen } from "@/components/Screen";
import { Button, Card, ErrorView, Loading, Muted, Row, SectionTitle, Segmented } from "@/components/ui";
import { formatPrice, isUsMarket } from "@/lib/format";
import { font, radius, space, useTheme } from "@/theme";

/** 보유 수량/평단/메모 수정, 매수·매도 기록(평단 자동 계산), 삭제 */
export default function EditStockScreen() {
  const { code } = useLocalSearchParams<{ code: string }>();
  const stock = useStock(code ?? "");
  if (!code) return null;
  if (stock.isLoading) return <Screen><Loading /></Screen>;
  if (stock.isError || !stock.data) return <Screen><ErrorView error={stock.error ?? new Error("종목을 찾을 수 없습니다")} onRetry={() => void stock.refetch()} /></Screen>;
  // key 로 종목이 바뀌면 폼 상태를 새로 만든다 (effect 로 setState 하지 않기 위함)
  return <EditForm key={`${stock.data.code}:${stock.data.updatedAt}`} stock={stock.data} />;
}

/** 매수: 수량 가중 평균으로 평단 재계산. 매도: 수량만 줄고 평단은 유지 */
export function applyTrade(current: { quantity: number | null; avgPrice: number | null }, side: "buy" | "sell", qty: number, price: number): { quantity: number; avgPrice: number | null } {
  const q0 = current.quantity ?? 0;
  const a0 = current.avgPrice ?? 0;
  if (side === "buy") {
    const q = q0 + qty;
    const avg = q0 > 0 && current.avgPrice !== null ? (q0 * a0 + qty * price) / q : price;
    return { quantity: q, avgPrice: Math.round(avg * 100) / 100 };
  }
  const q = Math.max(0, q0 - qty);
  return { quantity: q, avgPrice: q === 0 ? null : current.avgPrice };
}

function EditForm({ stock }: { stock: RegisteredStock }) {
  const t = useTheme();
  const { update, remove } = useStockMutations();
  const cur = isUsMarket(stock.market) ? "USD" : "KRW";
  const [quantity, setQuantity] = useState(stock.quantity?.toString() ?? "");
  const [avgPrice, setAvgPrice] = useState(stock.avgPrice?.toString() ?? "");
  const [memo, setMemo] = useState(stock.memo ?? "");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [tradeQty, setTradeQty] = useState("");
  const [tradePrice, setTradePrice] = useState("");

  const num = (s: string) => (s.trim() ? Number(s.replace(/,/g, "")) : null);

  const save = () => {
    const qty = num(quantity);
    const avg = num(avgPrice);
    if ((qty !== null && !(qty > 0)) || (avg !== null && !(avg > 0))) {
      Alert.alert("입력 확인", "수량과 평균 단가는 0보다 큰 숫자여야 합니다.");
      return;
    }
    update.mutate(
      { code: stock.code, quantity: qty, avgPrice: avg, memo: memo.trim() || null },
      { onSuccess: () => router.back(), onError: (e) => Alert.alert("저장 실패", e instanceof Error ? e.message : String(e)) },
    );
  };

  const preview = (() => {
    const q = num(tradeQty), p = num(tradePrice);
    if (q === null || p === null || !(q > 0) || !(p > 0)) return null;
    if (side === "sell" && q > (num(quantity) ?? 0)) return { error: "보유 수량보다 많이 매도할 수 없습니다" as const };
    return applyTrade({ quantity: num(quantity), avgPrice: num(avgPrice) }, side, q, p);
  })();

  const applyTradeToForm = () => {
    if (!preview || "error" in preview) return;
    setQuantity(preview.quantity > 0 ? String(preview.quantity) : "");
    setAvgPrice(preview.avgPrice !== null ? String(preview.avgPrice) : "");
    setTradeQty("");
    setTradePrice("");
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
        <View style={{ flexDirection: "row", gap: space.sm }}>
          <TextInput value={quantity} onChangeText={setQuantity} placeholder="보유 수량 (주)" placeholderTextColor={t.muted} keyboardType="numeric" style={[styles.field, { color: t.ink, borderColor: t.line, backgroundColor: t.surfaceAlt }]} />
          <TextInput value={avgPrice} onChangeText={setAvgPrice} placeholder={cur === "USD" ? "평균 단가 ($)" : "평균 단가 (원)"} placeholderTextColor={t.muted} keyboardType="numeric" style={[styles.field, { color: t.ink, borderColor: t.line, backgroundColor: t.surfaceAlt }]} />
        </View>
        <TextInput value={memo} onChangeText={setMemo} placeholder="메모 (선택)" placeholderTextColor={t.muted} multiline style={[styles.field, { color: t.ink, borderColor: t.line, backgroundColor: t.surfaceAlt, minHeight: 72 }]} />
        <Button title="저장" onPress={save} loading={update.isPending} />
      </Card>

      <Card>
        <SectionTitle>체결 반영</SectionTitle>
        <Segmented
          options={[
            { value: "buy", label: "매수" },
            { value: "sell", label: "매도" },
          ]}
          value={side}
          onChange={setSide}
        />
        <View style={{ flexDirection: "row", gap: space.sm }}>
          <TextInput value={tradeQty} onChangeText={setTradeQty} placeholder="수량 (주)" placeholderTextColor={t.muted} keyboardType="numeric" style={[styles.field, { color: t.ink, borderColor: t.line, backgroundColor: t.surfaceAlt }]} />
          <TextInput value={tradePrice} onChangeText={setTradePrice} placeholder={cur === "USD" ? "체결가 ($)" : "체결가 (원)"} placeholderTextColor={t.muted} keyboardType="numeric" style={[styles.field, { color: t.ink, borderColor: t.line, backgroundColor: t.surfaceAlt }]} />
        </View>
        {preview && "error" in preview ? <Text style={{ color: t.danger, fontSize: font.small }}>{preview.error}</Text> : null}
        {preview && !("error" in preview) ? (
          <View>
            <Row label="거래 후 수량" value={`${preview.quantity}주`} />
            <Row label="거래 후 평단" value={preview.avgPrice !== null ? formatPrice(preview.avgPrice, cur) : "-"} />
          </View>
        ) : null}
        <Button title="위 칸에 반영" variant="secondary" icon="calculator-outline" disabled={!preview || "error" in preview} onPress={applyTradeToForm} />
      </Card>

      <View style={{ paddingHorizontal: space.lg }}>
        <Button title="종목 삭제" variant="danger" onPress={confirmRemove} loading={remove.isPending} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  field: { flex: 1, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.sm, padding: space.md, fontSize: font.body },
});
