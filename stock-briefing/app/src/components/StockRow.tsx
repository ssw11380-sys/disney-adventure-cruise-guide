import React from "react";
import type { RegisteredWithQuote } from "@/api/types";
import { stockRowLabel } from "@/lib/a11y";
import { formatArrowDisplay, formatMoney, formatPct, formatPrice, formatQuoteDisplay, isUsMarket, shownSign } from "@/lib/format";
import { evalView } from "@/lib/liveTick";
import { changeColor, useTheme } from "@/theme";
import { LINE_COL, LineMark, LineValue, StockLine, type LinePrice } from "./StockLine";

/**
 * 잔고·관심 표의 한 줄 (공용 StockLine, 3-21).
 *  보유:  종목명 / 수량·평단  |  현재가 / 등락률  |  평가손익 / 수익률
 *  관심:  종목명 / 코드       |  현재가 / 등락률  |  전일대비 / 거래량
 * showKrw 면 미국 종목 금액을 원화로 환산한다. 길게 누르면 수정·삭제.
 */
export const COL = LINE_COL;

type StockRowProps = {
  stock: RegisteredWithQuote;
  onPress: (stock: RegisteredWithQuote) => void;
  onLongPress?: (stock: RegisteredWithQuote) => void;
  showKrw: boolean;
  afterCost?: boolean;
  /**
   * 초록 점: 이 종목 가격이 지금 열린 세션에서 실시간으로 갱신되고 있음. 부르는 쪽이 lib/liveDot quoteLive(시세, 시각, 앱 수신 상태)로 정해 넘긴다
   * (시각은 그릴 때 읽지 않는다 — 점이 바뀐 줄만 다시 그리게). 주지 않으면 예전처럼 시세의 live
   */
  live?: boolean;
};

/** 다시 그릴지: 종목 객체(체결이 오면 그 종목만 새 객체)·표시 설정·누름 처리 함수·초록 점이 같으면 그대로 (3-17) */
export function sameRow(a: StockRowProps, b: StockRowProps): boolean {
  return a.stock === b.stock && a.showKrw === b.showKrw && a.afterCost === b.afterCost && a.onPress === b.onPress && a.onLongPress === b.onLongPress && a.live === b.live;
}

/** 체결이 온 줄만 다시 그린다: 부르는 쪽은 onPress·onLongPress 를 안정된 함수(종목을 인자로 받음)로 넘긴다 */
export const StockRow = React.memo(StockRowView, sameRow);

function StockRowView({ stock, onPress, onLongPress, showKrw, afterCost = true, live: liveProp }: StockRowProps) {
  const t = useTheme();
  const q = stock.quote;
  const live = liveProp ?? q?.live === true;
  const cur = q?.currency;
  const fx = q?.fxRate ?? (q?.priceKrw && q.price ? q.priceKrw / q.price : null);
  const ev = evalView(stock.evaluation, { afterCost, toKrw: showKrw, currency: cur, fx });
  const us = isUsMarket(stock.market);
  const held = !!ev;
  // 현재가 색은 전일 대비 방향 그대로 (1센트 미만 등락의 동전주도 위젯처럼 방향 색)
  const c = changeColor(t, q?.change);
  // 등락·손익 글자의 부호·색은 그 글자에 보이는 값으로 — "0"·"$0.00"·"0.00%" 로 보이는 값을 손실·이익 색으로 칠하지 않게 (BH-38)
  const rateText = q ? formatPct(q.changeRate) : "";
  const arrowText = q ? formatArrowDisplay(q.change, cur, fx, showKrw) : "";
  const moveText = q ? formatMoney(q.change, cur, fx, showKrw) : "";
  const profitText = ev ? formatPrice(ev.profit, ev.currency, { sign: true }) : "";
  const profitRateText = ev ? formatPct(ev.profitRate) : "";
  const profitSign = ev ? shownSign(ev.profit, profitText) : 0;
  const pc = changeColor(t, profitSign);
  const rc = changeColor(t, ev ? shownSign(ev.profitRate, profitRateText) : 0);
  // 원화 보기의 미국 종목 평단은 손익과 같은 기준(매수 당시 환율의 원화 매입금액 ÷ 수량)으로
  const avgText =
    showKrw && cur === "USD" && ev?.currency === "KRW" && stock.quantity
      ? formatPrice(ev.costBasis / stock.quantity, "KRW")
      : formatQuoteDisplay(stock.avgPrice, cur, fx, showKrw);
  // 화면 읽기: 줄 전체를 한 문장으로 (3-22). 금액은 단위를 붙여 읽는다
  const label = stockRowLabel({
    name: stock.name,
    us,
    holding: ev
      ? {
          quantity: formatQty(stock.quantity),
          avg: showKrw && cur === "USD" && ev.currency === "KRW" && stock.quantity ? formatPrice(ev.costBasis / stock.quantity, "KRW") : formatMoney(stock.avgPrice, cur, fx, showKrw),
          profit: formatPrice(ev.profit, ev.currency),
          profitSign,
          profitRate: ev.profitRate,
        }
      : null,
    price: q ? { text: formatMoney(q.price, cur, fx, showKrw), changeRate: q.changeRate, live } : null,
    missing: stock.quoteError ? "시세 없음" : undefined,
    move: q ? { text: moveText, sign: shownSign(q.change, moveText) } : null,
    volume: formatVol(q?.volume),
  });
  const price: LinePrice | null = q
    ? { value: q.price, text: formatQuoteDisplay(q.price, cur, fx, showKrw), color: c, rate: rateText, rateColor: changeColor(t, shownSign(q.changeRate, rateText)), live }
    : null;
  return (
    <StockLine
      name={stock.name}
      nameBadge={<LineMark label={us ? "US" : "KR"} color={us ? t.accent : t.gold} />}
      sub={held ? `${formatQty(stock.quantity)}주 · ${avgText}` : stock.code}
      price={price}
      priceMissing={stock.quoteError ? "시세 없음" : "-"}
      right={
        !q ? null : held ? (
          <LineValue main={profitText.replace("원", "")} mainColor={pc} sub={profitRateText} subColor={rc} />
        ) : (
          <LineValue main={arrowText} mainColor={changeColor(t, shownSign(q.change, arrowText))} sub={formatVol(q.volume)} />
        )
      }
      onPress={() => onPress(stock)}
      onLongPress={onLongPress ? () => onLongPress(stock) : undefined}
      accessibilityLabel={label}
      accessibilityActions={onLongPress ? LONG_PRESS_ACTION : undefined}
      onAccessibilityAction={onLongPress ? (name) => name === "longpress" && onLongPress(stock) : undefined}
    />
  );
}

/** 화면 읽기의 길게 누르기 안내를 "수정·삭제"로 (TalkBack 이 "두 번 탭하고 길게 눌러 수정·삭제"라고 읽는다) */
const LONG_PRESS_ACTION = [{ name: "longpress", label: "수정·삭제" }];

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
