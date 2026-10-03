import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TossAccountSnapshotBody } from "@/api/types";
import { cleanupRenders, render, type HostNode } from "./miniRender";

const h = vi.hoisted(() => ({ data: undefined as TossAccountSnapshotBody | undefined, error: null as unknown, afterCost: true, showKrw: true, params: {} as { valuation?: string }, setParams: vi.fn() }));
vi.mock("expo-router", () => ({ useLocalSearchParams: () => h.params, router: { setParams: h.setParams } }));
vi.mock("react-native", () => ({ View: "View", Text: "Text", Pressable: "Pressable", StyleSheet: { create: <T,>(v: T) => v, hairlineWidth: 1 } }));
vi.mock("@/theme", async () => ({ ...(await import("@/tokens")), useTheme: () => ({}), }));
vi.mock("@/api/hooks", () => ({ useTossAccountSnapshot: () => ({ data: h.data, error: h.error, isError: !!h.error }) }));
vi.mock("@/lib/settings", () => ({ useSettings: () => h }));
vi.mock("@/lib/useNow", () => ({ useNow: () => Date.parse("2026-10-04T12:10:00+09:00") }));
const { TossAccountSummary, TossAccountSummaryView } = await import("@/components/TossAccountSummary");
const { tossSnapshotNotice, tossSnapshotRange, tossSnapshotTime } = await import("@/lib/tossAccountSnapshot");
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
beforeEach(() => { cleanupRenders(); h.data = BODY; h.error = null; h.afterCost = true; h.showKrw = true; h.params = {}; h.setParams.mockClear(); });

describe("토스 원본 계좌와 실시간 평가 분리", () => {
  it("위젯 금액 링크는 같은 실시간 평가를 열고, 다시 누르면 사용자가 고른 토스 탭에서도 돌아온다", () => {
    h.params = { valuation: "live" };
    const el = <TossAccountSummary><TextStub>위젯과 같은 실시간 평가</TextStub></TossAccountSummary>;
    const r = render(el);
    expect(text(r.tree)).toContain("위젯과 같은 실시간 평가");
    expect(text(r.tree)).not.toContain("토스 주식 평가금액");
    expect(h.setParams).toHaveBeenCalledWith({ valuation: undefined });
    h.params = {};
    r.rerender(el);
    const tab = all(r.tree).find((x) => x.props.accessibilityLabel === "토스 계좌 보기")!;
    r.act(() => (tab.props.onPress as () => void)());
    expect(text(r.tree)).toContain("토스 주식 평가금액");
    h.params = { valuation: "live" };
    r.rerender(el);
    expect(text(r.tree)).toContain("위젯과 같은 실시간 평가");
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
    expect(s).toContain("아래 종목·비중·위젯·보고서는 앱 시세 기준");
    expect(s).not.toContain("0.0%"); expect(s).not.toContain("기존 실시간 숫자");
  });
  it("비용 차감을 끄면 gross 원본을 표시하고 실시간 탭은 기존 요약을 그대로 표시", () => {
    const r = mount(BODY, false, false);
    expect(text(r.tree)).toContain("100,000원"); expect(text(r.tree)).toContain("$200.00");
    const tab = all(r.tree).find((x) => x.props.accessibilityLabel === "실시간 평가 보기")!;
    r.act(() => (tab.props.onPress as () => void)());
    expect(text(r.tree)).toContain("기존 실시간 숫자와 비중");
    expect(text(r.tree)).not.toContain("토스 주식 평가금액");
    expect(all(r.tree).find((x) => x.props.accessibilityLabel === "실시간 평가 보기")!.props.accessibilityState).toEqual({ selected: true });
  });
  it.each([undefined, { on: true, snapshot: null, sync: null }, { on: false, snapshot: null, sync: null }] as const)("원본 없음·로딩·이전 서버에서 실시간 요약을 막거나 0원 원본을 만들지 않는다", (body) => {
    const r = render(<TossAccountSummaryView body={body} failed={false} afterCost showKrw now={NOW}><TextStub>실시간 대체</TextStub></TossAccountSummaryView>);
    expect(text(r.tree)).toContain("실시간 대체"); expect(text(r.tree)).not.toContain("0원");
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
  });
  it("환율 없음은 환산값을 꾸미지 않으며 실제 빈 계좌의 0원만 원본으로 표시", () => {
    const r = mount({ ...BODY, snapshot: { ...BODY.snapshot!, displayFx: null } });
    expect(text(r.tree)).toContain("통화별 원본 금액만"); expect(text(r.tree)).not.toContain("원화 환산(참고)");
    const empty = mount({ ...BODY, snapshot: { ...BODY.snapshot!, holdingCount: 0, net: { krw: 0, usd: 0 }, displayFx: null } });
    expect(text(empty.tree)).toContain("보유 0종목"); expect(text(empty.tree)).toContain("0원");
  });
  it("큰 글씨·긴 금액은 줄 수 제한 없이 감싸고 탭은 최소 터치 높이를 보장", () => {
    const r = mount({ ...BODY, snapshot: { ...BODY.snapshot!, net: { krw: 999999999999, usd: 999999999 } } });
    for (const n of all(r.tree).filter((x) => x.type === "Text")) expect(n.props.numberOfLines).toBeUndefined();
    const tabs = all(r.tree).filter((x) => x.props.accessibilityRole === "tab");
    expect(tabs).toHaveLength(2);
    for (const n of tabs) expect((n.props.style as { minHeight?: number }[])[0]!.minHeight).toBeGreaterThanOrEqual(44);
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
