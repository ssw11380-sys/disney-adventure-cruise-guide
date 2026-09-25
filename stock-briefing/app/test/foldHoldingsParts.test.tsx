import React from "react";
import { describe, expect, it, vi } from "vitest";
import type { AccountData } from "@/components/AccountBand";
import { render, type HostNode } from "./miniRender";

/**
 * 넓은 잔고 화면의 부품 (3-42 웨이브 B 검증 반영): 계좌 띠 · 표 머리 · 맨 위 띠 지수 칸 · 두 줄 시장 상태.
 *  - 계좌 띠: 목업 글자 크기(값 14 · 총액 16), 펼친 폴드8 가로 한 줄 띠에 국내·해외 수익률, 칸 이름도 줄 글자 상한
 *  - 표 머리: 높이 44 · 아래로 넓히지 않는 누르는 칸 · 두 글자 정렬 이름도 폭 44 · 글자 상한
 *  - 맨 위 띠: 목업 글자 크기(11 / 14), 넓은 띠만 탭 머리 글자 상한 — 휴대폰 띠는 그대로
 *  - 시장 상태: 세션 / 실시간·시각 두 줄, 화면 읽기는 한 문장
 */
const NOW = Date.parse("2026-09-25T14:25:27Z");
const idx = vi.hoisted(() => ({ data: undefined as unknown }));

vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 0.5, absoluteFill: {} },
  Platform: { OS: "android" },
}));
vi.mock("@expo/vector-icons", () => ({ Ionicons: "Ionicons" }));
vi.mock("expo-router", () => ({ router: { push: vi.fn() } }));
vi.mock("@/theme", async () => {
  const tokens = await import("@/tokens");
  return { ...tokens, useTheme: () => tokens.dark, useFontScale: () => 1 };
});
vi.mock("@/components/ui", () => ({ Button: "Button" }));
vi.mock("@/components/HoldingsTable", () => ({ ColDivider: "ColDivider" }));
vi.mock("@/lib/useNow", () => ({ useNow: () => NOW }));
vi.mock("@/lib/liveStream", () => ({ useLiveStream: () => ({ connected: false, lastTickAt: null, connectedAt: null }) }));
vi.mock("@/api/hooks", () => ({ useMarketIndices: () => ({ data: idx.data, dataUpdatedAt: NOW, isError: false, failureCount: 0 }) }));

const { AccountBand, dayRateOf, fxNote } = await import("@/components/AccountBand");
const { TableHeadRow } = await import("@/components/HoldingsTableHead");
const { MarketStrip } = await import("@/components/MarketStrip");
const { LiveStatus, statusLines } = await import("@/components/Freshness");
const { pickCols } = await import("@/lib/holdingsColumns");
const { sessionStatus } = await import("@/lib/liveDot");
const { font, fontCap, layout, touch } = await import("@/tokens");

const texts = (r: ReturnType<typeof render>): HostNode[] => r.all().filter((n) => n.type === "Text");
const own = (n: HostNode): string => n.children.filter((c): c is string => typeof c === "string").join("");
const flat = (v: unknown): Record<string, unknown> => Object.assign({}, ...[v].flat(Infinity).filter(Boolean));
const textOf = (r: ReturnType<typeof render>, s: string): HostNode => {
  const hit = texts(r).filter((n) => own(n) === s);
  if (hit.length !== 1) throw new Error(`"${s}" 글자가 ${hit.length}개입니다`);
  return hit[0]!;
};

const bucket = (value: number, cost: number, day: number, count: number) => ({ value, cost, day, count });
// 목업과 같은 예시 계좌 (국내 9 · 해외 8)
const DATA: AccountData = {
  total: bucket(71_445_876, 54_699_110, 423_789, 17),
  byCur: { KRW: bucket(31_451_551, 26_060_000, 300_000, 9), USD: bucket(28_741.88, 21_040, 90, 8) },
  usdInKrw: bucket(39_994_325, 28_639_110, 123_789, 8),
  estimated: false,
  currentBasis: 0,
  afterCost: true,
  showKrw: false,
  fx: 1391.5,
  excluded: null,
};

describe("계좌 띠 (AccountBand)", () => {
  it("펼친 폴드8 가로 한 줄 띠: 국내·해외에 수익률까지 (설계 '국내+% | 해외·환율+%')", () => {
    const r = render(<AccountBand data={DATA} oneLine rates pad={12} />);
    const all = r.text();
    expect(all).toContain("31,451,551원 +20.69%");
    expect(all).toContain("$28,741.88 +36.61%");
    expect(all).toContain("해외 · 환율 1,391.5");
  });

  it("좁은 한 줄 띠(rates 꺼짐)는 국내·해외 금액만, 화면 읽기 문장에는 수익률이 그대로", () => {
    const r = render(<AccountBand data={DATA} oneLine rates={false} pad={12} />);
    expect(r.text()).not.toContain("+20.69%");
    expect(r.text()).toContain("31,451,551원");
    const sentence = r.all().find((n) => typeof n.props.accessibilityLabel === "string" && String(n.props.accessibilityLabel).startsWith("총 평가금액"))!;
    expect(String(sentence.props.accessibilityLabel)).toContain("20.69%");
  });

  it("두 줄 띠는 늘 수익률 · 매입금액", () => {
    const r = render(<AccountBand data={DATA} oneLine={false} rates={false} pad={12} />);
    expect(r.text()).toContain("31,451,551원 +20.69%");
    expect(r.text()).toContain("54,699,110원");
  });

  it("글자는 목업 크기: 총액 16 더 굵게 · 값 14 굵게 · 등락률 12 · 칸 이름 11 (띠 높이 52 를 지킨다)", () => {
    const r = render(<AccountBand data={DATA} oneLine rates pad={12} />);
    expect(flat(textOf(r, "71,445,876").props.style)).toMatchObject({ fontSize: font.h2, fontWeight: "800" });
    expect(flat(textOf(r, "+16,746,766원").props.style)).toMatchObject({ fontSize: font.body, fontWeight: "700" });
    expect(flat(textOf(r, "31,451,551원").props.style)).toMatchObject({ fontSize: font.body });
    expect(flat(textOf(r, "국내").props.style)).toMatchObject({ fontSize: font.tiny });
  });

  it("칸 이름도 값과 같은 확대 상한(fontCap.row): 큰 글씨에서 이름이 숫자보다 커지지 않는다", () => {
    const r = render(<AccountBand data={DATA} oneLine rates pad={12} />);
    const ts = texts(r);
    expect(ts.length).toBeGreaterThan(10);
    for (const n of ts) expect(n.props.maxFontSizeMultiplier).toBe(fontCap.row);
  });

  it("당일 등락률: 비용 차감 전 평가금액 − 당일손익을 전일 평가금액으로 (당일손익과 같은 기준)", () => {
    const gross = 72_000_000;
    expect(dayRateOf({ ...DATA, grossValue: gross })).toBeCloseTo((423_789 / (gross - 423_789)) * 100, 10);
    // 비용 차감 전 금액을 모르면(비용 차감 꺼짐 = 같은 값) 총 평가금액 그대로
    expect(dayRateOf(DATA)).toBeCloseTo((423_789 / (71_445_876 - 423_789)) * 100, 10);
    expect(dayRateOf({ ...DATA, total: bucket(100, 100, 100, 1) })).toBeNull();
  });

  it("환율 안내 문구 (휴대폰 계좌 패널과 같은 함수)", () => {
    expect(fxNote(DATA)).toBe("토스 적용 환율 1,391.5원 · 원화 손익은 매수 당시 환율 기준");
    expect(fxNote({ ...DATA, estimated: true, currentBasis: 2 })).toBe("토스 적용 환율 1,391.5원 · 원화 손익은 매수 당시 환율 기준 (일부 추정) · 2종목은 현재 환율 환산");
    expect(fxNote({ ...DATA, fx: null })).toBeNull();
  });
});

describe("표 머리 (TableHeadRow)", () => {
  const draw = (sortLabel: string) =>
    render(<TableHeadRow plan={pickCols(853)} title="보유 17" sort="profit" sortLabel={sortLabel} onSort={() => undefined} onOpenSort={() => undefined} />);
  const pressables = (r: ReturnType<typeof render>) => r.all().filter((n) => n.type === "Pressable");

  it("머리 높이 = 누르는 크기 44, 정렬 칸은 아래로 넓히지 않는다 (바로 밑이 고정 머리 아래의 종목 줄)", () => {
    const r = draw("등록순");
    const head = r.all().find((n) => n.type === "View")!;
    expect(flat(head.props.style).minHeight).toBe(touch.min);
    expect(layout.headH).toBe(touch.min);
    const ps = pressables(r);
    // 정렬 창 버튼 + 정렬 열 4개 (등락률·평가손익·평가금액·비중)
    expect(ps).toHaveLength(5);
    for (const p of ps) {
      const slop = p.props.hitSlop as { top: number; bottom: number; left: number; right: number };
      expect(slop.bottom).toBe(0);
      expect(slop.left).toBe(0);
      expect(slop.right).toBe(0);
      // 위로는 아래 구분선(머리카락 두께)만큼만: 보이는 높이 + 위 여유 ≥ 44
      expect(layout.headH - 0.5 + slop.top).toBeGreaterThanOrEqual(touch.min);
    }
  });

  it("정렬 이름이 두 글자('이름'·'시장')여도 정렬 창 버튼 폭은 44 이상", () => {
    const r = draw("이름");
    const btn = r.byLabel("정렬 바꾸기, 지금 이름");
    expect(flat(btn.props.style).minWidth).toBeGreaterThanOrEqual(touch.min);
  });

  it("머리 글자는 표 줄과 같은 확대 상한(fontCap.row): 큰 글씨에서 머리가 아래 숫자보다 커지지 않는다", () => {
    const r = draw("등록순");
    const ts = texts(r);
    expect(ts.map(own)).toEqual(expect.arrayContaining(["보유 17", "등록순", "현재가", "평가손익", "평단"]));
    for (const n of ts) expect(n.props.maxFontSizeMultiplier).toBe(fontCap.row);
  });
});

describe("맨 위 띠 지수 칸 (MarketStrip)", () => {
  const INDICES = [
    { code: "KOSPI", name: "코스피", kind: "index", value: 3478.12, change: 29.4, changeRate: 0.85, open: false, asOf: null, fetchedAt: "2026-09-25T14:25:00Z" },
    { code: "USDKRW", name: "원/달러", kind: "fx", value: 1391.5, change: 4.2, changeRate: 0.3, open: false, asOf: null, fetchedAt: "2026-09-25T14:25:00Z" },
  ];

  it("넓은 띠: 이름·등락률 11 / 값 14 굵게 (목업 크기), 글자 확대는 탭 머리 상한(fontCap.chrome)", () => {
    idx.data = { indices: INDICES };
    const r = render(<MarketStrip dense trailing={null} />);
    expect(flat(textOf(r, "3,478.12").props.style)).toMatchObject({ fontSize: font.body, fontWeight: "700" });
    expect(flat(textOf(r, "+0.85%").props.style)).toMatchObject({ fontSize: font.tiny });
    for (const n of texts(r).filter((x) => own(x) !== " 시장")) expect(n.props.maxFontSizeMultiplier).toBe(fontCap.chrome);
  });

  it("휴대폰 띠(dense 없음)는 지금 그대로: 글자 상한 없음", () => {
    idx.data = { indices: INDICES };
    const r = render(<MarketStrip />);
    for (const n of texts(r)) expect(n.props).not.toHaveProperty("maxFontSizeMultiplier");
  });
});

describe("시장 상태 두 줄 (LiveStatus twoLine · statusLines)", () => {
  it("세션 / 나머지로 나눈다: '미국 정규장 · 한국 휴장' / '실시간 9종목'", () => {
    const sessions = [
      { label: "미국 정규장", open: true },
      { label: "한국 휴장", open: false },
    ] as never[];
    const s = sessionStatus({ sessions, liveCount: 9, eligibleCount: 9, feedOk: true, offline: false });
    expect(s.text).toBe("미국 정규장 · 한국 휴장 · 실시간 9종목");
    expect(statusLines(s.text, "미국 정규장 · 한국 휴장")).toEqual({ top: "미국 정규장 · 한국 휴장", rest: "실시간 9종목" });
    // 모두 닫힘: 세션만
    expect(statusLines("미국 휴장 · 한국 휴장", "미국 휴장 · 한국 휴장")).toEqual({ top: "미국 휴장 · 한국 휴장", rest: "" });
    // 예전 서버(세션 없음): 윗줄에 전부
    expect(statusLines("장 마감", "")).toEqual({ top: "장 마감", rest: "" });
  });

  it("두 줄로 그리고(아랫줄은 시각·지연 수), 화면 읽기는 한 줄일 때와 같은 한 문장, 글자 상한 fontCap.chrome", () => {
    const query = { data: [], isError: false, fetchStatus: "idle" as const, dataUpdatedAt: NOW - 1_000 };
    const props = { query, open: false, closedLabel: "장 마감", maxAgeMs: () => 15_000, suffix: "시세 지연 2" };
    const one = render(<LiveStatus {...props} />);
    const two = render(<LiveStatus {...props} twoLine />);
    const label = (r: ReturnType<typeof render>) => String(r.all().find((n) => n.props.accessible)!.props.accessibilityLabel);
    expect(label(two)).toBe(label(one));
    const lines = texts(two).map(own);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("장 마감");
    expect(lines[1]).toMatch(/^\d{2}:\d{2}:\d{2} · 시세 지연 2$/);
    for (const n of texts(two)) expect(n.props.maxFontSizeMultiplier).toBe(fontCap.chrome);
    // 한 줄(휴대폰 패널)은 지금 그대로: 글자 하나, 상한 없음
    expect(texts(one)).toHaveLength(1);
    expect(texts(one)[0]!.props).not.toHaveProperty("maxFontSizeMultiplier");
  });
});
