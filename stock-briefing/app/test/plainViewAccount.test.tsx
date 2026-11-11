import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TossAccountSnapshotBody, WatchItem } from "@/api/types";
import { cleanupRenders, render, type HostNode } from "./miniRender";

/**
 * 군더더기 글 줄이기 (플래그 plainView) — 잔고 맨 위 계좌 요약과 관심 탭 카드.
 * 꺼져 있을 때의 모습은 test/tossAccountSnapshot.test.tsx 등 기존 테스트가 그대로 본다.
 */
const h = vi.hoisted(() => ({ afterCost: true, showKrw: true, plain: false, watch: { available: true, data: { items: [] as unknown[] }, isFetching: false, isPending: false, isError: false, refetch: () => undefined } }));
const navigation = { isReady: () => true, addListener: () => () => undefined };
vi.mock("expo-router", () => ({ useLocalSearchParams: () => ({}), useNavigationContainerRef: () => navigation, router: { setParams: () => undefined, push: () => undefined } }));
vi.mock("react-native", () => ({ View: "View", Text: "Text", Pressable: "Pressable", FlatList: "FlatList", StyleSheet: { create: <T,>(v: T) => v, hairlineWidth: 1 } }));
vi.mock("@/theme", async () => ({ ...(await import("@/tokens")), useTheme: () => ({}), changeColor: (_t: unknown, n: number) => (n > 0 ? "up" : n < 0 ? "down" : "flat") }));
vi.mock("@/api/hooks", () => ({ useTossAccountSnapshot: () => ({ data: undefined, error: null, isError: false }), useFeature: () => false }));
vi.mock("@/lib/settings", () => ({ useSettings: () => h }));
vi.mock("@/lib/useNow", () => ({ useNow: () => Date.parse("2026-11-12T01:45:00+09:00") }));
vi.mock("@/lib/watchlistHooks", () => ({ useWatchlist: () => h.watch }));
vi.mock("@/components/Screen", () => ({ Screen: "Screen" }));
vi.mock("@/components/RouteError", () => ({ RouteErrorBoundary: "RouteErrorBoundary" }));
vi.mock("@/components/ui", () => ({
  Button: "Button",
  Card: "Card",
  Muted: "Muted",
  SectionTitle: "SectionTitle",
  Row: ({ label, value }: { label: string; value: React.ReactNode }) => React.createElement("Row", { label }, value),
}));

const { TossAccountSummaryView } = await import("@/components/TossAccountSummary");
const { PlainViewContext } = await import("@/lib/plainFlag");
const watchlist = await import("@/app/(tabs)/watchlist");

const AT = "2026-11-12T01:39:40+09:00";
const NOW = Date.parse("2026-11-12T01:45:00+09:00");
const BODY: TossAccountSnapshotBody = {
  on: true,
  sync: { enabled: true, intervalMin: 10, idleIntervalMin: 60, lastRunAt: AT, nextRunAt: "2026-11-12T01:49:40+09:00", lastError: null },
  snapshot: {
    source: "toss-openapi", scope: "all-toss-stock-holdings", excludesCash: true, includesExcludedHoldings: true,
    receivedFrom: AT, receivedAt: AT, accountCount: 2, holdingCount: 18, excludedHoldingCount: 0,
    gross: { krw: 100_000, usd: 200 }, net: { krw: 30_000, usd: 50 },
    displayFx: { usdKrw: 1400, receivedAt: AT, source: "app-display-fx", kind: "reference" },
    costBasis: { krw: 120_000, holdingCount: 18, estimatedHoldingCount: 0, source: "synced-holdings-cost-book" },
  },
};
const all = (nodes: (HostNode | string)[]): HostNode[] => nodes.flatMap((x) => (typeof x === "string" ? [] : [x, ...all(x.children)]));
const text = (nodes: (HostNode | string)[]): string => nodes.map((x) => (typeof x === "string" ? x : text(x.children))).join("");
function Stub({ children }: { children: React.ReactNode }) {
  return React.createElement("Text", {}, children);
}
const summary = (extra: Record<string, unknown> = {}, body: TossAccountSnapshotBody = BODY, showKrw = true) => (
  <TossAccountSummaryView body={body} failed={false} afterCost showKrw={showKrw} now={NOW} focused {...extra}>
    <Stub>시세 기준 합계 패널</Stub>
  </TossAccountSummaryView>
);
const press = (r: ReturnType<typeof render>, label: string) => r.act(() => (all(r.tree).find((n) => n.props.accessibilityLabel === label)!.props.onPress as () => void)());

beforeEach(() => {
  cleanupRenders();
  h.afterCost = true;
  h.showKrw = true;
});

describe("잔고 맨 위 계좌 요약 — 짧은 글", () => {
  it("꺼져 있으면 지금 글 그대로 (단서 줄이 모두 보인다)", () => {
    const off = text(render(summary()).tree);
    for (const s of ["수수료·세금 차감 후 · 현금·예수금 제외", "원화 환산(참고)", "계좌 기준 평가손익(참고)", "토스 원화 손익과 차이 가능", "(한국 시각)", "금액·계산 기준 보기", "종목별 금액·손익·비중은 시세 기준 추정값입니다."]) expect(off).toContain(s);
  });

  it("켜면 금액·평가손익·받은 시각만 — 단서·출처 줄은 보이지 않는다", () => {
    const r = render(summary({ plain: true, status: <Stub>미국 정규장 · 실시간</Stub> }));
    const t = text(r.tree);
    // 금액(30,000 + 50달러 × 1,400 = 100,000원) · 평가손익(100,000 − 120,000) · 수익률(버림) · 받은 시각
    expect(t).toContain("토스 주식 평가금액");
    expect(t).toContain("100,000원");
    expect(t).toContain("-20,000원");
    expect(t).toContain("-16.66%");
    expect(t).toContain("01:39 기준");
    for (const s of ["수수료·세금", "현금·예수금", "(참고)", "차이 가능", "한국 시각", "추정값입니다"]) expect(t).not.toContain(s);
    // 맨 아래에는 단서 문장 대신 시세 상태 줄
    expect(t).toContain("미국 정규장 · 실시간");
    // 화면 읽기 문장도 짧게
    expect(all(r.tree).some((n) => typeof n.props.accessibilityLabel === "string" && n.props.accessibilityLabel.startsWith("평가손익"))).toBe(true);
  });

  it("켜도 링크는 그대로 눌린다 — 글만 짧다 (화면 읽기 이름은 지금 그대로)", () => {
    const open = { allocation: vi.fn(), themes: vi.fn(), journal: vi.fn() };
    const r = render(summary({ plain: true, onAllocation: open.allocation, onThemes: open.themes, onJournal: open.journal }));
    const t = text(r.tree);
    for (const s of ["계산 기준", "비중", "테마", "매매일지"]) expect(t).toContain(s);
    for (const s of ["금액·계산 기준 보기", "종목 비중 보기", "내 종목 테마 보기", "매매일지 보기"]) expect(t).not.toContain(s);
    press(r, "종목 시세 기준 비중 보기");
    press(r, "내 종목 테마 보기");
    press(r, "매매일지 보기");
    expect(open.allocation).toHaveBeenCalledTimes(1);
    expect(open.themes).toHaveBeenCalledTimes(1);
    expect(open.journal).toHaveBeenCalledTimes(1);
  });

  it("단서는 '계산 기준'을 펴면 보이고, 거기서 시세 기준 합계도 펼 수 있다 (펴면 아래 상태 줄은 패널 안의 것만)", () => {
    const r = render(summary({ plain: true, status: <Stub>상태 줄</Stub> }));
    expect(text(r.tree)).not.toContain("시세 기준 합계 패널");
    press(r, "금액·계산 기준 펼치기");
    const t = text(r.tree);
    for (const s of ["수수료·세금 차감 후", "현금·예수금 제외", "매입금액 120,000원", "앱 표시 환율 1,400.00원", "전체 연동 2개 계좌 · 보유 18종목", "토스 화면의 원화 손익과 다를 수 있습니다"]) expect(t).toContain(s);
    expect(t).toContain("상태 줄");
    press(r, "시간외 시세 기준 추정 보기");
    expect(text(r.tree)).toContain("시세 기준 합계 패널");
    expect(text(r.tree)).not.toContain("상태 줄");
  });

  it("켜도 경고는 남는다: 추정 원가·동기화 제외 종목·받지 못함", () => {
    const snap = { ...BODY.snapshot!, excludedHoldingCount: 2, costBasis: { ...BODY.snapshot!.costBasis!, estimatedHoldingCount: 3 } };
    const t = text(render(summary({ plain: true }, { ...BODY, snapshot: snap })).tree);
    expect(t).toContain("추정 원가 3종목 포함");
    expect(t).toContain("계좌 합계에는 앱 동기화 제외 2종목도 포함");
    const failed = text(render(<TossAccountSummaryView body={BODY} failed afterCost showKrw now={NOW} focused plain><Stub>패널</Stub></TossAccountSummaryView>).tree);
    expect(failed).toContain("새로고침 실패 · 마지막 수신 금액입니다.");
  });

  it("원화 환산을 끈 설정이면 통화별 금액 두 칸만 (설명 줄 없이)", () => {
    const t = text(render(summary({ plain: true }, BODY, false)).tree);
    expect(t).toContain("30,000원");
    expect(t).toContain("$50.00");
    expect(t).not.toContain("원화 환산 꺼짐");
    expect(t).not.toContain("평가손익");
  });

  it("넓은 창·예전 모습(focused 아님)에는 적용하지 않는다", () => {
    const t = text(render(<TossAccountSummaryView body={BODY} failed={false} afterCost showKrw now={NOW} plain><Stub>패널</Stub></TossAccountSummaryView>).tree);
    expect(t).toContain("토스 수수료·세금 차감 후");
  });
});

describe("관심 탭 카드 — 짧은 글", () => {
  const item = (over: Partial<WatchItem> = {}): WatchItem => ({
    code: "NVDA", name: "엔비디아", market: "NASDAQ", currency: "USD", startPrice: 240, desiredPrice: 200, alerts: true,
    createdAt: AT, updatedAt: AT,
    quote: { price: 250, changeRate: 1.23, asOf: AT, priceBasis: "최근 체결(시간외 포함)", stale: false } as unknown as WatchItem["quote"],
    ...over,
  });
  const card = (it2: WatchItem, plain: boolean) => render(<watchlist.WatchRow item={it2} focused {...(plain ? { plain: true } : null)} />);
  const rows = (r: ReturnType<typeof render>) => all(r.tree).filter((n) => n.type === "Row").map((n) => `${String(n.props.label)}=${text(n.children)}`);

  it("꺼져 있으면 지금 글 그대로", () => {
    const t = text(card(item(), false).tree);
    expect(t).toContain("하락하면 희망가 · 현재가 대비");
    expect(t).toContain("(한국 시각) · 최근 체결(시간외 포함)");
    expect(t).toContain("관심 시작 대비 5% 구간 알림 켜짐");
  });

  it("켜면 현재가 옆에 등락률, 희망가까지는 표 한 줄, 시세 기준 줄은 없다", () => {
    const r = card(item(), true);
    const t = text(r.tree);
    expect(t).toContain("$250.00");
    expect(t).toContain("+1.23%");
    expect(rows(r)).toEqual(["관심 시작 가격=$240.00", "구매희망 가격=$200.00", "희망가까지=-$50.00 (-20.00%)"]);
    expect(t).toContain("5% 알림 켜짐");
    for (const s of ["하락하면 희망가", "한국 시각", "시간외 포함", "관심 시작 대비", "시세 기준"]) expect(t).not.toContain(s);
    // 버튼은 그대로
    expect(all(r.tree).filter((n) => n.type === "Button").map((n) => n.props.title)).toEqual(["상세·차트", "가격·알림 수정"]);
  });

  it("켜도 알려야 하는 것은 남는다: 시세 지연 · 현재가 없음 · 희망가 도달", () => {
    expect(text(card(item({ quote: { price: 250, changeRate: 1.23, asOf: AT, stale: true } as unknown as WatchItem["quote"] }), true).tree)).toContain("시세 지연");
    const none = card(item({ quote: null }), true);
    expect(text(none.tree)).toContain("현재가 확인 불가");
    expect(rows(none)).toEqual(["관심 시작 가격=$240.00", "구매희망 가격=$200.00"]);
    expect(rows(card(item({ desiredPrice: 260 }), true)).at(-1)).toBe("희망가까지=도달 · $10.00 아래");
    expect(text(card(item({ alerts: false }), true).tree)).toContain("알림 꺼짐");
  });

  it("목록 머리의 설명 문장은 켜면 그리지 않는다 ('관심종목 담기' 버튼은 그대로)", () => {
    const head = (plain: boolean) => {
      const r = render(<PlainViewContext.Provider value={plain}><watchlist.default /></PlainViewContext.Provider>);
      const list = all(r.tree).find((n) => n.type === "FlatList")!;
      return render(list.props.ListHeaderComponent as React.ReactElement);
    };
    expect(text(head(false).tree)).toContain("잔고 합계에는 포함하지 않습니다.");
    const on = head(true);
    expect(text(on.tree)).not.toContain("잔고 합계에는 포함하지 않습니다.");
    expect(all(on.tree).some((n) => n.type === "Button" && n.props.title === "관심종목 담기")).toBe(true);
  });
});
