import React, { memo } from "react";
import type { DiscoverStock } from "@/api/types";
import { LINE_COL, LINE_H, LineMark, LineValue, StockLine } from "@/components/StockLine";
import { formatKrwCompact, formatPct, formatQuoteDisplay, formatVolume } from "@/lib/format";
import { changeColor, useTheme } from "@/theme";

/** 발견 목록 한 줄의 높이 (FlatList getItemLayout 용) */
export const DISCOVER_ROW_H = LINE_H;
export const DISCOVER_COL = LINE_COL;

export type HoldingMark = "보유" | "관심" | null;

/**
 * 순위·테마 종목 한 줄 (증권사 순위 화면처럼 4열):
 *  순위 | 종목명 / 코드·보유·관심 | 현재가 / 등락률 | 거래대금(또는 거래량) / 보조 값
 * 누르면 종목 상세, 길게 누르면 관심 추가. showKrw 면 미국 종목 금액을 원화로 환산한다.
 */
export const DiscoverRow = memo(function DiscoverRow({
  item,
  rank,
  metric,
  mark,
  showKrw,
  fxRate,
  onPress,
  onLongPress,
}: {
  item: DiscoverStock;
  rank?: number;
  /** 오른쪽 열에 보일 값 */
  metric: "tradingValue" | "volume";
  mark: HoldingMark;
  showKrw: boolean;
  fxRate: number | null | undefined;
  onPress: (item: DiscoverStock) => void;
  onLongPress?: (item: DiscoverStock) => void;
}) {
  const t = useTheme();
  const c = changeColor(t, item.change);
  const usd = item.currency === "USD";
  // 거래정지는 출처 표시로만 (거래량 0 이어도 거래 가능한 코넥스 종목·장 시작 전 목록이 있다)
  const suspended = item.suspended === true;
  const krw = usd && showKrw && !!fxRate;
  const tv = item.tradingValue;
  const main =
    metric === "volume"
      ? formatVolume(item.volume)
      : tv === null
        ? "-"
        : krw
          ? formatKrwCompact(tv * fxRate!, "KRW")
          : formatKrwCompact(tv, usd ? "USD" : "KRW");
  // 보조 값: 거래대금 열이면 거래량, 거래량 열이면 거래대금
  const sub =
    metric === "volume"
      ? tv === null
        ? ""
        : krw
          ? formatKrwCompact(tv * fxRate!, "KRW")
          : formatKrwCompact(tv, usd ? "USD" : "KRW")
      : item.volume === null
        ? ""
        : `${formatVolume(item.volume)}주`;
  return (
    <StockLine
      rank={rank}
      name={item.name}
      sub={item.code}
      badges={
        <>
          {mark ? <LineMark label={mark} color={mark === "보유" ? t.gold : t.accent} /> : null}
          {item.newlyListed ? <LineMark label="신규상장" color={t.muted} /> : null}
          {suspended ? <LineMark label="거래정지" color={t.muted} /> : null}
        </>
      }
      price={{ value: item.price, text: formatQuoteDisplay(item.price, item.currency, fxRate, showKrw), color: c, rate: formatPct(item.changeRate), rateColor: c }}
      right={<LineValue main={main} mainColor={t.ink} sub={sub} />}
      onPress={() => onPress(item)}
      onLongPress={onLongPress ? () => onLongPress(item) : undefined}
      accessibilityLabel={`${rank ? `${rank}위 ` : ""}${item.name} ${formatPct(item.changeRate)}`}
    />
  );
});
