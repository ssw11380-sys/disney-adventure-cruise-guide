import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RegisteredWithQuote } from "@/api/types";
import { holding, quote } from "./helpers";
import { render } from "./miniRender";

/**
 * 종목 상세 ‹ n/17 › 의 훅 (useHoldingsNav · useCachedRow)을 실제 QueryClient 로 본다 (3-42 웨이브 C 검증 지적).
 *  - 처음 구한 순서를 고정한다: 그리는 중 상태 바꾸기(setFrozen)로 고정한 뒤에는 등락률순이 체결로 바뀌어도 ‹ › 순서가 그대로
 *  - 고정한 뒤와 휴대폰 화면(active=false)에서는 select 가 늘 null 이라 체결이 와도 다시 그리지 않는다 (렌더 횟수)
 *  - ‹ › 로 바꿔 끼운 새 화면(router.replace 로 새로 만든 화면)은 기억한 순서를 이어 쓴다
 * 잔고 목록 캐시는 잔고 화면·체결 스트림이 채우는 [apiUrl, "stocks"] 이다 (여기서는 setQueryData 로 흉내)
 */
const h = vi.hoisted(() => ({ settings: { apiUrl: "http://x", sort: "changeRate" as string, afterCost: false } }));
vi.mock("@/api/hooks", () => ({ useApi: () => ({ listStocks: async () => [] }) }));
vi.mock("@/lib/settings", () => ({ useSettings: () => h.settings }));

const nav = await import("@/lib/holdingsNav");
type HoldingsNav = import("@/lib/holdingsNav").HoldingsNav;

const KEY = ["http://x", "stocks"];
const row = (code: string, name: string, rate: number, qty: number | null) => holding(code, quote(code, 10_000, { changeRate: rate }), qty, qty ? 9_000 : null, {}, name);
/** 등락률순: 보유 삼성전자(1.44) · NAVER(1.3) · SK하이닉스(-1.27), 관심 카카오 */
const LIST = (): RegisteredWithQuote[] => [row("005930", "삼성전자", 1.44, 120), row("000660", "SK하이닉스", -1.27, 18), row("035420", "NAVER", 1.3, 15), row("035720", "카카오", 3.1, null)];
/** 체결 뒤: NAVER 가 크게 오르고 삼성전자가 내려 등락률순이 바뀐다 */
const TICKED = (): RegisteredWithQuote[] => [row("005930", "삼성전자", -2.0, 120), row("000660", "SK하이닉스", -1.0, 18), row("035420", "NAVER", 5.0, 15), row("035720", "카카오", 3.3, null)];
const codes = (n: HoldingsNav | null) => n?.items.map((s) => s.code);
/** react-query 는 알림을 다음 차례(setTimeout 0)에 보낸다 */
const settle = () => new Promise((r) => setTimeout(r, 30));

let client: QueryClient;
beforeEach(() => {
  nav.forgetHoldingsNav();
  h.settings = { apiUrl: "http://x", sort: "changeRate", afterCost: false };
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
});
afterEach(() => client.clear());

/** 훅 하나를 그리는 화면: 그린 횟수와 마지막 결과를 남긴다 */
function mount<T>(use: () => T) {
  const seen = { renders: 0, value: undefined as T | undefined };
  function Probe() {
    seen.renders += 1;
    seen.value = use();
    return null;
  }
  render(
    <QueryClientProvider client={client}>
      <Probe />
    </QueryClientProvider>,
  );
  return seen;
}

describe("useHoldingsNav: 처음 구한 순서 고정 · 체결에 다시 그리지 않음", () => {
  it("잔고 화면과 같은 순서(등락률순)로 보유 구역에서 넘긴다", async () => {
    client.setQueryData(KEY, LIST());
    const seen = mount(() => nav.useHoldingsNav("005930", false, true));
    await settle();
    expect(codes(seen.value!)).toEqual(["005930", "035420", "000660"]);
    expect([seen.value!.index, seen.value!.total, seen.value!.next?.name]).toEqual([0, 3, "NAVER"]);
  });

  it("고정한 뒤에는 체결로 등락률순이 바뀌어도 ‹ › 순서가 그대로이고, 다시 그리지도 않는다", async () => {
    client.setQueryData(KEY, LIST());
    const seen = mount(() => nav.useHoldingsNav("005930", false, true));
    await settle();
    const before = seen.renders;
    for (let i = 0; i < 3; i++) {
      client.setQueryData(KEY, i % 2 ? LIST() : TICKED());
      await settle();
    }
    expect(seen.renders).toBe(before);
    expect(codes(seen.value!)).toEqual(["005930", "035420", "000660"]);
  });

  it("대조: select 없이 목록을 읽으면 체결마다 다시 그린다 (렌더 횟수 측정이 맞는지)", async () => {
    client.setQueryData(KEY, LIST());
    const seen = mount(() => useQuery({ queryKey: KEY, queryFn: async () => LIST(), enabled: false }).data);
    await settle();
    const before = seen.renders;
    client.setQueryData(KEY, TICKED());
    await settle();
    expect(seen.renders).toBeGreaterThan(before);
  });

  it("휴대폰 화면(active=false · 플래그 꺼짐 · 접힌 화면)은 계산하지 않고 null, 체결이 와도 다시 그리지 않는다", async () => {
    client.setQueryData(KEY, LIST());
    const seen = mount(() => nav.useHoldingsNav("005930", false, false));
    await settle();
    expect(seen.value).toBeNull();
    const before = seen.renders;
    client.setQueryData(KEY, TICKED());
    await settle();
    client.setQueryData(KEY, LIST());
    await settle();
    expect(seen.renders).toBe(before);
  });

  it("목록 캐시가 비어 있으면 null, 잔고 화면이 목록을 받으면 그때 순서를 만든다", async () => {
    const seen = mount(() => nav.useHoldingsNav("000660", false, true));
    await settle();
    expect(seen.value).toBeNull();
    client.setQueryData(KEY, LIST());
    await settle();
    expect(codes(seen.value!)).toEqual(["005930", "035420", "000660"]);
    expect(seen.value!.index).toBe(2);
  });

  it("관심 종목은 관심 구역에서, 목록에 없는 종목(미등록)은 null", async () => {
    client.setQueryData(KEY, LIST());
    expect(mount(() => nav.useHoldingsNav("035720", false, true)).value?.kind).toBe("watch");
    expect(mount(() => nav.useHoldingsNav("999999", false, true)).value).toBeNull();
  });
});

describe("‹ › 로 바꿔 끼운 새 화면 (router.replace)", () => {
  it("넘겨 온 화면(nav=1)은 기억한 순서를 이어 쓰고, 잔고에서 새로 연 화면은 지금 캐시로 새로 만든다", async () => {
    client.setQueryData(KEY, LIST());
    const first = mount(() => nav.useHoldingsNav("005930", false, true));
    await settle();
    const here = first.value!;
    // › 누름: 순서를 남기고 다음 종목으로 (화면은 새로 만들어진다)
    nav.rememberNav(here, here.next!);
    // 그사이 체결로 등락률순이 바뀌었다
    client.setQueryData(KEY, TICKED());
    const next = mount(() => nav.useHoldingsNav("035420", true, true));
    await settle();
    expect(codes(next.value!)).toEqual(["005930", "035420", "000660"]);
    expect([next.value!.index, next.value!.prev?.name, next.value!.next?.name]).toEqual([1, "삼성전자", "SK하이닉스"]);
    // 잔고에서 새로 연 화면(nav 없음)은 바뀐 순서로
    const fresh = mount(() => nav.useHoldingsNav("035420", false, true));
    await settle();
    expect(codes(fresh.value!)).toEqual(["035420", "000660", "005930"]);
    // 마지막에 본 종목 (잔고로 돌아가면 그 줄을 강조)
    expect(nav.takeLastViewed()).toEqual({ code: "035420", name: "NAVER" });
  });
});

describe("useCachedRow: 첫 응답 전 목록 캐시의 그 종목 줄", () => {
  it("넓은 창(active)이면 목록 캐시의 줄, 아니면 null — 구독하지 않아 체결에 다시 그리지 않는다", async () => {
    client.setQueryData(KEY, LIST());
    const on = mount(() => nav.useCachedRow("000660", true));
    expect(on.value?.name).toBe("SK하이닉스");
    const off = mount(() => nav.useCachedRow("000660", false));
    expect(off.value).toBeNull();
    const before = [on.renders, off.renders];
    client.setQueryData(KEY, TICKED());
    await settle();
    expect([on.renders, off.renders]).toEqual(before);
    expect(mount(() => nav.useCachedRow("999999", true)).value).toBeNull();
  });
});
