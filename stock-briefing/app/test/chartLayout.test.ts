import { describe, expect, it } from "vitest";
import {
  CHART_ICON_BTN,
  CHART_PANEL_PAD,
  candleChartSize,
  chartHeaderLayout,
  estimateTextWidth,
  fadeEdges,
  formatChartValue,
  headerButtonsRoom,
  headerNeedsTwoLines,
  maLegendItems,
  NAME_MIN_CHARS,
  nameMinWidth,
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
  // 패널 안쪽 폭 = 창 폭 − 패널 좌우 여백(14 × 2). 넓은 창에서 종목·지수 상세의 차트 묶음이 실제로 받는 폭
  const inner = (w: number) => w - CHART_PANEL_PAD * 2;
  // 3-42 이전(main) 식: min(창 폭 − 56, 720) — 패널 여백을 두 번 빼서 오른쪽 28dp 가 빈다. 휴대폰 화면은 이 식 그대로 (사용자 결정)
  const mainW = (w: number) => Math.min(w - space.lg * 2 - space.lg * 2, 720);
  const main = (w: number) => ({ width: mainW(w), height: Math.round(mainW(w) * 0.62) });
  const size = (name: SizeName, flagOn: boolean, box: number | null = inner(SIZES[name][0])) => {
    const [width, height] = SIZES[name];
    return candleChartSize({ box, window: { width, height }, wide: flagOn && WIDE[name] });
  };

  it("휴대폰 화면(좁은 창 · 플래그 꺼짐)은 3-42 이전 식 그대로: 폭 min(창 폭 − 56, 720), 높이 폭 × 0.62 (사용자 결정 '접은 화면은 지금 그대로')", () => {
    expect(CHART_PANEL_PAD).toBe(space.lg);
    // 360·411·475 창: 304×188 · 355×220 · 419×260 (main 과 같은 값 — 잰 폭이 무엇이든)
    const want = { 360: { width: 304, height: 188 }, 411: { width: 355, height: 220 }, 475: { width: 419, height: 260 } } as const;
    for (const w of [360, 411, 475] as const) {
      for (const box of [null, inner(w), 905, 0, Number.NaN, 200.5]) {
        expect(candleChartSize({ box, window: { width: w, height: 800 }, wide: false }), `${w} ${box}`).toEqual(want[w]);
        expect(candleChartSize({ box, window: { width: w, height: 800 }, wide: false }), `${w} ${box}`).toEqual(main(w));
      }
    }
    // 소수점 창 폭도 예전처럼 그대로 (내리지 않는다): 411.43 → 355.43 × 220
    expect(candleChartSize({ box: 383, window: { width: 411.43, height: 960 }, wide: false })).toEqual({ width: 411.43 - 56, height: Math.round((411.43 - 56) * 0.62) });
    // 폭을 모르는 창은 0 (그림 없음)
    expect(candleChartSize({ box: null, window: { width: Number.NaN, height: 800 }, wide: false }).width).toBe(0);
    // 플래그가 꺼져 있으면 넓은 창도 예전 식 (펼친 폴드8 세로 704 → 648×402, 가로 933 → 720×446)
    expect(candleChartSize({ box: 676, window: { width: 704, height: 933 }, wide: false })).toEqual({ width: 648, height: 402 });
    expect(candleChartSize({ box: 905, window: { width: 933, height: 704 }, wide: false })).toEqual({ width: 720, height: 446 });
  });

  it("넓은 창(플래그 켜짐 + 폭 중간 이상)만 패널 여백을 한 번만 뺀다: 오른쪽 28dp 빈 띠가 없다 (진단 22번)", () => {
    for (const name of Object.keys(SIZES) as SizeName[]) {
      if (!WIDE[name]) continue;
      const w = SIZES[name][0];
      expect(size(name, true).width, name).toBe(inner(w));
    }
    // 펼친 폴드8 세로(704): 예전 식 648 → 676 (+28)
    expect(size("폴드8 펼침 세로", true).width - mainW(704)).toBe(space.lg * 2);
  });

  it("6가지 창 크기 × 플래그 꺼짐·켜짐 (추정 창 크기로 계산한 값)", () => {
    const table = Object.fromEntries((Object.keys(SIZES) as SizeName[]).map((n) => [n, { off: size(n, false), on: size(n, true) }]));
    expect(table).toEqual({
      // 접힌 화면: 플래그와 상관없이 3-42 이전과 같다 (휴대폰 화면 그대로)
      "폴드8 접힘": { off: { width: 419, height: 260 }, on: { width: 419, height: 260 } },
      "울트라 접힘": { off: { width: 355, height: 220 }, on: { width: 355, height: 220 } },
      // 펼친 폴드8 가로(높이 704): 꺼짐은 720 상한 그대로(오른쪽 185dp 빈 칸), 켜짐은 폭을 다 쓰고 높이를 창 높이의 절반(352)으로
      "폴드8 펼침 가로": { off: { width: 720, height: 446 }, on: { width: 905, height: 352 } },
      // 펼친 폴드8 세로: 꺼짐은 예전 식(648), 켜짐은 패널 폭(676) — 높이 상한 467 보다 폭 × 0.62 = 419 가 작다
      "폴드8 펼침 세로": { off: { width: 648, height: 402 }, on: { width: 676, height: 419 } },
      "울트라 펼침 세로": { off: { width: 720, height: 446 }, on: { width: 831, height: 477 } },
      "울트라 펼침 가로": { off: { width: 720, height: 446 }, on: { width: 926, height: 430 } },
    });
    for (const name of Object.keys(SIZES) as SizeName[]) expect(size(name, false), name).toEqual(main(SIZES[name][0]));
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

  it("넓은 창: 재기 전(첫 그림)은 창 폭 − 패널 여백으로 어림하고, 잰 뒤에는 잰 폭을 쓴다 (2단 오른쪽 칸 등 창보다 좁은 자리)", () => {
    const win = { width: 933, height: 704 };
    expect(candleChartSize({ box: null, window: win, wide: true })).toEqual({ width: 905, height: 352 });
    // 2단 오른쪽 칸처럼 창보다 좁은 자리: 잰 폭 그대로, 높이는 폭 × 0.62 가 창 높이 상한보다 작으면 그 값
    expect(candleChartSize({ box: 500, window: win, wide: true })).toEqual({ width: 500, height: 310 });
    // 소수점 폭은 내린다 (그림이 패널 밖으로 넘치지 않게)
    expect(candleChartSize({ box: 500.6, window: win, wide: true }).width).toBe(500);
    // 잴 수 없는 값(0·NaN)은 어림으로
    expect(candleChartSize({ box: 0, window: win, wide: true }).width).toBe(905);
    expect(candleChartSize({ box: Number.NaN, window: win, wide: true }).width).toBe(905);
  });

  it("창이 바뀌었는데 잰 폭이 아직 넓을 때(onLayout 전): 넓은 창은 창 폭 − 패널 여백으로 줄이고, 접힌 화면은 잰 폭을 쓰지 않는다 → 화면 밖으로 넘치지 않는다", () => {
    // 펼친 폴드8 가로(933)에서 잰 905 가 남은 채 접힘(475): 예전 식 그대로 419×260 (잰 폭과 상관없음)
    expect(candleChartSize({ box: 905, window: { width: 475, height: 751 }, wide: false })).toEqual({ width: 419, height: 260 });
    // 울트라 펼침 가로(잰 926) → 접힘(411)
    expect(candleChartSize({ box: 926, window: { width: 411, height: 960 }, wide: false })).toEqual({ width: 355, height: 220 });
    // 넓은 창끼리(펼친 가로 → 펼친 세로): 잰 905 가 남아도 704 − 28 = 676
    expect(candleChartSize({ box: 905, window: { width: 704, height: 933 }, wide: true })).toEqual({ width: 676, height: 419 });
    // 창보다 좁은 자리(2단 오른쪽 칸·탭 막대 옆)는 잰 폭 그대로
    expect(candleChartSize({ box: 500, window: { width: 933, height: 704 }, wide: true }).width).toBe(500);
    // 어떤 잰 값이 남아 있어도 창 폭 − 패널 여백을 넘지 않는다
    for (const name of Object.keys(SIZES) as SizeName[]) {
      const [w, hh] = SIZES[name];
      for (const stale of [355, 383, 419, 447, 676, 831, 905, 926]) {
        for (const flagOn of [false, true]) {
          const wide = flagOn && WIDE[name];
          const s = candleChartSize({ box: stale, window: { width: w, height: hh }, wide });
          expect(s.width, `${name} ${stale}`).toBeLessThanOrEqual(inner(w));
          expect(s.width, `${name} ${stale}`).toBe(wide ? Math.min(stale, inner(w)) : mainW(w));
        }
      }
    }
  });

  it("부르는 쪽이 폭·높이를 정하면(전체 화면 차트) 그대로 쓴다", () => {
    expect(candleChartSize({ box: 300, window: { width: 933, height: 704 }, wide: true, width: 909, height: 480 })).toEqual({ width: 909, height: 480 });
    expect(candleChartSize({ box: null, window: { width: 400, height: 800 }, wide: false, width: 376 })).toEqual({ width: 376, height: Math.round(376 * 0.62) });
  });

  it("기준 숫자는 토큰 한 곳 (실측 뒤 바꾸기 쉽게)", () => {
    expect(layout.chartMaxW).toBe(720);
    expect(layout.chartAspect).toBe(0.62);
    expect(layout.chartMaxHRatio).toBe(0.5);
    expect(layout.chartMinH).toBe(200);
    expect(layout.chartCapRamp).toBe(96);
  });
});

describe("넓은 창 차트 높이의 하한과 폭 600 경계 (chartMinH · chartCapRamp)", () => {
  /** foldLayout 켜짐: 폭 등급 중간(600) 이상이면 넓은 창 배치 (useFoldLayout + isWide 와 같은 기준) */
  const at = (w: number, hh: number, box: number | null = null) => candleChartSize({ box, window: { width: w, height: hh }, wide: w >= layout.mediumMin });

  it("낮은 창에서도 chartMinH(200) 아래로 줄지 않는다 (예전: 933×300 → 150)", () => {
    // 펼친 폴드8 가로를 위아래로 나눈 창
    expect(at(933, 300)).toEqual({ width: 905, height: 200 });
    // 펼친 폴드8 세로를 위아래로 나눈 창 704×460: 창 높이 × 0.5 = 230 은 하한보다 커서 그대로
    expect(at(704, 460)).toEqual({ width: 676, height: 230 });
    expect(at(704, 360)).toEqual({ width: 676, height: 200 });
    for (const hh of [120, 200, 300, 399]) expect(at(933, hh).height, `${hh}`).toBe(layout.chartMinH);
  });

  it("하한도 그 폭의 플래그 꺼짐 높이(폭 × 0.62)보다 높이지는 않는다 (2단 오른쪽 칸처럼 좁은 자리)", () => {
    expect(at(933, 300, 300)).toEqual({ width: 300, height: 186 });
    expect(at(933, 300, 250)).toEqual({ width: 250, height: 155 });
  });

  it("폭 599 ↔ 600 (좁음 ↔ 중간): 높이가 355 → 200 으로 뛰지 않는다 — 600 부터 chartCapRamp(96) 만큼에 걸쳐 서서히 낮춘다", () => {
    // 좁은 창(599)은 휴대폰 화면 그대로(예전 식 543), 600 은 잰 폭(572)을 쓰되 아직 높이 상한을 거의 쓰지 않는다
    expect(at(599, 400)).toEqual({ width: 543, height: 337 });
    expect(at(600, 400)).toEqual({ width: 572, height: 355 });
    // 창을 끌어 폭을 1dp 씩 바꿔도 높이는 3dp 넘게 뛰지 않는다 (낮은 창 400·300, 보통 창 704).
    // 단 599 → 600 한 번은 폭 식이 휴대폰 식 → 잰 폭으로 바뀌어 폭이 29dp, 높이가 그만큼(약 18dp) 달라진다 (접은 화면을 3-42 이전과 같게 둔 대가)
    for (const hh of [300, 400, 704]) {
      let prev = at(560, hh);
      for (let w = 561; w <= 960; w++) {
        const cur = at(w, hh);
        if (w === layout.mediumMin) {
          expect(cur.width - prev.width, `${w}×${hh}`).toBe(space.lg * 2 + 1);
          expect(Math.abs(cur.height - prev.height), `${w}×${hh}`).toBeLessThanOrEqual(Math.round((space.lg * 2 + 1) * layout.chartAspect) + 1);
        } else {
          expect(Math.abs(cur.height - prev.height), `${w}×${hh}`).toBeLessThanOrEqual(3);
        }
        prev = cur;
      }
    }
    // 600 + 96 = 696 부터 다 적용 (펼친 폴드8 세로 704 와 그 분할 창은 이미 다 적용)
    expect(at(layout.mediumMin + layout.chartCapRamp, 400).height).toBe(200);
    expect(at(704, 400).height).toBe(200);
    // 가운데(648)는 절반쯤
    const mid = at(648, 400);
    expect(mid.height).toBeGreaterThan(200);
    expect(mid.height).toBeLessThan(Math.round(mid.width * layout.chartAspect));
  });

  it("높은 창·펼친 화면은 그대로 (6가지 창 크기 표와 같은 값)", () => {
    expect(at(933, 704)).toEqual({ width: 905, height: 352 });
    expect(at(704, 933)).toEqual({ width: 676, height: 419 });
    expect(at(859, 954)).toEqual({ width: 831, height: 477 });
    expect(at(954, 859)).toEqual({ width: 926, height: 430 });
  });
});

describe("전체 화면 차트 머리 (headerNeedsTwoLines · chartHeaderLayout, 진단 8번 — 깨질 때만 고친다)", () => {
  const NAME = "한화에어로스페이스";
  const PRICE = "912,000원";
  // 화면과 같은 글자 (chart.tsx: formatPrice(change, sign) + 등락률)
  const CHANGE = "+12,000원 (+1.33%)";
  /** 전체 화면 차트 판의 좌우 여백 (chart.tsx pad = space.md) */
  const PAD = space.md * 2;
  /**
   * 한 줄 머리를 그렸을 때 잰 값 흉내 (React Native 의 줄 배치와 같게): 다 들어가면 글자 폭 그대로,
   * 넘치면 글자 묶음은 쓸 수 있는 폭까지만, 이름이 그만큼 줄어든다(가격·등락은 줄지 않는다).
   * 글꼴 폭은 어림(estimateTextWidth) × em — em 1 은 어림만큼 넓은 글꼴, 1 보다 작으면 좁은 글꼴
   */
  const oneLine = (o: { width: number; fontScale: number; name: string; price: string; change: string; buttons: number; em?: number }) => {
    const s = Math.min(Math.max(o.fontScale, 1), fontCap.chrome);
    const w = (text: string, size: number) => estimateTextWidth(text, size * s) * (o.em ?? 1);
    const room = o.width - headerButtonsRoom(o.buttons);
    const quote = space.sm + w(o.price, font.body) + space.sm + w(o.change, font.small);
    const name = w(o.name, font.h2);
    return name + quote <= room ? { title: name + quote, nameWidth: name } : { title: room, nameWidth: Math.max(0, room - quote) };
  };
  const decide = (winW: number, fontScale: number, buttons = 2, name = NAME, change = CHANGE, em = 1) => {
    const width = winW - PAD;
    return headerNeedsTwoLines({ width, buttons, fontScale, name, ...oneLine({ width, fontScale, name, price: PRICE, change, buttons, em }) });
  };

  it("다 들어가면 늘 한 줄 (3-42 이전 머리 그대로): 360 창 삼성전자 — 웹 미리보기에서 잰 폭(글자 묶음 227, 이름 59)", () => {
    // 이름 x12–71 · 가격 79–132.5 · 등락 140.5–239, 버튼은 280 부터 (머리 폭 336, 쓸 수 있는 폭 336 − 84 = 252)
    for (const buttons of [2, 1]) expect(headerNeedsTwoLines({ width: 360 - PAD, buttons, fontScale: 1, name: "삼성전자", title: 227, nameWidth: 59 }), `${buttons}`).toBe(false);
    // 예전 어림 기준(글자 폭을 넉넉히 어림해 합 342.7 > 336)은 이 머리를 두 줄로 내렸다 — 이제 어림으로는 정하지 않는다
    const est = estimateTextWidth("삼성전자", font.h2) + space.sm + estimateTextWidth("74,500원", font.body) + space.sm + estimateTextWidth("+1,200원 (+1.64%)", font.small);
    expect(est + headerButtonsRoom(2)).toBeGreaterThan(360 - PAD);
  });

  it("다 들어가면 이름이 짧아도(어림 네 글자보다 좁아도) 한 줄", () => {
    expect(headerNeedsTwoLines({ width: 336, buttons: 2, fontScale: 1.5, name: "LG", title: 150, nameWidth: 20 })).toBe(false);
    // 쓸 수 있는 폭보다 0.5 넘게 좁으면 다 들어간 것
    expect(headerNeedsTwoLines({ width: 336, buttons: 2, fontScale: 1, name: "삼성전자", title: 251.4, nameWidth: 10 })).toBe(false);
  });

  it("접힌 화면 100%·115%: 긴 이름은 넘쳐도 이름만 줄이면(…) 네 글자가 남아 한 줄", () => {
    expect(decide(475, 1)).toBe(false);
    expect(decide(411, 1)).toBe(false);
    expect(decide(475, 1.15)).toBe(false);
    // 411 은 넘치긴 한다 (예전 머리라면 가격이 쪼개지던 경우)
    const width = 411 - PAD;
    expect(oneLine({ width, fontScale: 1, name: NAME, price: PRICE, change: CHANGE, buttons: 2 }).title).toBe(width - headerButtonsRoom(2));
  });

  it("좁은 창 + 큰 글씨(접힌 화면 130% 이상): 이름에 네 글자도 남지 않아 두 줄", () => {
    for (const [w, s] of [
      [411, 1.15],
      [411, 1.3],
      [475, 1.3],
      [475, 1.5],
      [411, 2],
    ] as const) {
      expect(decide(w, s), `${w} ${s}`).toBe(true);
    }
  });

  it("넓은 창·돌려 그린 가로 판은 큰 글씨에서도 한 줄", () => {
    for (const w of [933, 704, 859, 954, 751, 960]) for (const s of [1, 1.3, 1.5, 2]) expect(decide(w, s), `${w} ${s}`).toBe(false);
  });

  it("버튼이 하나면(가로 창에서 가로로 보기를 숨김) 그만큼 한 줄에 더 들어간다", () => {
    expect(decide(411, 1.15, 2)).toBe(true);
    expect(decide(411, 1.15, 1)).toBe(false);
    expect(headerButtonsRoom(2)).toBe(2 * CHART_ICON_BTN + space.sm + space.sm);
    expect(headerButtonsRoom(1)).toBe(CHART_ICON_BTN + space.sm);
    expect(headerButtonsRoom(0)).toBe(0);
  });

  it("좁은 글꼴이면 같은 창에서도 한 줄에 더 들어간다 (어림이 아니라 잰 폭을 따른다)", () => {
    expect(decide(411, 1.15)).toBe(true);
    expect(decide(411, 1.15, 2, NAME, CHANGE, 0.8)).toBe(false);
  });

  it("이름이 지키는 폭: 앞 네 글자 + '…'(짧은 이름은 전부), 글자 배율은 fontCap.chrome 까지", () => {
    expect(NAME_MIN_CHARS).toBe(4);
    expect(nameMinWidth(NAME, 1)).toBe(estimateTextWidth("한화에어…", font.h2));
    expect(nameMinWidth(`${NAME}우선주`, 1)).toBe(nameMinWidth(NAME, 1));
    expect(nameMinWidth("삼성전자", 1)).toBe(estimateTextWidth("삼성전자", font.h2));
    expect(nameMinWidth("삼성전자", 1)).toBeLessThan(nameMinWidth(NAME, 1));
    expect(nameMinWidth(NAME, 2)).toBe(nameMinWidth(NAME, fontCap.chrome));
    expect(nameMinWidth(NAME, 0.85)).toBe(nameMinWidth(NAME, 1));
    // 넘쳤을 때: 이름 폭이 그보다 좁으면 두 줄, 같거나 넓으면 한 줄
    const room = 336 - headerButtonsRoom(2);
    const at = (nameWidth: number) => headerNeedsTwoLines({ width: 336, buttons: 2, fontScale: 1, name: NAME, title: room, nameWidth });
    expect(at(nameMinWidth(NAME, 1))).toBe(false);
    expect(at(nameMinWidth(NAME, 1) - 1)).toBe(true);
    expect(at(0)).toBe(true);
  });

  it("잰 값이 이상하면(NaN) 한 줄 (3-42 이전 머리)", () => {
    expect(headerNeedsTwoLines({ width: 336, buttons: 2, fontScale: 1, name: NAME, title: Number.NaN, nameWidth: 0 })).toBe(false);
    expect(headerNeedsTwoLines({ width: Number.NaN, buttons: 2, fontScale: 1, name: NAME, title: 300, nameWidth: 0 })).toBe(false);
  });

  it("머리 높이: 한 줄은 100~200% 모두 44 (3-42 이전과 같은 높이), 두 줄은 100% 59 · 130% 65 · 150% 이상 69", () => {
    for (const s of [0.85, 1, 1.15, 1.3, 1.5, 2]) expect(chartHeaderLayout({ fontScale: s, quote: true, twoLines: false }), `${s}`).toEqual({ twoLines: false, height: touch.min });
    expect([1, 1.3, 1.5, 2].map((s) => chartHeaderLayout({ fontScale: s, quote: true, twoLines: true }))).toEqual([
      { twoLines: true, height: 59 },
      { twoLines: true, height: 65 },
      { twoLines: true, height: 69 },
      { twoLines: true, height: 69 },
    ]);
    for (const s of [1, 1.15, 1.3, 1.5, 2]) {
      const c = Math.min(s, fontCap.chrome);
      const two = chartHeaderLayout({ fontScale: s, quote: true, twoLines: true });
      // 첫 줄(버튼 34 와 이름 중 높은 쪽) + 둘째 줄(가격 한 줄)이 머리 안에 들어간다 → 아래 도구 줄과 겹치지 않는다
      expect(two.height, `${s}`).toBeGreaterThanOrEqual(Math.max(CHART_ICON_BTN, font.h2 * LINE * c) + font.body * LINE * c);
      expect(chartHeaderLayout({ fontScale: s, quote: true, twoLines: false }).height, `${s}`).toBeGreaterThanOrEqual(font.h2 * LINE * c);
    }
  });

  it("시세가 없으면(이름만) 두 줄로 정했어도 한 줄", () => {
    expect(chartHeaderLayout({ fontScale: 2, quote: false, twoLines: true })).toEqual({ twoLines: false, height: touch.min });
  });

  it("글자 폭 어림: 한글은 숫자보다 넓고, 쉼표·공백은 좁다 (실제 글꼴보다 조금 넓게)", () => {
    expect(estimateTextWidth("가", 10)).toBeGreaterThan(estimateTextWidth("1", 10));
    expect(estimateTextWidth("1", 10)).toBeGreaterThan(estimateTextWidth(",", 10));
    // Roboto 숫자 폭 0.56em 보다 넓게 어림한다
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
