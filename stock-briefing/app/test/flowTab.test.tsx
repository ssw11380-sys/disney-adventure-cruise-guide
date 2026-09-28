import { readFileSync } from "node:fs";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InvestorFlow } from "@/api/types";
import { render, type HostNode } from "./miniRender";

/**
 * 3-33 수급 탭 부품 (components/flow/FlowTab — 플래그 flowTab 이 켜졌을 때만 상세 화면이 그린다).
 * 서버 응답은 공용 픽스처(shared/fixtures/investorFlow.json — 서버 테스트가 지금 서버 계산과 같은지 본다, 2026-09-28 장 마감 자료).
 * 휴대폰 360 기본(20일), 칩으로 5·60일, 막대 누르기, 날짜별 숫자 표, 외국인 보유율, 한도, 잠정 줄, 네이버 폴백, 오래된 값, 대조, 자료 없음, 실패, 미국
 */
type Supported = Extract<InvestorFlow, { supported: true }>;
const FX = JSON.parse(readFileSync(new URL("../../shared/fixtures/investorFlow.json", import.meta.url), "utf8")) as { cases: Record<"samsung" | "samsungNaver" | "kt", Supported> };
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const h = vi.hoisted(() => ({
  win: { width: 360, height: 752, scale: 2.625, fontScale: 1 },
  query: { data: undefined as unknown, isLoading: false, isError: false, error: null as unknown, refetch: vi.fn(async () => undefined) },
  calls: [] as Array<[string, boolean]>,
}));

vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  ActivityIndicator: "ActivityIndicator",
  Switch: "Switch",
  StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 },
  useWindowDimensions: () => h.win,
}));
vi.mock("@expo/vector-icons/Ionicons", () => ({ default: "Ionicons" }));
vi.mock("@/theme", async () => {
  const tokens = await import("@/tokens");
  return { ...tokens, useTheme: () => tokens.dark, useFontScale: (cap = Infinity) => Math.min(Math.max(h.win.fontScale || 1, 1), cap) };
});
vi.mock("@/api/hooks", () => ({
  useInvestorFlow: (code: string, enabled: boolean) => {
    h.calls.push([code, enabled]);
    return h.query;
  },
}));

const { FlowTab } = await import("@/components/flow/FlowTab");
const { dark, touch } = await import("@/tokens");

type R = ReturnType<typeof render>;
const textOf = (n: HostNode | string): string => (typeof n === "string" ? n : n.children.map(textOf).join(""));
const flat = (n: HostNode): Record<string, unknown> => Object.assign({}, ...[n.props.style].flat(Infinity).filter(Boolean));
const texts = (r: R) => r.all().filter((n) => n.type === "Text").map(textOf);
const byText = (r: R, s: string) => {
  const hit = r.all().filter((n) => n.type === "Text" && textOf(n) === s);
  if (hit.length !== 1) throw new Error(`"${s}" 글이 ${hit.length}개`);
  return hit[0]!;
};
const pressables = (r: R) => r.all().filter((n) => n.type === "Pressable");
const chip = (r: R, label: string) => {
  const hit = pressables(r).find((n) => n.props.accessibilityLabel === label && n.props.accessibilityRole === "button");
  if (!hit) throw new Error(`칩 ${label} 없음`);
  return hit;
};
const press = (r: R, n: HostNode, ev: unknown = {}) => r.act(() => (n.props.onPress as (e: unknown) => void)(ev));
const sumRows = (r: R) => r.all().filter((n) => n.props.accessible === true && typeof n.props.accessibilityLabel === "string" && /최근 \d+일 합계/.test(n.props.accessibilityLabel as string));
const bars = (r: R, key: string) => r.all().filter((n) => typeof n.props.testID === "string" && (n.props.testID as string).startsWith(`flow-bar-${key}-`));

function open(data: unknown, o: { us?: boolean; width?: number; fontScale?: number; error?: boolean } = {}) {
  h.query = { data, isLoading: data === undefined && !o.error, isError: !!o.error, error: o.error ? new Error("x") : null, refetch: vi.fn(async () => undefined) };
  h.win = { ...h.win, width: o.width ?? 360, fontScale: o.fontScale ?? 1 };
  return render(<FlowTab code={o.us ? "AAPL" : "005930"} us={!!o.us} width={o.width ?? 360} />);
}

beforeEach(() => {
  h.calls = [];
});

describe("한국 종목 (삼성전자, 토스 웹 자료)", () => {
  it("합계 카드: 기본 20일 네 줄 (개인·외국인·기관·기타법인) — 글자·부호·색, 한 줄 = 한 요소", () => {
    const r = open(FX.cases.samsung);
    expect(h.calls).toEqual([["005930", true]]);
    const all = texts(r);
    expect(all).toContain("투자자별 매매");
    expect(all).toContain("최근 20일 합계 (장이 열린 날 기준)");
    expect(all).toContain("산 주식 수에서 판 주식 수를 뺀 값");
    const rows = sumRows(r);
    expect(rows.map((n) => textOf(n))).toEqual(["개인-3,348만 주", "외국인-1,364만 주", "기관+839만 주", "기타법인+3,880만 주"]);
    expect(rows.map((n) => n.props.accessibilityLabel)).toEqual([
      "개인, 최근 20일 합계, 판 주식이 산 주식보다 3,348만 주 많았습니다",
      "외국인, 최근 20일 합계, 판 주식이 산 주식보다 1,364만 주 많았습니다",
      "기관, 최근 20일 합계, 산 주식이 판 주식보다 839만 주 많았습니다",
      "기타법인, 최근 20일 합계, 산 주식이 판 주식보다 3,880만 주 많았습니다",
    ]);
    expect(flat(byText(r, "-3,348만 주")).color).toBe(dark.down);
    expect(flat(byText(r, "+839만 주")).color).toBe(dark.up);
    expect(all).toContain("+는 산 주식이 더 많았다는 뜻, -는 판 주식이 더 많았다는 뜻입니다.");
    expect(all).toContain("네 값을 더하면 0에 가깝습니다. 누군가 판 주식은 다른 누군가가 산 것이기 때문입니다.");
  });

  it("칩 5·20·60: 선택 상태(화면 읽기 '선택됨'), 바꾸면 합계와 막대 개수가 바뀐다", () => {
    const r = open(FX.cases.samsung);
    expect(chip(r, "20일").props.accessibilityState).toEqual({ selected: true });
    expect(chip(r, "5일").props.accessibilityState).toEqual({ selected: false });
    expect(bars(r, "individual")).toHaveLength(20);
    press(r, chip(r, "5일"));
    expect(chip(r, "5일").props.accessibilityState).toEqual({ selected: true });
    expect(texts(r)).toContain("최근 5일 합계 (장이 열린 날 기준)");
    expect(sumRows(r).map((n) => textOf(n))).toEqual(["개인-2,012만 주", "외국인+418만 주", "기관+637만 주", "기타법인+966만 주"]);
    expect(bars(r, "individual")).toHaveLength(5);
    press(r, chip(r, "60일"));
    expect(sumRows(r).map((n) => textOf(n))).toEqual(["개인-1,341만 주", "외국인-3,000만 주", "기관-441만 주", "기타법인+4,785만 주"]);
    expect(bars(r, "individual")).toHaveLength(60);
  });

  it("막대: 처음엔 가장 최근 날 줄, 누른 x 로 그날 줄 · 세 줄 같은 눈금(가장 큰 |값|이 반 줄 28)", () => {
    const r = open(FX.cases.samsung);
    const picked = () => textOf(r.all().find((n) => n.props.testID === "flow-picked")!);
    expect(picked()).toBe("9월 28일 (월) · 개인 +742만 · 외국인 -598만 · 기관 -363만 · 종가 270,000원");
    const area = r.all().find((n) => n.props.testID === "flow-bars-press")!;
    // 칸 폭 = 막대 칸 폭 / 20 → 첫 칸(가장 오래된 날, 8/28) 누르기
    press(r, area, { nativeEvent: { locationX: 1 } });
    expect(FX.cases.samsung.days[19]!.date).toBe("2026-08-28");
    expect(picked()).toMatch(/^8월 28일 \(금\) · 개인 /);
    // 화면 읽기: adjustable — 위로 쓸면 다음 날, 아래로 쓸면 앞 날 (끝에서 멈춤)
    const swipe = (actionName: string) => {
      const now = r.all().find((n) => n.props.testID === "flow-bars-press")!;
      r.act(() => (now.props.onAccessibilityAction as (e: unknown) => void)({ nativeEvent: { actionName } }));
    };
    swipe("increment");
    expect(picked()).toMatch(/^8월 31일 \(월\) · /);
    swipe("decrement");
    swipe("decrement");
    expect(picked()).toMatch(/^8월 28일 \(금\) · /);
    const heights = ["individual", "foreign", "institution"].flatMap((k) => bars(r, k).map((n) => flat(n).height as number));
    expect(Math.max(...heights)).toBeCloseTo(28);
    // 누르는 칸 높이 ≥ 44 (세 줄 전체)
    expect(flat(area).height as number).toBeGreaterThanOrEqual(touch.min);
    expect(area.props.accessibilityRole).toBe("adjustable");
    expect(area.props.accessibilityLabel).toMatch(/^날마다 막대, 8월 28일부터 9월 28일까지 20일\. 개인은 산 쪽이 많은 날 \d+일, 판 쪽이 많은 날 \d+일\./);
    // 축 아래 첫 날 · 마지막 날
    expect(texts(r)).toEqual(expect.arrayContaining(["8월 28일", "9월 28일"]));
  });

  it("막대 색: + 는 빨강(위), − 는 파랑(아래)", () => {
    const r = open(FX.cases.samsung);
    const last = bars(r, "individual").at(-1)!; // 9/28 개인 +742만
    expect(flat(last).backgroundColor).toBe(dark.up);
    const f = bars(r, "foreign").at(-1)!; // 9/28 외국인 -598만
    expect(flat(f).backgroundColor).toBe(dark.down);
    expect(flat(f).top).toBe(28);
  });

  it("날짜별 숫자 보기: 누르면 표(최근 날부터, 한 줄 = 한 요소), 다시 누르면 접힘", () => {
    const r = open(FX.cases.samsung);
    const toggle = () => pressables(r).find((n) => /날짜별 숫자/.test(String(n.props.accessibilityLabel)))!;
    expect(toggle().props.accessibilityState).toEqual({ expanded: false });
    expect(r.all().some((n) => n.props.testID === "flow-day-table")).toBe(false);
    press(r, toggle());
    const table = r.all().find((n) => n.props.testID === "flow-day-table")!;
    const rows = r.all(table.children).filter((n) => n.props.accessible === true);
    expect(rows).toHaveLength(20);
    expect(rows[0]!.props.accessibilityLabel).toBe("9월 28일 월요일, 개인 +742만 주, 외국인 -598만 주, 기관 -363만 주");
    expect(toggle().props.accessibilityLabel).toBe("날짜별 숫자 접기");
    press(r, toggle());
    expect(r.all().some((n) => n.props.testID === "flow-day-table")).toBe(false);
  });

  it("외국인 보유율: 큰 숫자 · 날짜와 뜻 · 5·20·60일 전 · 선(화면 읽기 한 요소) · 가장 높음/낮음 · %p 풀이 · 한도 줄 없음", () => {
    const r = open(FX.cases.samsung);
    const all = texts(r);
    expect(all).toContain("46.52%");
    expect(all).toContain("9월 28일 (월) · 이 회사 주식 가운데 외국인이 가진 몫입니다.");
    expect(all).toContain("5일 전 46.48% → +0.04%p");
    expect(all).toContain("20일 전 46.75% → -0.23%p");
    expect(all).toContain("60일 전 46.96% → -0.44%p");
    expect(all).toContain("가장 높음 46.96% · 가장 낮음 46.46%");
    expect(all).toContain("%p는 퍼센트끼리 뺀 값입니다 (46.75% → 46.52%는 -0.23%p).");
    expect(all).toContain("외국인 보유율은 다음 날 오전에 한 번 더 고쳐지기도 합니다.");
    expect(all.some((s) => s.startsWith("이 회사는 외국인이 가질 수 있는 몫이"))).toBe(false);
    expect(r.byLabel("외국인 보유율 60일, 6월 30일 46.96%에서 9월 28일 46.52%, 가장 높음 46.96%, 가장 낮음 46.46%").props.accessibilityRole).toBe("image");
  });

  it("읽는 법: 처음엔 접힘, 누르면 일곱 줄", () => {
    const r = open(FX.cases.samsung);
    expect(texts(r)).not.toContain("개인: 개인 투자자입니다.");
    const t = r.byLabel("이 숫자들이 뜻하는 것");
    expect(t.props.accessibilityState).toEqual({ expanded: false });
    press(r, t);
    expect(texts(r)).toContain("개인: 개인 투자자입니다.");
    expect(texts(r)).toContain("모두 지난 기록입니다. 이 숫자만으로 주가가 어떻게 될지는 알 수 없습니다.");
  });

  it("출처 줄 · 대조 20/20", () => {
    const all = texts(open(FX.cases.samsung));
    expect(all).toContain("자료: 토스증권 웹 공개 화면 · 한국거래소와 넥스트레이드 거래를 합친 값 · 9월 28일 (월) 20:15 반영");
    expect(all).toContain("토스증권 Open API 원자료와 최근 20일 비교: 20일 모두 같음 (9월 29일 (화) 21:05 확인)");
    expect(all.some((s) => s.startsWith("새 자료를 받지 못해"))).toBe(false);
  });
});

describe("다른 경우", () => {
  it("KT: 한도 줄 (49.0% · 100.0%) · 대조 20일 가운데 19일", () => {
    const all = texts(open(FX.cases.kt));
    expect(all).toContain("이 회사는 외국인이 가질 수 있는 몫이 발행 주식의 49.0%로 정해져 있습니다. 지금 그 한도의 100.0%를 채웠습니다.");
    expect(all).toContain("토스증권 Open API 원자료와 최근 20일 비교: 20일 가운데 19일 같음 (9월 29일 (화) 21:05 확인)");
  });

  it("네이버 폴백: 기준 문장 · 기타법인 줄 없음 · 세 값 합 풀이 · 대조 줄 없음", () => {
    const r = open(FX.cases.samsungNaver);
    expect(sumRows(r).map((n) => textOf(n))).toEqual(["개인-3,225만 주", "외국인-1,564만 주", "기관+895만 주"]);
    const all = texts(r);
    expect(all).toContain("기타법인 값이 없어 세 값을 더해도 0이 되지 않습니다.");
    expect(all).toContain("자료: 네이버 증권 · 한국거래소 거래만 (넥스트레이드 거래가 빠져 토스 앱 숫자와 같지 않습니다) · 9월 29일 (화) 02:40에 받음");
    expect(all.some((s) => s.startsWith("토스증권 Open API"))).toBe(false);
  });

  it("장중 잠정 줄: 합계·막대에 넣지 않았다는 안내 + 그 시각까지 외국인·기관 (개인은 장이 끝난 뒤)", () => {
    const d = clone(FX.cases.samsung);
    d.today = { date: "2026-09-29", updatedAt: "2026-09-29T10:05:00+09:00", individual: null, foreign: 120_000, institution: -40_000 };
    const all = texts(open(d));
    expect(all).toContain("오늘(9월 29일 (화)) 값은 집계 중이라 합계와 막대에 넣지 않았습니다.");
    expect(all).toContain("10:05까지 외국인 +12만 주 · 기관 -4만 주 (개인은 장이 끝난 뒤에 나옵니다)");
  });

  it("오래된 값 · 자료가 모자람 · 빈 값", () => {
    const d = clone(FX.cases.samsung);
    d.stale = true;
    d.sums["20"] = { ...d.sums["20"], days: 12, missing: 2 };
    const all = texts(open(d));
    expect(all).toContain("새 자료를 받지 못해 9월 29일 (화) 02:40에 받은 값입니다.");
    expect(all).toContain("자료가 12일치뿐이라 12일 합계입니다.");
    expect(all).toContain("(2일은 값이 없어 빼고 더했습니다)");
  });

  it("자료 없음 · 실패(다시 시도) · 불러오는 중 · 서버 404(꺼짐)", () => {
    const empty = clone(FX.cases.samsung);
    empty.days = [];
    empty.ratio = null;
    expect(texts(open(empty))).toContain("이 종목은 아직 투자자별 매매 자료가 없습니다.");
    const fail = open(undefined, { error: true });
    expect(texts(fail)).toContain("수급 자료를 받지 못했습니다.");
    const retry = fail.all().find((n) => n.type === "Pressable" && n.props.accessibilityLabel === "수급 자료 다시 불러오기")!;
    press(fail, retry);
    expect(h.query.refetch).toHaveBeenCalledTimes(1);
    expect(texts(open(undefined))).toContain("수급 자료를 불러오는 중");
    expect(texts(open(null))).toContain("지금은 수급 자료를 볼 수 없습니다.");
  });

  it("미국 종목: 서버에 묻지 않고 '해당 없음' 안내 세 줄", () => {
    const r = open(undefined, { us: true });
    expect(h.calls).toEqual([["AAPL", false]]);
    const all = texts(r);
    expect(all).toContain("해당 없음");
    expect(all).toContain("미국 주식은 이 탭에 보여 줄 자료가 없습니다.");
    expect(all).toContain("미국 거래소는 개인·외국인·기관이 날마다 사고판 주식 수를 공개하지 않습니다.");
    expect(all).toContain("공매도 잔고처럼 한 달에 두 번 나오는 자료는 지금 보여 주지 않습니다.");
  });
});

describe("넓은 칸 (펼침 세로 704)", () => {
  it("합계를 칩 대신 세 기간 표로 (칩은 막대 카드로) — 200% 는 칩 그대로", () => {
    const r = open(FX.cases.samsung, { width: 704 });
    expect(texts(r)).not.toContain("최근 20일 합계 (장이 열린 날 기준)");
    const rows = r.all().filter((n) => n.props.accessible === true && String(n.props.accessibilityLabel).startsWith("개인, 최근 5일 합계"));
    expect(rows).toHaveLength(1);
    expect(textOf(rows[0]!)).toBe("개인-2,012만 주-3,348만 주-1,341만 주");
    expect(rows[0]!.props.accessibilityLabel).toBe(
      "개인, 최근 5일 합계, 판 주식이 산 주식보다 2,012만 주 많았습니다. 개인, 최근 20일 합계, 판 주식이 산 주식보다 3,348만 주 많았습니다. 개인, 최근 60일 합계, 판 주식이 산 주식보다 1,341만 주 많았습니다",
    );
    expect(chip(r, "20일").props.accessibilityState).toEqual({ selected: true });
    const big = open(FX.cases.samsung, { width: 704, fontScale: 2 });
    expect(texts(big)).toContain("최근 20일 합계 (장이 열린 날 기준)");
  });
});
