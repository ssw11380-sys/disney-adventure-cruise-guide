import { fileURLToPath } from "node:url";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RegisteredWithQuote } from "@/api/types";
import { holding, quote } from "./helpers";
import { WIDGET_COLORS } from "@/widgets/palette";

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
const { HOME_URI, asOfLabel, failureText, assetLine, cumulativeLine, cumulativeRate, fillFromLast } = await import("@/widgets/model");
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

describe("잔고 위젯 합계 옆은 누적 손익 금액·수익률 (2026-09-24 요청)", () => {
  it("누적 수익률 = 누적 손익 ÷ (평가금액 − 누적 손익) — 토스 '내 투자'와 같은 기준", () => {
    // 토스 위젯 예: 평가 72,956,242원, 손익 −5,901,231원 → 매입 78,857,473원, −7.48%
    expect(cumulativeRate(72_956_242, -5_901_231)).toBeCloseTo(-7.483, 3);
    expect(cumulativeRate(110, 10)).toBeCloseTo(10, 6); // 매입 100 에 +10
    expect(cumulativeRate(0, 0)).toBeNull();
    expect(cumulativeRate(100, 100)).toBeNull(); // 매입금액 0
    const l = cumulativeLine(72_956_242, -5_901_231, (n) => `${n}원`, (n) => `${n.toFixed(2)}%`);
    expect(l).toEqual({ text: "누적 -5901231원 (-7.48%)", color: DOWN });
    expect(cumulativeLine(100, 100, String, String).text).toBe("누적 100"); // 수익률을 낼 수 없으면 금액만
  });

  it("렌더 결과: 오늘은 올라도 누적이 손실이면 '누적 −…원 (−…%)' 파랑, '당일' 글자는 없다", () => {
    // 오늘 +100×10 = +1,000원, 평단 80,000 → 누적 (70,000−80,000)×10 = −100,000원, −12.50%
    const s = [holding("005930", quote("005930", 70_000, { change: 100, asOf: AT_CLOSE }), 10, 80_000)];
    const tx = texts(render(<HoldingsWidget stocks={s} showKrw={false} afterCost={false} fetchedAt={NOW} error={null} now={NOW} />));
    const cum = tx.find((t) => t.text.startsWith("누적"))!;
    expect(cum.text).toBe("누적 -100,000원 (-12.50%)");
    expect(cum.color).toBe(DOWN);
    expect(tx.some((t) => t.text.startsWith("당일"))).toBe(false);
  });

  it("미국 종목을 원화로 볼 때도 합계와 같은 통화·같은 기준으로", () => {
    const us = holding("AAPL", quote("AAPL", 220, { currency: "USD", fxRate: 1_400, priceKrw: 308_000, change: 1, asOf: AT_CLOSE }), 2, 200);
    const tx = texts(render(<HoldingsWidget stocks={[us]} showKrw afterCost={false} fetchedAt={NOW} error={null} now={NOW} />)).map((t) => t.text);
    const cum = tx.find((t) => t.startsWith("누적"))!;
    expect(cum).toMatch(/^누적 \+[\d,]+원 \(\+\d+\.\d{2}%\)$/);
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
    const fullTotal = texts(render(<HoldingsWidget stocks={full} showKrw={false} fetchedAt={NOW} error={null} now={NOW} />)).map((t) => t.text).find((t) => t.endsWith("원") && !t.startsWith("누적"));
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

  it("BH-40: 미국 종목은 뉴욕 거래일로 본다 — 한국 자정이 지나도 같은 뉴욕 세션이면 등락 유지, 한국 날짜가 같아도 다른 뉴욕 세션이면 0", () => {
    const nvda = (asOf: string) => [holding("NVDA", quote("NVDA", 180, { currency: "USD", fxRate: 1_400, change: 5, changeRate: 2.86, asOf }), 10, 150)];
    const gone = (s: RegisteredWithQuote[]) => [{ ...s[0]!, quote: null, evaluation: null }];
    // 9/22 23:50 KST(뉴욕 10:50 정규장)에 받은 +5 → 00:01·01:00 KST(뉴욕 11:01·12:00, 같은 정규장)에 채워도 +5
    const last = nvda("2026-09-22T23:50:00+09:00");
    for (const t of ["2026-09-22T23:59:00+09:00", "2026-09-23T00:01:00+09:00", "2026-09-23T01:00:00+09:00"]) {
      const f = fillFromLast(gone(last), last, Date.parse(t));
      expect(f.filled, t).toEqual(["NVDA"]);
      expect(f.stocks[0]!.quote!.change, t).toBe(5);
      expect(f.stocks[0]!.quote!.changeRate, t).toBe(2.86);
    }
    // 반대: 08:30 KST(뉴욕 전날 19:30 애프터마켓 — 9/22 거래일) 값을 23:00 KST(뉴욕 10:00 — 9/23 정규장)에 채우면 지난 세션 등락이라 0
    const morning = nvda("2026-09-23T08:30:00+09:00");
    const f = fillFromLast(gone(morning), morning, Date.parse("2026-09-23T23:00:00+09:00"));
    expect(f.stocks[0]!.quote!.change).toBe(0);
    expect(f.stocks[0]!.quote!.changeRate).toBe(0);
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
      expect(note.color).toBe(WIDGET_COLORS.muted); // 회색 (위젯 팔레트)
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

const { pickWidgetBriefings, widgetBriefingsKey } = await import("@/widgets/refresh");
const { indexLineTargets } = await import("@/widgets/widgets");

describe("위젯 검토 7번: 앱이 브리핑 위젯에 넘기는 3종목은 서버(/api/widget briefings)와 같은 규칙", () => {
  type Latest = Parameters<typeof pickWidgetBriefings>[0][number];
  const latest = (code: string, name: string, id: number, createdAt: string, status: "ok" | "failed" = "ok", summary = `${name} 첫 줄\n둘째 줄`): Latest => ({
    code,
    name,
    latest: { id, code, name, session: "afternoon", date: "2026-09-24", status, summary, detail: "## 긴 본문", missing: [], model: "test", error: null, createdAt },
  });
  // 원화 환산 평가금액: 애플 3주 × $200 × 1,300 = 780,000 · 삼성전자 10주 × 70,000 = 700,000 · 테슬라 2주 × $250 × (환율 모름 → 1,400) = 700,000
  // 엔비디아는 가장 크지만 최신 브리핑이 실패, 관심종목은 평가 없음(0), 000660 은 목록에 없는 종목(0)
  const stocks = [
    holding("005930", quote("005930", 70_000), 10, 60_000, undefined, "삼성전자"),
    holding("AAPL", quote("AAPL", 200, { currency: "USD", fxRate: 1300 }), 3, 150, undefined, "애플"),
    holding("TSLA", quote("TSLA", 250, { currency: "USD", fxRate: null }), 2, 200, undefined, "테슬라"),
    holding("NVDA", quote("NVDA", 180, { currency: "USD", fxRate: 1300 }), 100, 100, undefined, "엔비디아"),
    holding("999990", quote("999990", 5_000), null, null, undefined, "관심종목"),
  ];
  const list: Latest[] = [
    latest("005930", "삼성전자", 11, "2026-09-24T16:02:00+09:00"),
    latest("AAPL", "애플", 12, "2026-09-24T16:01:00+09:00", "ok", "\n  \n애플 첫 줄\n둘째 줄"),
    latest("TSLA", "테슬라", 13, "2026-09-24T16:05:00+09:00"),
    latest("NVDA", "엔비디아", 14, "2026-09-24T16:06:00+09:00", "failed"),
    latest("999990", "관심종목", 15, "2026-09-24T16:09:00+09:00"),
    latest("000660", "SK하이닉스", 16, "2026-09-24T16:08:00+09:00"),
    { code: "035420", name: "NAVER", latest: null },
  ];

  it("보유 비중 큰 순(달러는 그 시세의 환율, 모르면 1,400원), 같으면 최신 순, 성공한 것만 3개 — 요약은 첫 줄만, 상세 본문은 넘기지 않는다", () => {
    const picked = pickWidgetBriefings(list, stocks);
    expect(picked.map((b) => b.code)).toEqual(["AAPL", "TSLA", "005930"]);
    expect(picked.map((b) => b.latest!.summary)).toEqual(["애플 첫 줄", "테슬라 첫 줄", "삼성전자 첫 줄"]);
    expect(picked.every((b) => b.latest!.status === "ok" && b.latest!.detail === "")).toBe(true);
    // 평가가 0 인 종목끼리는 최신 순 (보유가 적으면 관심·목록에 없는 종목이 들어온다)
    expect(pickWidgetBriefings(list, []).map((b) => b.code)).toEqual(["999990", "000660", "TSLA"]);
    expect(pickWidgetBriefings([], stocks)).toEqual([]);
    // 받은 목록은 바꾸지 않는다 (앱 캐시를 그대로 둔다)
    expect(list.map((b) => b.code)).toEqual(["005930", "AAPL", "TSLA", "NVDA", "999990", "000660", "035420"]);
  });

  it("서버 buildWidgetPayload 와 같은 입력이면 같은 3종목·같은 순서·같은 요약 (서버 코드를 직접 불러 견준다)", async () => {
    // 타입 검사는 앱 설정으로 서버 파일을 보지 않게 경로를 변수로 (서버 파일은 타입만 가져오는 순수 함수)
    const path = fileURLToPath(new URL("../../backend/src/services/widgetPayload.ts", import.meta.url));
    const server = (await import(/* @vite-ignore */ path)) as {
      buildWidgetPayload: (s: unknown[], l: unknown[], status: null) => { briefings: { id: number; code: string; name: string; session: string; date: string; summary: string; createdAt: string }[] };
    };
    for (const s of [stocks, [], stocks.slice(0, 2), [...stocks].reverse()]) {
      const fromServer = server.buildWidgetPayload(s, list, null).briefings;
      const fromApp = pickWidgetBriefings(list, s).map((b) => ({ id: b.latest!.id, code: b.code, name: b.name, session: b.latest!.session, date: b.latest!.date, summary: b.latest!.summary, createdAt: b.latest!.createdAt }));
      expect(fromApp).toEqual(fromServer);
    }
  });
});

describe("위젯 검토 7번: 다듬은 잔고 위젯 지수 줄 — 항목마다 따로 누를 수 있는지", () => {
  const item = (code: string, label: string, rate: string | null) => ({ code, label, value: "1", rate, stale: false, short: true });
  it("한 줄이고 항목이 모두 48dp 이상이면 항목마다, 하나라도 좁으면 줄 전체가 첫 항목(그 지수 차트) 한 칸", () => {
    const wide = { font: 10, height: 15, lines: [[item("NASDAQ", "나스닥", "-1.13%"), item("KOSPI", "코스피", "+0.90%"), item("USDKRW", "원/달러", "+0.38%")]] };
    expect(indexLineTargets(wide, 1)).toBe("each");
    const narrow = { font: 10, height: 15, lines: [[item("SPX", "S", null), item("NASDAQ", "나스닥", "-1.13%")]] };
    expect(indexLineTargets(narrow, 1)).toEqual({ single: "SPX" });
    // 글자를 줄이면(배율 < 1) 좁아질 수 있다
    expect(indexLineTargets({ ...wide, lines: [[item("KOSPI", "코", null)]] }, 0.85)).toEqual({ single: "KOSPI" });
  });

  it("검증 지적 (2차): 두 줄이어도(4x3 이상·폴드8 커버 4x2 크게) 항목이 모두 48dp 이상이면 항목마다 — 첫 항목 한 칸은 항목이 좁을 때만", () => {
    // 예전(1차 반영): 두 줄이면 늘 줄 전체가 첫 항목(나스닥) 한 칸 → '코스피'·'원/달러'를 눌러도 나스닥 차트가 열렸다
    const two = { font: 10, height: 15, lines: [[item("NASDAQ", "나스닥", "-1.13%"), item("SPX", "S&P500", "+0.19%")], [item("KOSPI", "코스피", "+0.90%"), item("USDKRW", "원/달러", "+0.38%")]] };
    expect(indexLineTargets(two, 1)).toBe("each");
    expect(indexLineTargets({ ...two, lines: [two.lines.flat()] }, 1)).toBe("each");
    // 어느 줄이든 좁은 항목이 있으면 줄 전체가 첫 항목(윗줄 첫 항목) 한 칸
    expect(indexLineTargets({ ...two, lines: [two.lines[0]!, [item("KOSPI", "코", null)]] }, 0.85)).toEqual({ single: "NASDAQ" });
  });
});

describe("검증 지적: 앱 → 위젯 즉시 넘김의 브리핑 목록 키는 시세(보유 비중 순서)를 보지 않는다", () => {
  type Latest = Parameters<typeof widgetBriefingsKey>[0][number];
  const latest = (code: string, id: number, createdAt: string, status: "ok" | "failed" = "ok"): Latest => ({
    code,
    name: code,
    latest: { id, code, name: code, session: "afternoon", date: "2026-09-24", status, summary: "요약", detail: "", missing: [], model: "test", error: null, createdAt },
  });
  const a = latest("005930", 1, "2026-09-24T16:05:00+09:00");
  const b = latest("000660", 2, "2026-09-24T16:06:00+09:00");
  const c = latest("NVDA", 3, "2026-09-24T16:07:00+09:00");
  it("받은 순서와 상관없이 같고, 성공한 브리핑의 id·만든 시각이 바뀔 때만 바뀐다", () => {
    const key = widgetBriefingsKey([a, b, c]);
    expect(widgetBriefingsKey([c, a, b])).toBe(key);
    // 실패한 것·브리핑 없는 종목은 넣지 않는다 (위젯에 들어가지 않으므로)
    expect(widgetBriefingsKey([a, b, c, latest("TSLA", 4, "2026-09-24T16:08:00+09:00", "failed"), { code: "AAPL", name: "애플", latest: null }])).toBe(key);
    // 다시 만들기(새 id)·최신이 실패로 바뀜은 키가 바뀐다
    expect(widgetBriefingsKey([latest("005930", 5, "2026-09-24T16:20:00+09:00"), b, c])).not.toBe(key);
    expect(widgetBriefingsKey([latest("005930", 6, "2026-09-24T16:20:00+09:00", "failed"), b, c])).not.toBe(key);
    expect(widgetBriefingsKey([])).toBe("");
  });
});

const { canReuse, fromPayload, isDelayed, shouldSkipFetch } = await import("@/widgets/payload");
const { widgetPushDue } = await import("@/widgets/pushPolicy");
const { BriefingWidget } = await import("@/widgets/widgets");

describe("3-16 위젯 데이터·갱신 주기", () => {
  const payload = {
    v: 1 as const,
    market: { label: "한국 장중", open: true, nextChangeAt: "2026-09-24T11:00:00Z", kr: true, us: false },
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
    // 새 앱은 지수 줄을 그릴 수 있다고 알린다 (?indices=1 — 서버는 이 표시가 있을 때만 지수를 넣는다)
    expect(calls.map((c) => c.url)).toEqual([`${API}/api/widget?indices=1&sessions=1&ui=2`, `${API}/api/widget?indices=1&sessions=1&ui=2`]);
    expect(calls[1]!.inm).toBe('"abc"');
    expect(b.stocks.map((s) => s.code)).toEqual(a.stocks.map((s) => s.code));
    expect(b.market?.label).toBe("한국 장중");
    expect(b.latestIds).toEqual([2, 3]);
  });

  it("예전 서버(/api/widget 404)면 예전 두 API 로", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      if (url.includes("/api/widget")) return new Response("", { status: 404 });
      return new Response(JSON.stringify(url.includes("briefings") ? [] : book()), { status: 200 });
    });
    const d = await loadWidgetData({ stocks: true, briefings: true });
    expect(urls).toEqual([`${API}/api/widget?indices=1&sessions=1&ui=2`, `${API}/api/stocks?quotes=1`, `${API}/api/briefings/latest`]);
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
    expect(isDelayed({ openAsOf: null, fetchedAt: NOW - 31 * 60_000, error: "HTTP 500", now: NOW })).toBe(true);
  });

  it("지연은 열린 시장 종목의 시세만 본다: 한국 장중에 미국 종목만 가진 사람은 지연 아님, 칩은 다음 개장·마감 시각이 지나면 감춤", () => {
    const p = fromPayload(payload);
    const usOnly = p.stocks.filter((x) => x.quote?.currency === "USD").map((x) => ({ ...x, quote: { ...x.quote!, asOf: "2026-09-24T05:00:00+09:00" } }));
    const t = Date.parse("2026-09-24T11:00:00+09:00");
    const tx = texts(render(<HoldingsWidget stocks={usOnly} showKrw={false} fetchedAt={t} error={null} now={t} market={p.market} />)).map((x) => x.text);
    expect(tx).toContain("한국 장중");
    expect(tx).not.toContain("지연");
    const afterClose = Date.parse("2026-09-24T20:05:00+09:00"); // nextChangeAt(20:00) 지남
    const tx2 = texts(render(<HoldingsWidget stocks={p.stocks} showKrw={false} fetchedAt={afterClose} error={null} now={afterClose} market={p.market} />)).map((x) => x.text);
    expect(tx2).not.toContain("한국 장중");
    expect(tx2).not.toContain("지연");
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

  it("앱 → 위젯: 시세만 바뀌면 1분에 한 번, 원화 표시를 바꾸거나 앱을 떠나면 바로 (휴장 중 시세가 1분에 한 번 와도)", () => {
    const base = { now: NOW, fetchedThisSession: true, lastAt: NOW - 10_000, lastKey: "false|true|장 마감", key: "false|true|장 마감" };
    expect(widgetPushDue(base)).toBe(false);
    expect(widgetPushDue({ ...base, key: "true|true|장 마감" })).toBe(true);
    expect(widgetPushDue({ ...base, leaving: true })).toBe(true);
    expect(widgetPushDue({ ...base, lastAt: NOW - 61_000 })).toBe(true);
    expect(widgetPushDue({ ...base, key: "true|true|장 마감", fetchedThisSession: false })).toBe(false); // 기기에 저장해 둔 옛 값으로는 덮지 않음
  });

  it("위젯이 스스로 갱신할 때는 백그라운드가 받아 둔 응답을 다시 쓴다: 장중 15분, 휴장 2시간", () => {
    const open = { label: "한국 장중", open: true, nextChangeAt: "2026-09-24T06:30:00Z" };
    expect(canReuse({ at: NOW - 10 * 60_000, market: open }, NOW)).toBe(true);
    expect(canReuse({ at: NOW - 16 * 60_000, market: open }, NOW)).toBe(false);
    const t = Date.parse("2026-09-26T13:00:00+09:00");
    expect(canReuse({ at: t - 90 * 60_000, market: { label: "휴장", open: false, nextChangeAt: "2026-09-28T23:00:00Z" } }, t)).toBe(true);
    expect(canReuse(null, t)).toBe(false);
  });

  // 예전 서버 모드는 10분만, JSON 404(정말 /api/widget 이 없는 예전 서버)일 때만 — HTML 404·HTML 200 은 연결 오류 (위젯 리뷰 6, test/widgetReliability.test.tsx)
  it("주기 갱신(reuse)은 서버를 부르지 않고, 예전 서버는 한 번 404 뒤 10분 동안 /api/widget 을 묻지 않는다", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify(payload), { status: 200, headers: { etag: '"x"' } });
    });
    await loadWidgetData({ stocks: true, briefings: true });
    const d = await loadWidgetData({ stocks: true, briefings: true, reuse: true });
    expect(urls).toHaveLength(1);
    expect(d.stocks).toHaveLength(3);

    store.clear();
    urls.length = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      if (url.includes("/api/widget")) return new Response(JSON.stringify({ message: "Route GET:/api/widget not found", error: "Not Found", statusCode: 404 }), { status: 404, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify(url.includes("briefings") ? [] : book()), { status: 200 });
    });
    await loadWidgetData({ stocks: true, briefings: true });
    await loadWidgetData({ stocks: true, briefings: true });
    expect(urls.filter((u) => u.includes("/api/widget"))).toHaveLength(1);
  });

  it("주소가 바뀌기 전(OTA 전 ?indices=1)에 받아 둔 응답은 다시 쓰지 않는다 — 옛 달력 칩과 새 세션 칩이 번갈아 보이지 않게", async () => {
    // OTA 전 앱이 적어 둔 응답 (요청 주소 표시 없음): 1분 전, 달력만 본 칩
    const old = { ...payload, market: { label: "한국 휴장", open: false, nextChangeAt: "2026-09-27T23:00:00Z", kr: false, us: false } };
    store.set("widget.payload", JSON.stringify({ at: Date.now() - 60_000, apiUrl: API, etag: '"old"', body: old }));
    const calls: { url: string; inm: string | null }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, inm: new Headers(init?.headers).get("if-none-match") });
      return new Response(JSON.stringify({ ...payload, market: { label: "미국 주간거래", open: false, nextChangeAt: "2026-09-25T08:00:00Z", kr: false, us: false } }), { status: 200, headers: { etag: '"new"' } });
    });
    const d = await loadWidgetData({ stocks: true, briefings: true, reuse: true });
    expect(calls).toEqual([{ url: `${API}/api/widget?indices=1&sessions=1&ui=2`, inm: null }]);
    expect(d.market?.label).toBe("미국 주간거래");
    // 새 주소로 받아 둔 응답은 그대로 다시 쓴다
    await loadWidgetData({ stocks: true, briefings: true, reuse: true });
    expect(calls).toHaveLength(1);
  });

  it("예전 서버의 브리핑은 최신 순으로 (등록 순서가 아니라)", async () => {
    const mk = (code: string, createdAt: string) => ({ code, name: code, latest: { id: code.length, code, name: code, session: "morning", date: "2026-09-24", status: "ok", summary: "s", detail: "", missing: [], model: "", error: null, createdAt } });
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("/api/widget")) return new Response("", { status: 404 });
      return new Response(JSON.stringify(url.includes("briefings") ? [mk("A", "2026-09-24T08:31:00+09:00"), mk("B", "2026-09-24T16:02:00+09:00")] : []), { status: 200 });
    });
    const d = await loadWidgetData({ stocks: false, briefings: true });
    expect(d.briefings.map((b) => b.code)).toEqual(["B", "A"]);
  });
});
