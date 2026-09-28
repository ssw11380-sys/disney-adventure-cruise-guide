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
  type BandCellText,
  type PanelFit,
} from "@/lib/basisFit";
import { reconcileBadge } from "@/lib/numberBasis";
import { font, space } from "@/tokens";

/**
 * 숫자 기준 점 '큰 글씨면 점만' (3-32 다듬기, 사용자가 맡긴 결정 A) — 순수 함수.
 *  목표: 360·475(휴대폰)·704·933(넓은 창) × 글자 100·130·200% × 기본·촘촘에서 점을 켜도 줄 수가 꺼졌을 때와 같다.
 *  - 줄 수는 같은 어림(basisTextWidth·lineCount)으로 켬/끔을 비교한다 (웹 미리보기 캡처가 실제 높이를 따로 잰다)
 *  - 어림은 웹 미리보기에서 잰 자연 폭보다 작지 않다 (모자랄 쪽으로 틀리지 않게)
 *  - 숫자는 웹 미리보기 가짜 서버 계좌 (총 67,050,074원 · 평가손익 +6,626,840원 +10.97% · 당일 +517,859원)
 */

const TOTAL = "67,050,074";
const LINE = "평가손익 +6,626,840원 +10.97% · 당일 +517,859원";
const room = (w: number) => w - space.lg * 2;
const pct = (fs: number) => `${Math.round(fs * 100)}%`;

/** 켠 뒤 '평가손익 · 당일' 줄의 줄 수 (점 자리·모양에 따라) */
function linesOn(f: PanelFit, w: number, fs: number): number {
  const size = font.small * Math.max(fs, 1);
  if (f.spot === "total") return lineCount(LINE, room(w), size);
  const mark = f.dotOnly ? DOT_MARK_W : space.sm + markTextWidth(fs);
  const r = room(w) - mark;
  // 한 줄로 두고 글자를 줄이는 경우 (fitLine) — MIN_FIT 까지 줄여 들어가야 한다
  if (f.fitLine) {
    expect(basisTextWidth(LINE, size) * MIN_FIT).toBeLessThanOrEqual(r);
    return 1;
  }
  return lineCount(LINE, r, size);
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
    expect(f).toEqual({ dotOnly, spot: "group", fitLine: false });
    // 총액이 0.6 까지 줄면 점 칸 옆에 들어간다 (잘림 0)
    const mark = dotOnly ? DOT_MARK_W : markTextWidth(fs);
    const need = (basisTextWidth(TOTAL, font.hero * fs) + basisTextWidth(" 원", font.body * fs)) * 0.6;
    expect(need).toBeLessThanOrEqual(room(w) - space.sm - mark);
  });
});

describe("휴대폰 촘촘: '평가손익 · 당일' 줄 수가 꺼졌을 때와 같다", () => {
  const cases: [number, number, Pick<PanelFit, "dotOnly" | "spot">][] = [
    [360, 1, { dotOnly: true, spot: "group" }],
    [360, 1.3, { dotOnly: true, spot: "group" }],
    [360, 2, { dotOnly: true, spot: "total" }],
    [475, 1, { dotOnly: false, spot: "group" }],
    [475, 1.3, { dotOnly: true, spot: "group" }],
    [475, 2, { dotOnly: true, spot: "group" }],
  ];
  it.each(cases)("%sdp 글자 %s → %j, 줄 수 켬 = 끔", (w, fs, want) => {
    const f = panelBasisFit({ width: w, fontScale: fs, total: TOTAL, line: LINE });
    expect(f).toMatchObject(want);
    const off = lineCount(LINE, room(w), font.small * fs);
    expect(linesOn(f, w, fs), `${w} ${pct(fs)}`).toBe(off);
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

  it("폭 320~480 × 글자 100~200% × 짧은·긴 계좌 전부에서 줄 수 켬 = 끔 (새 줄 0)", () => {
    const lines = [LINE, "평가손익 +1,234,567,890원 +123.45% · 당일 -12,345,678원", "평가손익 0원 0.00% · 당일 0원"];
    for (const line of lines)
      for (let w = 320; w <= 480; w += 4)
        for (const fs of [1, 1.15, 1.3, 1.5, 1.75, 2]) {
          const f = panelBasisFit({ width: w, fontScale: fs, total: "1,234,567,890", line });
          const size = font.small * fs;
          const off = lineCount(line, room(w), size);
          let on: number;
          if (f.spot === "total") on = lineCount(line, room(w), size);
          else if (f.fitLine) on = basisTextWidth(line, size) * MIN_FIT <= room(w) - (f.dotOnly ? DOT_MARK_W : space.sm + markTextWidth(fs)) ? 1 : Infinity;
          else on = lineCount(line, room(w) - (f.dotOnly ? DOT_MARK_W : space.sm + markTextWidth(fs)), size);
          expect(on, `${line} ${w} ${pct(fs)} ${JSON.stringify(f)}`).toBe(off);
        }
  });
});

describe("넓은 창 띠: 점 줄의 칸이 꺼졌을 때처럼 한 줄", () => {
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
  /** 칸 줄 수 (flexWrap: 칸 자연 폭을 차례로 채움) */
  const rows = (cells: readonly BandCellText[], width: number, fs: number) => {
    let n = 1;
    let x = 0;
    for (const c of cells) {
      const w = bandCellWidth(c, fs);
      if (x > 0 && x + w > width) {
        n += 1;
        x = w;
      } else x += w;
    }
    return n;
  };
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
      const inner = w - space.md * 2 - bandActionWidth(fs);
      // 끈 줄 수 (어림 — 넉넉히 잡아 704 × 200% 촘촘은 2 로 나오지만 웹 미리보기 실측은 1)
      const off = rows(cells, inner, fs);
      const mark = f.dotOnly ? DOT_MARK_W : markTextWidth(fs);
      const on = f.noWrap ? 1 : rows(cells, inner - mark, fs);
      expect(on).toBe(1);
      expect(on).toBeLessThanOrEqual(off);
      // 줄바꿈을 막으면 칸 글자가 MIN_FIT 까지 줄어서 들어간다
      if (f.noWrap) expect(cells.reduce((a, c) => a + bandCellWidth(c, fs), 0) * MIN_FIT + mark).toBeLessThanOrEqual(inner);
    }
  });

  it("점 + 글이면 줄이 늘던 704 × 130·200% 는 점만 (그 자리에서 글이었다면 칸이 두 줄)", () => {
    for (const fs of [1.3, 2]) {
      const inner = 704 - space.md * 2 - bandActionWidth(fs);
      expect(rows(SECOND, inner - markTextWidth(fs), fs)).toBe(2);
      expect(rows(DENSE, inner - markTextWidth(fs), fs)).toBe(2);
    }
  });

  it("'비중' 버튼이 없으면 그만큼 넓게 본다", () => {
    const withA = bandBasisFit({ width: 704, pad: space.md, fontScale: 1.3, cells: SECOND, action: true });
    const without = bandBasisFit({ width: 704 - bandActionWidth(1.3), pad: space.md, fontScale: 1.3, cells: SECOND, action: false });
    expect(without).toEqual(withA);
  });
});
