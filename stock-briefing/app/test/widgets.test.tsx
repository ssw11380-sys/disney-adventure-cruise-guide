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
const { HOME_URI, asOfLabel, failureText, assetLine, fillFromLast } = await import("@/widgets/model");
const API = "https://server.test";

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
    await saveLastStocks(full, NOW - 60_000, API);
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
    expect(tx.some((t) => t.startsWith("이전 값 · "))).toBe(true); // 채운 종목 행에도 표시
  });

  it("어제 값으로 채우면 등락은 0 (지난 거래일 등락이 오늘 손익에 들어가지 않게)", () => {
    const yesterday = [holding("005930", quote("005930", 70_000, { change: 5_000, changeRate: 7.7, asOf: "2026-09-23T15:30:00+09:00" }), 10, 60_000)];
    const now = [{ ...yesterday[0]!, quote: null, evaluation: null }];
    const f = fillFromLast(now, yesterday, NOW);
    expect(f.filled).toEqual(["005930"]);
    expect(f.stocks[0]!.quote!.change).toBe(0);
    expect(f.stocks[0]!.quote!.price).toBe(70_000);
    // 오늘 값이면 등락 유지
    const today = [holding("005930", quote("005930", 70_000, { change: 5_000, asOf: AT_CLOSE }), 10, 60_000)];
    expect(fillFromLast(now, today, NOW).stocks[0]!.quote!.change).toBe(5_000);
  });

  it("7일 넘은 값·수량이 바뀐 종목은 채우지 않음", () => {
    const old = [holding("005930", quote("005930", 70_000, { asOf: "2026-09-16T15:30:00+09:00" }), 10, 60_000)];
    const now = [{ ...old[0]!, quote: null, evaluation: null }];
    expect(fillFromLast(now, old, NOW).filled).toEqual([]);
    const fresh = [holding("005930", quote("005930", 70_000, { asOf: AT_CLOSE }), 10, 60_000)];
    expect(fillFromLast([{ ...now[0]!, quantity: 11 }], fresh, NOW).filled).toEqual([]);
  });

  it("서버 주소가 바뀌면 이전 서버의 잔고를 쓰지 않음", async () => {
    await saveLastStocks(book(), NOW - 60_000, "https://other.server");
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Network request failed");
    });
    const d = await loadWidgetData({ stocks: true, briefings: false });
    expect(d.stocks).toEqual([]);
  });

  it("모든 보유 종목 시세가 없고 이전 값도 없으면 자산 위젯은 '시세 없음 · N종목' ('보유 종목 없음' 아님)", () => {
    const s = book().map((x) => ({ ...x, quote: null, evaluation: null }));
    const words = texts(render(<AssetWidget stocks={s} showKrw={false} fetchedAt={NOW} error={null} now={NOW} />)).map((t) => t.text);
    expect(words).toContain("시세 없음 · 17종목");
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
    await saveLastStocks(full, NOW - 120_000, API);
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

const { fromPayload, isDelayed, shouldSkipFetch } = await import("@/widgets/payload");
const { widgetPushDue } = await import("@/widgets/pushPolicy");
const { BriefingWidget } = await import("@/widgets/widgets");

describe("3-16 위젯 데이터·갱신 주기", () => {
  const payload = {
    v: 1 as const,
    market: { label: "한국 장중", open: true, nextChangeAt: "2026-09-24T06:30:00Z" },
    stocks: [
      { c: "005930", n: "삼성전자", qty: 10, avg: 60_000, q: [70_000, 100, 0.14, "KRW", AT_CLOSE, null, 0] as [number, number, number, "KRW", string, null, 0], e: [700_000, 600_000, 698_000, null, null] as [number, number, number, null, null] },
      { c: "VRT", n: "버티브", qty: 2, avg: 200, q: [250, -1, -0.4, "USD", AT_CLOSE, 1360, 0] as [number, number, number, "USD", string, number, 0], e: [500, 400, 499, 540_000, "exact"] as [number, number, number, number, "exact"] },
      { c: "999990", n: "관심", qty: null, avg: null, q: [5_000, 0, 0, "KRW", AT_CLOSE, null, 1] as [number, number, number, "KRW", string, null, 1], e: null },
    ],
    briefings: [
      { id: 3, code: "005930", name: "삼성전자", session: "afternoon", date: "2026-09-24", summary: "첫 줄 삼성\n둘째 줄", createdAt: "2026-09-24T16:05:00+09:00" },
      { id: 2, code: "VRT", name: "버티브", session: "afternoon", date: "2026-09-24", summary: "첫 줄 버티브", createdAt: "2026-09-24T16:04:00+09:00" },
    ],
    latestIds: [2, 3],
  };

  it("짧은 키 응답을 위젯 모양으로: 손익·수익률은 평가금 − 매입금으로 계산 (서버 evaluate 와 같은 식)", () => {
    const p = fromPayload(payload);
    const s = p.stocks[0]!;
    expect(s.quote).toMatchObject({ price: 70_000, change: 100, changeRate: 0.14, currency: "KRW", asOf: AT_CLOSE });
    expect(s.evaluation).toMatchObject({ marketValue: 700_000, costBasis: 600_000, profit: 100_000, profitRate: 16.67, afterCost: { marketValue: 698_000, profit: 98_000, profitRate: 16.33 } });
    expect(p.stocks[1]!.evaluation).toMatchObject({ costBasisKrw: 540_000, krwCostSource: "exact" });
    expect(p.stocks[2]!.quote).toMatchObject({ stale: true });
    expect(p.briefings.map((b) => b.code)).toEqual(["005930", "VRT"]);
  });

  it("/api/widget 한 번으로 받고, 같은 내용이면 304 → 저장해 둔 값", async () => {
    const calls: { url: string; inm: string | null }[] = [];
    let first = true;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      calls.push({ url, inm: h.get("if-none-match") });
      if (first) {
        first = false;
        return new Response(JSON.stringify(payload), { status: 200, headers: { etag: '"abc"' } });
      }
      return new Response(null, { status: 304, headers: { etag: '"abc"' } });
    });
    const a = await loadWidgetData({ stocks: true, briefings: true });
    const b = await loadWidgetData({ stocks: true, briefings: true });
    expect(calls.map((c) => c.url)).toEqual([`${API}/api/widget`, `${API}/api/widget`]);
    expect(calls[1]!.inm).toBe('"abc"');
    expect(b.stocks.map((s) => s.code)).toEqual(a.stocks.map((s) => s.code));
    expect(b.market?.label).toBe("한국 장중");
    expect(b.latestIds).toEqual([2, 3]);
  });

  it("예전 서버(/api/widget 404)면 예전 두 API 로", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      if (url.endsWith("/api/widget")) return new Response("", { status: 404 });
      return new Response(JSON.stringify(url.includes("briefings") ? [] : book()), { status: 200 });
    });
    const d = await loadWidgetData({ stocks: true, briefings: true });
    expect(urls).toEqual([`${API}/api/widget`, `${API}/api/stocks?quotes=1`, `${API}/api/briefings/latest`]);
    expect(d.stocks).toHaveLength(18);
    expect(d.market).toBeNull();
  });

  it("장 상태 칩과 '지연': 장중인데 시세가 30분 넘게 지났으면 지연", () => {
    const p = fromPayload(payload);
    const later = Date.parse(AT_CLOSE) + 31 * 60_000;
    const tx = texts(render(<HoldingsWidget stocks={p.stocks} showKrw={false} fetchedAt={later} error={null} now={later} market={p.market} />)).map((t) => t.text);
    expect(tx).toContain("한국 장중");
    expect(tx).toContain("지연");
    const fresh = texts(render(<HoldingsWidget stocks={p.stocks} showKrw={false} fetchedAt={NOW} error={null} now={Date.parse(AT_CLOSE) + 5 * 60_000} market={p.market} />)).map((t) => t.text);
    expect(fresh).not.toContain("지연");
    const holiday = texts(render(<AssetWidget stocks={p.stocks} showKrw={false} fetchedAt={later} error={null} now={later} market={{ label: "휴장", open: false, nextChangeAt: null }} />)).map((t) => t.text);
    expect(holiday).toContain("휴장");
    expect(holiday.some((t) => t.startsWith("지연"))).toBe(false); // 휴장 중 옛 시세는 지연이 아님
    expect(isDelayed({ marketOpen: false, asOf: 0, fetchedAt: NOW - 31 * 60_000, error: "HTTP 500", now: NOW })).toBe(true);
  });

  it("브리핑 위젯: 서버가 고른 순서(보유 비중)대로 최대 3종목, 고지 한 줄은 항상", () => {
    const p = fromPayload(payload);
    const tx = texts(render(<BriefingWidget briefings={p.briefings} fetchedAt={NOW} error={null} now={NOW} market={p.market} />)).map((t) => t.text);
    expect(tx.filter((t) => t.includes(" · 09/24") || t.includes(" · 9/24") || / · \d\d\/\d\d/.test(t))).toHaveLength(2);
    expect(tx).toContain("첫 줄 삼성");
    expect(tx).toContain("첫 줄 버티브");
    expect(tx).toContain("참고 정보이며 투자 권유가 아닙니다");
    const empty = texts(render(<BriefingWidget briefings={[]} fetchedAt={NOW} error={null} now={NOW} />)).map((t) => t.text);
    expect(empty).toContain("참고 정보이며 투자 권유가 아닙니다");
  });

  it("백그라운드: 두 시장이 닫혀 있으면 2시간에 한 번만 서버에 (다음 개장·브리핑 시간에는 바로)", () => {
    const closed = { label: "휴장", open: false, nextChangeAt: "2026-09-28T23:00:00Z" };
    const t = Date.parse("2026-09-26T13:00:00+09:00"); // 토요일 낮
    expect(shouldSkipFetch({ at: t - 30 * 60_000, market: closed }, t)).toBe(true);
    expect(shouldSkipFetch({ at: t - 2 * 3_600_000, market: closed }, t)).toBe(false);
    expect(shouldSkipFetch({ at: t - 10 * 60_000, market: { ...closed, open: true } }, t)).toBe(false);
    expect(shouldSkipFetch({ at: t - 10 * 60_000, market: { ...closed, nextChangeAt: "2026-09-26T03:55:00Z" } }, t)).toBe(false); // 개장 시각 지남
    const briefingTime = Date.parse("2026-09-24T16:10:00+09:00");
    expect(shouldSkipFetch({ at: briefingTime - 10 * 60_000, market: closed }, briefingTime)).toBe(false);
    expect(shouldSkipFetch(null, t)).toBe(false);
  });

  it("앱 → 위젯: 시세만 바뀌면 1분에 한 번, 원화 표시를 바꾸거나 앱을 떠나면 바로", () => {
    const base = { now: NOW, dataAt: NOW - 1000, lastAt: NOW - 10_000, lastKey: "false|true|장 마감", key: "false|true|장 마감" };
    expect(widgetPushDue(base)).toBe(false);
    expect(widgetPushDue({ ...base, key: "true|true|장 마감" })).toBe(true);
    expect(widgetPushDue({ ...base, leaving: true })).toBe(true);
    expect(widgetPushDue({ ...base, lastAt: NOW - 61_000 })).toBe(true);
    expect(widgetPushDue({ ...base, key: "true|true|장 마감", dataAt: NOW - 60_000 })).toBe(false); // 기기에 저장해 둔 옛 값으로는 덮지 않음
  });
});
