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
  query: { data: undefined as unknown, isLoading: false, isError: false, isFetching: false, error: null as unknown, refetch: vi.fn(async () => undefined) },
  calls: [] as Array<[string, boolean]>,
  /** 화면 읽기(TalkBack) 켜짐 흉내 · 켜짐/꺼짐 바뀜 알림 받는 함수 */
  reader: false,
  readerFns: [] as Array<(on: boolean) => void>,
}));

vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  ActivityIndicator: "ActivityIndicator",
  Switch: "Switch",
  StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 },
  useWindowDimensions: () => h.win,
  AccessibilityInfo: {
    isScreenReaderEnabled: async () => h.reader,
    addEventListener: (_name: string, fn: (on: boolean) => void) => {
      h.readerFns.push(fn);
      return { remove: () => void (h.readerFns = h.readerFns.filter((f) => f !== fn)) };
    },
  },
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
/** 줄바꿈 막기 글자(WORD JOINER — 보이지 않음)를 뺀 보이는 글. 붙어 있는지는 flowView 테스트가 본다 */
const plain = (s: string) => s.replace(/\u2060/g, "");
const textOf = (n: HostNode | string): string => plain(typeof n === "string" ? n : n.children.map(textOf).join(""));
const flat = (n: HostNode): Record<string, unknown> => Object.assign({}, ...[typeof n.props.style === "function" ? (n.props.style as (s: { pressed: boolean }) => unknown)({ pressed: false }) : n.props.style].flat(Infinity).filter(Boolean));
const texts = (r: R) => r.all().filter((n) => n.type === "Text").map(textOf);
const byText = (r: R, s: string) => {
  const hit = r.all().filter((n) => n.type === "Text" && textOf(n) === s);
  if (hit.length !== 1) throw new Error(`"${s}" 글이 ${hit.length}개`);
  return hit[0]!;
};
const pressables = (r: R) => r.all().filter((n) => n.type === "Pressable");
/** 기간 칩 (화면 읽기 이름: 휴대폰 '합계와 막대 기간 20일', 넓은 칸 '막대 기간 20일') */
const chip = (r: R, label: string) => {
  const hit = pressables(r).find((n) => typeof n.props.accessibilityLabel === "string" && (n.props.accessibilityLabel as string).endsWith(`기간 ${label}`) && n.props.accessibilityRole === "button");
  if (!hit) throw new Error(`칩 ${label} 없음`);
  return hit;
};
const press = (r: R, n: HostNode, ev: unknown = {}) => r.act(() => (n.props.onPress as (e: unknown) => void)(ev));
const sumRows = (r: R) => r.all().filter((n) => n.props.accessible === true && typeof n.props.accessibilityLabel === "string" && /최근 \d+일 합계/.test(n.props.accessibilityLabel as string));
const bars = (r: R, key: string) => r.all().filter((n) => typeof n.props.testID === "string" && (n.props.testID as string).startsWith(`flow-bar-${key}-`));

function open(data: unknown, o: { us?: boolean; width?: number; fontScale?: number; error?: boolean; fetching?: boolean } = {}) {
  h.query = { data, isLoading: data === undefined && !o.error, isError: !!o.error, isFetching: !!o.fetching, error: o.error ? new Error("x") : null, refetch: vi.fn(async () => undefined) };
  h.win = { ...h.win, width: o.width ?? 360, fontScale: o.fontScale ?? 1 };
  return render(<FlowTab code={o.us ? "AAPL" : "005930"} us={!!o.us} width={o.width ?? 360} />);
}

beforeEach(() => {
  h.calls = [];
  h.reader = false;
  h.readerFns = [];
});
/** 비동기로 온 화면 읽기 상태를 반영 (약속이 풀리게 한 번 쉬고 다시 그림) */
const settle = async (r: R) => {
  await new Promise((res) => setTimeout(res, 0));
  r.act(() => undefined);
};

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
    // 화면 읽기 이름에 무엇을 바꾸는지 (휴대폰은 합계와 막대를 함께)
    expect(chip(r, "5일").props.accessibilityLabel).toBe("합계와 막대 기간 5일");
    // 누르는 폭: 보이는 폭 40 이상 + 좌우 여유 2 씩 = 44 이상 ('5일'처럼 짧은 이름도)
    expect(flat(chip(r, "5일")).minWidth).toBe(40);
    expect((chip(r, "5일").props.hitSlop as { left: number; right: number }).left).toBe(2);
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
    const pickedNode = () => r.all().find((n) => n.props.testID === "flow-picked")!;
    const picked = () => plain(pickedNode().props.accessibilityLabel as string);
    // 주 수에 늘 '주' (옆의 종가 '원'과 헷갈리지 않게), 조각마다 한 덩어리 (숫자와 단위가 줄에서 갈라지지 않게)
    expect(picked()).toBe("9월 28일 (월) · 개인 +742만 주 · 외국인 -598만 주 · 기관 -363만 주 · 종가 270,000원");
    expect(r.all(pickedNode().children).filter((n) => n.type === "Text").map(textOf)).toEqual(["9월 28일 (월)", "· 개인 +742만 주", "· 외국인 -598만 주", "· 기관 -363만 주", "· 종가 270,000원"]);
    // 알림 영역 없음 — 막대 칸의 값(accessibilityValue)과 같은 글이라 쓸어 옮길 때 두 번 읽지 않게
    expect(pickedNode().props.accessibilityLiveRegion).toBeUndefined();
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
    // 칸은 숫자만 ('주'는 표 위에 한 번), 글자는 1.4배까지 (고정 폭 열 표 규칙)
    const cells = r.all(rows[0]!.children).filter((n) => n.type === "Text");
    expect(cells.map(textOf)).toEqual(["9월 28일", "+742만", "-598만", "-363만"]);
    for (const c of cells) expect(c.props.maxFontSizeMultiplier).toBe(1.4);
    expect(texts(r)).toContain("단위: 주");
    expect(toggle().props.accessibilityLabel).toBe("날짜별 숫자 접기");
    press(r, toggle());
    expect(r.all().some((n) => n.props.testID === "flow-day-table")).toBe(false);
  });

  it("외국인 보유율: 큰 숫자 · 날짜와 뜻 · 5·20·60일 전 · 선(화면 읽기 한 요소) · 가장 높음/낮음 · %p 풀이 · 한도 줄 없음", () => {
    const r = open(FX.cases.samsung);
    const all = texts(r);
    expect(all).toContain("46.52%");
    expect(all).toContain("9월 28일 (월) · 이 종목의 전체 주식 가운데 외국인이 가진 몫입니다.");
    // 'N일 전'은 장이 열린 날 수라 그 날짜를 함께 (9/28 에서 5일 전 = 추석을 건넌 9/17)
    expect(all).toContain("5일 전(9월 17일) 46.48% → +0.04%p");
    expect(all).toContain("20일 전(8월 27일) 46.75% → -0.23%p");
    expect(all).toContain("60일 전(6월 30일) 46.96% → -0.44%p");
    // 화면 읽기는 기호('→'·'%p') 대신 말로
    expect(byText(r, "5일 전(9월 17일) 46.48% → +0.04%p").props.accessibilityLabel).toBe("5일 전인 9월 17일 46.48%, 지금은 그때보다 0.04퍼센트포인트 높습니다");
    expect(byText(r, "20일 전(8월 27일) 46.75% → -0.23%p").props.accessibilityLabel).toBe("20일 전인 8월 27일 46.75%, 지금은 그때보다 0.23퍼센트포인트 낮습니다");
    expect(all).toContain("가장 높음 46.96% · 가장 낮음 46.46%");
    expect(all).toContain("%p는 퍼센트끼리 뺀 값입니다 (46.75% → 46.52%는 -0.23%p).");
    expect(all).toContain("외국인 보유율은 다음 날 오전에 한 번 더 고쳐지기도 합니다.");
    expect(all.some((s) => s.startsWith("이 종목은 외국인이 가질 수 있는 몫이"))).toBe(false);
    expect(all.some((s) => s.includes("이 회사"))).toBe(false); // ETF 도 같은 글을 쓴다
    expect(r.byLabel("외국인 보유율 60일, 6월 30일 46.96%에서 9월 28일 46.52%, 가장 높음 46.96%, 가장 낮음 46.46%").props.accessibilityRole).toBe("image");
  });

  it("읽는 법: 처음엔 접힘, 누르면 일곱 줄", () => {
    const r = open(FX.cases.samsung);
    expect(texts(r)).not.toContain("개인: 개인 투자자입니다.");
    const t = r.byLabel("이 숫자들이 뜻하는 것");
    expect(t.props.accessibilityState).toEqual({ expanded: false });
    press(r, t);
    expect(texts(r)).toContain("개인: 개인 투자자입니다.");
    expect(texts(r)).toContain("외국인: 금융감독원에 등록한 외국인 투자자입니다.");
    expect(texts(r)).toContain("모두 지난 기록입니다. 이 숫자만으로 주가가 어떻게 될지는 알 수 없습니다.");
    expect(texts(r)).toContain("기타법인: 투자 회사가 아닌 일반 회사 등입니다. 회사가 자기 회사 주식을 사면 보통 여기에 들어갑니다.");
  });

  it("출처 줄 · 대조 20/20", () => {
    const all = texts(open(FX.cases.samsung));
    expect(all).toContain("자료: 토스증권 웹 공개 화면 · 한국거래소와 넥스트레이드 거래를 합친 값 · 9월 28일 (월) 20:15 반영");
    expect(all).toContain("토스증권 Open API 원자료와 최근 20일 비교: 20일 모두 같음 (9월 29일 (화) 21:05 확인)");
    expect(all.some((s) => s.startsWith("새 자료를 받지 못해"))).toBe(false);
  });
});

describe("다른 경우", () => {
  it("한도율이 소수 둘째 자리까지 오면 그대로 (트리니티항공 49.99% — '50.0%'로 반올림하지 않음)", () => {
    const d = clone(FX.cases.kt);
    d.limit = { limitPct: 49.99, usedPct: 0.9 };
    expect(texts(open(d))).toContain("이 종목은 외국인이 가질 수 있는 몫이 전체 주식의 49.99%로 정해져 있습니다. 지금 그 한도의 0.9%를 채웠습니다.");
  });

  it("KT: 한도 줄 (49.0% · 100.0%) · 대조 20일 가운데 19일", () => {
    const r = open(FX.cases.kt);
    const all = texts(r);
    expect(all).toContain("이 종목은 외국인이 가질 수 있는 몫이 전체 주식의 49.0%로 정해져 있습니다. 지금 그 한도의 100.0%를 채웠습니다.");
    // 보유율이 60일 내내 49.00% → 선은 가로선 하나 (짧은 선분 60개를 이으면 점선처럼 보였다)
    const segs = r.all().filter((n) => n.props.testID === "flow-ratio-seg");
    expect(segs).toHaveLength(1);
    expect(flat(segs[0]!).borderRadius).toBeUndefined();
    expect(all).toContain("토스증권 Open API 원자료와 최근 20일 비교: 20일 가운데 19일 같음 (9월 29일 (화) 21:05 확인)");
  });

  it("네이버 폴백: 기준 문장(마지막 자료 날까지) · 기타법인 줄 없음 · 세 값 합 풀이 · 대조 줄 없음 · 읽는 법의 외국인 뜻", () => {
    const r = open(FX.cases.samsungNaver);
    expect(sumRows(r).map((n) => textOf(n))).toEqual(["개인-3,225만 주", "외국인-1,564만 주", "기관+895만 주"]);
    const all = texts(r);
    expect(all).toContain("기타법인 값이 없어 세 값을 더해도 대개 0이 되지 않습니다.");
    // ETF·ETN 은 넥스트레이드 거래가 없어 '빠져'가 틀린 말이라 기준이 다르다는 것만
    expect(all).toContain("자료: 네이버 증권 · 한국거래소 거래만 (기준이 달라 토스 앱 숫자와 다를 때가 있습니다) · 9월 28일 (월)까지 · 9월 29일 (화) 02:40에 받음");
    expect(all.some((s) => s.startsWith("토스증권 Open API"))).toBe(false);
    // 읽는 법: '금융감독원에 등록한'은 토스증권 기준이라 네이버 자료에서는 기준이 다르다고
    press(r, r.byLabel("이 숫자들이 뜻하는 것"));
    expect(texts(r)).toContain("외국인: 외국인 투자자입니다. 네이버 증권은 셈하는 기준이 토스증권과 달라 숫자가 같지 않습니다.");
    expect(texts(r)).not.toContain("외국인: 금융감독원에 등록한 외국인 투자자입니다.");
    // 기타법인 값이 없는 자료라 기타법인 뜻 줄도 없다 (여섯 줄)
    expect(texts(r).some((s) => s.startsWith("기타법인:"))).toBe(false);
    expect(texts(r).filter((s) => /^(개인|외국인|기관|기타법인): |^순매수라고|^오늘 값은|^모두 지난/.test(s))).toHaveLength(6);
  });

  it("네이버 폴백 60줄(둘째 쪽을 받지 못함): 60일 전 보유율이 없는 까닭 한 줄 (60일 합계는 보이므로)", () => {
    const r = open(FX.cases.samsungNaver);
    expect(FX.cases.samsungNaver.ratio!.ago["60"]).toBeNull();
    const all = texts(r);
    expect(all).toContain("60일 전 자료 없음 (네이버 증권 자료는 60일치까지라 그 앞날 값을 받지 못했습니다)");
    expect(all).toContain("5일 전(9월 17일) 46.48% → +0.08%p");
    // 토스 웹 자료가 짧은 종목(새로 상장)은 까닭 없이 '자료 없음' (합계 카드가 '받은 자료가 N일치'를 말함)
    const short = clone(FX.cases.samsung);
    short.ratio!.ago["60"] = null;
    expect(texts(open(short))).toContain("60일 전 자료 없음");
  });

  it("외국인 보유율 자료가 없는 종목(일부 ETN): 카드가 사라지지 않고 한 줄 안내", () => {
    const d = clone(FX.cases.samsungNaver);
    d.ratio = null;
    for (const x of d.days) x.foreignRatio = null;
    const r = open(d);
    expect(texts(r)).toContain("외국인 보유율");
    expect(texts(r)).toContain("이 종목은 외국인 보유율 자료가 없습니다.");
  });

  it("자료가 오래전에 끝난 종목(530036 모양 — 마지막 7월 6일, 9월 29일에 받음): '마지막 자료: 7월 6일 (월)' · 네이버 출처 줄도 '7월 6일 (월)까지'", () => {
    const d = clone(FX.cases.samsungNaver);
    d.days = [{ ...d.days[0]!, date: "2026-07-06" }];
    d.fetchedAt = "2026-09-29T04:50:00+09:00";
    const all = texts(open(d));
    expect(all).toContain("마지막 자료: 7월 6일 (월)");
    expect(all.some((s) => s.includes("7월 6일 (월)까지 · 9월 29일 (화) 04:50에 받음"))).toBe(true);
    // 요즘 자료는 이 줄이 없다
    expect(texts(open(FX.cases.samsung)).some((s) => s.startsWith("마지막 자료:"))).toBe(false);
  });

  it("장중 잠정 줄: 합계·막대에 넣지 않았다는 안내 + 그 시각까지 외국인·기관 (개인은 장이 끝난 뒤)", () => {
    const d = clone(FX.cases.samsung);
    d.today = { date: "2026-09-29", updatedAt: "2026-09-29T10:05:00+09:00", individual: null, foreign: 120_000, institution: -40_000 };
    const all = texts(open(d));
    expect(all).toContain("오늘(9월 29일) 값은 집계 중이라 합계와 막대에 넣지 않았습니다.");
    expect(all.some((s) => s.includes("))"))).toBe(false);
    expect(all).toContain("10:05까지 외국인 +12만 주 · 기관 -4만 주 (개인은 장이 끝난 뒤에 나옵니다)");
  });

  it("오래된 값 · 자료가 모자람 · 빈 값", () => {
    const d = clone(FX.cases.samsung);
    d.stale = true;
    d.sums["20"] = { ...d.sums["20"], days: 12, missing: 2 };
    const all = texts(open(d));
    expect(all).toContain("새 자료를 받지 못해 9월 29일 (화) 02:40에 받은 값입니다.");
    expect(all).toContain("받은 자료가 12일치라 12일 합계입니다.");
    // 부제도 실제로 더한 날 수 (20 이 아니라 12)
    expect(all).toContain("최근 12일 합계 (장이 열린 날 기준)");
    expect(all).not.toContain("최근 20일 합계 (장이 열린 날 기준)");
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
    expect(retry.props.accessibilityState).toEqual({ disabled: false, busy: false });
    // 다시 받는 중에는 버튼이 '불러오는 중'(돌아가는 표시 · 화면 읽기 busy)이고 또 누를 수 없다
    const again = open(undefined, { error: true, fetching: true });
    const busy = again.all().find((n) => n.type === "Pressable" && n.props.accessibilityLabel === "수급 자료 다시 불러오기")!;
    expect(busy.props.accessibilityState).toEqual({ disabled: true, busy: true });
    expect(busy.props.disabled).toBe(true);
    expect(again.all(busy.children).some((n) => n.type === "ActivityIndicator")).toBe(true);
    expect(texts(open(undefined))).toContain("수급 자료를 불러오는 중");
    expect(texts(open(null))).toContain("지금은 수급 자료를 볼 수 없습니다.");
  });

  it("빈 값: 화면에는 '—', 화면 읽기는 '값 없음' (고른 날 줄 · 막대 칸 값 · 날짜별 표)", () => {
    const d = clone(FX.cases.samsung);
    d.days[0] = { ...d.days[0]!, individual: null, institution: null };
    const r = open(d);
    const pickedNode = r.all().find((n) => n.props.testID === "flow-picked")!;
    expect(plain(pickedNode.props.accessibilityLabel as string)).toBe("9월 28일 (월) · 개인 값 없음 · 외국인 -598만 주 · 기관 값 없음 · 종가 270,000원");
    expect(r.all(pickedNode.children).filter((n) => n.type === "Text").map(textOf)).toEqual(["9월 28일 (월)", "· 개인 —", "· 외국인 -598만 주", "· 기관 —", "· 종가 270,000원"]);
    const area = r.all().find((n) => n.props.testID === "flow-bars-press")!;
    expect(plain((area.props.accessibilityValue as { text: string }).text)).toBe("9월 28일 (월) · 개인 값 없음 · 외국인 -598만 주 · 기관 값 없음 · 종가 270,000원");
    press(r, pressables(r).find((n) => /날짜별 숫자/.test(String(n.props.accessibilityLabel)))!);
    const table = r.all().find((n) => n.props.testID === "flow-day-table")!;
    const row0 = r.all(table.children).filter((n) => n.props.accessible === true)[0]!;
    expect(row0.props.accessibilityLabel).toBe("9월 28일 월요일, 개인 값 없음, 외국인 -598만 주, 기관 값 없음");
    expect(r2cells(row0).map(textOf)).toEqual(["9월 28일", "—", "-598만", "—"]);
  });

  it("화면 읽기가 켜져 있으면 막대 칸은 누르기를 받지 않는다 (두 번 두드림이 칸 가운데 날을 고르지 않게) — 날은 위·아래 쓸기로만", async () => {
    h.reader = true;
    const r = open(FX.cases.samsung);
    await settle(r);
    const area = () => r.all().find((n) => n.props.testID === "flow-bars-press")!;
    const picked = () => plain(r.all().find((n) => n.props.testID === "flow-picked")!.props.accessibilityLabel as string);
    expect(area().props.onPress).toBeUndefined();
    expect(area().props.accessibilityRole).toBe("adjustable");
    r.act(() => (area().props.onAccessibilityAction as (e: unknown) => void)({ nativeEvent: { actionName: "decrement" } }));
    expect(picked()).toMatch(/^9월 23일 \(수\) · /);
    // 화면 읽기를 끄면 다시 누를 수 있다
    r.act(() => h.readerFns.forEach((f) => f(false)));
    expect(typeof area().props.onPress).toBe("function");
    // 꺼져 있을 때(기본)는 처음부터 누를 수 있다
    h.reader = false;
    const off = open(FX.cases.samsung);
    await settle(off);
    expect(typeof off.all().find((n) => n.props.testID === "flow-bars-press")!.props.onPress).toBe("function");
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
    // 표 머리가 '5일 | 20일 | 60일'뿐이라 '장이 열린 날 기준'을 한 줄 남긴다
    expect(texts(r)).toContain("장이 열린 날 기준 최근 5·20·60일 합계");
    // 넓은 칸의 칩은 막대 카드에 있고 막대 기간만 바꾼다
    expect(chip(r, "20일").props.accessibilityLabel).toBe("막대 기간 20일");
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

  it("자료가 12일치: 열 머리·부제가 실제 날 수('5일 | 12일' · '최근 5·12일') — 같은 12일 합계를 두 열에 되풀이하지 않음, 뺀 날은 열마다", () => {
    const d = clone(FX.cases.samsung);
    d.sums["5"] = { ...d.sums["5"], days: 5, missing: 1 };
    d.sums["20"] = { ...d.sums["20"], days: 12, missing: 2 };
    d.sums["60"] = { ...d.sums["20"], days: 12, missing: 2 };
    const r = open(d, { width: 704 });
    const all = texts(r);
    expect(all).toContain("장이 열린 날 기준 최근 5·12일 합계");
    const head = r.all().find((n) => n.props.importantForAccessibility === "no-hide-descendants" && r.all(n.children).some((c) => c.type === "Text" && textOf(c) === "구분"))!;
    expect(r.all(head.children).filter((c) => c.type === "Text").map(textOf)).toEqual(["구분", "5일", "12일"]);
    const row = r.all().find((n) => n.props.accessible === true && String(n.props.accessibilityLabel).startsWith("개인, 최근 5일 합계"))!;
    expect(textOf(row)).toBe("개인-2,012만 주-3,348만 주");
    expect(row.props.accessibilityLabel).toMatch(/개인, 최근 12일 합계/);
    expect(all).toContain("받은 자료가 12일치라 12일 합계입니다.");
    // 5일 열은 1일, 12일 열은 2일 뺌 (예전: 60일 열 기준 '2일' 하나만)
    expect(all).toContain("(값이 없는 날은 빼고 더했습니다: 5일 합계 1일 · 12일 합계 2일)");
  });
});

describe("날짜별 숫자 표: 큰 글씨 (글자 200%)", () => {
  const openTable = (width: number) => {
    const r = open(FX.cases.samsung, { width, fontScale: 2 });
    press(r, pressables(r).find((n) => /날짜별 숫자/.test(String(n.props.accessibilityLabel)))!);
    const table = r.all().find((n) => n.props.testID === "flow-day-table")!;
    return r.all(table.children).filter((n) => n.props.accessible === true);
  };

  it("휴대폰 360: 날짜 열은 가장 넓은 날짜('12월 31일')가 1.4배 글자로 한 줄에 드는 폭, 세 칸은 나머지를 나눈다 · 모든 칸 한 줄", () => {
    const rows = openTable(360);
    const cells = r2cells(rows[0]!);
    expect(flat(cells[0]!).width).toBe(83);
    for (const c of cells) {
      expect(c.props.maxFontSizeMultiplier).toBe(1.4);
      expect(c.props.numberOfLines).toBe(1);
      // 글자를 저절로 줄이지 않는다 (고정 폭 열 표 — 1.4배 상한과 폭 계산으로 한 줄)
      expect(c.props.adjustsFontSizeToFit).toBeUndefined();
      expect(c.props.minimumFontScale).toBeUndefined();
    }
    // 9/21 개인 -1,243만 주: 칸에는 '-1,243만' (단위는 표 위) — '-1,243' / '만 주'로 갈라지지 않는다
    const d21 = rows.find((n) => String(n.props.accessibilityLabel).startsWith("9월 21일"))!;
    expect(r2cells(d21).map(textOf)).toEqual(["9월 21일", "-1,243만", "+595만", "+460만"]);
    expect(d21.props.accessibilityLabel).toBe("9월 21일 월요일, 개인 -1,243만 주, 외국인 +595만 주, 기관 +460만 주");
  });

  it("아주 좁은 칸(240)은 날짜를 위 줄에 따로 두고 세 칸이 폭을 나눈다 — 그래도 모자라면 표 글자 상한만 낮춘다(저절로 줄이기 없음)", () => {
    const rows = openTable(240);
    const cells = r2cells(rows[0]!);
    expect(flat(cells[0]!).width).toBe("100%");
    for (const c of cells) {
      expect(c.props.maxFontSizeMultiplier).toBeLessThan(1.4);
      expect(c.props.maxFontSizeMultiplier).toBeGreaterThanOrEqual(1);
      expect(c.props.adjustsFontSizeToFit).toBeUndefined();
    }
  });
});

describe("네이버 폴백 60줄: 집계 중인 오늘 줄이 끼면 확정 59일", () => {
  it("60일 칩: '네이버 증권 자료는 한 번에 60일치까지라' 안내 (종목 자료가 짧다는 글이 아니다)", () => {
    const d = clone(FX.cases.samsungNaver);
    d.days = d.days.slice(0, 59);
    d.sums["60"] = { ...d.sums["60"], days: 59 };
    d.today = { date: "2026-09-29", updatedAt: null, individual: 1, foreign: 2, institution: 3 };
    const r = open(d);
    press(r, chip(r, "60일"));
    const all = texts(r);
    expect(all).toContain("네이버 증권 자료는 한 번에 60일치까지라, 집계 중인 오늘 값을 빼면 59일 합계입니다.");
    expect(all).toContain("최근 59일 합계 (장이 열린 날 기준)");
    expect(all.some((s) => s.startsWith("받은 자료가"))).toBe(false);
  });
});

function r2cells(row: HostNode): HostNode[] {
  return row.children.filter((c): c is HostNode => typeof c !== "string" && c.type === "Text");
}
