import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RegisteredWithQuote } from "@/api/types";
import { holding, quote } from "./helpers";

// 위젯 프리미티브·RN·저장소를 가짜로: 렌더 결과(글자·색·누르면 가는 곳)만 본다
vi.mock("react-native-android-widget", () => {
  const mk = (kind: string) => Object.assign((_: unknown) => null, { __widget: kind });
  return { FlexWidget: mk("Flex"), TextWidget: mk("Text"), ListWidget: mk("List") };
});
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: { apiUrl: "https://server.test" } } } }));
const store = new Map<string, string>();
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: string) => void store.set(k, v),
    removeItem: async (k: string) => void store.delete(k),
    multiGet: async (keys: string[]) => keys.map((k) => [k, store.get(k) ?? null]),
  },
}));

const { AssetWidget, HoldingsWidget } = await import("@/widgets/widgets");
const { loadWidgetData, saveLastStocks } = await import("@/widgets/data");
const { HOME_URI, asOfLabel, failureText, assetLine } = await import("@/widgets/model");

interface Node {
  kind: string;
  props: Record<string, unknown>;
  children: Node[];
}
/** 함수 컴포넌트를 펼쳐 위젯 트리로 */
function render(el: React.ReactNode): Node[] {
  if (el === null || el === undefined || typeof el === "boolean") return [];
  if (Array.isArray(el)) return el.flatMap(render);
  if (!React.isValidElement(el)) return [];
  const type = el.type as { __widget?: string } & ((p: unknown) => React.ReactNode);
  const props = el.props as Record<string, unknown>;
  if (type.__widget) return [{ kind: type.__widget, props, children: render(props.children as React.ReactNode) }];
  if (typeof type === "function") return render(type(props));
  return render(props.children as React.ReactNode);
}
const all = (nodes: Node[]): Node[] => nodes.flatMap((n) => [n, ...all(n.children)]);
const texts = (nodes: Node[]) => all(nodes).filter((n) => n.kind === "Text").map((n) => ({ text: String(n.props.text), color: (n.props.style as { color?: string })?.color }));

const UP = "#FF4B55";
const DOWN = "#3D8EFF";
const NOW = Date.parse("2026-09-24T15:40:00+09:00");
const AT_CLOSE = "2026-09-24T15:30:00+09:00";

/** 원화 보유 17종목 + 관심 1 (종목명은 한글) */
function book(): RegisteredWithQuote[] {
  const names = "가나다라마바사아자차카타파하거너더".split("");
  const held = names.map((n, i) =>
    holding(`00${String(1000 + i).slice(1)}0`, quote(`00${String(1000 + i).slice(1)}0`, 10_000 + i * 100, { change: 100, asOf: AT_CLOSE }), 10, 9_000, undefined, `${n}종목`),
  );
  const watch = holding("999990", quote("999990", 5_000, { asOf: AT_CLOSE }), null, null, undefined, "관심종목");
  return [...held, watch];
}

beforeEach(() => {
  store.clear();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

describe("위젯-2: 자산 위젯 색 (오늘·총 각자 부호)", () => {
  const cases: [number, number, string, string][] = [
    [1000, 5000, UP, UP],
    [1000, -5000, UP, DOWN],
    [-1000, 5000, DOWN, UP],
    [-1000, -5000, DOWN, DOWN],
  ];
  for (const [day, profit, dc, pc] of cases) {
    it(`오늘 ${day > 0 ? "+" : "−"} / 총 ${profit > 0 ? "+" : "−"}`, () => {
      const l = assetLine(day, profit, String);
      expect(l.day.color).toBe(dc);
      expect(l.total.color).toBe(pc);
    });
  }

  it("렌더 결과: 오늘 +, 총 − 이면 총손익 글자가 파랑", () => {
    // 오늘은 오름(+100×10), 평단이 높아 총손익은 손실
    const s = [holding("005930", quote("005930", 70_000, { change: 100, asOf: AT_CLOSE }), 10, 80_000)];
    const tx = texts(render(<AssetWidget stocks={s} showKrw={false} fetchedAt={NOW} error={null} now={NOW} />));
    expect(tx.find((t) => t.text.startsWith("오늘"))!.color).toBe(UP);
    expect(tx.find((t) => /^총 [+-]/.test(t.text))!.color).toBe(DOWN);
  });
});

describe("위젯-3: 시세 없는 보유 종목", () => {
  it("SOXL 처럼 한 종목 시세가 null 이어도 보유 17 유지, '관심' 표시 0, 마지막 값으로 합계 유지", async () => {
    const full = book();
    await saveLastStocks(full, NOW - 60_000);
    const broken = full.map((s, i) => (i === 3 ? { ...s, quote: null, quoteError: "시세 없음", evaluation: null } : s));
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(broken), { status: 200 }));
    const d = await loadWidgetData({ stocks: true, briefings: false });
    expect(d.filled).toEqual([full[3]!.code]);
    const nodes = render(<HoldingsWidget stocks={d.stocks} showKrw={false} fetchedAt={d.fetchedAt} error={d.error} filled={d.filled} now={NOW} />);
    const tx = texts(nodes).map((t) => t.text);
    expect(tx).toContain("잔고 18");
    expect(tx.filter((t) => t === "관심")).toHaveLength(1); // 진짜 관심 종목 1개만
    const fullTotal = texts(render(<HoldingsWidget stocks={full} showKrw={false} fetchedAt={NOW} error={null} now={NOW} />)).map((t) => t.text).find((t) => t.endsWith("원") && !t.startsWith("당일"));
    expect(tx).toContain(fullTotal);
    expect(tx.some((t) => t.includes("1종목 이전 값"))).toBe(true);
  });

  it("마지막 값도 없으면 '시세 없음'으로 보유에 남고 '일부 제외 1' 표시", () => {
    const s = book().map((x, i) => (i === 3 ? { ...x, quote: null, evaluation: null } : x));
    const tx = texts(render(<HoldingsWidget stocks={s} showKrw={false} fetchedAt={NOW} error={null} now={NOW} />)).map((t) => t.text);
    expect(tx).toContain("10주 · 시세 없음");
    expect(tx.some((t) => t.includes("일부 제외 1"))).toBe(true);
  });
});

describe("위젯-1: 조회 실패", () => {
  it("비행기 모드 10회: 합계·종목 유지, '잔고 0'·영어 오류 0건, '갱신 실패' 회색", async () => {
    const full = book();
    await saveLastStocks(full, NOW - 120_000);
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Network request failed");
    });
    for (let i = 0; i < 10; i++) {
      const d = await loadWidgetData({ stocks: true, briefings: false });
      const tx = texts(render(<HoldingsWidget stocks={d.stocks} showKrw={false} fetchedAt={d.fetchedAt} error={d.error} filled={d.filled} now={NOW} />));
      const words = tx.map((t) => t.text);
      expect(words).toContain("잔고 18");
      expect(words).not.toContain("잔고 0");
      expect(words.join(" ")).not.toMatch(/Network|request|failed|HTTP|Error/);
      const note = tx.find((t) => t.text.startsWith("갱신 실패"))!;
      expect(note.text).toBe("갱신 실패 · 연결 안 됨");
      expect(note.color).toBe("#7A828F");
      const asset = texts(render(<AssetWidget stocks={d.stocks} showKrw={false} fetchedAt={d.fetchedAt} error={d.error} filled={d.filled} now={NOW} />)).map((t) => t.text);
      expect(asset.some((t) => /^\d[\d,]*원$/.test(t))).toBe(true);
    }
  });

  it("처음부터 받은 적이 없으면 한국어 안내", async () => {
    vi.stubGlobal("fetch", async () => new Response("", { status: 500 }));
    const d = await loadWidgetData({ stocks: true, briefings: false });
    const words = texts(render(<AssetWidget stocks={d.stocks} showKrw={false} fetchedAt={d.fetchedAt} error={d.error} now={NOW} />)).map((t) => t.text);
    expect(words).toContain("갱신 실패 · 서버 오류 · 눌러서 앱 열기");
  });

  it("실패 사유 한국어", () => {
    expect(failureText("HTTP 401")).toBe("갱신 실패 · 토큰 확인");
    expect(failureText("Aborted")).toBe("갱신 실패 · 응답 없음");
    expect(failureText("HTTP 503")).toBe("갱신 실패 · 서버 오류");
    expect(failureText(null)).toBeNull();
  });
});

describe("위젯-8: 기준 시각은 시세 시각", () => {
  it("장 마감 뒤에는 15:30 기준 (휴대폰이 받은 15:40 이 아니라)", () => {
    const words = texts(render(<HoldingsWidget stocks={book()} showKrw={false} fetchedAt={NOW} error={null} now={NOW} />)).map((t) => t.text);
    expect(words).toContain("15:30 기준");
  });
  it("오늘이 아니면 날짜까지", () => {
    expect(asOfLabel(Date.parse("2026-09-23T15:30:00+09:00"), NOW)).toBe("9/23 15:30 기준");
  });
});

describe("위젯-13: 누르면 잔고 탭", () => {
  it("자산 위젯 전체와 잔고 위젯 머리는 잔고 탭 주소로", () => {
    const asset = render(<AssetWidget stocks={book()} showKrw={false} fetchedAt={NOW} error={null} now={NOW} />);
    expect(asset[0]!.props.clickAction).toBe("OPEN_URI");
    expect(asset[0]!.props.clickActionData).toEqual({ uri: HOME_URI });
    const holdings = all(render(<HoldingsWidget stocks={book()} showKrw={false} fetchedAt={NOW} error={null} now={NOW} />));
    expect(holdings.filter((n) => n.props.clickAction === "OPEN_APP")).toHaveLength(0);
    expect(holdings.some((n) => (n.props.clickActionData as { uri?: string })?.uri === HOME_URI)).toBe(true);
  });
});
