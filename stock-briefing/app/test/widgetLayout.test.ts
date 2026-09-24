import { describe, expect, it } from "vitest";
import {
  charEm,
  headerRoom,
  indexItemWidth,
  indexSepWidth,
  lineHeight,
  listMinHeight,
  listSize,
  assetSize,
  briefingItemHeight,
  disclaimerHeight,
  PAD,
  planAsset,
  planBriefing,
  planHoldings,
  textWidth,
  totalBlock,
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

const CUM = { amount: "누적 -12,345,678원", rate: "(-12.34%)" };
const DAY = { amount: "당일 -2,868,108원", rate: "(-3.78%)" };
const NOTE = ["갱신 실패 · 연결 안 됨", "17종목 이전 값", "일부 제외 3"];

function holdingsInput(width: number, height: number, scale: number, mode: "cumulative" | "day" = "cumulative", toggle = true, note: string[] = NOTE): HoldingsInput {
  return {
    width,
    height,
    scale,
    header: { title: "잔고 18", chip: "한국 장중", sub: ["9/23 15:30 기준", "9/23 15:30", "15:30"], delayed: true },
    // 전환 칸이 없으면 누적(플래그를 끈 것과 같다), 있으면 저장된 쪽
    total: { total: LONG_TOTAL, fixed: CUM, toggle: toggle ? (mode === "day" ? DAY : CUM) : null },
    indices: INDICES,
    rows: ROWS,
    note,
    alert: note.some((n) => n.startsWith("갱신 실패")) ? "갱신 실패" : null,
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
    // 금액·수익률은 빠지지 않는다 (줄이거나 두 줄로만). 전환 칸이 있으면 저장된 쪽, 없으면 누적
    const want = p.total.toggle ? i.total!.toggle : i.total!.fixed;
    const joined = p.total.pnl.join(" ");
    if (!want) bad.push("플래그가 꺼졌는데 전환 칸");
    else if (!joined.includes(want.amount) || (want.rate && !joined.includes(want.rate))) bad.push(`손익 빠짐 ${joined}`);
    if (!p.total.toggle && p.total.pnlPadX) bad.push("전환 칸이 없는데 누르는 칸 여백");
    if (p.total.toggle && p.total.pnlH < TOUCH) bad.push(`손익 누르는 칸 ${p.total.pnlH} < 48`);
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

/**
 * 세로 합 (어림, 실제 글꼴보다 높게): 머리 줄 48 + 합계 줄(여백 포함) + 지수 줄 + 메모 + 아래 여백.
 * 위젯 높이를 넘으면 안 되고, 목록을 넣었으면 남는 높이가 첫 줄(이름·가격) 이상이어야 한다 —
 * 높이 0 인 ListWidget 은 라이브러리가 예외를 던지고(CollectionView "ListWidget width and height must be > 0") 위젯이 갱신되지 않는다
 */
function holdingsVertical(i: HoldingsInput, p: HoldingsPlan): string[] {
  const bad: string[] = [];
  const s = i.scale;
  const used = TOUCH + totalBlock(p.total) + (p.index ? p.index.height + space.xs : 0) + (p.note ? lineHeight(F.sm, s) : 0) + PAD;
  if (used > i.height) bad.push(`세로 ${used} > ${i.height}`);
  const listH = i.height - used;
  if (p.list) {
    if (!(listH > 0)) bad.push(`목록 높이 ${listH} ≤ 0`);
    if (listH < listMinHeight(s)) bad.push(`목록 ${listH} < 첫 줄 ${listMinHeight(s)}`);
    if (Math.abs(p.listH - listH) > 0.001) bad.push(`목록 어림 ${p.listH} ≠ ${listH}`);
  }
  if (p.index && (!p.list || listH < p.rows.rowH)) bad.push("지수 줄 때문에 목록이 한 줄도 안 보임");
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
            expect(holdingsVertical(input, plan)).toEqual([]);
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

  it("폭 250~420dp, 높이 110~420dp, 글자 90~130% × 전환 켬·끔 × 메모 있음·없음 × 종목 있음·없음: 가로·세로 모두 넘치지 않는다", () => {
    const bad: string[] = [];
    let cases = 0;
    for (let w = 250; w <= 420; w += 10)
      for (let h = 110; h <= 420; h += 10)
        for (const s of [0.9, 1, 1.15, 1.3])
          for (const toggle of [true, false])
            for (const note of [NOTE, []])
              for (const rows of [ROWS, []]) {
                const input = { ...holdingsInput(w, h, s, "day", toggle, note), rows };
                const plan = planHoldings(input);
                const o = [...holdingsOverflow(input, plan), ...holdingsVertical(input, plan)];
                if (!rows.length && plan.list) o.push("종목이 없는데 목록");
                if (o.length) bad.push(`${w}×${h}@${s} 전환 ${toggle} 메모 ${note.length} 종목 ${rows.length}: ${o.join(", ")}`);
                cases++;
              }
    expect(bad.slice(0, 5)).toEqual([]);
    expect(cases).toBe(18 * 32 * 4 * 2 * 2 * 2);
  });

  it("손익 전환이 꺼져 있으면 누르는 칸(48dp)을 두지 않는다 (예전과 같은 높이)", () => {
    const p = planHoldings(holdingsInput(330, 180, 1, "cumulative", false));
    expect(p.total!.toggle).toBe(false);
    expect(p.total!.pnlPadX).toBe(0);
    expect(p.total!.pnlH).toBeLessThan(TOUCH);
  });

  describe("세로: 목록(ListWidget)은 첫 줄이 보일 높이가 있을 때만 (검토 지적 — 높이 0 이면 위젯이 갱신되지 않음)", () => {
    it("4×2 최소(250×110) × 100·130% × 메모 있음·없음 × 전환 켬: 세로 합이 높이 안이고, 목록 자리가 없으면 목록을 넣지 않는다", () => {
      for (const s of SCALES)
        for (const note of [NOTE, []]) {
          const input = holdingsInput(250, 110, s, "cumulative", true, note);
          const p = planHoldings(input);
          expect(holdingsVertical(input, p)).toEqual([]);
          expect(holdingsOverflow(input, p)).toEqual([]);
          // 머리 줄(48, ↻ 칸)만으로도 목록 첫 줄 자리가 없다 (예전 배치는 여기서 목록 높이 0 → 예외)
          expect(p.list).toBe(false);
        }
    });

    it("수정 전 배치(머리 48 + 합계 48 + 여백 8 + 아래 12 = 116dp)는 110dp 에서 넘쳤다 — 지금은 세로 합이 높이 안", () => {
      const input = holdingsInput(250, 110, 1, "cumulative", true, []);
      const p = planHoldings(input);
      expect(TOUCH + TOUCH + space.xs * 2 + PAD).toBeGreaterThan(110);
      expect(TOUCH + totalBlock(p.total) + PAD).toBeLessThanOrEqual(110);
    });

    it("메모가 있을 때 130dp·100%, 250×150·130% 도 목록 높이가 0 이하가 되지 않는다", () => {
      for (const [w, h, s] of [
        [250, 130, 1],
        [330, 130, 1],
        [250, 150, 1.3],
        [330, 150, 1.3],
      ] as const) {
        const input = holdingsInput(w, h, s);
        const p = planHoldings(input);
        expect(holdingsVertical(input, p)).toEqual([]);
        if (p.list) expect(p.listH).toBeGreaterThanOrEqual(listMinHeight(s));
      }
    });

    it("높이가 모자라면 목록을 지키고 전환 칸(48dp)을 먼저 뺀다(누적만) → 그래도 없으면 목록을 뺀다", () => {
      // 250×130 · 100% · 메모 없음: 전환 칸이 있으면 목록 자리가 없고, 빼면 목록 첫 줄이 들어간다
      const mid = planHoldings(holdingsInput(250, 130, 1, "day", true, []));
      expect(mid.list).toBe(true);
      expect(mid.total!.toggle).toBe(false);
      expect(mid.total!.pnl.join(" ")).toContain("누적"); // 전환 칸이 없으면 누적 (플래그를 끈 것과 같다)
      // 흔한 4×2(330×150 이상)는 목록과 전환 칸이 함께
      for (const [w, h, s] of [
        [330, 150, 1],
        [330, 150, 1.3],
        [330, 180, 1],
        [330, 180, 1.3],
      ] as const) {
        const p = planHoldings(holdingsInput(w, h, s, "day", true, []));
        expect(p.list).toBe(true);
        expect(p.total!.toggle).toBe(true);
        expect(p.total!.pnl.join(" ")).toContain("당일");
      }
    });

    it("전환 칸(48dp) 줄은 위아래 여백을 두지 않는다 (칸 안에 빈 곳이 있다) — 흔한 4×2 에서 목록을 한 줄 넘게 잃지 않게", () => {
      const on = planHoldings(holdingsInput(330, 180, 1, "cumulative", true, []));
      const off = planHoldings(holdingsInput(330, 180, 1, "cumulative", false, []));
      expect(on.total!.gapY).toBe(0);
      expect(off.total!.gapY).toBe(space.xs);
      expect(off.listH - on.listH).toBeLessThan(on.rows.rowH);
    });

    it("갱신이 실패해 메모가 생겨도 목록은 사라지지 않는다 (메모를 머리 줄로 옮기거나 전환 칸을 먼저 뺀다)", () => {
      const bad: string[] = [];
      for (let w = 250; w <= 420; w += 10)
        for (let h = 110; h <= 420; h += 10)
          for (const s of [0.9, 1, 1.15, 1.3]) {
            const ok = planHoldings(holdingsInput(w, h, s, "day", true, []));
            const failed = planHoldings(holdingsInput(w, h, s, "day", true, NOTE));
            if (ok.list && !failed.list) bad.push(`${w}×${h}@${s}`);
            // 메모를 뺐으면 '갱신 실패'는 머리 줄에
            if (!failed.note && failed.header.sub !== "갱신 실패" && failed.header.sub !== null) bad.push(`${w}×${h}@${s} 머리 ${failed.header.sub}`);
          }
      expect(bad.slice(0, 5)).toEqual([]);
    });

    it("메모 줄도 안 들어가면 메모를 빼고 '갱신 실패'를 머리 줄 기준 시각 자리에 (옛 값인지 알 수 있게)", () => {
      const input = holdingsInput(250, 110, 1.3);
      const p = planHoldings(input);
      expect(p.note).toBeNull();
      expect(p.header.sub).toBe("갱신 실패");
      expect(p.header.delayed).toBe(true);
      expect(holdingsVertical(input, p)).toEqual([]);
      // 메모가 들어가는 높이면 머리 줄은 기준 시각 그대로
      const tall = planHoldings(holdingsInput(330, 250, 1.3));
      expect(tall.note).not.toBeNull();
      expect(tall.header.sub).not.toBe("갱신 실패");
    });
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
  it("4×2 최소는 1종목(이름·요약 한 줄), 흔한 4×2 는 이름 줄 + 요약, 4×4 는 3종목·요약 두 줄", () => {
    for (const scale of SCALES) expect(planBriefing({ width: 250, height: 110, scale, header, count: 3 })).toMatchObject({ items: 1, item: "line" });
    expect(planBriefing({ width: 330, height: 180, scale: 1, header, count: 3 })).toMatchObject({ item: "full", summaryLines: 1 });
    const large = planBriefing({ width: 330, height: 380, scale: 1, header, count: 3 });
    expect(large).toMatchObject({ size: "large", items: 3, item: "full", summaryLines: 2 });
  });

  it("고지 한 줄은 늘 들어간다: 세로 합(머리 48 + 종목 칸·안내 문구 + 고지 + 아래 여백) ≤ 높이 (110~420 × 글자 90~130% × 종목 0~3)", () => {
    const bad: string[] = [];
    for (let h = 110; h <= 420; h += 5)
      for (const scale of [0.9, 1, 1.15, 1.3])
        for (const count of [0, 1, 2, 3]) {
          const p = planBriefing({ width: 250, height: h, scale, header, count });
          const body = count ? p.items * briefingItemHeight(p.item, p.summaryLines, scale) : p.messageGap + p.messageLines * lineHeight(F.md, scale);
          const used = TOUCH + body + disclaimerHeight(scale) + PAD;
          if (used > h) bad.push(`${h}@${scale} 종목 ${count}: ${used} > ${h}`);
          if (count && p.items < 1) bad.push(`${h}@${scale}: 종목 0`);
        }
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it("검토 지적: 4×2 최소 110dp · 130% 에서 이름 줄 + 요약 칸을 억지로 넣지 않는다 (수정 전: 칸 44dp > 남는 25dp → 고지 줄이 잘림)", () => {
    expect(briefingItemHeight("full", 1, 1.3)).toBeGreaterThan(110 - TOUCH - PAD - disclaimerHeight(1.3));
    const p = planBriefing({ width: 250, height: 110, scale: 1.3, header, count: 3 });
    expect(p.item).toBe("line");
    expect(TOUCH + p.items * briefingItemHeight(p.item, p.summaryLines, 1.3) + disclaimerHeight(1.3) + PAD).toBeLessThanOrEqual(110);
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
