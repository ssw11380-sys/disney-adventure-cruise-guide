import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { RegisteredWithQuote } from "@/api/types";
import { formatArrowDisplay, formatPct, formatPrice, formatQuoteDisplay, isUsMarket } from "@/lib/format";
import { evalView } from "@/lib/liveTick";
import { changeColor, font, space, useTheme } from "@/theme";
import { FlashPrice } from "./FlashPrice";

/**
 * 잔고·관심 표의 한 줄 (증권사 잔고 화면처럼 3열).
 *  보유:  종목명 / 수량·평단  |  현재가 / 등락률  |  평가손익 / 수익률
 *  관심:  종목명 / 코드       |  현재가 / 등락률  |  전일대비 / 거래량
 * showKrw 면 미국 종목 금액을 원화로 환산한다. 길게 누르면 수정·삭제.
 */
export const COL = { price: 96, right: 108 } as const;

type StockRowProps = { stock: RegisteredWithQuote; onPress: (stock: RegisteredWithQuote) => void; onLongPress?: (stock: RegisteredWithQuote) => void; showKrw: boolean; afterCost?: boolean };

/** 다시 그릴지: 종목 객체(체결이 오면 그 종목만 새 객체)·표시 설정·누름 처리 함수가 같으면 그대로 (3-17) */
export function sameRow(a: StockRowProps, b: StockRowProps): boolean {
  return a.stock === b.stock && a.showKrw === b.showKrw && a.afterCost === b.afterCost && a.onPress === b.onPress && a.onLongPress === b.onLongPress;
}

/** 체결이 온 줄만 다시 그린다: 부르는 쪽은 onPress·onLongPress 를 안정된 함수(종목을 인자로 받음)로 넘긴다 */
export const StockRow = React.memo(StockRowView, sameRow);

function StockRowView({ stock, onPress, onLongPress, showKrw, afterCost = true }: StockRowProps) {
  const t = useTheme();
  const q = stock.quote;
  const cur = q?.currency;
  const fx = q?.fxRate ?? (q?.priceKrw && q.price ? q.priceKrw / q.price : null);
  const ev = evalView(stock.evaluation, { afterCost, toKrw: showKrw, currency: cur, fx });
  const us = isUsMarket(stock.market);
  const held = !!ev;
  const c = changeColor(t, q?.change);
  const pc = changeColor(t, ev?.profit);
  // 원화 보기의 미국 종목 평단은 손익과 같은 기준(매수 당시 환율의 원화 매입금액 ÷ 수량)으로
  const avgText =
    showKrw && cur === "USD" && ev?.currency === "KRW" && stock.quantity
      ? formatPrice(ev.costBasis / stock.quantity, "KRW")
      : formatQuoteDisplay(stock.avgPrice, cur, fx, showKrw);
  return (
    <Pressable
      onPress={() => onPress(stock)}
      onLongPress={onLongPress ? () => onLongPress(stock) : undefined}
      delayLongPress={350}
      accessibilityRole="button"
      style={({ pressed }) => [styles.row, { backgroundColor: pressed ? t.surfaceAlt : t.surface, borderBottomColor: t.line }]}
    >
      <View style={styles.name}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
          <Text style={[styles.mkt, { color: us ? t.accent : t.gold, borderColor: us ? t.accent : t.gold }]}>{us ? "US" : "KR"}</Text>
          <Text style={{ color: t.ink, fontSize: font.body, fontWeight: "600", flexShrink: 1 }} numberOfLines={1}>
            {stock.name}
          </Text>
        </View>
        <Text style={styles.subText(t.muted)} numberOfLines={1}>
          {held ? `${formatQty(stock.quantity)}주 · ${avgText}` : stock.code}
        </Text>
      </View>

      {q ? (
        <>
          <View style={[styles.num, { width: COL.price }]}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
              {q.live ? <View style={[styles.live, { backgroundColor: c === t.ink ? t.muted : c }]} /> : null}
              <FlashPrice value={q.price} text={formatQuoteDisplay(q.price, cur, fx, showKrw)} style={[styles.main, { color: c }]} />
            </View>
            <Text style={[styles.sub, { color: c }]}>{formatPct(q.changeRate)}</Text>
          </View>
          <View style={[styles.num, { width: COL.right }]}>
            {held ? (
              <>
                <Text style={[styles.main, { color: pc }]} numberOfLines={1} adjustsFontSizeToFit>
                  {formatPrice(ev!.profit, ev!.currency, { sign: true }).replace("원", "")}
                </Text>
                <Text style={[styles.sub, { color: pc }]}>{formatPct(ev!.profitRate)}</Text>
              </>
            ) : (
              <>
                <Text style={[styles.main, { color: c }]} numberOfLines={1}>
                  {formatArrowDisplay(q.change, cur, fx, showKrw)}
                </Text>
                <Text style={[styles.sub, { color: t.muted }]}>{formatVol(q.volume)}</Text>
              </>
            )}
          </View>
        </>
      ) : (
        <View style={[styles.num, { width: COL.price + COL.right }]}>
          <Text style={{ color: t.muted, fontSize: font.small }}>{stock.quoteError ? "시세 없음" : "-"}</Text>
        </View>
      )}
    </Pressable>
  );
}

function formatQty(n: number | null): string {
  if (n === null) return "-";
  return Number.isInteger(n) ? n.toLocaleString("ko-KR") : n.toLocaleString("ko-KR", { maximumFractionDigits: 4 });
}

function formatVol(n: number | null | undefined): string {
  if (!n) return "";
  if (n >= 1e8) return `${(n / 1e8).toFixed(1)}억주`;
  if (n >= 1e4) return `${Math.round(n / 1e4).toLocaleString("ko-KR")}만주`;
  return `${n.toLocaleString("ko-KR")}주`;
}

const styles = {
  ...StyleSheet.create({
    row: { flexDirection: "row", alignItems: "center", paddingHorizontal: space.lg, paddingVertical: 9, borderBottomWidth: StyleSheet.hairlineWidth, minHeight: 52 },
    name: { flex: 1, gap: 2, paddingRight: space.sm },
    mkt: { fontSize: 9, fontWeight: "800", borderWidth: 1, borderRadius: 2, paddingHorizontal: 3, lineHeight: 12, overflow: "hidden" },
    num: { alignItems: "flex-end", gap: 2 },
    main: { fontSize: font.body, fontWeight: "700", fontVariant: ["tabular-nums"] },
    sub: { fontSize: font.small, fontVariant: ["tabular-nums"] },
    live: { width: 4, height: 4, borderRadius: 2 },
  }),
  subText: (color: string) => ({ color, fontSize: font.small, fontVariant: ["tabular-nums" as const] }),
};
