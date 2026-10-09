import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TossAccountSnapshotBody } from "@/api/types";
import { cleanupRenders, render, type HostNode } from "./miniRender";

const h = vi.hoisted(() => ({ data: undefined as TossAccountSnapshotBody | undefined, error: null as unknown, afterCost: true, showKrw: true, params: {} as { valuation?: string }, setParams: vi.fn(), navReady: true, readyListeners: new Set<() => void>() }));
const navigation = {
  isReady: () => h.navReady,
  addListener: (_event: string, listener: () => void) => { h.readyListeners.add(listener); return () => { h.readyListeners.delete(listener); }; },
};
vi.mock("expo-router", () => ({ useLocalSearchParams: () => h.params, useNavigationContainerRef: () => navigation, router: { setParams: h.setParams } }));
vi.mock("react-native", () => ({ View: "View", Text: "Text", Pressable: "Pressable", StyleSheet: { create: <T,>(v: T) => v, hairlineWidth: 1 } }));
vi.mock("@/theme", async () => ({ ...(await import("@/tokens")), useTheme: () => ({}), }));
vi.mock("@/api/hooks", () => ({ useTossAccountSnapshot: () => ({ data: h.data, error: h.error, isError: !!h.error }) }));
vi.mock("@/lib/settings", () => ({ useSettings: () => h }));
vi.mock("@/lib/useNow", () => ({ useNow: () => Date.parse("2026-10-04T12:10:00+09:00") }));
const { TossAccountSummary, TossAccountSummaryView } = await import("@/components/TossAccountSummary");
const { tossSnapshotNotice, tossSnapshotRange, tossSnapshotTime, tossSnapshotValuation } = await import("@/lib/tossAccountSnapshot");
const { ApiRequestError } = await import("@/api/client");
const AT = "2026-10-04T12:00:00+09:00";
const NOW = Date.parse("2026-10-04T12:10:00+09:00");
const BODY: TossAccountSnapshotBody = {
  on: true,
  sync: { enabled: true, intervalMin: 10, idleIntervalMin: 60, lastRunAt: AT, nextRunAt: "2026-10-04T13:00:00+09:00", lastError: null },
  snapshot: { source: "toss-openapi", scope: "all-toss-stock-holdings", excludesCash: true, includesExcludedHoldings: true,
    receivedFrom: AT, receivedAt: AT, accountCount: 2, holdingCount: 20, excludedHoldingCount: 1,
    gross: { krw: 100_000, usd: 200 }, net: { krw: 99_800, usd: 199.8 },
    displayFx: { usdKrw: 1400, receivedAt: AT, source: "app-display-fx", kind: "reference" } },
};
const all = (nodes: (HostNode | string)[]): HostNode[] => nodes.flatMap((x) => typeof x === "string" ? [] : [x, ...all(x.children)]);
const text = (nodes: (HostNode | string)[]): string => nodes.map((x) => typeof x === "string" ? x : text(x.children)).join("");
const mount = (body: TossAccountSnapshotBody | undefined = BODY, failed = false, afterCost = true) => render(
  <TossAccountSummaryView body={body} failed={failed} afterCost={afterCost} showKrw now={NOW}><TextStub>기존 실시간 숫자와 비중</TextStub></TossAccountSummaryView>,
);
function TextStub({ children }: { children: React.ReactNode }) { return React.createElement("Text", {}, children); }
beforeEach(() => {
  cleanupRenders(); h.data = BODY; h.error = null; h.afterCost = true; h.showKrw = true; h.params = {}; h.navReady = true; h.readyListeners.clear();
  h.setParams.mockReset().mockImplementation(() => {
    if (!h.navReady) throw new Error("Attempted to navigate before mounting the Root Layout component. Ensure the Root Layout component is rendering a Slot, or other navigator on the first render.");
  });
});

describe("계좌 대표 손익과 선택해서 보는 시세 추정", () => {
  it("예전 실시간 링크에서도 계좌 손익을 대표로 보이고 추정 합계는 자동으로 펼치지 않는다", () => {
    h.params = { valuation: "live" };
    h.data = { ...BODY, snapshot: { ...BODY.snapshot!, net: { krw: 30_000, usd: 50 },
      costBasis: { krw: 120_000, holdingCount: 20, estimatedHoldingCount: 0, source: "synced-holdings-cost-book" } } };
    const r = render(<TossAccountSummary><TextStub>시세 합계 +5,000원</TextStub></TossAccountSummary>);
    expect(text(r.tree)).toContain("-20,000원");
    expect(text(r.tree)).not.toContain("+5,000원");
    expect(all(r.tree).some((x) => x.props.accessibilityRole === "tab")).toBe(false);
  });
  it("계좌 손익은 같은 수신 평가와 원화 원가로 표시하고 시간외 실시간 손익과 구분한다", () => {
    const body: TossAccountSnapshotBody = { ...BODY, snapshot: { ...BODY.snapshot!,
      net: { krw: 30_000, usd: 50 },
      costBasis: { krw: 120_000, holdingCount: 20, estimatedHoldingCount: 0, source: "synced-holdings-cost-book" },
    } };
    const r = render(<TossAccountSummaryView body={body} failed={false} afterCost showKrw now={NOW}><TextStub>실시간 평가손익 +5,000원</TextStub></TossAccountSummaryView>);
    expect(text(r.tree)).toContain("원화 환산(참고) 100,000원");
    expect(text(r.tree)).toContain("계좌 기준 평가손익(참고)");
    expect(text(r.tree)).toContain("-20,000원");
    expect(text(r.tree)).toContain("수익률 -16.67%");
    expect(text(r.tree)).toContain("매입금액 120,000원");
    expect(text(r.tree)).not.toContain("+5,000원");
    const tab = all(r.tree).find((x) => x.props.accessibilityLabel === "시간외 시세 기준 추정 보기")!;
    r.act(() => (tab.props.onPress as () => void)());
    expect(text(r.tree)).toContain("시간외 시세를 포함");
    expect(text(r.tree)).toContain("실시간 평가손익 +5,000원");
    expect(text(r.tree)).toContain("-20,000원");
    const back = all(r.tree).find((x) => x.props.accessibilityLabel === "시간외 시세 기준 추정 접기")!;
    r.act(() => (back.props.onPress as () => void)());
    expect(text(r.tree)).toContain("-20,000원");
    expect(text(r.tree)).not.toContain("+5,000원");
  });
  it("큰 글씨 변경 등으로 위젯 링크가 재시작되어도 루트 준비 전에 이동하지 않고 준비 즉시 한 번 소비한다", () => {
    h.params = { valuation: "live" }; h.navReady = false;
    let r!: ReturnType<typeof render>;
    expect(() => { r = render(<TossAccountSummary><TextStub>위젯과 같은 실시간 평가</TextStub></TossAccountSummary>); }).not.toThrow();
    expect(text(r.tree)).toContain("토스 주식 평가금액");
    expect(text(r.tree)).not.toContain("위젯과 같은 실시간 평가");
    expect(h.setParams).not.toHaveBeenCalled();
    for (const listener of h.readyListeners) listener();
    expect(h.setParams).not.toHaveBeenCalled();
    h.navReady = true;
    for (const listener of h.readyListeners) listener();
    expect(h.setParams).toHaveBeenCalledExactlyOnceWith({ valuation: undefined });
    for (const listener of h.readyListeners) listener();
    expect(h.setParams).toHaveBeenCalledTimes(1);
  });
  it("준비 전에 화면을 닫으면 구독과 이전 링크 소비가 남지 않고 새 화면에서만 한 번 소비한다", () => {
    h.params = { valuation: "live" }; h.navReady = false;
    const el = <TossAccountSummary><TextStub>실시간 평가</TextStub></TossAccountSummary>;
    const first = render(el); const old = [...h.readyListeners];
    first.unmount(); expect(h.readyListeners.size).toBe(0);
    const next = render(el); h.navReady = true;
    for (const listener of old) listener();
    expect(h.setParams).not.toHaveBeenCalled();
    for (const listener of h.readyListeners) listener();
    expect(h.setParams).toHaveBeenCalledExactlyOnceWith({ valuation: undefined });
    expect(text(next.tree)).toContain("토스 주식 평가금액");
  });
  it("준비를 기다리던 링크가 바뀌면 취소한 요청으로 주소를 뒤늦게 고치지 않는다", () => {
    h.params = { valuation: "live" }; h.navReady = false;
    const el = <TossAccountSummary><TextStub>실시간 평가</TextStub></TossAccountSummary>;
    const r = render(el); const old = [...h.readyListeners];
    h.params = {}; r.rerender(); expect(h.readyListeners.size).toBe(0);
    h.navReady = true; for (const listener of old) listener();
    expect(h.setParams).not.toHaveBeenCalled();
    h.params = { valuation: "live" }; r.rerender();
    expect(h.setParams).toHaveBeenCalledExactlyOnceWith({ valuation: undefined });
  });
  it.each(["live", "account"])("위젯 %s 링크는 계좌를 열고 다시 누르면 펼친 추정 합계를 닫는다", (valuation) => {
    h.params = { valuation };
    const el = <TossAccountSummary><TextStub>위젯과 같은 실시간 평가</TextStub></TossAccountSummary>;
    const r = render(el);
    expect(text(r.tree)).not.toContain("위젯과 같은 실시간 평가");
    expect(text(r.tree)).toContain("토스 주식 평가금액");
    expect(h.setParams).toHaveBeenCalledWith({ valuation: undefined });
    h.params = {};
    r.rerender(el);
    const tab = all(r.tree).find((x) => x.props.accessibilityLabel === "시간외 시세 기준 추정 보기")!;
    r.act(() => (tab.props.onPress as () => void)());
    expect(text(r.tree)).toContain("토스 주식 평가금액");
    expect(text(r.tree)).toContain("위젯과 같은 실시간 평가");
    h.params = { valuation };
    r.rerender(el);
    expect(text(r.tree)).not.toContain("위젯과 같은 실시간 평가");
    expect(text(r.tree)).toContain("토스 주식 평가금액");
    expect(h.setParams).toHaveBeenCalledTimes(2);
  });
  it("기본은 비용 차감 후 원본 통화별 금액, 전체 범위·예수금 제외·수신과 환산 한계를 함께 표시", () => {
    const r = mount();
    const s = text(r.tree);
    expect(s).toContain("99,800원"); expect(s).toContain("$199.80");
    expect(s).toContain("원화 환산(참고) 379,520원");
    expect(s).toContain("전체 연동 2개 계좌 · 보유 20종목 · 현금·예수금 제외");
    expect(s).toContain("앱 동기화에서 제외한 1종목도 포함");
    expect(s).toContain("토스 앱의 최종 원화 합계와 다를 수");
    expect(s).toContain("아래 종목·비중은 종목 시세 기준 추정값");
    expect(s).not.toContain("0.0%"); expect(s).not.toContain("기존 실시간 숫자");
  });
  it("비용 차감을 끄면 gross 원본을 표시하고 선택해서 연 추정은 기존 기능을 보존", () => {
    const r = mount(BODY, false, false);
    expect(text(r.tree)).toContain("100,000원"); expect(text(r.tree)).toContain("$200.00");
    const tab = all(r.tree).find((x) => x.props.accessibilityLabel === "시간외 시세 기준 추정 보기")!;
    r.act(() => (tab.props.onPress as () => void)());
    expect(text(r.tree)).toContain("기존 실시간 숫자와 비중");
    expect(text(r.tree)).toContain("토스 주식 평가금액");
    expect(all(r.tree).find((x) => x.props.accessibilityLabel === "시간외 시세 기준 추정 접기")!.props.accessibilityState).toEqual({ expanded: true });
  });
  it.each([undefined, { on: true, snapshot: null, sync: null }] as const)("원본 없음·로딩 때 추정 합계를 계좌 대표 값으로 자동 대체하지 않는다", (body) => {
    const r = render(<TossAccountSummaryView body={body} failed={false} afterCost showKrw now={NOW}><TextStub>실시간 대체</TextStub></TossAccountSummaryView>);
    expect(text(r.tree)).not.toContain("실시간 대체"); expect(text(r.tree)).not.toContain("0원");
    const more = all(r.tree).find((x) => x.props.accessibilityLabel === "시간외 시세 기준 추정 보기")!;
    r.act(() => (more.props.onPress as () => void)());
    expect(text(r.tree)).toContain("다시 계산한 추정 평가");
    expect(text(r.tree)).toContain("실시간 대체");
  });
  it("서버 기능이 꺼져 있거나 이전 서버이면 기존 요약을 유지", () => {
    const r = mount({ on: false, snapshot: null, sync: null });
    expect(text(r.tree)).toBe("기존 실시간 숫자와 비중");
  });
  it("추정 합계를 펼치지 않고도 비중 화면을 열 수 있다", () => {
    const open = vi.fn();
    const r = render(<TossAccountSummaryView body={BODY} failed={false} afterCost showKrw now={NOW} onAllocation={open}><TextStub>기존 비중 기능</TextStub></TossAccountSummaryView>);
    const button = all(r.tree).find((x) => x.props.accessibilityLabel === "종목 시세 기준 비중 보기")!;
    r.act(() => (button.props.onPress as () => void)()); expect(open).toHaveBeenCalledOnce();
    expect(text(r.tree)).not.toContain("기존 비중 기능");
  });
  it("조회 실패는 원래 수신 시각·금액을 유지하고 갱신 실패로 알린다", () => {
    const r = mount(BODY, true);
    expect(text(r.tree)).toContain("새로고침 실패 · 마지막 수신 금액");
    expect(text(r.tree)).toContain("99,800원"); expect(text(r.tree)).toContain("12:00");
  });
  it.each([401, 403])("권한 오류 %i는 앞서 받은 주인 계좌 금액도 숨긴다", (status) => {
    h.error = new ApiRequestError(status, "FORBIDDEN", "권한 없음");
    const r = render(<TossAccountSummary><TextStub>실시간 대체</TextStub></TossAccountSummary>);
    expect(text(r.tree)).not.toContain("99,800원"); expect(text(r.tree)).toContain("확인하지 못했습니다");
    expect(text(r.tree)).not.toContain("실시간 대체");
    expect(text(r.tree)).not.toContain("추정 보기");
  });
  it("환율 없음은 환산값을 꾸미지 않으며 실제 빈 계좌의 0원만 원본으로 표시", () => {
    const r = mount({ ...BODY, snapshot: { ...BODY.snapshot!, displayFx: null } });
    expect(text(r.tree)).toContain("통화별 원본 금액만"); expect(text(r.tree)).not.toContain("원화 환산(참고)");
    const empty = mount({ ...BODY, snapshot: { ...BODY.snapshot!, holdingCount: 0, net: { krw: 0, usd: 0 }, displayFx: null } });
    expect(text(empty.tree)).toContain("보유 0종목"); expect(text(empty.tree)).toContain("0원");
  });
  it("큰 글씨·긴 금액은 줄 수 제한 없이 감싸고 펼치기 버튼은 최소 터치 높이를 보장", () => {
    const r = mount({ ...BODY, snapshot: { ...BODY.snapshot!, net: { krw: 999999999999, usd: 999999999 } } });
    for (const n of all(r.tree).filter((x) => x.type === "Text")) expect(n.props.numberOfLines).toBeUndefined();
    const buttons = all(r.tree).filter((x) => x.props.accessibilityRole === "button");
    expect(buttons).toHaveLength(1);
    expect((buttons[0]!.props.style as { minHeight: number }).minHeight).toBeGreaterThanOrEqual(44);
  });
});

describe("핵심 금액 우선 표시", () => {
  const body = (): TossAccountSnapshotBody => ({ ...BODY, snapshot: { ...BODY.snapshot!, costBasis: { krw: 400_000, holdingCount: 20, estimatedHoldingCount: 3, source: "synced-holdings-cost-book" } } });
  const focused = (data = body(), extra = {}) => <TossAccountSummaryView body={data} failed={false} afterCost showKrw now={NOW} focused {...extra}><TextStub>추정 합계 +5,000원</TextStub></TossAccountSummaryView>;
  const press = (r: ReturnType<typeof render>, label: string) => {
    const button = all(r.tree).find(n => n.props.accessibilityLabel === label);
    expect(button, label).toBeDefined(); r.act(() => (button!.props.onPress as () => void)());
  };
  it("접힌 기본 화면도 금액·손익·추정 원가·제외 종목·현금 제외·수신 시각을 보존한다", () => {
    const r = render(focused()); const s = text(r.tree);
    for (const expected of ["379,520원", "-20,480원", "수익률 -5.12%", "추정 원가 3종목 포함", "토스 원화 손익과 차이 가능", "현금·예수금 제외", "계좌 수신", "앱 동기화 제외 1종목도 포함", "종목별 금액·손익·비중은 시세 기준 추정값"]) expect(s).toContain(expected);
    expect(s).not.toContain("매입금액 400,000원"); expect(s).not.toContain("$199.80"); expect(s).not.toContain("추정 합계 +5,000원");
    expect(all(r.tree).some(n => String(n.props.accessibilityLabel).includes("20,480원 손실"))).toBe(true);
  });
  it("한 번 펼치면 통화별 원본·매입금액·환율·계좌 범위와 수신 구간을 모두 확인하고 다시 접는다", () => {
    const r = render(focused()); press(r, "금액·계산 기준 펼치기");
    for (const expected of ["99,800원", "$199.80", "매입금액 400,000원", "1,400.00원", "전체 연동 2개 계좌 · 보유 20종목", "토스 계좌 수신 구간", "보고서는 작성 당시 시세 기준"]) expect(text(r.tree)).toContain(expected);
    press(r, "시간외 시세 기준 추정 보기"); expect(text(r.tree)).toContain("추정 합계 +5,000원");
    expect(text(r.tree)).toContain("-20,480원");
    press(r, "금액·계산 기준 접기"); expect(text(r.tree)).not.toContain("추정 합계 +5,000원");
    press(r, "금액·계산 기준 펼치기"); expect(text(r.tree)).not.toContain("추정 합계 +5,000원");
  });
  it("자료가 갱신돼도 펼친 상태와 금액 기준을 유지하며 새 위젯 링크에서는 접는다", () => {
    const r = render(focused()); press(r, "금액·계산 기준 펼치기");
    const next = body(); next.snapshot!.net = { ...next.snapshot!.net, krw: 100_800 };
    r.rerender(focused(next)); expect(text(r.tree)).toContain("380,520원"); expect(text(r.tree)).toContain("-19,480원"); expect(text(r.tree)).toContain("매입금액 400,000원");
    r.rerender(focused(next, { requestedView: "account" })); expect(text(r.tree)).not.toContain("매입금액 400,000원"); expect(text(r.tree)).toContain("-19,480원");
  });
  it("조회 실패·갱신 지연·원가 누락 경고를 상세 안으로 숨기지 않는다", () => {
    const r = render(focused(body(), { failed: true })); expect(text(r.tree)).toContain("새로고침 실패 · 마지막 수신 금액");
    r.rerender(focused(body(), { now: NOW + 24 * 60 * 60_000 })); expect(text(r.tree)).toContain("계좌 금액 갱신 대기");
    r.rerender(focused(BODY)); expect(text(r.tree)).toContain("같은 수신 시점의 매입금액을 확인하지 못했습니다"); expect(text(r.tree)).toContain("확인 불가");
  });
  it("원화 끄기·환율 누락·빈 계좌에서도 통화별 금액과 의미가 남는다", () => {
    const r = render(focused(body(), { showKrw: false })); expect(text(r.tree)).toContain("$199.80"); expect(text(r.tree)).toContain("원화 환산 꺼짐");
    const noFx = body(); noFx.snapshot!.displayFx = null;
    r.rerender(focused(noFx)); expect(text(r.tree)).toContain("통화별 원본만 표시"); expect(text(r.tree)).not.toContain("379,520원");
    const empty = body(); empty.snapshot = { ...empty.snapshot!, net: { krw: 0, usd: 0 }, holdingCount: 0, excludedHoldingCount: 0, costBasis: { krw: 0, holdingCount: 0, estimatedHoldingCount: 0, source: "synced-holdings-cost-book" } };
    r.rerender(focused(empty)); expect(text(r.tree)).toContain("0원"); expect(text(r.tree)).toContain("계산 불가 (매입금액 0원)");
  });
  it("금액을 못 받은 상태에서도 시세 추정을 계좌 금액으로 자동 대체하지 않는다", () => {
    const r = render(focused({ on: true, snapshot: null, sync: null })); expect(text(r.tree)).toContain("수신한 토스 계좌 금액이 없습니다"); expect(text(r.tree)).not.toContain("추정 합계 +5,000원");
    press(r, "시간외 시세 기준 추정 보기"); expect(text(r.tree)).toContain("추정 합계 +5,000원");
  });
  it("새 표시를 끄면 종전 상세 내용이 기본 표시되고 새 펼치기는 없다", () => {
    const r = render(focused(body(), { focused: false })); expect(text(r.tree)).toContain("매입금액 400,000원"); expect(text(r.tree)).toContain("$199.80");
    expect(all(r.tree).some(n => n.props.accessibilityLabel === "금액·계산 기준 펼치기")).toBe(false);
  });
  it("큰 금액에도 줄 제한이 없고 펼치기·비중 누름 영역과 설명이 남는다", () => {
    const allocation = vi.fn(); const r = render(focused(body(), { onAllocation: allocation }));
    for (const n of all(r.tree).filter(n => n.type === "Text")) expect(n.props.numberOfLines).toBeUndefined();
    for (const n of all(r.tree).filter(n => n.props.accessibilityRole === "button")) expect((n.props.style as { minHeight: number }).minHeight).toBeGreaterThanOrEqual(44);
    press(r, "종목 시세 기준 비중 보기"); expect(allocation).toHaveBeenCalledOnce();
  });
  it("3-35 내 종목 테마: onThemes 를 줄 때만 '비중' 옆에 '내 종목 테마 보기' (접힌·종전 표시 모두), 없으면 지금 그대로", () => {
    const themes = vi.fn();
    const label = (r: ReturnType<typeof render>) => all(r.tree).filter((n) => n.props.accessibilityLabel === "내 종목 테마 보기");
    const off = render(focused(body(), { onAllocation: vi.fn() }));
    expect(label(off)).toHaveLength(0);
    expect(text(off.tree)).not.toContain("내 종목 테마");
    const on = render(focused(body(), { onAllocation: vi.fn(), onThemes: themes }));
    expect(label(on)).toHaveLength(1);
    expect((label(on)[0]!.props.style as { minHeight: number }).minHeight).toBeGreaterThanOrEqual(44);
    press(on, "내 종목 테마 보기"); expect(themes).toHaveBeenCalledOnce();
    expect(text(on.tree)).not.toContain("추정 합계 +5,000원");
    const plain = render(focused(body(), { focused: false, onThemes: themes }));
    expect(label(plain)).toHaveLength(1);
    press(plain, "내 종목 테마 보기"); expect(themes).toHaveBeenCalledTimes(2);
  });
  it("3-37 매매일지: onJournal 을 줄 때만 '내 종목 테마 보기' 뒤에 '매매일지 보기' (접힌·종전 표시 모두), 없으면 지금 그대로", () => {
    const journal = vi.fn();
    const labels = (r: ReturnType<typeof render>) => all(r.tree).map((n) => n.props.accessibilityLabel).filter((l): l is string => typeof l === "string");
    const off = render(focused(body(), { onAllocation: vi.fn(), onThemes: vi.fn() }));
    expect(labels(off)).not.toContain("매매일지 보기");
    expect(text(off.tree)).not.toContain("매매일지");
    for (const extra of [{}, { focused: false }]) {
      const on = render(focused(body(), { onAllocation: vi.fn(), onThemes: vi.fn(), onJournal: journal, ...extra }));
      const l = labels(on);
      expect(l.indexOf("매매일지 보기")).toBe(l.indexOf("내 종목 테마 보기") + 1);
      const link = all(on.tree).find((n) => n.props.accessibilityLabel === "매매일지 보기")!;
      expect((link.props.style as { minHeight: number }).minHeight).toBeGreaterThanOrEqual(44);
      press(on, "매매일지 보기");
    }
    expect(journal).toHaveBeenCalledTimes(2);
  });
});

describe("토스 수신 금액 최신성", () => {
  it("한국 시각과 연도를 표시하고 같은 수신 시각은 범위를 중복하지 않는다", () => {
    expect(tossSnapshotTime("2025-12-31T23:00:00Z")).toContain("2026. 01. 01.");
    expect(tossSnapshotRange(AT, AT)).not.toContain("~");
    expect(tossSnapshotRange(AT, "2026-10-04T12:00:01+09:00")).toContain("~");
  });
  it("장외 정상 60분 간격은 지연이 아니며 예정 시각+유예 뒤에 갱신 대기", () => {
    expect(tossSnapshotNotice(BODY, false, NOW)).toBeNull();
    expect(tossSnapshotNotice(BODY, false, Date.parse("2026-10-04T13:06:00+09:00"))).toContain("갱신 대기");
  });
  it("서버 재시작으로 다음 예정이 미래여도 며칠 된 기록을 최신으로 보지 않는다", () => {
    const body = { ...BODY, snapshot: { ...BODY.snapshot!, receivedAt: "2026-10-01T12:00:00+09:00" } };
    expect(tossSnapshotNotice(body, false, NOW)).toContain("갱신 대기");
  });
  it("동기화 실패·꺼짐을 원본 값이 있어도 표시", () => {
    expect(tossSnapshotNotice({ ...BODY, sync: { ...BODY.sync!, lastError: "외부 오류" } }, false, NOW)).toContain("동기화 실패");
    expect(tossSnapshotNotice({ ...BODY, sync: { ...BODY.sync!, enabled: false } }, false, NOW)).toContain("동기화 꺼짐");
  });
});

describe("같은 계좌 동기화의 평가손익", () => {
  const snap = () => ({ ...BODY.snapshot!, costBasis: {
    krw: 400_000, holdingCount: 20, estimatedHoldingCount: 3, source: "synced-holdings-cost-book" as const,
  } });
  it("비용 전후 평가·손익은 같은 원금을 사용하고 참고 원가 여부를 표시한다", () => {
    const snapshot = snap();
    expect(tossSnapshotValuation(snapshot, true)).toMatchObject({ evaluationKrw: 379_520, costKrw: 400_000, profitKrw: -20_480, profitRate: -5.12, estimatedHoldingCount: 3, unavailable: null });
    expect(tossSnapshotValuation(snapshot, false)).toMatchObject({ evaluationKrw: 380_000, costKrw: 400_000, profitKrw: -20_000, profitRate: -5 });
    const r = mount({ ...BODY, snapshot });
    expect(text(r.tree)).toContain("3종목의 추정 원가를 포함");
    expect(all(r.tree).some((x) => String(x.props.accessibilityLabel).includes("20,480원 손실"))).toBe(true);
    r.rerender(<TossAccountSummaryView body={{ ...BODY, snapshot }} failed={false} afterCost={false} showKrw now={NOW}><TextStub>실시간</TextStub></TossAccountSummaryView>);
    expect(text(r.tree)).toContain("수수료·세금 차감 전");
    expect(text(r.tree)).toContain("-20,000원");
    expect(text(r.tree)).not.toContain("-20,480원");
  });
  it("원화로 표시한 평가금액과 매입금액의 뺄셈이 손익과 정확히 일치한다", () => {
    const snapshot = { ...snap(), net: { krw: 300_000.4, usd: 0 }, costBasis: { ...snap().costBasis, krw: 299_999.6 } };
    expect(tossSnapshotValuation(snapshot, true)).toMatchObject({ evaluationKrw: 300_000, costKrw: 300_000, profitKrw: 0, profitRate: 0 });
  });
  it("원가 없는 예전 서버·기록은 평가금액은 유지하고 손익 0원 대신 다음 동기화를 안내한다", () => {
    const r = mount();
    expect(text(r.tree)).toContain("원화 환산(참고) 379,520원");
    expect(text(r.tree)).toContain("계좌 기준 평가손익(참고)확인 불가");
    expect(text(r.tree)).toContain("같은 수신 시점의 매입금액을 확인하지 못했습니다");
    expect(text(r.tree)).toContain("다음 계좌 동기화 후");
    expect(text(r.tree)).not.toContain("매입금액 0원");
  });
  it.each([
    null,
    { ...snap().costBasis, krw: -1 },
    { ...snap().costBasis, krw: NaN },
    { ...snap().costBasis, krw: Infinity },
    { ...snap().costBasis, holdingCount: 19 },
    { ...snap().costBasis, estimatedHoldingCount: 21 },
    { ...snap().costBasis, estimatedHoldingCount: -1 },
  ])("원가가 누락·부정·부분 금액이면 전체 손익으로 표시하지 않는다: %j", (costBasis) => {
    expect(tossSnapshotValuation({ ...snap(), costBasis }, true)).toMatchObject({ evaluationKrw: 379_520, costKrw: null, profitKrw: null, profitRate: null });
  });
  it("해외 평가의 환율이 없거나 잘못됐으면 손익은 확인 불가지만 국내만 있으면 계산할 수 있다", () => {
    for (const displayFx of [null, { ...BODY.snapshot!.displayFx!, usdKrw: 0 }, { ...BODY.snapshot!.displayFx!, usdKrw: NaN }]) {
      expect(tossSnapshotValuation({ ...snap(), displayFx }, true)).toMatchObject({ evaluationKrw: null, profitKrw: null });
      expect(tossSnapshotValuation({ ...snap(), net: { krw: 380_000, usd: 0 }, displayFx }, true)).toMatchObject({ evaluationKrw: 380_000, profitKrw: -20_000 });
    }
  });
  it("실제 빈 계좌만 손익 0원을 표시하고 원가 0일 때 수익률은 계산하지 않는다", () => {
    const empty = { ...snap(), holdingCount: 0, net: { krw: 0, usd: 0 }, displayFx: null,
      costBasis: { ...snap().costBasis, krw: 0, holdingCount: 0, estimatedHoldingCount: 0 } };
    expect(tossSnapshotValuation(empty, true)).toMatchObject({ evaluationKrw: 0, costKrw: 0, profitKrw: 0, profitRate: null });
    const r = mount({ ...BODY, snapshot: empty });
    expect(text(r.tree)).toContain("계좌 기준 평가손익(참고)0원");
    expect(text(r.tree)).toContain("계산 불가 (매입금액 0원)");
    expect(text(r.tree)).not.toContain("0.00%");
  });
  it("보유 0종목인데 양수 원가가 남은 손상 기록은 가짜 손실로 표시하지 않는다", () => {
    expect(tossSnapshotValuation({ ...snap(), holdingCount: 0, net: { krw: 0, usd: 0 }, displayFx: null,
      costBasis: { ...snap().costBasis, krw: 10_000, holdingCount: 0, estimatedHoldingCount: 0 } }, true))
      .toMatchObject({ evaluationKrw: 0, costKrw: null, profitKrw: null, profitRate: null });
  });
  it("원화 환산을 끈 설정을 존중하고 계좌 손익의 표시 방법을 안내한다", () => {
    const r = render(<TossAccountSummaryView body={{ ...BODY, snapshot: snap() }} failed={false} afterCost showKrw={false} now={NOW}><TextStub>실시간</TextStub></TossAccountSummaryView>);
    expect(text(r.tree)).toContain("원화 환산을 켜면 확인");
    expect(text(r.tree)).not.toContain("-20,480원");
    expect(text(r.tree)).toContain("$199.80");
  });
});
