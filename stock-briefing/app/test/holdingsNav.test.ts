import { beforeEach, describe, expect, it, vi } from "vitest";
import { holding, quote } from "./helpers";

/**
 * 종목 상세 ‹ n/17 › 의 순서 (3-42 웨이브 C): 잔고 화면과 같은 함수·같은 정렬 설정으로 만든 순서.
 * 넘기는 동안에는 처음 순서를 이어 쓰고(모듈 저장소), 끝에서는 돌지 않는다
 */
vi.mock("@/api/hooks", () => ({ useApi: () => ({ listStocks: async () => [] }) }));
vi.mock("@/lib/settings", () => ({ useSettings: () => ({ apiUrl: "http://x", sort: "created", afterCost: false }) }));

const nav = await import("@/lib/holdingsNav");
const { sortHoldings, splitHoldings } = await import("@/lib/portfolio");

const LIST = [
  holding("005930", quote("005930", 84_300, { changeRate: 1.44 }), 120, 71_000, {}, "삼성전자"),
  holding("000660", quote("000660", 351_000, { changeRate: -1.27 }), 18, 250_000, {}, "SK하이닉스"),
  holding("035720", quote("035720", 41_000, { changeRate: 3.1 }), null, null, {}, "카카오"),
  holding("035420", quote("035420", 232_000, { changeRate: 1.3 }), 15, 200_000, {}, "NAVER"),
  holding("068270", quote("068270", 171_000, { changeRate: -0.7 }), null, null, {}, "셀트리온"),
];

beforeEach(() => nav.forgetHoldingsNav());

describe("잔고와 같은 순서", () => {
  it("정렬 설정마다 잔고 화면의 보유·관심 구역 순서와 같다", () => {
    for (const sort of ["created", "name", "changeRate", "profit", "value", "market"] as const) {
      const { held, watch } = splitHoldings(sortHoldings(LIST, sort, false));
      const order = nav.holdingsOrder(LIST, sort, false);
      expect(order.held.map((s) => s.code), sort).toEqual(held.map((s) => s.code));
      expect(order.watch.map((s) => s.code), sort).toEqual(watch.map((s) => s.code));
    }
  });

  it("등락률순: 보유 NAVER(1.3) 가 SK하이닉스(-1.27) 보다 앞, 관심은 관심끼리", () => {
    const order = nav.holdingsOrder(LIST, "changeRate", false);
    expect(order.held.map((s) => s.name)).toEqual(["삼성전자", "NAVER", "SK하이닉스"]);
    expect(order.watch.map((s) => s.name)).toEqual(["카카오", "셀트리온"]);
  });

  it("보유 종목은 보유 구역에서, 관심 종목은 관심 구역에서 넘기고, 목록에 없으면 없음", () => {
    const order = nav.holdingsOrder(LIST, "created", false);
    expect(nav.sectionOf(order, "000660")?.kind).toBe("held");
    expect(nav.sectionOf(order, "035720")?.kind).toBe("watch");
    expect(nav.sectionOf(order, "999999")).toBeNull();
  });
});

describe("앞뒤 종목", () => {
  const items = nav.holdingsOrder(LIST, "created", false).held;

  it("가운데: 앞뒤 종목과 '2/3'", () => {
    const n = nav.navAt("held", items, "000660")!;
    expect([n.index, n.total, n.prev?.name, n.next?.name]).toEqual([1, 3, "삼성전자", "NAVER"]);
    expect(nav.navLabel(n)).toBe("2/3");
    expect(nav.navSpeech(n)).toBe("보유 3종목 중 2번째");
  });

  it("처음과 끝에서는 돌지 않는다", () => {
    expect(nav.navAt("held", items, "005930")!.prev).toBeNull();
    expect(nav.navAt("held", items, "035420")!.next).toBeNull();
    expect(nav.navAt("held", items, "035720")).toBeNull();
  });
});

describe("넘기는 동안 순서 고정 (모듈 저장소)", () => {
  it("‹ › 로 온 화면은 넘기기 전 순서를 그대로 쓰고, 잔고에서 새로 연 화면은 새로 만든다", () => {
    const items = nav.holdingsOrder(LIST, "changeRate", false).held;
    const here = nav.navAt("held", items, "005930")!;
    nav.rememberNav(here, "035420");
    // 시세가 바뀌어 정렬이 달라져도 넘겨 온 화면은 기억한 순서
    expect(nav.recallNav("035420", true)?.items.map((s) => s.code)).toEqual(["005930", "035420", "000660"]);
    // 잔고에서 새로 연 화면(주소에 nav 없음) · 기억한 순서에 없는 종목은 새로
    expect(nav.recallNav("035420", false)).toBeNull();
    expect(nav.recallNav("035720", true)).toBeNull();
  });

  it("마지막에 본 종목은 한 번 읽으면 지운다 (잔고로 돌아가 그 줄을 강조할 때)", () => {
    const items = nav.holdingsOrder(LIST, "created", false).held;
    nav.rememberNav(nav.navAt("held", items, "005930")!, "000660");
    expect(nav.takeLastViewed()).toBe("000660");
    expect(nav.takeLastViewed()).toBeNull();
  });
});
