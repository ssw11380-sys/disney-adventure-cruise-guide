import React from "react";
import { StyleSheet, Text, View } from "react-native";
import type { Currency } from "@/api/types";
import { Button } from "@/components/ui";
import { sentence, speakAmount, speakProfit, speakRate } from "@/lib/a11y";
import { formatPct, formatPrice, formatQuote, shownSign } from "@/lib/format";
import type { Bucket as Totals } from "@/lib/portfolio";
import { changeColor, font, fontCap, layout, space, useTheme } from "@/theme";

/**
 * 잔고 계좌 요약의 숫자와 화면 읽기 문장 (휴대폰 계좌 패널과 넓은 창 계좌 띠가 같이 쓴다 — 같은 숫자·같은 문장).
 * 합계는 원화로(환율을 모르면 원화 종목만). 해외 줄은 설정 '원화로 보기'에 따라 달러 또는 원화
 */
export interface AccountData {
  total: Totals | null;
  byCur: Record<Currency, Totals>;
  usdInKrw: Totals;
  estimated: boolean;
  /** 원화 매입금액 장부가 없어 현재 환율로 환산한 해외 종목 수 */
  currentBasis: number;
  afterCost: boolean;
  showKrw: boolean;
  fx: number | null;
  /** 합계에서 뺀 보유 종목 안내 ("시세 없음 1종목 · 환율 없음 1종목 제외"). 없으면 null */
  excluded: string | null;
}

export interface AccountLine {
  label: "국내" | "해외";
  tot: Totals;
  cur: Currency;
}

export function accountFigures(d: AccountData) {
  const main = d.total ?? d.byCur.KRW;
  const profit = main.value - main.cost;
  const rate = main.cost > 0 ? (profit / main.cost) * 100 : 0;
  const lines: AccountLine[] = [];
  if (d.byCur.KRW.count) lines.push({ label: "국내", tot: d.byCur.KRW, cur: "KRW" });
  if (d.byCur.USD.count) lines.push(d.showKrw && d.usdInKrw.count === d.byCur.USD.count ? { label: "해외", tot: d.usdInKrw, cur: "KRW" } : { label: "해외", tot: d.byCur.USD, cur: "USD" });
  // 국내·해외 줄은 원화 종목만 있으면(총액과 같음) 보이지 않는다
  const showSplit = lines.length > 1 || lines[0]?.cur === "USD";
  return { main, profit, rate, lines, showSplit };
}

/** 국내·해외 줄의 손익·수익률 */
export function lineProfit(l: AccountLine): { p: number; r: number } {
  const p = l.tot.value - l.tot.cost;
  return { p, r: l.tot.cost > 0 ? (p / l.tot.cost) * 100 : 0 };
}

/** 화면 읽기: 계좌 요약을 한 문장으로 (3-22). 상태 줄(실시간·지연)은 따로 읽는다 */
export function accountSpeech(d: AccountData): string {
  const { main, profit, rate, lines, showSplit } = accountFigures(d);
  return sentence([
    `총 평가금액${d.total ? "" : " (원화 종목)"} ${speakAmount(formatPrice(main.value, "KRW"))}`,
    `평가손익 ${speakProfit(formatPrice(profit, "KRW"), Math.sign(profit)) ?? "없음"}`,
    speakRate(rate) ? `수익률 ${speakRate(rate)}` : null,
    `매입금액 ${speakAmount(formatPrice(main.cost, "KRW"))}`,
    `당일손익 ${speakProfit(formatPrice(main.day, "KRW"), Math.sign(main.day)) ?? "없음"}`,
    // 국내·해외 줄은 화면에 있을 때만 (그 줄 자체는 화면 읽기에서 숨겨 두 번 읽히지 않게)
    ...(showSplit
      ? lines.map((l) => {
          const { p, r } = lineProfit(l);
          return sentence([`${l.label} ${speakAmount(formatPrice(l.tot.value, l.cur))}`, speakProfit(formatPrice(p, l.cur), Math.sign(p)) ?? "손익 없음", speakRate(r)]);
        })
      : []),
  ]);
}

/** 환율 안내 (휴대폰 패널과 같은 말): 원화 손익 기준·추정·현재 환율 환산 종목 수 */
export function fxNote(d: AccountData): string | null {
  if (!d.fx) return null;
  return `토스 적용 환율 ${d.fx.toLocaleString("ko-KR", { maximumFractionDigits: 2 })}원 · 원화 손익은 매수 당시 환율 기준${d.estimated ? " (일부 추정)" : ""}${d.currentBasis ? ` · ${d.currentBasis}종목은 현재 환율 환산` : ""}`;
}

/**
 * 넓은 창 계좌 띠 (3-42 웨이브 B, 기능 플래그 foldLayout — 잔고 탭이 넓은 창에서만 쓴다).
 *  - 한 줄(oneLine, 펼친 폴드8 가로·울트라 펼침): 총 평가금액 | 평가손익·수익률 | 당일손익·% | 국내·% | 해외·환율·% | [비중]
 *  - 두 줄(펼친 폴드8 세로 704 · 큰 글씨): 총 평가금액 | 평가손익·수익률 | 당일손익·% / 국내 | 해외 | 매입금액 | [비중]
 * 숫자는 칸이 모자라면 말줄임 대신 글자를 줄여 한 줄에 다 보인다. 화면 읽기는 휴대폰 패널과 같은 한 문장 (칸 조각은 숨긴다),
 * '비중' 버튼은 문장 밖에 두어 따로 고를 수 있다
 */
export function AccountBand({ data, oneLine, pad, onAllocation }: { data: AccountData; oneLine: boolean; pad: number; onAllocation?: () => void }) {
  const t = useTheme();
  const { main, profit, rate, lines, showSplit } = accountFigures(data);
  const pc = changeColor(t, profit);
  const dayText = formatPrice(main.day, "KRW", { sign: true });
  const dc = changeColor(t, shownSign(main.day, dayText));
  // 당일 등락률: 당일손익 ÷ 전일 평가금액(지금 평가금액 − 당일손익)
  const prevValue = main.value - main.day;
  const dayRate = prevValue > 0 ? (main.day / prevValue) * 100 : null;
  const dayRateText = dayRate === null ? null : formatPct(dayRate);
  const total = (
    <Cell key="total" first label={`총 평가금액${data.total ? "" : " (원화 종목)"}${data.afterCost ? " · 비용 차감" : ""}`} value={formatQuote(main.value, "KRW")} unit="원" big />
  );
  const profitCell = <Cell key="profit" label="평가손익 · 수익률" value={formatPrice(profit, "KRW", { sign: true })} color={pc} sub={formatPct(rate)} subColor={pc} />;
  const day = <Cell key="day" label="당일손익" value={dayText} color={dc} sub={dayRateText} subColor={changeColor(t, dayRateText ? shownSign(dayRate, dayRateText) : 0)} />;
  // 국내·해외 칸 (firstAt0: 줄의 첫 칸이면 왼쪽 구분선 없음).
  // 한 줄 띠는 폭이 빠듯해 국내·해외 수익률을 뺀다 (울트라 펼침 세로 목업과 같음 — 화면 읽기 문장에는 그대로 있다)
  const split = (firstAt0: boolean, withRate: boolean) =>
    showSplit
      ? lines.map((l, i) => {
          const { p, r } = lineProfit(l);
          const rt = formatPct(r);
          const label = l.label === "해외" && data.fx ? `해외 · 환율 ${data.fx.toLocaleString("ko-KR", { maximumFractionDigits: 2 })}` : l.label;
          return <Cell key={l.label} first={firstAt0 && i === 0} label={label} value={formatPrice(l.tot.value, l.cur)} sub={withRate ? rt : null} subColor={changeColor(t, shownSign(p, rt))} />;
        })
      : null;
  const label = accountSpeech(data);
  const button = onAllocation ? (
    <View style={styles.action}>
      <Button title="비중" icon="pie-chart-outline" variant="secondary" compact accessibilityLabel="비중 보기" onPress={onAllocation} />
    </View>
  ) : null;
  const note = fxNote(data);
  // 합계에서 뺀 종목·원화 손익 추정은 띠 아래 한 줄로 알린다 (휴대폰 패널과 같은 말). 환율 값 자체는 해외 칸 이름에 있다
  const notes = data.excluded || data.estimated || data.currentBasis ? (
    <View style={[styles.notes, { paddingHorizontal: pad }]}>
      {data.excluded ? <Text style={{ color: t.warn, fontSize: font.tiny }}>{data.excluded}</Text> : null}
      {note && (data.estimated || data.currentBasis) ? <Text style={{ color: t.muted, fontSize: font.tiny }}>{note}</Text> : null}
    </View>
  ) : null;
  return (
    <View style={[styles.band, { backgroundColor: t.surface, borderBottomColor: t.line }]}>
      {oneLine ? (
        <View style={[styles.line, { paddingHorizontal: pad }]}>
          <View accessible accessibilityLabel={label} style={styles.cells}>
            {total}
            {profitCell}
            {day}
            {split(false, false)}
          </View>
          {button}
        </View>
      ) : (
        <>
          {/* 두 줄 띠는 큰 글씨에서 칸이 한 줄에 다 안 들어가면 줄여 자르지 않고 다음 줄로 넘긴다 (flexWrap) */}
          <View accessible accessibilityLabel={label} style={[styles.row1, { paddingHorizontal: pad }]}>
            {total}
            {profitCell}
            {day}
          </View>
          <View style={[styles.line2, styles.second, { paddingHorizontal: pad, borderTopColor: t.line }]}>
            {/* 숫자는 위 요약 문장에 들어 있다 → 조각으로 한 번 더 읽히지 않게 숨긴다 */}
            <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={[styles.cells, styles.wrap]}>
              {split(true, true)}
              <Cell first={!showSplit} label="매입금액" value={formatPrice(main.cost, "KRW")} />
            </View>
            {button}
          </View>
        </>
      )}
      {notes}
    </View>
  );
}

/** 띠 한 칸: 위 이름(작게) / 아래 값(굵게) + 등락률 */
function Cell({ label, value, unit, color, sub, subColor, big = false, first = false }: { label: string; value: string; unit?: string; color?: string; sub?: string | null; subColor?: string; big?: boolean; first?: boolean }) {
  const t = useTheme();
  return (
    <View style={[styles.cell, !first && { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: t.line, paddingLeft: space.sm }]}>
      <Text style={{ color: t.muted, fontSize: font.tiny }} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
        {label}
      </Text>
      {/* 숫자는 말줄임 없이: 칸이 모자라면 글자를 줄여 한 줄에 */}
      <Text style={styles.value} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6} maxFontSizeMultiplier={fontCap.row}>
        <Text style={{ color: color ?? t.ink, fontSize: big ? font.title : font.h2, fontWeight: big ? "800" : "700" }} maxFontSizeMultiplier={fontCap.row}>
          {value}
        </Text>
        {unit ? (
          <Text style={{ color: t.muted, fontSize: font.small, fontWeight: "500" }} maxFontSizeMultiplier={fontCap.row}>
            {" "}
            {unit}
          </Text>
        ) : null}
        {sub ? (
          <Text style={{ color: subColor ?? t.muted, fontSize: font.small, fontWeight: "600" }} maxFontSizeMultiplier={fontCap.row}>
            {" "}
            {sub}
          </Text>
        ) : null}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  band: { borderBottomWidth: StyleSheet.hairlineWidth },
  line: { flexDirection: "row", alignItems: "center", minHeight: layout.bandH },
  // 두 줄 띠의 한 줄
  line2: { flexDirection: "row", alignItems: "center", minHeight: layout.bandRowH },
  // 두 줄 띠의 첫 줄 (칸 묶음 자체)
  row1: { flexDirection: "row", flexWrap: "wrap", alignItems: "stretch", minHeight: layout.bandRowH },
  second: { borderTopWidth: StyleSheet.hairlineWidth },
  cells: { flex: 1, flexDirection: "row", alignItems: "stretch" },
  wrap: { flexWrap: "wrap" },
  // 칸 폭은 내용에 맞추고(남는 폭은 나눠 가짐), 모자라면 줄어든다 (숫자는 글자를 줄여 맞춤)
  cell: { flexGrow: 1, flexShrink: 1, flexBasis: "auto", justifyContent: "center", gap: space.xxs, paddingVertical: space.xs, paddingRight: space.sm },
  value: { fontVariant: ["tabular-nums"] },
  action: { paddingLeft: space.sm },
  notes: { paddingBottom: space.s, gap: space.xxs },
});
