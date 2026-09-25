import { describe, expect, it } from "vitest";
import {
  CHART_ICON_BTN,
  CHART_PANEL_PAD,
  candleChartSize,
  chartHeaderLayout,
  estimateTextWidth,
  fadeEdges,
  formatChartValue,
  maLegendItems,
  NAME_MIN_CHARS,
  NO_FADE,
} from "@/lib/chartLayout";
import { LINE } from "@/lib/textScale";
import { clearOf, dark, font, fontCap, layout, light, space, touch } from "@/tokens";

/**
 * 차트 화면 배치 (3-42 접는 폰 3단계 1) · 폴드 진단 8·22·24·25·6·7번). 순수 함수만 본다 — 화면에 붙는지는 chartRotation·candleChartView 테스트.
 * 창 크기(dp)는 폰 실측 전 추정값: 폴드8 접힘 475×751 · 펼침 가로 933×704 · 펼침 세로 704×933 / 울트라 접힘 411×960 · 펼침 세로 859×954 · 펼침 가로 954×859
 */
const SIZES = {
  "폴드8 접힘": [475, 751],
  "폴드8 펼침 가로": [933, 704],
  "폴드8 펼침 세로": [704, 933],
  "울트라 접힘": [411, 960],
  "울트라 펼침 세로": [859, 954],
  "울트라 펼침 가로": [954, 859],
} as const;
type SizeName = keyof typeof SIZES;
/** 폭 등급 중간 이상 (foldLayout 이 켜져 있을 때 넓은 창 배치를 쓰는 크기) */
const WIDE: Record<SizeName, boolean> = {
  "폴드8 접힘": false,
  "폴드8 펼침 가로": true,
  "폴드8 펼침 세로": true,
  "울트라 접힘": false,
  "울트라 펼침 세로": true,
  "울트라 펼침 가로": true,
};

describe("상세 차트 크기 (candleChartSize)", () => {
  // 패널 안쪽 폭 = 창 폭 − 패널 좌우 여백(14 × 2). 종목·지수 상세의 차트 묶음이 실제로 받는 폭
  const inner = (w: number) => w - CHART_PANEL_PAD * 2;
  const size = (name: SizeName, flagOn: boolean, box: number | null = inner(SIZES[name][0])) => {
    const [width, height] = SIZES[name];
    return candleChartSize({ box, window: { width, height }, wide: flagOn && WIDE[name] });
  };

  it("패널 여백을 한 번만 뺀다: 모든 크기에서 오른쪽 28dp 빈 띠가 없다 (진단 22번, 버그 수정 — 플래그와 상관없음)", () => {
    expect(CHART_PANEL_PAD).toBe(space.lg);
    for (const name of Object.keys(SIZES) as SizeName[]) {
      const w = SIZES[name][0];
      const s = size(name, false);
      // 예전 식: min(창 폭 − 56, 720) → 좁은 창에서 패널 안쪽보다 28 좁았다
      const before = Math.min(w - space.lg * 4, 720);
      if (inner(w) <= layout.chartMaxW) {
        expect(s.width, name).toBe(inner(w));
        expect(s.width - before, name).toBe(space.lg * 2);
      } else {
        // 넓은 창(플래그 꺼짐)은 지금처럼 720 에서 멈춘다
        expect(s.width, name).toBe(layout.chartMaxW);
      }
    }
  });

  it("6가지 창 크기 × 플래그 꺼짐·켜짐 (추정 창 크기로 계산한 값)", () => {
    const table = Object.fromEntries((Object.keys(SIZES) as SizeName[]).map((n) => [n, { off: size(n, false), on: size(n, true) }]));
    expect(table).toEqual({
      // 접힌 화면: 플래그와 상관없이 같다 (휴대폰 화면 그대로 + 28dp 버그 수정)
      "폴드8 접힘": { off: { width: 447, height: 277 }, on: { width: 447, height: 277 } },
      "울트라 접힘": { off: { width: 383, height: 237 }, on: { width: 383, height: 237 } },
      // 펼친 폴드8 가로(높이 704): 꺼짐은 720 상한 그대로(오른쪽 185dp 빈 칸), 켜짐은 폭을 다 쓰고 높이를 창 높이의 절반(352)으로
      "폴드8 펼침 가로": { off: { width: 720, height: 446 }, on: { width: 905, height: 352 } },
      // 펼친 폴드8 세로: 폭이 720 보다 좁아 켜도 같다 (높이 상한 467 보다 폭 × 0.62 = 419 가 작다)
      "폴드8 펼침 세로": { off: { width: 676, height: 419 }, on: { width: 676, height: 419 } },
      "울트라 펼침 세로": { off: { width: 720, height: 446 }, on: { width: 831, height: 477 } },
      "울트라 펼침 가로": { off: { width: 720, height: 446 }, on: { width: 926, height: 430 } },
    });
  });

  it("플래그 꺼짐: 높이는 지금처럼 폭 × 0.62, 폭은 720 에서 멈춘다", () => {
    for (const name of Object.keys(SIZES) as SizeName[]) {
      const s = size(name, false);
      expect(s.width, name).toBeLessThanOrEqual(layout.chartMaxW);
      expect(s.height, name).toBe(Math.round(s.width * layout.chartAspect));
    }
  });

  it("플래그 켜짐 + 넓은 창: 720 상한 없이 패널 폭을 다 쓰고, 높이는 min(폭 × 0.62, 창 높이 × 0.5)", () => {
    for (const name of Object.keys(SIZES) as SizeName[]) {
      if (!WIDE[name]) continue;
      const [w, winH] = SIZES[name];
      const s = size(name, true);
      expect(s.width, name).toBe(inner(w));
      expect(s.height, name).toBe(Math.min(Math.round(inner(w) * layout.chartAspect), Math.round(winH * layout.chartMaxHRatio)));
      expect(s.height, name).toBeLessThanOrEqual(Math.round(winH * layout.chartMaxHRatio));
    }
  });

  it("좁은 창(접힌 화면)은 플래그를 켜도 휴대폰 화면 그대로", () => {
    for (const name of ["폴드8 접힘", "울트라 접힘"] as const) expect(size(name, true), name).toEqual(size(name, false));
    // 넓은 창 배치 여부는 부르는 쪽이 정한다(fold.on && isWide) — wide=false 면 창이 넓어도 지금과 같다
    expect(candleChartSize({ box: 905, window: { width: 933, height: 704 }, wide: false })).toEqual({ width: 720, height: 446 });
  });

  it("재기 전(첫 그림)은 창 폭 − 패널 여백으로 어림하고, 잰 뒤에는 잰 폭을 쓴다 (2단 오른쪽 칸 등 창보다 좁은 자리)", () => {
    const win = { width: 933, height: 704 };
    expect(candleChartSize({ box: null, window: win, wide: true })).toEqual({ width: 905, height: 352 });
    // 2단 오른쪽 칸처럼 창보다 좁은 자리: 잰 폭 그대로, 높이는 폭 × 0.62 가 창 높이 상한보다 작으면 그 값
    expect(candleChartSize({ box: 500, window: win, wide: true })).toEqual({ width: 500, height: 310 });
    // 소수점 폭은 내린다 (그림이 패널 밖으로 넘치지 않게)
    expect(candleChartSize({ box: 383.43, window: { width: 411.43, height: 960 }, wide: false }).width).toBe(383);
    // 잴 수 없는 값(0·NaN)은 어림으로
    expect(candleChartSize({ box: 0, window: { width: 475, height: 751 }, wide: false }).width).toBe(447);
    expect(candleChartSize({ box: Number.NaN, window: { width: 475, height: 751 }, wide: false }).width).toBe(447);
  });

  it("부르는 쪽이 폭·높이를 정하면(전체 화면 차트) 그대로 쓴다", () => {
    expect(candleChartSize({ box: 300, window: { width: 933, height: 704 }, wide: true, width: 909, height: 480 })).toEqual({ width: 909, height: 480 });
    expect(candleChartSize({ box: null, window: { width: 400, height: 800 }, wide: false, width: 376 })).toEqual({ width: 376, height: Math.round(376 * 0.62) });
  });

  it("기준 숫자는 토큰 한 곳 (실측 뒤 바꾸기 쉽게)", () => {
    expect(layout.chartMaxW).toBe(720);
    expect(layout.chartAspect).toBe(0.62);
    expect(layout.chartMaxHRatio).toBe(0.5);
  });
});

describe("전체 화면 차트 머리 (chartHeaderLayout, 진단 8번)", () => {
  const NAME = "한화에어로스페이스";
  const PRICE = "912,000원";
  // 화면과 같은 글자 (chart.tsx: formatPrice(change, sign) + 등락률)
  const CHANGE = "+12,000원 (+1.33%)";
  /** 전체 화면 차트 판의 좌우 여백 (chart.tsx pad = space.md) */
  const PAD = space.md * 2;
  const head = (winW: number, fontScale: number, buttons = 2, name = NAME) => chartHeaderLayout({ width: winW - PAD, fontScale, name, price: PRICE, change: CHANGE, buttons });

  it("접힌 화면 100%: 이름만 줄이고(…) 가격·등락은 같은 줄 — 높이 44 그대로", () => {
    for (const w of [475, 411]) expect(head(w, 1), `${w}`).toEqual({ twoLines: false, height: touch.min });
  });

  it("폴드8 접힘 115% 는 이름을 줄여 한 줄에 들어간다", () => {
    expect(head(475, 1.15)).toEqual({ twoLines: false, height: touch.min });
  });

  it("좁은 창 + 큰 글씨(접힌 화면 130% 이상)는 가격·등락을 둘째 줄로 내리고 머리를 두 줄 높이로", () => {
    for (const [w, s] of [
      [411, 1.15],
      [411, 1.3],
      [475, 1.3],
      [475, 1.5],
      [411, 2],
    ]) {
      const r = head(w!, s!);
      expect(r.twoLines, `${w} ${s}`).toBe(true);
      // 첫 줄(버튼 34 와 이름 중 높은 쪽) + 둘째 줄(가격 한 줄)이 머리 안에 들어간다 → 아래 도구 줄과 겹치지 않는다
      expect(r.height, `${w} ${s}`).toBeGreaterThanOrEqual(CHART_ICON_BTN + Math.ceil(font.body * LINE * Math.min(s!, fontCap.chrome)));
      expect(r.height, `${w} ${s}`).toBeGreaterThan(touch.min);
    }
  });

  it("두 줄 머리 높이: 100% 59 · 130% 65 · 150% 이상 69 (최소 44 보다 크고, 글자에 맞춰 늘어난다)", () => {
    const two = (s: number) => chartHeaderLayout({ width: 100, fontScale: s, name: NAME, price: PRICE, change: CHANGE, buttons: 2 });
    expect([1, 1.3, 1.5, 2].map((s) => two(s))).toEqual([
      { twoLines: true, height: 59 },
      { twoLines: true, height: 65 },
      { twoLines: true, height: 69 },
      { twoLines: true, height: 69 },
    ]);
  });

  it("머리 높이는 최소 44, 글자 배율은 fontCap.chrome(150%) 까지만 반영한다", () => {
    for (const w of [411, 475, 933]) {
      for (const s of [1, 1.15, 1.3, 1.5, 2]) {
        const r = head(w, s);
        expect(r.height, `${w} ${s}`).toBeGreaterThanOrEqual(touch.min);
        const c = Math.min(s, fontCap.chrome);
        if (r.twoLines) expect(r.height, `${w} ${s}`).toBeGreaterThanOrEqual(Math.max(CHART_ICON_BTN, font.h2 * LINE * c) + font.body * LINE * c);
        else expect(r.height, `${w} ${s}`).toBeGreaterThanOrEqual(font.h2 * LINE * c);
      }
      // 200% 는 150% 와 같다 (머리가 화면을 다 먹지 않게)
      expect(head(w, 2), `${w}`).toEqual(head(w, 1.5));
    }
    // 작은 글씨(85%)는 100% 로 본다
    expect(head(411, 0.85)).toEqual(head(411, 1));
  });

  it("넓은 창·돌려 그린 가로 판은 큰 글씨에서도 한 줄", () => {
    for (const w of [933, 704, 859, 954, 751, 960]) for (const s of [1, 1.3, 1.5, 2]) expect(head(w, s).twoLines, `${w} ${s}`).toBe(false);
  });

  it("버튼이 하나면(가로 창에서 가로로 보기를 숨김) 그만큼 한 줄에 더 들어간다", () => {
    expect(head(411, 1.15, 2).twoLines).toBe(true);
    expect(head(411, 1.15, 1).twoLines).toBe(false);
  });

  it("시세가 없으면(이름만) 늘 한 줄", () => {
    expect(chartHeaderLayout({ width: 200, fontScale: 2, name: NAME, price: null, change: null, buttons: 2 })).toEqual({ twoLines: false, height: touch.min });
  });

  it("한 줄 기준: 이름 앞 네 글자 + '…'(짧은 이름은 전부) + 가격 + 등락 + 버튼이 폭에 들어가는가", () => {
    expect(NAME_MIN_CHARS).toBe(4);
    const buttons = 2 * CHART_ICON_BTN + space.sm + space.sm;
    const need = (nameMin: string) => estimateTextWidth(nameMin, font.h2) + space.sm + estimateTextWidth(PRICE, font.body) + space.sm + estimateTextWidth(CHANGE, font.small) + buttons;
    const at = (width: number, name: string) => chartHeaderLayout({ width, fontScale: 1, name, price: PRICE, change: CHANGE, buttons: 2 }).twoLines;
    // 긴 이름: 앞 네 글자 + … 만 지키면 된다 (그 뒤는 줄어든다)
    expect(at(need("한화에어…"), NAME)).toBe(false);
    expect(at(need("한화에어…") - 1, NAME)).toBe(true);
    // 이름이 더 길어도 기준은 같다
    expect(at(need("한화에어…"), `${NAME}우선주`)).toBe(false);
    // 네 글자 이하 이름은 다 보여야 한다
    expect(at(need("삼성전자"), "삼성전자")).toBe(false);
    expect(at(need("삼성전자") - 1, "삼성전자")).toBe(true);
    expect(need("삼성전자")).toBeLessThan(need("한화에어…"));
  });

  it("글자 폭 어림: 한글은 숫자보다 넓고, 쉼표·공백은 좁다 (실제 글꼴보다 조금 넓게)", () => {
    expect(estimateTextWidth("가", 10)).toBeGreaterThan(estimateTextWidth("1", 10));
    expect(estimateTextWidth("1", 10)).toBeGreaterThan(estimateTextWidth(",", 10));
    // Roboto 숫자 폭 0.56em 보다 넓게 어림한다 (한 줄에 들어간다고 본 것은 폰에서도 들어가게)
    expect(estimateTextWidth("1234567890", 14)).toBeGreaterThan(10 * 0.56 * 14);
    expect(estimateTextWidth("", 14)).toBe(0);
  });
});

describe("이동평균 값 줄 항목 (maLegendItems, 진단 24번)", () => {
  const series = (last: number | null) => [null, 1, 2, last];

  it("항목마다 '기간 + 단위 + 값'이고, 항목 안 공백은 줄바꿈 없는 공백 → 글자를 키워도 항목 안에서 줄이 바뀌지 않는다", () => {
    const items = maLegendItems(
      [
        { period: 5, values: series(71500) },
        { period: 120, values: series(77120) },
      ],
      3,
      "KRW",
      "D",
    );
    expect(items).toEqual([
      { period: 5, text: "5일 71,500원" },
      { period: 120, text: "120일 77,120원" },
    ]);
    for (const it of items) expect(it.text).not.toMatch(/[ \t]/);
  });

  it("주·월·분봉 단위와 값이 없는 봉('-')", () => {
    const mas = [{ period: 20, values: series(null) }];
    expect(maLegendItems(mas, 3, "KRW", "W")[0]!.text).toBe("20주 -");
    expect(maLegendItems([{ period: 20, values: series(5) }], 3, "KRW", "M")[0]!.text).toBe("20월 5원");
    expect(maLegendItems([{ period: 20, values: series(5) }], 3, "KRW", "5m")[0]!.text).toBe("20봉 5원");
    // 범위 밖 인덱스도 '-'
    expect(maLegendItems([{ period: 60, values: series(5) }], 99, "KRW", "D")[0]!.text).toBe("60일 -");
  });

  it("달러·지수 값도 한 항목 (값 안 공백이 있어도 줄바꿈 없는 공백으로)", () => {
    expect(maLegendItems([{ period: 60, values: series(230.1) }], 3, "USD", "D")[0]!.text).toBe(`60일 ${formatChartValue(230.1, "USD")}`);
    expect(maLegendItems([{ period: 60, values: series(2650.123) }], 3, "PT", "D")[0]!.text).toBe("60일 2,650.12");
  });

  it("고른 이동평균 순서 그대로, 없으면 빈 목록", () => {
    const items = maLegendItems([5, 20, 60, 120].map((p) => ({ period: p, values: series(p) })), 3, "KRW", "D");
    expect(items.map((i) => i.period)).toEqual([5, 20, 60, 120]);
    expect(maLegendItems([], 3, "KRW", "D")).toEqual([]);
  });
});

describe("칩 띠 가장자리 흐림 (fadeEdges, 진단 25번)", () => {
  it("넘길 수 없으면(칩이 다 보이면) 칠하지 않는다", () => {
    expect(fadeEdges({ view: 400, content: 300, x: 0 })).toEqual(NO_FADE);
    expect(fadeEdges({ view: 400, content: 400.6, x: 0 })).toEqual(NO_FADE);
    // 아직 재지 못함
    expect(fadeEdges({ view: 0, content: 500, x: 0 })).toEqual(NO_FADE);
  });

  it("처음에는 오른쪽만, 넘기는 중에는 양쪽, 끝까지 넘기면 왼쪽만", () => {
    expect(fadeEdges({ view: 300, content: 500, x: 0 })).toEqual({ left: false, right: true });
    expect(fadeEdges({ view: 300, content: 500, x: 100 })).toEqual({ left: true, right: true });
    expect(fadeEdges({ view: 300, content: 500, x: 200 })).toEqual({ left: true, right: false });
    // 1dp 안쪽 오차는 끝에 닿은 것으로
    expect(fadeEdges({ view: 300, content: 500, x: 199.5 })).toEqual({ left: true, right: false });
    expect(fadeEdges({ view: 300, content: 500, x: 0.5 })).toEqual({ left: false, right: true });
    // 튕김(음수·끝 넘어감)
    expect(fadeEdges({ view: 300, content: 500, x: -20 })).toEqual({ left: false, right: true });
    expect(fadeEdges({ view: 300, content: 500, x: 230 })).toEqual({ left: true, right: false });
  });

  it("흐림 색은 바탕색 토큰에서 투명으로 (라이트·다크 모두 같은 색의 투명값 — 회색으로 비치지 않게)", () => {
    for (const t of [light, dark]) {
      for (const c of [t.bg, t.surface]) {
        expect(clearOf(c)).toBe(`${c}00`);
        expect(clearOf(c)).toMatch(/^#[0-9A-Fa-f]{8}$/);
      }
    }
    expect(clearOf("rgba(0,0,0,0.5)")).toBe("transparent");
  });
});
