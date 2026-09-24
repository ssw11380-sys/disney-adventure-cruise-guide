import { router, useLocalSearchParams } from "expo-router";
import React, { useState } from "react";
import { Alert, StyleSheet, Text, TextInput, View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useApi, useStock, useStockMutations } from "@/api/hooks";
import type { Evaluation, RegisteredStock } from "@/api/types";
import { useSettings } from "@/lib/settings";
import { Screen } from "@/components/Screen";
import { Button, Card, ErrorView, Loading, Muted, Row, SectionTitle, Segmented } from "@/components/ui";
import { formatPrice, isUsMarket } from "@/lib/format";
import { avgText, holdingPatch, parseNum, qtyText } from "@/lib/holdingForm";
import { font, radius, space, useTheme } from "@/theme";

/** 보유 수량/평단/메모 수정, 매수·매도 기록(평단 자동 계산), 삭제 */
export default function EditStockScreen() {
  const { code } = useLocalSearchParams<{ code: string }>();
  const stock = useStock(code ?? "");
  if (!code) return null;
  // 입력 중에 재조회가 실패해도 폼을 지우지 않는다(값이 한 번이라도 왔으면 폼 유지)
  if (!stock.data && !stock.isError) return <Screen><Loading /></Screen>;
  if (!stock.data) return <Screen><ErrorView error={stock.error ?? new Error("종목을 찾을 수 없습니다")} onRetry={() => void stock.refetch()} /></Screen>;
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

function EditForm({ stock }: { stock: RegisteredStock & { evaluation?: Evaluation | null } }) {
  const t = useTheme();
  const api = useApi();
  const qc = useQueryClient();
  const { apiUrl } = useSettings();
  const { update, remove } = useStockMutations();
  const ev = stock.evaluation ?? null;
  const [krwCost, setKrwCost] = useState(ev?.costBasisKrw && ev.krwCostSource === "exact" ? String(Math.round(ev.costBasisKrw)) : "");
  const [savingKrw, setSavingKrw] = useState(false);
  const saveKrwCost = async () => {
    const v = Number(krwCost.replace(/[^0-9.]/g, ""));
    if (!(v > 0)) {
      Alert.alert("입력 확인", "원화 매입금액을 숫자로 입력하세요.");
      return;
    }
    setSavingKrw(true);
    try {
      const r = await api.setKrwCost({ [stock.code]: v });
      if (!r.applied.includes(stock.code)) throw new Error(skipMessage(r.skipped.find((x) => x.code === stock.code)));
      await qc.invalidateQueries({ queryKey: [apiUrl, "stocks"] });
      await qc.invalidateQueries({ queryKey: [apiUrl, "stock", stock.code] });
      Alert.alert("저장됨", "원화 손익이 토스 앱과 같은 기준으로 계산됩니다.");
    } catch (e) {
      Alert.alert("저장 실패", e instanceof Error ? e.message : String(e));
    } finally {
      setSavingKrw(false);
    }
  };
  const cur = isUsMarket(stock.market) ? "USD" : "KRW";
  const locked = stock.tossSynced === true;
  const initial = { quantity: qtyText(stock.quantity), avgPrice: avgText(stock.avgPrice, cur) };
  const [quantity, setQuantity] = useState(initial.quantity);
  const [avgPrice, setAvgPrice] = useState(initial.avgPrice);
  const [memo, setMemo] = useState(stock.memo ?? "");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [tradeQty, setTradeQty] = useState("");
  const [tradePrice, setTradePrice] = useState("");

  const num = parseNum;

  /** 바꾼 칸만 보낸다 (메모만 고치면 수량·평단은 그대로). 토스 종목은 메모만 */
  const save = (values: { quantity: string; avgPrice: string } = { quantity, avgPrice }) => {
    const patch = locked ? {} : holdingPatch(initial, values);
    if ("error" in patch) {
      Alert.alert("입력 확인", patch.error);
      return;
    }
    update.mutate(
      { code: stock.code, ...patch, memo: memo.trim() || null },
      { onSuccess: () => router.back(), onError: (e) => Alert.alert("저장 실패", e instanceof Error ? e.message : String(e)) },
    );
  };

  const preview = (() => {
    const q = num(tradeQty), p = num(tradePrice);
    if (q === null || p === null || !(q > 0) || !(p > 0)) return null;
    if (side === "sell" && q > (num(quantity) ?? 0)) return { error: "보유 수량보다 많이 매도할 수 없습니다" as const };
    return applyTrade({ quantity: num(quantity), avgPrice: num(avgPrice) }, side, q, p);
  })();

  /** 체결을 반영해 바로 저장 (예전: 위 칸에 반영 → 저장, 2단계) */
  const saveTrade = () => {
    if (!preview || "error" in preview) return;
    save({ quantity: preview.quantity > 0 ? String(preview.quantity) : "", avgPrice: avgText(preview.avgPrice, cur) });
  };

  const confirmRemove = () => {
    const body = locked
      ? `${stock.name} 은(는) 토스 계좌에서 가져온 종목입니다. 삭제하면 토스 동기화에서도 빠져 다시 나타나지 않습니다 (다시 등록하면 다시 맞춤). 지난 브리핑은 남습니다.`
      : `${stock.name} 을(를) 목록에서 삭제할까요? 지난 브리핑은 남습니다.`;
    Alert.alert(locked ? "동기화 제외하고 삭제" : "종목 삭제", body, [
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
        {locked ? (
          <View style={[styles.lockNote, { backgroundColor: t.surfaceAlt }]}>
            <Text style={{ color: t.ink, fontSize: font.small, fontWeight: "600" }}>토스 계좌 기준 · 10분마다 맞춤</Text>
            <Muted>수량·평단은 토스 계좌 값으로 자동으로 맞춰져 여기서 바꿀 수 없습니다. 메모는 바꿀 수 있습니다.</Muted>
          </View>
        ) : null}
        <View style={{ flexDirection: "row", gap: space.sm }}>
          <View style={styles.col}>
            <Text style={[styles.label, { color: t.muted }]}>보유 수량 (주)</Text>
            <TextInput value={quantity} onChangeText={setQuantity} editable={!locked} accessibilityLabel="보유 수량" placeholder="예: 10" placeholderTextColor={t.muted} keyboardType="numeric" style={[styles.field, styles.inCol, { color: locked ? t.muted : t.ink, borderColor: t.line, backgroundColor: t.surfaceAlt }]} />
          </View>
          <View style={styles.col}>
            <Text style={[styles.label, { color: t.muted }]}>{cur === "USD" ? "평균 단가 ($)" : "평균 단가 (원)"}</Text>
            <TextInput value={avgPrice} onChangeText={setAvgPrice} editable={!locked} accessibilityLabel="평균 단가" placeholder={cur === "USD" ? "예: 123.45" : "예: 70000"} placeholderTextColor={t.muted} keyboardType="numeric" style={[styles.field, styles.inCol, { color: locked ? t.muted : t.ink, borderColor: t.line, backgroundColor: t.surfaceAlt }]} />
          </View>
        </View>
        <Text style={[styles.label, { color: t.muted }]}>메모</Text>
        <TextInput value={memo} onChangeText={setMemo} accessibilityLabel="메모" placeholder="선택" placeholderTextColor={t.muted} multiline style={[styles.field, { color: t.ink, borderColor: t.line, backgroundColor: t.surfaceAlt, minHeight: 72 }]} />
        <Button title="저장" onPress={() => save()} loading={update.isPending} />
      </Card>

      {cur === "USD" && ev ? (
        <Card>
          <SectionTitle>원화 매입금액</SectionTitle>
          <Muted>
            토스 앱 원화 보기에서 이 종목의 평가금액 − 평가손익 값을 넣으면 원화 손익이 토스와 똑같아집니다.{" "}
            {ev.costBasisKrw ? `현재 ${Math.round(ev.costBasisKrw).toLocaleString("ko-KR")}원 (${ev.krwCostSource === "exact" ? "토스 값" : "체결 환율 추정"})` : ""}
          </Muted>
          <View style={{ flexDirection: "row", gap: space.sm }}>
            <TextInput value={krwCost} onChangeText={setKrwCost} placeholder="예: 24557187" placeholderTextColor={t.muted} keyboardType="numeric" style={[styles.field, { color: t.ink, borderColor: t.line, backgroundColor: t.surfaceAlt }]} />
            <Button title="저장" variant="secondary" onPress={() => void saveKrwCost()} loading={savingKrw} />
          </View>
        </Card>
      ) : null}

      {locked ? null : (
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
        <Button title="반영해 저장" variant="secondary" icon="calculator-outline" disabled={!preview || "error" in preview} loading={update.isPending} onPress={saveTrade} />
      </Card>
      )}

      <View style={{ paddingHorizontal: space.lg }}>
        <Button title={locked ? "동기화 제외하고 삭제" : "종목 삭제"} variant="danger" onPress={confirmRemove} loading={remove.isPending} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  field: { flex: 1, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.sm, padding: space.md, fontSize: font.body },
  col: { flex: 1, gap: 4 },
  inCol: { flexGrow: 0, flexBasis: "auto" },
  label: { fontSize: font.tiny },
  lockNote: { borderRadius: radius.sm, padding: space.md, gap: 2 },
});

/** 원화 매입금액을 저장하지 못한 이유 (서버가 알려 준 대로) */
function skipMessage(skip: { reason: string; retryAfter?: string } | undefined): string {
  switch (skip?.reason) {
    case "unexplained": {
      const at = skip.retryAfter ? new Date(skip.retryAfter) : null;
      const when = at && !Number.isNaN(at.getTime()) ? `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")} 이후` : "잠시 뒤";
      return `토스 주문 내역이 아직 이 보유와 맞지 않습니다 (방금 체결됐거나 입고된 주식). ${when} 다시 저장해 주세요.`;
    }
    case "changed":
      return "저장하는 사이 체결이 있었습니다. 토스 앱의 최신 값으로 다시 저장해 주세요.";
    case "orders_failed":
      return "토스 주문 내역을 읽지 못했습니다. 잠시 뒤 다시 시도해 주세요.";
    default:
      return "토스 계좌에서 가져온 해외 보유 종목만 저장할 수 있습니다 (설정 → 토스증권 연동 → 동기화 후 다시 시도).";
  }
}

// 이 화면에서 난 렌더 오류는 앱을 끄지 않고 "다시 시도" 화면으로 (expo-router)
export { RouteErrorBoundary as ErrorBoundary } from "@/components/RouteError";
