import { describe, expect, it } from "vitest";
import type { ReconcileBadgeBody } from "@/api/types";
import {
  bandActionWidth,
  bandBasisFit,
  bandCellWidth,
  basisTextWidth,
  DOT_MARK_W,
  lineCount,
  MARK_TEXT_SAMPLES,
  markTextWidth,
  MIN_FIT,
  panelBasisFit,
  SLACK,
  TOTAL_LINE,
  type BandCellText,
  type PanelFit,
} from "@/lib/basisFit";
import { reconcileBadge } from "@/lib/numberBasis";
import { font, space, touch } from "@/tokens";

/**
 * 숫자 기준 점 '큰 글씨면 점만' (3-32 다듬기, 사용자가 맡긴 결정 A) — 순수 함수.
 *  목표: 360·475(휴대폰)·704·933(넓은 창) × 글자 100·130·200% × 기본·촘촘에서 점을 켜도 줄 수가 꺼졌을 때와 같다.
 *  - 어림은 웹 미리보기에서 잰 자연 폭보다 작지 않다 (모자랄 쪽으로 틀리지 않게)
 *  - 켬·끔 줄 수를 같은 어림으로만 세면 순환 검증이라, '실제 폭 = 어림 ÷ k'(k 1~1.25 — 어림이 실제보다 넓은 만큼)로도 끔 ≥ 켬 을 본다
 *    (다듬기 1차는 어림 2줄 = 켬 2줄이면 옆에 두었는데, 실제 끔이 1줄이면 한 줄이 늘었다 — 384 × 130% 촘촘 +22dp)
 *  - 숫자는 웹 미리보기 가짜 서버 계좌 (총 67,050,074원 · 평가손익 +6,626,840원 +10.97% · 당일 +517,859원), 큰 계좌는 수량 20배(13억)
 */

const TOTAL = "67,050,074";
const LINE = "평가손익 +6,626,840원 +10.97% · 당일 +517,859원";
const BIG_TOTAL = "1,341,001,480";
const BIG_LINE = "평가손익 +132,536,800원 +10.97% · 당일 +10,357,180원";
const room = (w: number) => w - space.lg * 2;
const pct = (fs: number) => `${Math.round(fs * 100)}%`;
/** 어림이 실제보다 넓은 정도 — 1(어림 = 실제) · 웹 미리보기 실측(1.05~1.06) · 더 좁은 글꼴 */
const KS = [1, 1.04, 1.061, 1.08, 1.15, 1.25];

/** '평가손익 · 당일' 줄의 끔·켬 줄 수 — 실제 폭이 어림 ÷ k 일 때 (k = 1 이면 어림 그대로) */
function panelLines(f: PanelFit, line: string, w: number, fs: number, k = 1): { off: number; on: number } {
  const size = (font.small * Math.max(fs, 1)) / k;
  const off = lineCount(line, room(w), size);
  // 총액 줄 옆(total): 그 줄은 꺼졌을 때와 같은 폭 · 요약 옆(group): 점 칸(점만 44 · 점 + 글은 사이 space.sm 더) 만큼 좁다
  if (f.spot === "total") return { off, on: lineCount(line, room(w), size) };
  const mark = f.dotOnly ? DOT_MARK_W : space.sm + markTextWidth(fs);
  return { off, on: lineCount(line, room(w) - mark, size) };
}

describe("어림은 웹 미리보기에서 잰 폭보다 작지 않다 (최대 +25%)", () => {
  // 웹 미리보기(크롬 · 윈도 글꼴, 2026-09-28)에서 잰 자연 폭
  it.each([
    [LINE, font.small, 270.4],
    [LINE, font.small * 1.3, 351.5],
    [LINE, font.small * 2, 540.7],
  ])("'%s' %sdp → %sdp", (text, size, measured) => {
    const est = basisTextWidth(text, size);
    expect(est).toBeGreaterThanOrEqual(measured);
    expect(est).toBeLessThanOrEqual(measured * 1.25);
  });

  it("점 + '토스와 0.1% 이내' 칸 91.8dp(100%) 보다 가장 긴 글 칸이 넓다", () => {
    expect(markTextWidth(1)).toBeGreaterThanOrEqual(91.8);
    expect(markTextWidth(1.3)).toBeGreaterThanOrEqual(116.4);
    expect(markTextWidth(2)).toBeGreaterThanOrEqual(124.6);
  });

  // 704dp 띠에서 잰 칸 자연 폭의 합 (여백 포함)과 '비중' 버튼 + 앞 간격
  const SECOND: BandCellText[] = [
    { label: "국내", value: "31,451,550원", sub: "-17.36%", first: true },
    { label: "해외 · 환율 1,391.5", value: "$25,582.84", sub: "+55.20%" },
    { label: "매입금액", value: "60,423,234원" },
  ];
  const DENSE: BandCellText[] = [
    { label: "총 평가금액 · 비용 차감", value: TOTAL, unit: "원", big: true, first: true },
    { label: "평가손익 · 수익률", value: "+6,626,840원", sub: "+10.97%" },
    { label: "당일손익", value: "+517,859원", sub: "+0.78%" },
  ];
  it.each([
    [1, 382.6, 404.6, 76.1],
    [1.3, 484.9, 513.3, 82.7],
    [2, 518.9, 549.6, 98.2],
  ])("글자 %s: 둘째 줄 칸 %sdp · 촘촘 칸 %sdp · 비중 %sdp", (fs, second, dense, action) => {
    const sum = (cells: BandCellText[]) => cells.reduce((a, c) => a + bandCellWidth(c, fs), 0);
    expect(sum(SECOND)).toBeGreaterThanOrEqual(second);
    expect(sum(SECOND)).toBeLessThanOrEqual(second * 1.25);
    expect(sum(DENSE)).toBeGreaterThanOrEqual(dense);
    expect(sum(DENSE)).toBeLessThanOrEqual(dense * 1.25);
    expect(bandActionWidth(fs)).toBeGreaterThanOrEqual(action);
  });
});

describe("점 옆 글의 폭은 나올 수 있는 가장 긴 글로 잰다", () => {
  const SYNC = { enabled: true, intervalMin: 10, idleIntervalMin: 60, lastRunAt: null, nextRunAt: null };
  const body = (last: Partial<NonNullable<NonNullable<ReconcileBadgeBody["status"]>["last"]>> | null): ReconcileBadgeBody => ({
    on: true,
    status: { last: last ? { at: "2026-12-31T23:59:00+09:00", diffKrw: 1, diffPct: 0, missing: 0, n: 17, ...last } : null, streakOver: 0, qtyStreak: 0, week: { n: 0, withinPct: null }, alert: false },
    intraday: null,
    sync: SYNC,
  });
  it("모든 상태의 글이 MARK_TEXT_SAMPLES 의 가장 넓은 글보다 넓지 않다", () => {
    const widest = Math.max(...MARK_TEXT_SAMPLES.map((t) => basisTextWidth(t, 11)));
    const now = Date.parse("2027-01-01T10:00:00+09:00");
    const texts = [
      reconcileBadge(null, now).text,
      reconcileBadge(body(null), now).text,
      // 어제 23:59 기록 → '토스 대조 12/31 23:59'
      reconcileBadge(body({}), now).text,
      reconcileBadge(body({ at: "2027-01-01T09:59:00+09:00", qtyMismatch: ["A"] }), now).text,
      reconcileBadge(body({ at: "2027-01-01T09:59:00+09:00", missing: 3 }), now).text,
      reconcileBadge(body({ at: "2027-01-01T09:59:00+09:00", diffPct: -99.99 }), now).text,
      reconcileBadge(body({ at: "2027-01-01T09:59:00+09:00", diffPct: 0.104 }), now).text,
      reconcileBadge(body({ at: "2027-01-01T09:59:00+09:00", diffPct: 0.05 }), now).text,
    ];
    expect(texts).toContain("토스 대조 12/31 23:59");
    expect(texts).toContain("토스와 차이 99.99%");
    for (const t of texts) expect(basisTextWidth(t, 11), t).toBeLessThanOrEqual(widest);
  });
});

describe("lineCount: 띄어쓰기·한글 앞뒤에서만 줄을 바꾼다", () => {
  it("넉넉하면 1줄, 좁으면 숫자 덩어리는 쪼개지 않는다", () => {
    expect(lineCount(LINE, 1000, 12)).toBe(1);
    expect(lineCount(LINE, basisTextWidth(LINE, 12), 12)).toBe(1);
    expect(lineCount(LINE, basisTextWidth(LINE, 12) - 1, 12)).toBe(2);
    expect(lineCount("+6,626,840", 10, 12)).toBe(1);
    expect(lineCount(LINE, 0, 12)).toBe(Infinity);
  });
});

describe("휴대폰 계좌 패널 (기본): 총액 줄은 늘 한 줄 — 총액이 0.6 까지 줄어도 안 들어가 잘릴 때만 점만", () => {
  it.each([
    [360, 1, false],
    [360, 1.3, false],
    [360, 2, true],
    [475, 1, false],
    [475, 1.3, false],
    [475, 2, false],
  ])("%sdp 글자 %s → 점만 %s", (w, fs, dotOnly) => {
    const f = panelBasisFit({ width: w, fontScale: fs, total: TOTAL });
    expect(f).toEqual({ dotOnly, spot: "group", tuck: 0 });
    // 총액이 0.6 까지 줄면 점 칸 옆에 들어간다 (잘림 0)
    const mark = dotOnly ? DOT_MARK_W : markTextWidth(fs);
    const need = (basisTextWidth(TOTAL, font.hero * fs) + basisTextWidth(" 원", font.body * fs)) * 0.6;
    expect(need).toBeLessThanOrEqual(room(w) - space.sm - mark);
  });
});

describe("휴대폰 촘촘: 점 옆에서 한 줄일 때만 요약 옆, 아니면 총액 줄 옆 — '평가손익 · 당일' 줄 수가 꺼졌을 때와 같다", () => {
  const cases: [number, number, Pick<PanelFit, "dotOnly" | "spot">][] = [
    [360, 1, { dotOnly: true, spot: "group" }],
    [360, 1.3, { dotOnly: true, spot: "total" }],
    [360, 2, { dotOnly: true, spot: "total" }],
    [475, 1, { dotOnly: false, spot: "group" }],
    [475, 1.3, { dotOnly: true, spot: "group" }],
    [475, 2, { dotOnly: true, spot: "total" }],
  ];
  it.each(cases)("%sdp 글자 %s → %j, 줄 수 켬 = 끔", (w, fs, want) => {
    const f = panelBasisFit({ width: w, fontScale: fs, total: TOTAL, line: LINE });
    expect(f).toMatchObject(want);
    const { off, on } = panelLines(f, LINE, w, fs);
    expect(on, `${w} ${pct(fs)}`).toBe(off);
    // 요약 옆이면 그 줄은 점 옆에서도 한 줄 (어림)
    if (f.spot === "group") expect(on).toBe(1);
  });

  it("점 + 글이면 줄이 느는 자리(475 × 130% · 360 × 100%)는 점만 — 그 자리에서 글이었다면 한 줄이 늘었다", () => {
    for (const [w, fs] of [
      [475, 1.3],
      [360, 1],
    ] as const) {
      const off = lineCount(LINE, room(w), font.small * fs);
      expect(lineCount(LINE, room(w) - space.sm - markTextWidth(fs), font.small * fs)).toBeGreaterThan(off);
      expect(panelBasisFit({ width: w, fontScale: fs, total: TOTAL, line: LINE }).dotOnly).toBe(true);
    }
  });

  // 다듬기 1차의 새 줄 (웹 미리보기 검증에서 잰 것): 어림 2줄 = 점 옆 2줄이라 요약 옆에 두었는데, 실제로는 끈 줄이 1줄(또는 2줄)이었다
  it.each([
    ["384 × 130% (끈 줄 실제 1줄 → 켜서 2줄, +22dp)", 384, 1.3, TOTAL, LINE],
    ["360 × 200% · 13억 계좌 (끈 줄 실제 2줄 → 켜서 3줄, +35dp)", 360, 2, BIG_TOTAL, BIG_LINE],
  ])("%s → 이제 총액 줄 옆, 실제 폭(어림 ÷ 1.061)으로도 줄 수 같음", (_name, w, fs, total, line) => {
    const f = panelBasisFit({ width: w, fontScale: fs, total, line });
    expect(f.spot).toBe("total");
    const size = font.small * fs;
    // 어림으로는 끈 줄 = 점 옆 줄이라 예전 규칙(=== off)은 요약 옆을 골랐다
    expect(lineCount(line, room(w) - DOT_MARK_W, size)).toBe(lineCount(line, room(w), size));
    // 웹 미리보기 실측 폭(어림 ÷ 1.061)이면 점 옆에서 한 줄이 는다 — 그래서 옆에 두면 안 됐다
    const k = 1.061;
    expect(lineCount(line, room(w) - DOT_MARK_W, size / k)).toBe(lineCount(line, room(w), size / k) + 1);
    const { off, on } = panelLines(f, line, w, fs, k);
    expect(on).toBe(off);
  });

  it("웹 미리보기 실측: '평가손익 · 당일' 줄 15.6px 는 351.5dp (384 × 130% 의 끈 폭 356 에 한 줄) — 어림은 373 (두 줄로 셈)", () => {
    expect(basisTextWidth(LINE, font.small * 1.3)).toBeGreaterThan(room(384));
    expect(351.5).toBeLessThanOrEqual(room(384));
    expect(basisTextWidth(LINE, font.small * 1.3) / 351.5).toBeCloseTo(1.061, 2);
  });

  it("폭 320~480 × 글자 100~200% × 짧은·긴 계좌 × 실제 폭(어림 ÷ 1~1.25) 전부에서 줄 수 켬 = 끔 (새 줄 0, 끈 줄 수를 어림으로 세지 않음)", () => {
    const lines: [string, string][] = [
      [TOTAL, LINE],
      [BIG_TOTAL, BIG_LINE],
      ["1,234,567,890", "평가손익 +1,234,567,890원 +123.45% · 당일 -12,345,678원"],
      ["0", "평가손익 0원 0.00% · 당일 0원"],
    ];
    let checked = 0;
    for (const [total, line] of lines)
      for (let w = 320; w <= 480; w += 4)
        for (const fs of [1, 1.15, 1.3, 1.5, 1.75, 2]) {
          const f = panelBasisFit({ width: w, fontScale: fs, total, line });
          if (f.spot === "group") expect(panelLines(f, line, w, fs).on, `${line} ${w} ${pct(fs)}`).toBe(1);
          for (const k of KS) {
            const { off, on } = panelLines(f, line, w, fs, k);
            expect(on, `${line} ${w} ${pct(fs)} ÷${k} ${JSON.stringify(f)}`).toBe(off);
            checked += 1;
          }
        }
    expect(checked).toBe(4 * 41 * 6 * KS.length);
  });

  it("'평가손익 · 당일' 줄을 줄이거나 한 줄로 묶는 값이 없다 (3-39 '말줄임 없이 다음 줄로' 그대로)", () => {
    for (let w = 320; w <= 480; w += 8)
      for (const fs of [1, 1.15, 1.3, 2]) expect(Object.keys(panelBasisFit({ width: w, fontScale: fs, total: TOTAL, line: LINE })).sort()).toEqual(["dotOnly", "spot", "tuck"]);
  });

  it("총액 줄 옆이면 누르는 칸 44 와 총액 글 높이(어림 16 × 배율 × 1.5)의 차이 반만큼 위아래를 거둔다 — 줄이 두꺼워지지 않게", () => {
    for (const [w, fs, tuck] of [
      [360, 1.3, (touch.min - 16 * 1.3 * TOTAL_LINE) / 2],
      [384, 1.15, (touch.min - 16 * 1.15 * TOTAL_LINE) / 2],
      [360, 2, 0],
    ] as const) {
      const f = panelBasisFit({ width: w, fontScale: fs, total: TOTAL, line: fs === 1.15 ? BIG_LINE : LINE });
      expect(f.spot, `${w} ${pct(fs)}`).toBe("total");
      expect(f.tuck).toBeCloseTo(tuck, 5);
      // 거둔 뒤 줄이 차지하는 높이 = min(44, 총액 글 높이 어림) — 안드로이드 Roboto 글자 여백 포함(1.33배)보다 낮지 않다 (총액 글이 위아래 줄과 겹치지 않게)
      const slot = touch.min - 2 * f.tuck;
      expect(slot).toBeGreaterThanOrEqual(Math.min(touch.min, font.h2 * fs * 1.33));
    }
    // 요약 옆이면 거두지 않는다
    expect(panelBasisFit({ width: 475, fontScale: 1.3, total: TOTAL, line: LINE })).toMatchObject({ spot: "group", tuck: 0 });
  });
});

describe("넓은 창 띠: 점 줄의 칸이 꺼졌을 때처럼 한 줄 · 끄고 줄바꿈하는 띠는 켜도 줄바꿈", () => {
  const SECOND: BandCellText[] = [
    { label: "국내", value: "31,451,550원", sub: "-17.36%", first: true },
    { label: "해외 · 환율 1,391.5", value: "$25,582.84", sub: "+55.20%" },
    { label: "매입금액", value: "60,423,234원" },
  ];
  const DENSE: BandCellText[] = [
    { label: "총 평가금액 · 비용 차감", value: TOTAL, unit: "원", big: true, first: true },
    { label: "평가손익 · 수익률", value: "+6,626,840원", sub: "+10.97%" },
    { label: "당일손익", value: "+517,859원", sub: "+0.78%" },
  ];
  // 수량 20배(13억) 계좌
  const SECOND_BIG: BandCellText[] = [
    { label: "국내", value: "629,031,000원", sub: "-17.36%", first: true },
    { label: "해외 · 환율 1,391.5", value: "$511,656.80", sub: "+55.20%" },
    { label: "매입금액", value: "1,208,464,680원" },
  ];
  const DENSE_BIG: BandCellText[] = [
    { label: "총 평가금액 · 비용 차감", value: BIG_TOTAL, unit: "원", big: true, first: true },
    { label: "평가손익 · 수익률", value: "+132,536,800원", sub: "+10.97%" },
    { label: "당일손익", value: "+10,357,180원", sub: "+0.78%" },
  ];
  const SETS = { SECOND, DENSE, SECOND_BIG, DENSE_BIG };
  const sumOf = (cells: readonly BandCellText[], fs: number) => cells.reduce((a, c) => a + bandCellWidth(c, fs), 0);
  const inner = (w: number, fs: number) => w - space.md * 2 - bandActionWidth(fs);
  /** 칸 줄 수 (flexWrap: 칸 자연 폭을 차례로 채움) — 실제 폭이 어림 ÷ k 일 때 */
  const rows = (cells: readonly BandCellText[], width: number, fs: number, k = 1) => {
    let n = 1;
    let x = 0;
    for (const c of cells) {
      const w = bandCellWidth(c, fs) / k;
      if (x > 0 && x + w > width) {
        n += 1;
        x = w;
      } else x += w;
    }
    return n;
  };
  /** 켠 칸 줄 수: 줄바꿈을 막으면 1, 아니면 점 칸만큼 좁은 폭에서 */
  const rowsOn = (f: { dotOnly: boolean; noWrap: boolean }, cells: readonly BandCellText[], w: number, fs: number, k = 1) =>
    f.noWrap ? 1 : rows(cells, inner(w, fs) - (f.dotOnly ? DOT_MARK_W : markTextWidth(fs)), fs, k);

  // [띠 폭(표 폭), 글자, 둘째 줄 점만, 촘촘 점만] — 933 × 130·200% 는 두 줄 띠(한 줄 띠는 800 × 배율 이상)
  it.each([
    [704, 1, false, false],
    [704, 1.3, true, true],
    [704, 2, true, true],
    [933, 1.3, false, false],
    [933, 2, false, false],
  ])("%sdp 글자 %s → 둘째 줄 점만 %s · 촘촘 점만 %s, 켠 줄 수 1 ≤ 끈 줄 수", (w, fs, secondDot, denseDot) => {
    for (const [cells, dot] of [
      [SECOND, secondDot],
      [DENSE, denseDot],
    ] as const) {
      const f = bandBasisFit({ width: w, pad: space.md, fontScale: fs, cells, action: true });
      expect(f.dotOnly).toBe(dot);
      // 끈 줄 수 (어림 — 넉넉히 잡아 704 × 200% 촘촘은 2 로 나오지만 웹 미리보기 실측은 1 · 여유를 뺀 어림도 1)
      const off = rows(cells, inner(w, fs), fs);
      const on = rowsOn(f, cells, w, fs);
      expect(on).toBe(1);
      expect(on).toBeLessThanOrEqual(off);
      // 이 자리는 모두 끄고도 한 줄(여유를 뺀 어림) → 줄바꿈을 막고, 칸 글자는 MIN_FIT 까지 줄어서 들어간다
      expect(f.noWrap).toBe(true);
      expect(sumOf(cells, fs) / SLACK).toBeLessThanOrEqual(inner(w, fs));
      expect(sumOf(cells, fs) * MIN_FIT + (f.dotOnly ? DOT_MARK_W : markTextWidth(fs))).toBeLessThanOrEqual(inner(w, fs));
    }
  });

  it("점 + 글이면 줄이 늘던 704 × 130·200% 는 점만 (그 자리에서 글이었다면 칸이 두 줄)", () => {
    for (const fs of [1.3, 2]) {
      expect(rows(SECOND, inner(704, fs) - markTextWidth(fs), fs)).toBe(2);
      expect(rows(DENSE, inner(704, fs) - markTextWidth(fs), fs)).toBe(2);
    }
  });

  // 다듬기 1차의 회귀 (웹 미리보기 검증에서 잰 것): 끄면 칸이 다음 줄로 가는 띠도 켜면 줄바꿈을 막아 한 줄로 누르고 칸 글자를 0.82~0.86배로 줄였다
  it.each([
    ["600 × 130% 촘촘 띠 (116 → 55dp · 0.86배)", 600, 1.3, DENSE],
    ["600 × 200% 두 줄 띠 둘째 줄 (186 → 120dp · 0.82배)", 600, 2, SECOND],
    ["704 × 200% 촘촘 띠 · 13억 (124 → 58dp · 0.85배)", 704, 2, DENSE_BIG],
  ])("%s → 이제 줄바꿈 그대로 · 점만, 칸 줄 수 켬 = 끔", (_name, w, fs, cells) => {
    const f = bandBasisFit({ width: w, pad: space.md, fontScale: fs, cells, action: true });
    expect(f).toEqual({ dotOnly: true, noWrap: false });
    // 여유를 뺀 어림(≈ 웹 미리보기 실측)으로도 끄면 두 줄
    expect(sumOf(cells, fs) / SLACK).toBeGreaterThan(inner(w, fs));
    for (const k of [SLACK, 1.08]) {
      const off = rows(cells, inner(w, fs), fs, k);
      expect(off, `÷${k}`).toBe(2);
      expect(rowsOn(f, cells, w, fs, k), `÷${k}`).toBe(off);
    }
  });

  it("704 × 200% 촘촘(보통 금액)은 여전히 줄바꿈을 막는다 — 끄고 한 줄(실측 549.6 ≤ 576), 점만 더하면 두 줄이 되던 곳(+61dp)", () => {
    const f = bandBasisFit({ width: 704, pad: space.md, fontScale: 2, cells: DENSE, action: true });
    expect(f).toEqual({ dotOnly: true, noWrap: true });
    expect(549.6).toBeLessThanOrEqual(inner(704, 2));
    expect(rows(DENSE, inner(704, 2) - DOT_MARK_W, 2, SLACK)).toBe(2);
  });

  // 넓은 창 띠는 창 폭 600 부터 (tokens windowClass.mediumMin). 그보다 좁은 표 폭(560·568 × 150%+ · 13억)은 점 칸 44 때문에 칸이 세 줄이 될 수 있다
  it("폭 600~960 × 글자 100~200% × 네 계좌: 줄바꿈을 막는 것은 끄고 한 줄일 때만 (실제 폭 = 어림 ÷ 1.05~1.25)", () => {
    for (const [name, cells] of Object.entries(SETS))
      for (let w = 600; w <= 960; w += 8)
        for (const fs of [1, 1.15, 1.3, 1.5, 1.75, 2]) {
          const f = bandBasisFit({ width: w, pad: space.md, fontScale: fs, cells, action: true });
          for (const k of [SLACK, 1.061, 1.08, 1.15, 1.25]) {
            const off = rows(cells, inner(w, fs), fs, k);
            const at = `${name} ${w} ${pct(fs)} ÷${k}`;
            // 줄바꿈을 막으면(한 줄로 누름) 끈 띠도 한 줄이었다 — 끄고 두 줄인 띠를 켜서 한 줄로 누르지 않는다
            if (f.noWrap) expect(off, at).toBe(1);
          }
          // 웹 미리보기 실측(어림 ÷ 1.05 안팎)에서는 켠 칸 줄 수가 끈 줄 수와 같다
          const off = rows(cells, inner(w, fs), fs, SLACK);
          expect(rowsOn(f, cells, w, fs, SLACK), `${name} ${w} ${pct(fs)}`).toBe(off);
        }
  });

  it("'비중' 버튼이 없으면 그만큼 넓게 본다", () => {
    const withA = bandBasisFit({ width: 704, pad: space.md, fontScale: 1.3, cells: SECOND, action: true });
    const without = bandBasisFit({ width: 704 - bandActionWidth(1.3), pad: space.md, fontScale: 1.3, cells: SECOND, action: false });
    expect(without).toEqual(withA);
  });
});
