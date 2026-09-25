import { router, useLocalSearchParams } from "expo-router";
import React, { useState } from "react";
import { Alert, StyleSheet, Text, TextInput, View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { ApiRequestError } from "@/api/client";
import { useApi, useStock, useStockMutations } from "@/api/hooks";
import type { Evaluation, RegisteredStock } from "@/api/types";
import { useSettings } from "@/lib/settings";
import { Screen } from "@/components/Screen";
import { Button, Card, ErrorView, Loading, Muted, Row, SectionTitle, Segmented } from "@/components/ui";
import { formatPrice, isUsMarket } from "@/lib/format";
import { parseStockCode } from "@/lib/freshness";
import { avgText, draftOf, editDraft, holdingPatch, normNum, normText, parseNum, qtyText, rebaseDraft, tradePatch, type Draft, type HoldingPatch, type Norm } from "@/lib/holdingForm";
import { font, radius, space, useTheme } from "@/theme";

/** 보유 수량/평단/메모 수정, 매수·매도 기록(평단 자동 계산), 삭제 */
export default function EditStockScreen() {
  const { code } = useLocalSearchParams<{ code: string }>();
  // 잘못된 딥링크(다른 앱·웹 페이지가 연 주소 등)는 서버에 묻지 않고 안내만 한다 — 상세 화면과 같은 규칙 (BH-36)
  const c = parseStockCode(code) ?? "";
  const stock = useStock(c);
  if (!c) return <Screen><ErrorView error={new Error("종목 주소가 올바르지 않습니다")} retryLabel="잔고로" onRetry={() => router.dismissTo("/")} /></Screen>;
  // 입력 중에 재조회가 실패해도 폼을 지우지 않는다(값이 한 번이라도 왔으면 폼 유지)
  if (!stock.data && !stock.isError) return <Screen><Loading /></Screen>;
  if (!stock.data) return <Screen><ErrorView error={stock.error ?? new Error("종목을 찾을 수 없습니다")} onRetry={() => void stock.refetch()} /></Screen>;
  // key 로 종목이 바뀌면 폼 상태를 새로 만든다 (effect 로 setState 하지 않기 위함).
  // updatedAt 은 넣지 않는다: 넣으면 토스 체결 동기화로 같은 종목 값만 바뀌어도 쓰던 메모 등 초안이 지워진다 (PF-07). 같은 종목의 새 서버 값은 칸마다 useDraft 가 맞춘다
  return <EditForm key={stock.data.code} stock={stock.data} />;
}

/**
 * 서버 값에서 시작하는 입력 칸. 같은 종목의 서버 값이 바뀌면 손대지 않은 칸만 새 값을 따르고 고치던 초안은 지킨다 (PF-07).
 * 이전 렌더의 기준값과 그리는 중에 비교해 맞춘다 (effect 로 setState 하지 않기 위함)
 */
function useDraft(server: string, norm: Norm): [Draft, (v: string) => void] {
  const [draft, setDraft] = useState(() => draftOf(server));
  const next = rebaseDraft(draft, server, norm);
  if (next !== draft) setDraft(next);
  return [next, (v: string) => setDraft((d) => editDraft(d, v, norm))];
}

const STALE_NOTE = "입력하는 사이 저장된 값이 바뀌었습니다. 저장하면 지금 입력한 값으로 바뀝니다.";
/** 원화 매입금액을 저장했지만 지금은 쓰지 않을 때 (잠금 밖에서 수량·평단을 직접 고친 해외 종목) */
const MANUAL_KRW_NOTE =
  "직접 고친 수량·평단으로 평가 중이라, 원화 매입금액은 다음 토스 동기화 뒤에 쓰입니다 (설정 → 토스증권 연동 → 지금 계좌 동기화). 동기화하면 수량·평단도 토스 계좌 값으로 돌아갑니다.";

/** 소수 주식 계산의 0.30000000000000004 같은 꼬리 제거 (소수 6자리) */
const roundQty = (q: number) => Math.round(q * 1e6) / 1e6;
/** 달러 평단: 부동소수 꼬리(188.12339000000003)만 지우고 동전주의 작은 자리(0.0001234)는 자르지 않는다 (유효숫자 12자리) */
const roundUsdAvg = (n: number) => Number(n.toPrecision(12));

/**
 * 매수: 수량 가중 평균으로 평단 재계산. 매도: 수량만 줄고 평단은 유지.
 * 수량은 저장할 값 그대로(꼬리 제거) 돌려준다 — 미리보기와 저장값이 같게 (BH-70).
 * 평단은 국내 소수 2자리, 미국은 꼬리만 지운 값 — 센트나 소수 몇 자리로 자르면 1달러 미만 종목의 매입금액이 몇 %씩 틀어진다 (BH-55)
 */
export function applyTrade(
  current: { quantity: number | null; avgPrice: number | null },
  side: "buy" | "sell",
  qty: number,
  price: number,
  currency: "KRW" | "USD" = "KRW",
): { quantity: number; avgPrice: number | null } {
  const q0 = current.quantity ?? 0;
  const a0 = current.avgPrice ?? 0;
  if (side === "buy") {
    const total = q0 + qty;
    const avg = q0 > 0 && current.avgPrice !== null ? (q0 * a0 + qty * price) / total : price;
    return { quantity: roundQty(total), avgPrice: currency === "USD" ? roundUsdAvg(avg) : Math.round(avg * 100) / 100 };
  }
  const q = roundQty(Math.max(0, q0 - qty));
  return { quantity: q, avgPrice: q === 0 ? null : current.avgPrice };
}

/** 거래 후 수량 표기: 자리 구분, 소수 주식은 소수 6자리까지 (저장값과 같은 자리) */
function formatQty(q: number): string {
  return q.toLocaleString("ko-KR", { maximumFractionDigits: 6 });
}

/**
 * 거래 후 평단 표기. 1달러 미만 미국 종목은 센트 아래 자리까지 유효숫자 4자리("$0.05745"·"$0.0001234") —
 * 센트로 줄이면 저장할 평단이 "$0.00" 으로 보인다 (BH-55). 그 밖에는 평소 가격 표기
 */
function formatTradeAvg(avg: number, cur: "KRW" | "USD"): string {
  if (cur !== "USD" || !(avg > 0) || avg >= 1) return formatPrice(avg, cur);
  const digits = Math.min(10, Math.max(2, 3 - Math.floor(Math.log10(avg))));
  // 소수 둘째 자리 뒤의 끝 0 은 뺀다 ("0.5000" → "0.50")
  return `$${avg.toFixed(digits).replace(/(\.\d\d\d*?)0+$/, "$1")}`;
}

function EditForm({ stock }: { stock: RegisteredStock & { evaluation?: Evaluation | null } }) {
  const t = useTheme();
  const api = useApi();
  const qc = useQueryClient();
  const { apiUrl } = useSettings();
  const { update, remove } = useStockMutations();
  const ev = stock.evaluation ?? null;
  const [krw, setKrwCost] = useDraft(ev?.costBasisKrw && ev.krwCostSource === "exact" ? String(Math.round(ev.costBasisKrw)) : "", normNum);
  const krwCost = krw.value;
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
      const skip = r.skipped.find((x) => x.code === stock.code);
      // manual: 서버가 값은 두었지만 직접 고친 수량·평단으로 평가 중이라 지금 원화 손익에는 쓰지 않는다 (PF-05)
      const deferred = !r.applied.includes(stock.code) && skip?.reason === "manual";
      if (!r.applied.includes(stock.code) && !deferred) throw new Error(skipMessage(skip));
      await qc.invalidateQueries({ queryKey: [apiUrl, "stocks"] });
      await qc.invalidateQueries({ queryKey: [apiUrl, "stock", stock.code] });
      if (deferred) Alert.alert("저장됨 (동기화 뒤 적용)", MANUAL_KRW_NOTE);
      else Alert.alert("저장됨", "원화 손익이 토스 앱과 같은 기준으로 계산됩니다.");
    } catch (e) {
      Alert.alert("저장 실패", e instanceof Error ? e.message : String(e));
    } finally {
      setSavingKrw(false);
    }
  };
  const cur = isUsMarket(stock.market) ? "USD" : "KRW";
  const locked = stock.tossSynced === true;
  const initial = { quantity: qtyText(stock.quantity), avgPrice: avgText(stock.avgPrice, cur) };
  const [qtyDraft, setQuantity] = useDraft(initial.quantity, normNum);
  const [avgDraft, setAvgPrice] = useDraft(initial.avgPrice, normNum);
  const [memoDraft, setMemo] = useDraft(stock.memo ?? "", normText);
  // 토스 종목은 수량·평단을 저장하지 않는다 → 고치다 잠긴 칸도 서버 값을 보인다
  const quantity = locked ? initial.quantity : qtyDraft.value;
  const avgPrice = locked ? initial.avgPrice : avgDraft.value;
  const memo = memoDraft.value;
  const stale = memoDraft.stale || (!locked && (qtyDraft.stale || avgDraft.stale));
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [tradeQty, setTradeQty] = useState("");
  const [tradePrice, setTradePrice] = useState("");

  const num = parseNum;

  /** 바꾼 칸만 보낸다 (메모만 고치면 수량·평단은 그대로). 토스 종목은 메모만 */
  const save = (changes: HoldingPatch = holdingPatch(initial, { quantity, avgPrice })) => {
    const patch = locked ? {} : changes;
    if ("error" in patch) {
      Alert.alert("입력 확인", patch.error);
      return;
    }
    update.mutate(
      { code: stock.code, ...patch, memo: memo.trim() || null },
      {
        onSuccess: () => router.back(),
        onError: (e) => {
          Alert.alert("저장 실패", e instanceof Error ? e.message : String(e));
          // 토스 연동으로 막혔으면 최신 상태(잠김)로 다시 그린다
          if (e instanceof ApiRequestError && e.code === "TOSS_LOCKED") void qc.invalidateQueries({ queryKey: [apiUrl, "stock", stock.code] });
        },
      },
    );
  };

  const preview = (() => {
    const q = num(tradeQty), p = num(tradePrice);
    if (q === null || p === null || !(q > 0) || !(p > 0)) return null;
    if (side === "sell" && q > (num(quantity) ?? 0)) return { error: "보유 수량보다 많이 매도할 수 없습니다" as const };
    // 평단 칸을 고치지 않았으면 화면에 줄여 보인 값이 아니라 저장된 원래 값으로 계산한다
    const avg0 = avgPrice.trim() === initial.avgPrice.trim() ? stock.avgPrice : num(avgPrice);
    return applyTrade({ quantity: num(quantity), avgPrice: avg0 }, side, q, p, cur);
  })();

  /**
   * 체결을 반영해 바로 저장 (예전: 위 칸에 반영 → 저장, 2단계). 수량·평단은 미리보기에 보인 값 그대로 (applyTrade 가 자리를 맞춤).
   * 칸 글자가 아니라 서버의 원래 값과 숫자로 비교한다 — 새 평단이 칸의 줄인 글자("0.05")와 같아도 빠뜨리지 않게 (BH-55)
   */
  const saveTrade = () => {
    if (!preview || "error" in preview) return;
    save(tradePatch(stock, preview));
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
            <Text style={{ color: t.ink, fontSize: font.small, fontWeight: "600" }}>토스 계좌 기준 · 자동으로 맞춤</Text>
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
        {stale ? <Text style={[styles.label, { color: t.warn }]}>{STALE_NOTE}</Text> : null}
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
            <TextInput value={krwCost} onChangeText={setKrwCost} accessibilityLabel="원화 매입금액" placeholder="예: 24557187" placeholderTextColor={t.muted} keyboardType="numeric" style={[styles.field, { color: t.ink, borderColor: t.line, backgroundColor: t.surfaceAlt }]} />
            <Button title="저장" accessibilityLabel="원화 매입금액 저장" variant="secondary" onPress={() => void saveKrwCost()} loading={savingKrw} />
          </View>
          {krw.stale ? <Text style={[styles.label, { color: t.warn }]}>{STALE_NOTE}</Text> : null}
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
          <TextInput value={tradeQty} onChangeText={setTradeQty} accessibilityLabel={`${side === "buy" ? "매수" : "매도"} 수량`} placeholder="수량 (주)" placeholderTextColor={t.muted} keyboardType="numeric" style={[styles.field, { color: t.ink, borderColor: t.line, backgroundColor: t.surfaceAlt }]} />
          <TextInput value={tradePrice} onChangeText={setTradePrice} accessibilityLabel={`${side === "buy" ? "매수" : "매도"} 체결가`} placeholder={cur === "USD" ? "체결가 ($)" : "체결가 (원)"} placeholderTextColor={t.muted} keyboardType="numeric" style={[styles.field, { color: t.ink, borderColor: t.line, backgroundColor: t.surfaceAlt }]} />
        </View>
        {preview && "error" in preview ? <Text style={{ color: t.danger, fontSize: font.small }}>{preview.error}</Text> : null}
        {preview && !("error" in preview) ? (
          <View>
            <Row label="거래 후 수량" value={`${formatQty(preview.quantity)}주`} />
            <Row label="거래 후 평단" value={preview.avgPrice !== null ? formatTradeAvg(preview.avgPrice, cur) : "-"} />
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
  col: { flex: 1, gap: space.xs },
  inCol: { flexGrow: 0, flexBasis: "auto" },
  label: { fontSize: font.tiny },
  lockNote: { borderRadius: radius.sm, padding: space.md, gap: space.xxs },
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
