import React from "react";
import type { LayoutChangeEvent } from "react-native";
import type { RegisteredWithQuote } from "@/api/types";
import { sentence, speakAmount, speakProfit, stockRowLabel } from "@/lib/a11y";
import { formatArrowDisplay, formatMoney, formatPct, formatPrice, formatQuoteDisplay, isUsMarket, shownSign } from "@/lib/format";
import type { ColKey, ColumnPlan } from "@/lib/holdingsColumns";
import { evalView } from "@/lib/liveTick";
import { isHolding } from "@/lib/portfolio";
import { changeColor, useTheme } from "@/theme";
import { TableLine, type TableCell } from "./HoldingsTable";
import { LINE_COL, LineMark, LineValue, StockLine, type LinePrice } from "./StockLine";

/**
 * 잔고·관심 표의 한 줄 (공용 StockLine, 3-21).
 *  보유:  종목명 / 수량·평단  |  현재가 / 등락률  |  평가손익 / 수익률
 *  관심:  종목명 / 코드       |  현재가 / 등락률  |  전일대비 / 거래량
 * showKrw 면 미국 종목 금액을 원화로 환산한다. 길게 누르면 수정·삭제.
 * columns 를 주면 넓은 창의 한 줄 표 (3-42 웨이브 B, 기능 플래그 foldLayout — components/HoldingsTable):
 *  보유:  종목 | 현재가 · 등락률 ‖ 평가손익 · 수익률 ‖ 당일손익 · 평가금액 · 비중 · 평단 · 수량 (열은 창 폭·글자 크기에 따라)
 *  관심:  종목 | 현재가 · 등락률 ‖ 전일대비 · 거래량
 *  금액은 휴대폰 줄과 같은 기준·같은 표기 함수(부호·색은 보이는 값으로 — BH-38). 미국 종목은 설정 '원화로 보기'를 따른다 (기본 달러).
 *  화면 읽기 문장은 휴대폰 줄 문장에 당일손익·평가금액·비중을 덧붙인다.
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
  /** 넓은 창 한 줄 표의 열 (lib/holdingsColumns pickCols·pickWatchCols). 주지 않으면 휴대폰 줄 그대로 */
  columns?: ColumnPlan | null;
  /** 줄무늬 (짝수 줄 바탕) — 한 줄 표에서만 */
  zebra?: boolean;
  /** 비중 % (소수 첫째 자리, lib/holdingsColumns holdingWeights). 한 줄 표에서만 */
  weight?: number | null;
  /** 가장 큰 비중 (막대 길이 기준) */
  weightMax?: number;
  /** 줄 위치 (접고 펼 때 이어 보기 — lib/holdingsAnchor). 기능이 꺼져 있으면 주지 않는다 */
  onLayoutRow?: (stock: RegisteredWithQuote, y: number, h: number) => void;
};

/**
 * 다시 그릴지: 종목 객체(체결이 오면 그 종목만 새 객체)·표시 설정·누름 처리 함수·초록 점이 같으면 그대로 (3-17).
 * 한 줄 표: 열 계획(같은 폭이면 같은 객체)·줄무늬·비중(반올림한 값)도 같으면 그대로 — 체결마다 총액이 조금 바뀌어도 보이는 비중이 같으면 다시 그리지 않는다
 */
export function sameRow(a: StockRowProps, b: StockRowProps): boolean {
  return (
    a.stock === b.stock &&
    a.showKrw === b.showKrw &&
    a.afterCost === b.afterCost &&
    a.onPress === b.onPress &&
    a.onLongPress === b.onLongPress &&
    a.live === b.live &&
    a.columns === b.columns &&
    a.zebra === b.zebra &&
    a.weight === b.weight &&
    a.weightMax === b.weightMax &&
    a.onLayoutRow === b.onLayoutRow
  );
}

/** 체결이 온 줄만 다시 그린다: 부르는 쪽은 onPress·onLongPress 를 안정된 함수(종목을 인자로 받음)로 넘긴다 */
export const StockRow = React.memo(StockRowView, sameRow);

/** 한 줄 표의 금액: 원화는 단위 없이("1,576,274"), 달러는 "$" 를 붙인다 (국내·미국 줄이 한 열에 섞이므로) */
const cellMoney = (text: string) => text.replace("원", "");

function StockRowView({ stock, onPress, onLongPress, showKrw, afterCost = true, live: liveProp, columns, zebra = false, weight = null, weightMax = 0, onLayoutRow }: StockRowProps) {
  const t = useTheme();
  const q = stock.quote;
  const live = liveProp ?? q?.live === true;
  const us = isUsMarket(stock.market);
  // 첫 시세를 아직 못 받았으면 시장으로 통화를 정한다 (미국 종목 평단이 원화로 보이지 않게)
  const cur = q ? q.currency : us ? "USD" : "KRW";
  const fx = q?.fxRate ?? (q?.priceKrw && q.price ? q.priceKrw / q.price : null);
  const ev = evalView(stock.evaluation, { afterCost, toKrw: showKrw, currency: cur, fx });
  // 보유: 수량이 있으면 평단·시세가 없어 평가가 없어도 보유 줄 (BH-26 · BH-30). 평가가 없으면 손익 칸에 "합계 제외"
  const held = isHolding(stock);
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
  const krwAvg = showKrw && cur === "USD" && ev?.currency === "KRW" && stock.quantity ? formatPrice(ev.costBasis / stock.quantity, "KRW") : null;
  const avgText = stock.avgPrice === null ? "평단 없음" : (krwAvg ?? formatQuoteDisplay(stock.avgPrice, cur, fx, showKrw));
  // 화면 읽기: 줄 전체를 한 문장으로 (3-22). 금액은 단위를 붙여 읽는다
  const label = stockRowLabel({
    name: stock.name,
    us,
    holding: held
      ? {
          quantity: formatQty(stock.quantity),
          avg: stock.avgPrice === null ? "없음" : (krwAvg ?? formatMoney(stock.avgPrice, cur, fx, showKrw)),
          profit: ev ? formatPrice(ev.profit, ev.currency) : "-",
          profitSign,
          profitRate: ev ? ev.profitRate : null,
        }
      : null,
    price: q ? { text: formatMoney(q.price, cur, fx, showKrw), changeRate: q.changeRate, live } : null,
    missing: stock.quoteError ? "시세 없음" : undefined,
    move: q ? { text: moveText, sign: shownSign(q.change, moveText) } : null,
    volume: formatVol(q?.volume),
    note: held && !ev ? EXCLUDED : undefined,
  });
  const badge = <LineMark label={us ? "US" : "KR"} color={us ? t.accent : t.gold} />;
  const layoutProp = onLayoutRow ? (e: LayoutChangeEvent) => onLayoutRow(stock, e.nativeEvent.layout.y, e.nativeEvent.layout.height) : undefined;
  const a11yActions = onLongPress ? LONG_PRESS_ACTION : undefined;
  const a11yAction = onLongPress ? (name: string) => name === "longpress" && onLongPress(stock) : undefined;

  if (columns) {
    const rateColor = changeColor(t, shownSign(q?.changeRate, rateText));
    const cells: Partial<Record<ColKey, TableCell>> = {};
    if (q) cells.rate = { text: rateText, color: rateColor };
    let extra: (string | null)[] = [];
    if (held) {
      if (ev) {
        // 당일손익 = 전일 대비 × 수량 (계좌 띠 당일손익과 같은 기준). 미국 종목은 설정대로 달러 또는 원화
        const dayN = q ? q.change * (stock.quantity ?? 0) : null;
        const dayText = q ? formatMoney(dayN, cur, fx, showKrw, { sign: true }) : "-";
        const daySign = shownSign(dayN, dayText);
        const valueText = formatPrice(ev.marketValue, ev.currency);
        cells.profit = { text: cellMoney(profitText), color: pc, strong: true };
        cells.profitRate = { text: profitRateText, color: rc };
        if (q) cells.day = { text: cellMoney(dayText), color: changeColor(t, daySign) };
        cells.value = { text: cellMoney(valueText), color: t.ink };
        extra = [
          q ? `당일손익 ${speakProfit(dayText, daySign) ?? "없음"}` : null,
          `평가금액 ${speakAmount(valueText)}`,
          weight !== null ? `비중 ${weight.toFixed(1)}%` : null,
        ];
      } else {
        cells.profit = { text: "-", color: t.muted };
        cells.profitRate = { text: EXCLUDED, color: t.muted, note: true };
      }
      cells.avg = { text: stock.avgPrice === null ? "없음" : cellMoney(krwAvg ?? formatMoney(stock.avgPrice, cur, fx, showKrw)), color: t.sub };
      cells.qty = { text: formatQty(stock.quantity), color: t.sub };
    } else if (q) {
      cells.move = { text: arrowText, color: changeColor(t, shownSign(q.change, arrowText)) };
      const vol = formatVol(q.volume);
      if (vol) cells.volume = { text: vol, color: t.sub };
    }
    return (
      <TableLine
        plan={columns}
        zebra={zebra}
        name={stock.name}
        badge={badge}
        price={q ? { value: q.price, text: cellMoney(formatMoney(q.price, cur, fx, showKrw)), color: c, live } : null}
        priceMissing={stock.quoteError ? "시세 없음" : "-"}
        cells={cells}
        weight={held && ev ? { pct: weight, rel: weightMax > 0 && weight !== null ? weight / weightMax : 0, color: us ? t.chart.pie[1]! : t.chart.pie[0]! } : null}
        onPress={() => onPress(stock)}
        onLongPress={onLongPress ? () => onLongPress(stock) : undefined}
        onLayout={layoutProp}
        accessibilityLabel={sentence([label, ...extra])}
        accessibilityActions={a11yActions}
        onAccessibilityAction={a11yAction}
      />
    );
  }

  const price: LinePrice | null = q
    ? { value: q.price, text: formatQuoteDisplay(q.price, cur, fx, showKrw), color: c, rate: rateText, rateColor: changeColor(t, shownSign(q.changeRate, rateText)), live }
    : null;
  return (
    <StockLine
      name={stock.name}
      nameBadge={badge}
      sub={held ? `${formatQty(stock.quantity)}주 · ${avgText}` : stock.code}
      price={price}
      priceMissing={stock.quoteError ? "시세 없음" : "-"}
      right={
        held && !ev ? (
          <LineValue main="-" mainColor={t.muted} sub={EXCLUDED} />
        ) : !q ? null : ev ? (
          <LineValue main={profitText.replace("원", "")} mainColor={pc} sub={profitRateText} subColor={rc} />
        ) : (
          <LineValue main={arrowText} mainColor={changeColor(t, shownSign(q.change, arrowText))} sub={formatVol(q.volume)} />
        )
      }
      onPress={() => onPress(stock)}
      onLongPress={onLongPress ? () => onLongPress(stock) : undefined}
      onLayout={layoutProp}
      accessibilityLabel={label}
      accessibilityActions={a11yActions}
      onAccessibilityAction={a11yAction}
    />
  );
}

/** 평가가 없는 보유 종목(평단·시세 없음)의 손익 칸: 계좌 합계에서 빠졌음을 알린다 */
const EXCLUDED = "합계 제외";

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
