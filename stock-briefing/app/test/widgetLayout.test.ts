import { describe, expect, it } from "vitest";
import {
  charEm,
  headerRoom,
  indexItemWidth,
  indexSepWidth,
  lineHeight,
  listSize,
  assetSize,
  PAD,
  planAsset,
  planBriefing,
  planHoldings,
  textWidth,
  type AssetInput,
  type AssetPlan,
  type HoldingsInput,
  type HoldingsPlan,
  type IndexInput,
} from "@/widgets/layout";
import { WIDGET_FONT as F, WIDGET_TOUCH as TOUCH } from "@/widgets/palette";
import { space } from "@/tokens";

/**
 * 3-23 크기별 배치: 2×1·4×2·4×4 × 글자 100·130% 에서 숫자가 잘리지 않는다.
 * 글자 폭은 layout.ts 의 보수적 어림(실제 글꼴보다 넓게)으로 재고, 칸이 모자라면 글자를 줄이거나 덜 중요한 칸을 뺐는지 본다.
 * 크기는 안드로이드 칸 공식(70×n − 30 dp)의 최소값(= app.json 의 minWidth·minHeight)과 흔한 실제 크기 둘 다.
 */

const SCALES = [1, 1.3] as const;

/** 위젯 칸 크기 (dp): 최소값(app.json)과 흔한 실제 크기 */
const SIZES = {
  "2x1": [
    { width: 110, height: 40 },
    { width: 160, height: 72 },
  ],
  "4x2": [
    { width: 250, height: 110 },
    { width: 330, height: 180 },
  ],
  "4x4": [
    { width: 250, height: 250 },
    { width: 330, height: 380 },
  ],
} as const;

// ── 긴 값 (실제로 나올 수 있는 가장 긴 쪽) ──
const LONG_TOTAL = "123,456,789원";
const INDICES: IndexInput[] = [
  { label: "코스피", value: "3,412.35", rate: "+0.90%", stale: false },
  { label: "나스닥", value: "26,936.04", rate: "-1.13%", stale: true },
  { label: "환율", value: "1,360.50", rate: null, stale: false },
];
const ROWS = [
  { name: "TIGER 미국필라델피아반도체나스닥", price: "1,234,000원", rate: "+12.34%", subs: ["이전 값 · -12.34% -1,234,567원", "이전 값 · -12.34%", "-12.34%"] },
  { name: "버티브 홀딩스", price: "$12,345.67", rate: "-29.99%", subs: ["+123.45% +$12,345.67", "+123.45%"] },
  { name: "삼성전자", price: "72,000원", rate: "+1.50%", subs: ["+2.86% +20,000원", "+2.86%"] },
  { name: "관심종목", price: "5,000원", rate: "0.00%", subs: ["관심"] },
  { name: "시세없는종목", price: "-", rate: null, subs: ["1,234.5678주 · 시세 없음", "시세 없음"] },
];

function holdingsInput(width: number, height: number, scale: number, mode: "cumulative" | "day" = "cumulative", toggle = true): HoldingsInput {
  return {
    width,
    height,
    scale,
    header: { title: "잔고 18", chip: "한국 장중", sub: ["9/23 15:30 기준", "9/23 15:30", "15:30"], delayed: true },
    total: mode === "day" ? { total: LONG_TOTAL, amount: "당일 -2,868,108원", rate: "(-3.78%)", toggle } : { total: LONG_TOTAL, amount: "누적 -12,345,678원", rate: "(-12.34%)", toggle },
    indices: INDICES,
    rows: ROWS,
    note: ["갱신 실패 · 연결 안 됨", "17종목 이전 값", "일부 제외 3"],
  };
}

/** 계획대로 그렸을 때 칸을 넘는 글자 목록 (없어야 한다) */
function holdingsOverflow(i: HoldingsInput, p: HoldingsPlan): string[] {
  const bad: string[] = [];
  const s = i.scale;
  const content = i.width - PAD * 2;
  // 머리: 제목·칩·기준 시각·지연 + 간격 ≤ ↻ 칸을 뺀 폭
  const head = [textWidth(i.header.title, F.title, s, true)];
  if (p.header.chip) head.push(textWidth(i.header.chip!, F.xs, s, true) + space.xs * 2 + 2);
  if (p.header.sub) head.push(textWidth(p.header.sub, F.sm, s));
  if (p.header.delayed) head.push(textWidth("지연", F.sm, s, true));
  const headW = head.reduce((a, b) => a + b, 0) + space.s * (head.length - 1);
  if (headW > headerRoom(i.width)) bad.push(`머리 ${headW.toFixed(0)} > ${headerRoom(i.width)}`);
  // 합계·손익
  if (p.total) {
    const t = textWidth(i.total!.total, p.total.totalFont, s, true);
    const pnl = Math.max(...p.total.pnl.map((l) => textWidth(l, p.total!.pnlFont, s, true))) + p.total.pnlPadX * 2;
    const w = p.total.inline ? t + space.sm + pnl : Math.max(t, pnl);
    if (w > content) bad.push(`합계 줄 ${w.toFixed(0)} > ${content}`);
    // 금액·수익률은 빠지지 않는다 (줄이거나 두 줄로만)
    const joined = p.total.pnl.join(" ");
    if (!joined.includes(i.total!.amount) || (i.total!.rate && !joined.includes(i.total!.rate))) bad.push(`손익 빠짐 ${joined}`);
    if (!i.total!.toggle && p.total.pnlPadX) bad.push("전환이 꺼졌는데 누르는 칸 여백");
    if (i.total!.toggle && p.total.pnlH < TOUCH) bad.push(`손익 누르는 칸 ${p.total.pnlH} < 48`);
  }
  // 지수 줄
  for (const line of p.index?.lines ?? []) {
    const w = line.reduce((a, it) => a + indexItemWidth(it, p.index!.font, s), 0) + indexSepWidth(p.index!.font, s) * (line.length - 1);
    if (w > content) bad.push(`지수 줄 ${w.toFixed(0)} > ${content}`);
  }
  // 메모
  if (p.note && textWidth(p.note, F.sm, s) > content) bad.push(`메모 ${p.note}`);
  // 목록 줄: 가격·등락률은 늘 보이고, 손익 줄은 왼쪽 칸 안에
  const r = p.rows;
  i.rows.forEach((row, n) => {
    const price = textWidth(row.price, F.base, s, true);
    const rate = row.rate ? textWidth(row.rate, F.md, s, true) : 0;
    if (rate > r.rateW) bad.push(`등락률 칸 ${row.rate} ${rate.toFixed(0)} > ${r.rateW}`);
    const right = r.stacked ? Math.max(price, r.rateW) : price + space.sm + r.rateW;
    if (r.leftW + space.sm + right > content) bad.push(`줄 ${row.name} ${r.leftW + space.sm + right} > ${content}`);
    const sub = r.sub[n];
    if (sub && textWidth(sub, r.subFont, s) > r.leftW) bad.push(`손익 줄 ${sub}`);
    if (sub && !row.subs.includes(sub)) bad.push(`모르는 손익 줄 ${sub}`);
  });
  return bad;
}

function assetInput(width: number, height: number, scale: number): AssetInput {
  return {
    width,
    height,
    scale,
    label: "총 평가",
    chip: "한국 장중",
    asOf: ["지연 · 9/23 15:30 기준", "지연 · 9/23 15:30", "지연 · 15:30", "지연"],
    total: LONG_TOTAL,
    day: { text: "오늘 -2,868,108원", value: "-2,868,108원" },
    cum: "총 -12,345,678원",
    note: ["갱신 실패 · 연결 안 됨", "17종목 이전 값"],
  };
}

function assetOverflow(i: AssetInput, p: AssetPlan): string[] {
  const bad: string[] = [];
  const s = i.scale;
  const content = i.width - p.pad * 2;
  if (p.top) {
    const left = (p.top.label ? textWidth(i.label, F.sm, s, true) : 0) + (p.top.chip ? space.xs + textWidth(i.chip!, F.xs, s, true) + space.xs * 2 + 2 : 0);
    const right = p.top.asOf ? textWidth(p.top.asOf, F.xs, s) : 0;
    if (left + (left && right ? space.xs : 0) + right > content) bad.push("윗줄");
  }
  if (textWidth(i.total!, p.totalFont, s, true) > content) bad.push(`합계 ${p.totalFont}`);
  if (p.line === "both" && textWidth(i.day!.text, p.lineFont, s, true) + space.xs * 2 + textWidth("·", p.lineFont, s) + textWidth(i.cum!, p.lineFont, s, true) > content) bad.push("손익 줄");
  if (p.line === "day" && textWidth(i.day!.text, p.lineFont, s, true) > content) bad.push("오늘 줄");
  if (p.line === "dayValue" && textWidth(i.day!.value, p.lineFont, s, true) > content) bad.push("오늘 값");
  if (p.note && textWidth(p.note, F.xs, s) > content) bad.push("메모");
  return bad;
}

describe("3-23 글자 폭 어림은 실제 글꼴보다 넓다 (보수적)", () => {
  // Roboto 전진 폭(em, 2048 단위 환산)과 본고딕(Noto Sans CJK KR) 한글 폭
  const ROBOTO: [string, number][] = [
    ["0", 0.5615],
    ["9", 0.5615],
    [",", 0.1968],
    [".", 0.2632],
    ["%", 0.7324],
    ["+", 0.5669],
    ["-", 0.2759],
    ["(", 0.3418],
    ["$", 0.5615],
    [" ", 0.2476],
    [":", 0.2422],
    ["/", 0.4121],
    ["가", 0.92],
    ["원", 0.92],
  ];
  for (const [ch, em] of ROBOTO) it(`'${ch}' ${em}em 이상`, () => expect(charEm(ch)).toBeGreaterThanOrEqual(em));
  it("굵은 글자·배율·여유가 폭에 들어간다", () => {
    expect(textWidth("123", 10, 1)).toBeCloseTo(0.6 * 3 * 10 + 2, 6);
    expect(textWidth("123", 10, 1.3, true)).toBeGreaterThan(textWidth("123", 10, 1.3));
    expect(lineHeight(10, 1.3)).toBeGreaterThanOrEqual(10 * 1.3 * 1.17); // Roboto 줄 높이 이상
  });
});

describe("3-23 크기 단계", () => {
  it("잔고·브리핑은 높이(4×2 최소 110 → compact, 4×4 250 → large), 자산은 폭", () => {
    expect(listSize(110)).toBe("compact");
    expect(listSize(180)).toBe("regular");
    expect(listSize(250)).toBe("large");
    expect(assetSize(110)).toBe("compact");
    expect(assetSize(160)).toBe("regular");
    expect(assetSize(250)).toBe("large");
  });
});

describe("3-23 잔고 위젯: 4×2·4×4 × 글자 100·130% 숫자 잘림 0", () => {
  for (const size of ["4x2", "4x4"] as const)
    for (const box of SIZES[size])
      for (const scale of SCALES)
        for (const mode of ["cumulative", "day"] as const)
          it(`${size} ${box.width}×${box.height} · ${scale * 100}% · ${mode === "day" ? "당일" : "누적"}`, () => {
            const input = holdingsInput(box.width, box.height, scale, mode);
            const plan = planHoldings(input);
            expect(holdingsOverflow(input, plan)).toEqual([]);
            // 제목·합계·손익·모든 줄의 가격은 빠지지 않는다
            expect(plan.total).not.toBeNull();
          });

  it("좁을수록 칩 → 기준 시각 줄임 → 손익 두 줄·합계 아래로 순서로 줄인다 (숫자를 자르지 않고)", () => {
    const wide = planHoldings(holdingsInput(420, 300, 1));
    expect(wide.header).toMatchObject({ chip: true, sub: "9/23 15:30 기준", delayed: true });
    expect(wide.total!.inline).toBe(true);
    const narrow = planHoldings(holdingsInput(250, 250, 1.3));
    expect(narrow.header.delayed).toBe(true); // "지연"은 늘 남긴다
    expect(narrow.header.chip).toBe(false);
    expect(narrow.total!.inline).toBe(false); // 합계 아래로
    expect(narrow.total!.totalFont).toBeGreaterThanOrEqual(F.md);
  });

  it("지수 줄: compact(4×2 최소)에서는 감추고, 넓으면 세 항목, 좁으면 뒤(환율)부터 뺀다. 두 줄은 large 만", () => {
    expect(planHoldings(holdingsInput(250, 110, 1)).index).toBeNull();
    const wide = planHoldings(holdingsInput(420, 220, 1)).index!;
    expect(wide.lines.flat().map((i) => i.label)).toEqual(["코스피", "나스닥", "환율"]);
    expect(wide.lines).toHaveLength(1);
    const narrow = planHoldings(holdingsInput(250, 230, 1)).index!;
    expect(narrow.lines).toHaveLength(1);
    expect(narrow.lines[0]![0]!.label).toBe("코스피");
    expect(narrow.lines[0]!.length).toBeLessThan(3);
    const large = planHoldings(holdingsInput(340, 380, 1.3)).index!;
    expect(large.lines.flat().map((i) => i.label)).toEqual(["코스피", "나스닥", "환율"]); // 두 줄로 모두
    expect(large.lines.length).toBe(2);
    // regular 라도 줄을 넣으면 목록이 한 줄도 안 보이는 높이면 감춘다
    expect(planHoldings(holdingsInput(250, 160, 1.3)).index).toBeNull();
  });

  it("폭 250~420dp, 높이 110~420dp, 글자 90~130% 어디서도 넘치지 않는다", () => {
    const bad: string[] = [];
    for (let w = 250; w <= 420; w += 10)
      for (let h = 110; h <= 420; h += 30)
        for (const s of [0.9, 1, 1.15, 1.3]) {
          const input = holdingsInput(w, h, s);
          const o = holdingsOverflow(input, planHoldings(input));
          if (o.length) bad.push(`${w}×${h}@${s}: ${o.join(", ")}`);
        }
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it("손익 전환이 꺼져 있으면 누르는 칸(48dp)을 두지 않는다 (예전과 같은 높이)", () => {
    const p = planHoldings(holdingsInput(330, 180, 1, "cumulative", false));
    expect(p.total!.pnlPadX).toBe(0);
    expect(p.total!.pnlH).toBeLessThan(TOUCH);
  });
});

describe("3-23 브리핑 위젯: 크기별 종목 수·요약 줄 수", () => {
  const header = { title: "브리핑", chip: "한국 장중", sub: ["9/23 15:30 기준", "9/23 15:30", "15:30"], delayed: false };
  for (const size of ["4x2", "4x4"] as const)
    for (const box of SIZES[size])
      for (const scale of SCALES)
        it(`${size} ${box.width}×${box.height} · ${scale * 100}%: 머리가 들어가고 종목 1~3`, () => {
          const p = planBriefing({ ...box, scale, header, count: 3 });
          expect(p.items).toBeGreaterThanOrEqual(1);
          expect(p.items).toBeLessThanOrEqual(3);
          const head = [textWidth("브리핑", F.title, scale, true), p.header.chip ? textWidth("한국 장중", F.xs, scale, true) + space.xs * 2 + 2 : 0, p.header.sub ? textWidth(p.header.sub, F.sm, scale) : 0].filter(Boolean);
          expect(head.reduce((a, b) => a + b, 0) + space.s * (head.length - 1)).toBeLessThanOrEqual(headerRoom(box.width));
          // 날짜(" · 09/24 오후")는 이름을 줄여서라도 늘 들어간다
          expect(textWidth(" · 09/24 오후", F.sm, scale, true)).toBeLessThan(box.width - PAD * 2);
        });
  it("4×2 최소는 1종목, 4×4 는 3종목·요약 두 줄", () => {
    expect(planBriefing({ width: 250, height: 110, scale: 1, header, count: 3 }).items).toBe(1);
    const large = planBriefing({ width: 330, height: 380, scale: 1, header, count: 3 });
    expect(large).toMatchObject({ size: "large", items: 3, summaryLines: 2 });
  });
});

describe("3-23 자산 위젯(2×1) × 글자 100·130% 숫자 잘림 0", () => {
  for (const box of SIZES["2x1"])
    for (const scale of SCALES)
      it(`2x1 ${box.width}×${box.height} · ${scale * 100}%`, () => {
        const input = assetInput(box.width, box.height, scale);
        const plan = planAsset(input);
        expect(assetOverflow(input, plan)).toEqual([]);
        expect(plan.totalFont).toBeGreaterThanOrEqual(F.xs); // 합계는 줄여도 9sp 이상
      });

  it("흔한 2×1(160dp)에서는 오늘 손익이 보인다, 넓으면 오늘·총 둘 다와 윗줄", () => {
    expect(planAsset(assetInput(160, 72, 1)).line).not.toBeNull();
    const wide = planAsset(assetInput(250, 90, 1));
    expect(wide.line).toBe("both");
    expect(wide.top?.asOf).toBe("지연 · 9/23 15:30 기준");
  });

  it("폭 110~260dp, 글자 90~130% 어디서도 넘치지 않는다", () => {
    const bad: string[] = [];
    for (let w = 110; w <= 260; w += 5)
      for (const h of [40, 60, 90])
        for (const s of [0.9, 1, 1.15, 1.3]) {
          const input = assetInput(w, h, s);
          const o = assetOverflow(input, planAsset(input));
          if (o.length) bad.push(`${w}×${h}@${s}: ${o.join(", ")}`);
        }
    expect(bad.slice(0, 5)).toEqual([]);
  });
});
