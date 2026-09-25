import { describe, expect, it } from "vitest";
import { bandOneLine, bandRates, COL_LABEL, COL_SORT, HELD_COLS, holdingWeights, nameMinFor, pickCols, pickWatchCols, usedWidth, WATCH_COLS } from "@/lib/holdingsColumns";
import { railWidth } from "@/lib/windowClass";
import { fontCap, layout, space } from "@/tokens";
import { holding, quote } from "./helpers";

/**
 * 넓은 잔고 표의 열 고르기 (3-42 웨이브 B, lib/holdingsColumns).
 * 폭은 표가 받은 폭(세로 탭 막대·화면 여백을 뺀 값, 좌우 여백 포함). 추정 창: 펼친 폴드8 가로 933(막대 80 → 853)·세로 704,
 * 울트라 펼침 세로 859·가로 954 / 2단계 제안의 내용 폭 640·795·869·890 도 함께 본다.
 */
const WIDTHS = [640, 704, 795, 853, 859, 869, 890, 933] as const;
const SCALES = [1, 1.3, 1.4] as const;
const keys = (w: number, s = 1) => pickCols(w, s).cols.map((c) => c.key);
const HELD = HELD_COLS.map((c) => c.key);

describe("pickCols: 폭·글자 배율별 열", () => {
  it.each(WIDTHS.flatMap((w) => SCALES.map((s) => [w, s] as const)))("폭 %i · 글자 %s: 앞에서부터 우선 · 합계가 폭을 넘지 않음 · 이름 칸 최소 폭(100% 146, 큰 글씨 132) 이상", (w, s) => {
    const p = pickCols(w, s);
    const inner = w - p.pad * 2;
    // 열은 휴대폰에서 보던 순서 그대로, 앞에서부터 (뒤에서부터 뺀다)
    expect(p.cols.map((c) => c.key)).toEqual(HELD.slice(0, p.cols.length));
    // 숫자 칸은 적어도 현재가·등락률·평가손익·수익률 (가장 좁은 펼친 창 640 도)
    expect(p.cols.length).toBeGreaterThanOrEqual(4);
    // 합계(이름 + 숫자 열 + 구분선 칸)가 표 폭 그대로
    expect(p.nameW + usedWidth(p.cols)).toBe(inner);
    expect(p.nameW).toBeGreaterThanOrEqual(nameMinFor(s));
    // 한 열을 더 넣으면 이름 칸이 최소 폭보다 좁아진다 (넣을 수 있는 만큼 넣었다)
    if (p.cols.length < HELD.length) {
      const next = HELD_COLS[p.cols.length]!;
      const extra = Math.ceil(layout.cols[next.key] * Math.min(s, fontCap.row)) + (next.group !== HELD_COLS[p.cols.length - 1]!.group ? layout.colGap : 0);
      expect(p.nameW - extra).toBeLessThan(nameMinFor(s));
    }
    // 열 폭은 글자 배율(최대 140%)만큼 넓힌다 → 숫자가 잘리지 않는다
    for (const c of p.cols) expect(c.width).toBe(Math.ceil(layout.cols[c.key as keyof typeof layout.cols] * Math.min(s, fontCap.row)));
  });

  it("설계 목업과 같은 열 (글자 100%)", () => {
    // 펼친 폴드8 가로: 막대 80 을 뺀 853 → 숫자 8칸(평단까지), 이름 157
    expect(keys(853)).toEqual(["price", "rate", "profit", "profitRate", "day", "value", "weight", "avg"]);
    expect(pickCols(853).nameW).toBe(157);
    // 울트라 펼침 세로 859 → 8칸, 이름 163
    expect(keys(859)).toEqual(keys(853));
    expect(pickCols(859).nameW).toBe(163);
    // 폴드8 펼침 세로 704 → 6칸(평가금액까지), 이름 156
    expect(keys(704)).toEqual(["price", "rate", "profit", "profitRate", "day", "value"]);
    expect(pickCols(704).nameW).toBe(156);
    // 더 넓으면(울트라 펼침 가로 954 등 탭 막대 없는 933 이상) 수량까지 9칸
    expect(keys(933)).toEqual(HELD);
    expect(keys(795)).toEqual(["price", "rate", "profit", "profitRate", "day", "value", "weight"]);
    expect(keys(640)).toEqual(["price", "rate", "profit", "profitRate", "day"]);
  });

  it("큰 글씨는 열이 넓어져 칸 수가 줄어든다 (130% → 펼친 폴드8 가로 8칸 → 6칸, 140% → 5칸)", () => {
    expect(keys(853, 1.3)).toHaveLength(6);
    // 실제 펼친 폴드8 가로 130%: 세로 탭 막대가 글자만큼 넓어져(92) 표 폭 841 — 그래도 6칸 (이름 칸 142, 두 줄까지 접힘).
    // 예전(이름 최소 146)에는 5칸으로 줄고 이름 칸이 265 로 벌어져 이름과 현재가 사이에 약 200dp 빈칸이 생겼다
    const f8l130 = pickCols(933 - railWidth(1.3), 1.3);
    expect(railWidth(1.3)).toBe(92);
    expect(f8l130.cols.map((c) => c.key)).toEqual(["price", "rate", "profit", "profitRate", "day", "value"]);
    expect(f8l130.nameW).toBe(142);
    expect(keys(853, 1.4)).toHaveLength(5);
    // 140% 넘는 글자는 줄 글자 상한(fontCap.row)이라 열도 140% 그대로
    expect(pickCols(853, 2)).toEqual(pickCols(853, 1.4));
    // 작은 글씨(100% 미만)는 100% 로 본다
    expect(pickCols(853, 0.85)).toEqual(pickCols(853, 1));
  });

  it("묶음이 바뀌는 자리에만 구분선 칸: 현재가·등락률 ‖ 평가손익·수익률 ‖ 그 밖", () => {
    const p = pickCols(933);
    expect(p.cols.filter((c) => c.divider).map((c) => c.key)).toEqual(["profit", "day"]);
    expect(pickCols(704).cols.filter((c) => c.divider).map((c) => c.key)).toEqual(["profit", "day"]);
    // 좌우 여백은 간격 토큰
    expect(p.pad).toBe(space.md);
  });

  it("폭을 모르면(0·NaN) 한 열만 남기고 이름 칸 0 — 오류 없이", () => {
    expect(pickCols(0).cols.map((c) => c.key)).toEqual(["price"]);
    expect(pickCols(Number.NaN).nameW).toBe(0);
  });
});

describe("pickWatchCols: 관심 표는 보유 표와 이름 칸 폭을 맞춘다", () => {
  it.each(WIDTHS)("폭 %i: 현재가·등락률 열이 보유 표와 같은 자리", (w) => {
    const held = pickCols(w);
    const watch = pickWatchCols(w, 1, held.nameW);
    expect(watch.cols.map((c) => c.key)).toEqual(WATCH_COLS.map((c) => c.key));
    expect(watch.nameW).toBe(held.nameW);
    expect(watch.cols.slice(0, 2)).toEqual(held.cols.slice(0, 2));
    expect(watch.nameW + usedWidth(watch.cols)).toBeLessThanOrEqual(w - watch.pad * 2);
    // 구분선은 현재가·등락률 ‖ 전일대비·거래량 사이
    expect(watch.cols.filter((c) => c.divider).map((c) => c.key)).toEqual(["move"]);
  });

  it("보유 표 이름 폭으로 다 안 들어가면 이름 최소 폭 기준으로 다시 고른다", () => {
    const w = pickWatchCols(500, 1, 400);
    expect(w.nameW).toBeGreaterThanOrEqual(layout.nameMinW);
    expect(w.nameW + usedWidth(w.cols)).toBe(500 - w.pad * 2);
  });
});

describe("열 이름·정렬", () => {
  it("열 이름이 모두 있고, 누르면 바꿀 정렬은 설정의 정렬 값 중 하나", () => {
    for (const c of [...HELD_COLS, ...WATCH_COLS]) expect(COL_LABEL[c.key]).toBeTruthy();
    // lib/settings SortKey 값 (그 모듈은 기기 저장소를 불러와 여기서는 값만 적는다)
    const values = ["created", "changeRate", "profit", "value", "name", "market"];
    for (const k of Object.values(COL_SORT)) expect(values).toContain(k);
    expect(COL_SORT).toEqual({ rate: "changeRate", profit: "profit", value: "value", weight: "value" });
  });
});

describe("이름 칸 최소 폭 (nameMinFor)", () => {
  it("100% 는 146(한 줄 이름), 큰 글씨는 이름이 두 줄까지 접혀 132 — 100% 미만은 100% 로 본다", () => {
    expect(nameMinFor(1)).toBe(layout.nameMinW);
    expect(nameMinFor(0.85)).toBe(layout.nameMinW);
    expect(nameMinFor(1.1)).toBe(layout.nameMinWrapW);
    expect(nameMinFor(2)).toBe(layout.nameMinWrapW);
    expect(layout.nameMinWrapW).toBeLessThan(layout.nameMinW);
  });
});

describe("계좌 띠 한 줄/두 줄", () => {
  it("표 폭 800 이상이면 한 줄 (펼친 폴드8 가로 853·울트라 859), 704 는 두 줄. 큰 글씨는 배율만큼 기준을 올린다", () => {
    expect(bandOneLine(853)).toBe(true);
    expect(bandOneLine(859)).toBe(true);
    expect(bandOneLine(704)).toBe(false);
    expect(bandOneLine(853, 1.3)).toBe(false);
    expect(bandOneLine(1100, 1.3)).toBe(true);
    expect(bandOneLine(Number.NaN)).toBe(false);
  });

  it("한 줄 띠의 국내·해외 수익률: 표 폭 840 이상 (펼친 폴드8 가로 853 · 울트라 859·954 는 넣고, 800~839 는 금액만)", () => {
    expect(bandRates(933 - railWidth(1))).toBe(true);
    expect(bandRates(859)).toBe(true);
    expect(bandRates(954)).toBe(true);
    expect(bandRates(820)).toBe(false);
    expect(bandOneLine(820)).toBe(true);
    // 큰 글씨는 배율만큼 기준을 올린다 (그 폭이면 띠가 이미 두 줄이다 — 두 줄 띠는 늘 수익률)
    expect(bandRates(853, 1.3)).toBe(false);
    expect(bandRates(Number.NaN)).toBe(false);
  });
});

describe("비중 열 (holdingWeights): 계좌 총 평가금액과 같은 기준", () => {
  const FX = 1400;
  const kr = holding("005930", quote("005930", 70_000), 10, 60_000, undefined, "삼성전자"); // 700,000원
  const us = holding("AAPL", quote("AAPL", 250, { currency: "USD", fxRate: FX }), 1, 200, { costBasisKrw: 270_000, krwCostSource: "exact" }, "애플"); // $250 → 350,000원
  const watch = holding("035720", quote("035720", 40_000), null, null, undefined, "카카오");

  it("원화 환산 평가금액 ÷ 총액, 소수 첫째 자리 · 가장 큰 비중", () => {
    const w = holdingWeights([kr, us, watch], false, 1_050_000);
    expect(w.byCode.get("005930")).toBe(66.7);
    expect(w.byCode.get("AAPL")).toBe(33.3);
    expect(w.byCode.has("035720")).toBe(false);
    expect(w.max).toBe(66.7);
  });

  it("비용 차감 설정을 따른다 (평가금액과 같은 값)", () => {
    const after = holding("005930", quote("005930", 70_000), 10, 60_000, { afterCost: { marketValue: 690_000, profit: 90_000, profitRate: 15 } }, "삼성전자");
    expect(holdingWeights([after], true, 690_000).byCode.get("005930")).toBe(100);
    expect(holdingWeights([after], false, 690_000).byCode.get("005930")).toBe(101.4);
  });

  it("환율을 모르는 해외 종목이 있어 총액이 원화 종목만이면 원화 종목만 비중 · 총액이 0 이면 비중 없음", () => {
    const noFx = holding("TSLA", quote("TSLA", 400, { currency: "USD" }), 1, 300, undefined, "테슬라");
    const w = holdingWeights([kr, noFx], false, 700_000, true);
    expect(w.byCode.get("005930")).toBe(100);
    expect(w.byCode.has("TSLA")).toBe(false);
    expect(holdingWeights([kr], false, 0).byCode.size).toBe(0);
  });

  it("시세 환율이 빠진 달러 종목은 다른 달러 시세의 환율로 (계좌 합계와 같은 규칙)", () => {
    const noRate = holding("NVDA", quote("NVDA", 100, { currency: "USD" }), 1, 90, undefined, "엔비디아");
    const w = holdingWeights([us, noRate], false, 490_000);
    expect(w.byCode.get("NVDA")).toBe(28.6);
  });
});
