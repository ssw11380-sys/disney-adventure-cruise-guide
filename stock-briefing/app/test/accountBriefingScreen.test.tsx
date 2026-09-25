import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountBriefing, AccountBriefingWithData, AccountData } from "@/api/types";
import { render, type HostNode } from "./miniRender";

/**
 * 계좌 한 장 브리핑 화면 (3-31): 브리핑 탭 카드와 상세 화면을 최소 렌더러로 그린다.
 *  - 플래그를 끄면 카드가 없고 목록·상세를 요청하지 않는다 (fallback false)
 *  - 상세: 기여 표 줄 + 그 외 = 합계 = 당일 손익, 지수·환율 영향(환율 효과 줄), 오늘 일정, 설명, 고지
 * RN 부품·공용 UI 는 문자열 요소로, API 훅은 가짜로 바꿔 끼운다
 */
const h = vi.hoisted(() => ({
  flags: {} as Record<string, boolean>,
  flagsLoaded: true,
  /** 플래그 요청이 실패함(끊김·서버 오류): data 없음, 받는 중 아님 */
  flagsFailed: false,
  refetchFlags: vi.fn(),
  params: { id: "7" } as { id?: string },
  list: [] as unknown[],
  detail: null as unknown,
  listEnabled: [] as boolean[],
  detailEnabled: [] as boolean[],
  push: vi.fn(),
}));

vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 },
  Alert: { alert: vi.fn() },
  Linking: { openURL: vi.fn() },
  Platform: { OS: "android" },
}));
vi.mock("@expo/vector-icons", () => ({ Ionicons: "Ionicons" }));
vi.mock("expo-router", () => ({ router: { push: h.push, dismissTo: vi.fn(), replace: vi.fn() }, Stack: { Screen: "StackScreen" }, useLocalSearchParams: () => h.params }));
vi.mock("@/theme", async () => {
  const tokens = await import("@/tokens");
  return { ...tokens, useTheme: () => tokens.dark };
});
vi.mock("@/components/Screen", () => ({ Screen: "Screen" }));
vi.mock("@/components/RouteError", () => ({ RouteErrorBoundary: "RouteErrorBoundary" }));
vi.mock("@/components/Freshness", () => ({ StaleBanner: "StaleBanner", usePull: () => ({ pulling: false, onPull: () => undefined }) }));
vi.mock("@/components/Skeleton", () => ({ CardsSkeleton: "CardsSkeleton" }));
vi.mock("@/components/MarkdownView", () => ({ MarkdownView: "MarkdownView" }));
vi.mock("@/components/BriefingCard", () => ({ BriefingCard: "BriefingCard" }));
vi.mock("@/components/ui", () => ({
  Badge: "Badge", Button: "Button", Card: "Card", ChangeText: "ChangeText", Empty: "Empty", ErrorView: "ErrorView", Muted: "Muted", SectionTitle: "SectionTitle", Segmented: "Segmented", TableHead: "TableHead",
}));
vi.mock("@/api/hooks", () => {
  const q = (data: unknown) => ({ data, isError: false, error: null, isSuccess: true, refetch: vi.fn(async () => undefined), dataUpdatedAt: 1, errorUpdatedAt: 0, fetchStatus: "idle" });
  return {
    useFeature: (key: string, fallback: boolean) => (h.flagsLoaded && !h.flagsFailed ? (h.flags[key] ?? fallback) : fallback),
    useFeatures: () => ({ data: h.flagsLoaded && !h.flagsFailed ? { features: h.flags } : undefined, isFetching: !h.flagsLoaded && !h.flagsFailed, refetch: h.refetchFlags }),
    useAccountBriefings: (enabled: boolean) => {
      h.listEnabled.push(enabled);
      return q(enabled ? h.list : undefined);
    },
    useAccountBriefing: (_id: number, enabled: boolean) => {
      h.detailEnabled.push(enabled);
      return q(enabled ? h.detail : undefined);
    },
    useLatestBriefings: () => q([{ code: "005930", name: "삼성전자", latest: { id: 1, code: "005930", name: "삼성전자", session: "morning", date: "2026-09-25", status: "ok", summary: "요약", detail: "", missing: [], model: "m", error: null, createdAt: "2026-09-25T08:40:00+09:00" } }]),
    useRegisteredStocks: () => q([]),
    useHealth: () => q({ llmConfigured: true, lastBriefing: null }),
    useMarketStatus: () => q(undefined),
    useStockMutations: () => ({ run: { mutate: vi.fn(), isPending: false, variables: undefined } }),
  };
});

const { AccountBriefingCard } = await import("@/components/AccountBriefingCard");
const { default: BriefingsScreen } = await import("@/app/(tabs)/briefings");
const { default: AccountBriefingScreen } = await import("@/app/briefings/account/[id]");

const DATA: AccountData = {
  version: 1,
  session: "morning",
  date: "2026-09-25",
  asOf: "2026-09-25T08:35:00+09:00",
  basis: "앱 잔고 화면과 같은 기준",
  afterCost: true,
  holdings: 7,
  stale: 1,
  totalValue: 9_157_673,
  totalCost: 8_274_349,
  totalProfit: 883_324,
  totalProfitRate: 10.68,
  dayPnl: -250_267,
  dayRate: -2.66,
  contributions: [
    { code: "RGTX", name: "리게티 컴퓨팅", currency: "USD", amount: -268_838, changeRate: -8.06, value: 3_052_000 },
    { code: "NVDA", name: "엔비디아", currency: "USD", amount: 39_240, changeRate: 1.82, value: 2_186_000 },
    { code: "000660", name: "SK하이닉스", currency: "KRW", amount: 13_500, changeRate: 1.99, value: 693_000 },
    { code: "005930", name: "삼성전자", currency: "KRW", amount: -12_000, changeRate: -1.65, value: 713_355 },
    { code: "035420", name: "NAVER", currency: "KRW", amount: -17_500, changeRate: -1.3, value: 1_331_000 },
  ],
  others: { count: 2, amount: -4_669 },
  markets: { kr: { count: 4, value: 2_791_070, day: -15_827, dayRate: -0.56 }, us: { count: 3, value: 6_366_603, day: -234_440, dayRate: -3.55 } },
  excluded: [],
  fx: { status: "computed", reason: null, usdKrw: { value: 1391, change: 5.2, changeRate: 0.38, stale: false }, appliedRate: 1391.5, usdHoldingsKrwChange: -211_000, priceEffect: -234_440, fxEffect: 23_440 },
  indices: [{ code: "KOSPI", name: "코스피", value: 3412.35, change: -27.5, changeRate: -0.8, open: false, stale: false }],
  missingIndices: ["코스닥"],
  schedule: {
    kr: { date: "2026-09-25", tradingDay: false, now: "한국 휴장일", hours: null, nextOpen: "2026-09-28T23:00:00.000Z" },
    us: { date: "2026-09-25", tradingDay: true, now: "미국 정규장 마감 상태", hours: "정규장 9/25 22:30~9/26 05:00 (한국 시간)" },
    disclosures: [{ code: "005930", name: "삼성전자", title: "분기보고서", filedAt: "2026-09-24", url: "https://dart.fss.or.kr/x" }],
  },
  narrative: { source: "llm", reason: null },
};
const ITEM: AccountBriefing = {
  id: 7,
  date: "2026-09-25",
  session: "morning",
  status: "ok",
  summary: "당일 -250,267원 (-2.66%) · 기여 1위 리게티 컴퓨팅 -268,838원\n총 평가금액 9,157,673원 · 환율 효과 +23,440원",
  detail: "- 설명 한 줄",
  model: "m",
  template: false,
  createdAt: "2026-09-25T08:36:00+09:00",
  headline: { totalValue: 9_157_673, dayPnl: -250_267, dayRate: -2.66, holdings: 7, top: [{ code: "RGTX", name: "리게티 컴퓨팅", amount: -268_838, changeRate: -8.06 }] },
};
const DETAIL: AccountBriefingWithData = { ...ITEM, data: DATA };

const ofType = (r: ReturnType<typeof render>, type: string) => r.all().filter((n: HostNode) => n.type === type);
const labels = (r: ReturnType<typeof render>) => r.all().map((n) => n.props.accessibilityLabel).filter((x): x is string => typeof x === "string");

beforeEach(() => {
  h.flags = {};
  h.flagsLoaded = true;
  h.flagsFailed = false;
  h.refetchFlags.mockReset();
  h.params = { id: "7" };
  h.list = [ITEM];
  h.detail = DETAIL;
  h.listEnabled = [];
  h.detailEnabled = [];
  h.push.mockReset();
});

describe("브리핑 탭 '내 계좌 브리핑' 카드", () => {
  it("플래그가 꺼져 있으면(기본) 카드가 없고 목록을 요청하지 않는다", () => {
    const r = render(<BriefingsScreen />);
    expect(r.text()).not.toContain("내 계좌 브리핑");
    expect(h.listEnabled.every((e) => e === false)).toBe(true);
    expect(ofType(r, "Screen")[0]!.props.disclaimer).toBe(true);
  });

  it("켜져 있으면 맨 위에 카드: 당일 손익·총 평가금액·기여 1위, 누르면 계좌 브리핑 화면", () => {
    h.flags = { accountBriefing: true };
    const r = render(<BriefingsScreen />);
    expect(h.listEnabled.at(-1)).toBe(true);
    const text = r.text();
    expect(text).toContain("내 계좌 브리핑");
    expect(text).toContain("-250,267원");
    expect(text).toContain("9,157,673원");
    expect(text).toContain("기여 1위 리게티 컴퓨팅 -268,838원");
    // 카드는 화면 맨 위 (종목 브리핑 카드보다 앞)
    const nodes = r.all();
    const card = nodes.find((n) => n.type === "Pressable" && String(n.props.accessibilityLabel).startsWith("내 계좌 브리핑"))!;
    expect(nodes.indexOf(card)).toBeLessThan(nodes.findIndex((n) => n.type === "BriefingCard"));
    expect(ofType(r, "Screen")[0]!.children[0]).toMatchObject({ type: "Card" });
    expect(card.props.accessibilityRole).toBe("link");
    r.act(() => (card.props.onPress as () => void)());
    expect(h.push).toHaveBeenCalledWith("/briefings/account/7");
  });

  it("켜져 있어도 목록이 비면(예전 서버 404) 카드가 없다", () => {
    h.flags = { accountBriefing: true };
    h.list = [];
    expect(render(<BriefingsScreen />).text()).not.toContain("내 계좌 브리핑");
  });

  it("실패한 브리핑은 숫자 대신 실패 문구", () => {
    const r = render(<AccountBriefingCard briefing={{ ...ITEM, status: "failed", headline: null, summary: "시세를 받지 못해 계좌 브리핑을 만들지 못했습니다" }} />);
    expect(r.text()).toContain("생성 실패");
    expect(r.text()).toContain("시세를 받지 못해");
  });
});

describe("계좌 브리핑 상세 화면", () => {
  it("플래그가 꺼져 있으면 상세를 요청하지 않고 안내만", () => {
    const r = render(<AccountBriefingScreen />);
    expect(h.detailEnabled.every((e) => e === false)).toBe(true);
    expect(ofType(r, "Empty")[0]!.props.title).toBe("계좌 브리핑을 볼 수 없습니다");
  });

  it("플래그를 아직 받지 못했으면 잠깐 기다린다 (알림으로 막 켠 경우)", () => {
    h.flagsLoaded = false;
    const r = render(<AccountBriefingScreen />);
    expect(ofType(r, "CardsSkeleton")).toHaveLength(1);
  });

  it("(2차 검증) 플래그를 받지 못하면(오프라인·서버 오류) '꺼져 있다'가 아니라 연결 확인 안내와 다시 시도", () => {
    h.flagsFailed = true;
    const r = render(<AccountBriefingScreen />);
    const empty = ofType(r, "Empty")[0]!;
    expect(empty.props.title).toBe("계좌 브리핑을 불러오지 못했습니다");
    expect(String(empty.props.hint)).toContain("연결을 확인해 주세요");
    expect(String(empty.props.hint)).not.toContain("꺼져 있습니다");
    expect(h.detailEnabled.every((e) => e === false)).toBe(true);
    const retry = empty.props.action as React.ReactElement<{ title: string; onPress: () => void }>;
    expect(retry.props.title).toBe("다시 시도");
    retry.props.onPress();
    expect(h.refetchFlags).toHaveBeenCalledTimes(1);
  });

  it("요약·총 평가·기여 표(줄 + 그 외 = 합계 = 당일 손익)·지수·환율 영향·오늘 일정·설명·고지", () => {
    h.flags = { accountBriefing: true };
    const r = render(<AccountBriefingScreen />);
    expect(h.detailEnabled.at(-1)).toBe(true);
    const screen = ofType(r, "Screen")[0]!;
    expect(screen.props.disclaimer).toBe(true);
    const text = r.text();
    for (const s of ["내 계좌 브리핑", "당일 -250,267원 (-2.66%)", "9,157,673원", "당일 손익 기여", "합계 (= 당일 손익)", "지수·환율 영향", "오늘 일정", "무엇이 계좌를 움직였나", "시세 지연 1종목"]) expect(text, s).toContain(s);
    // 기여 표: 5줄 + 그 외 2종목 + 합계. 합계 금액 = 당일 손익
    const rows = labels(r).filter((l) => l.includes(", 기여 ") && !l.startsWith("요약,"));
    expect(rows).toHaveLength(6);
    expect(rows[0]).toBe("리게티 컴퓨팅, 기여 268,838원 손실, 8.06% 하락");
    expect(rows[5]).toBe("그 외 2종목, 기여 4,669원 손실");
    expect(labels(r)).toContain("합계, 당일 손익, 250,267원 손실");
    expect(text).toContain("줄의 합이 당일 손익과 같습니다");
    // 환율 효과 줄과 나눔 설명
    expect(labels(r)).toContain("환율 효과, 23,440원 이익, 당일 손익에는 넣지 않음");
    expect(text).toContain("미국 보유분 원화 평가 변화 -211,000원 = 가격 효과 -234,440원 + 환율 효과 +23,440원");
    // 오늘 일정: 한국 휴장·미국 정규장, 공시 링크
    expect(labels(r).find((l) => l.startsWith("한국, 휴장"))).toBeTruthy();
    // 장 상태는 브리핑을 만든 때의 것 — '지금'이 아니라 '브리핑 시각(08:35) 기준' (오후 브리핑이 생기기 전까지 맨 위 카드로 남는다)
    expect(labels(r)).toContain("미국, 9/25(현지) 정규장 9/25 22:30~9/26 05:00 (한국 시간), 브리핑 시각 08:35 기준 미국 정규장 마감 상태");
    expect(text).toContain("브리핑 시각(08:35) 기준: 한국 휴장일");
    expect(text).not.toContain("지금:");
    const disclosure = r.all().find((n) => n.type === "Pressable" && String(n.props.accessibilityLabel).includes("DART 에서 열기"))!;
    expect(disclosure.props.accessibilityRole).toBe("link");
    // 설명
    expect(ofType(r, "MarkdownView")[0]!.children).toEqual(["- 설명 한 줄"]);
  });

  it("기본 설명·환율 효과를 계산하지 못한 경우를 알린다 — 기본 설명으로 바꾼 자세한 이유(모델이 지어낸 숫자·오류 문구)는 화면에 옮기지 않는다", () => {
    h.flags = { accountBriefing: true };
    const withReason = (reason: string | null): AccountBriefingWithData => ({ ...DETAIL, template: true, data: { ...DATA, narrative: { source: "template", reason }, fx: { ...DATA.fx, status: "unavailable", reason: "원/달러 전일 대비 변동을 받지 못해 환율 효과를 계산하지 못했습니다", usdHoldingsKrwChange: null, priceEffect: null, fxEffect: null } } });
    h.detail = withReason("입력에 없는 숫자: +16,589원");
    let r = render(<AccountBriefingScreen />);
    let text = r.text();
    expect(text).toContain("숫자로 만든 기본 설명");
    expect(text).toContain("모델 설명이 검사를 통과하지 못해 위 숫자로 만든 기본 설명을 보여 드립니다.");
    expect(text).not.toContain("16,589");
    expect(text).not.toContain("입력에 없는 숫자");
    expect(text).toContain("환율 효과를 계산하지 못했습니다");
    expect(labels(r).some((l) => l.startsWith("환율 효과,"))).toBe(false);
    for (const [reason, note] of [
      ["숫자 표기가 틀림: -30,0890원", "모델 설명이 검사를 통과하지 못해"],
      ["방향이 사실과 반대: 8.06% 올랐", "모델 설명이 검사를 통과하지 못해"],
      ["쓰지 않는 표현: 세요", "모델 설명이 검사를 통과하지 못해"],
      ["부호가 빠진 숫자: 8.06%", "모델 설명이 검사를 통과하지 못해"],
      ["쓰지 않는 표기: &plus;", "모델 설명이 검사를 통과하지 못해"],
      ["모델 호출 실패 (api: 429 rate_limit_error {\"type\":\"error\"})", "모델 설명을 받지 못해"],
      ["모델 응답 시간 초과(90초)", "모델 설명을 받지 못해"],
      ["브리핑 모델이 설정되지 않음", "모델이 설정되지 않아"],
    ] as const) {
      h.detail = withReason(reason);
      r = render(<AccountBriefingScreen />);
      text = r.text();
      expect(text, reason).toContain(note);
      expect(text, reason).not.toContain(reason);
    }
    h.detail = withReason(null);
    expect(render(<AccountBriefingScreen />).text()).toContain("위 숫자로 만든 기본 설명입니다.");
  });

  it("(2차 검증) 숫자가 여럿인 요약 카드·환율 효과 등식 줄은 화면 읽기에서 기호 없이 한 문장 (디자인 규칙)", () => {
    h.flags = { accountBriefing: true };
    const r = render(<AccountBriefingScreen />);
    const all = labels(r);
    const summary = all.find((l) => l.startsWith("요약,"))!;
    expect(summary).toBe("요약, 당일손익 250,267원 손실, 2.66% 하락, 기여 1위 리게티 컴퓨팅 268,838원 손실, 총 평가금액 9,157,673원, 환율 효과 23,440원 이익");
    const summaryNode = r.all().find((n) => n.props.accessibilityLabel === summary)!;
    expect(summaryNode.props.accessible).toBe(true);
    const eq = all.find((l) => l.startsWith("미국 보유분 원화 평가 변화"))!;
    expect(eq).toBe("미국 보유분 원화 평가 변화 211,000원 손실, 가격 효과와 환율 효과의 합, 가격 효과 234,440원 손실, 환율 효과 23,440원 이익, 환율 효과는 원달러 전일 대비 변동으로 계산하며 당일 손익에는 넣지 않습니다");
    for (const l of [summary, eq]) expect(l, l).not.toMatch(/[+=·]|-\d|\(/);
    // 휴장 줄도 말로
    h.detail = { ...DETAIL, data: { ...DATA, krPreviousDay: true, usPreviousDay: true } };
    expect(labels(render(<AccountBriefingScreen />)).find((l) => l.startsWith("요약,"))).toMatch(/오늘 한국 휴장, 국내 종목은 직전 거래일 등락, 지난밤 미국 휴장, 미국 종목은 직전 거래일 등락$/);
  });

  it("기여 표 숫자 칸(합계 줄의 등락률 포함)은 모두 한 줄 맞춤 — 글자 140%에서 두 줄로 꺾이지 않게 (디자인 규칙)", () => {
    h.flags = { accountBriefing: true };
    const r = render(<AccountBriefingScreen />);
    const rows = r.all().filter((n) => typeof n.props.accessibilityLabel === "string" && ((String(n.props.accessibilityLabel).includes(", 기여 ") && !String(n.props.accessibilityLabel).startsWith("요약,")) || String(n.props.accessibilityLabel).startsWith("합계, 당일 손익")));
    expect(rows).toHaveLength(7);
    for (const row of rows) {
      const cells = row.children.filter((c): c is HostNode => typeof c !== "string" && c.type === "Text");
      expect(cells).toHaveLength(3);
      for (const c of cells.slice(1)) expect(c.props, String(row.props.accessibilityLabel)).toMatchObject({ numberOfLines: 1, adjustsFontSizeToFit: true });
    }
    const total = rows.at(-1)!.children.filter((c): c is HostNode => typeof c !== "string" && c.type === "Text");
    expect(total[2]!.children).toEqual(["-2.66%"]);
  });

  it("한국 휴장이면 기여 표 아래와 브리핑 탭 카드에 국내 등락이 직전 거래일 것임을 밝힌다", () => {
    h.flags = { accountBriefing: true };
    h.detail = { ...DETAIL, data: { ...DATA, krPreviousDay: true } };
    expect(render(<AccountBriefingScreen />).text()).toContain("오늘 한국은 휴장이라 국내 종목은 직전 거래일 등락입니다");
    h.detail = DETAIL;
    expect(render(<AccountBriefingScreen />).text()).not.toContain("직전 거래일");
    const card = render(<AccountBriefingCard briefing={{ ...ITEM, headline: { ...ITEM.headline!, krPreviousDay: true } }} />);
    expect(card.text()).toContain("오늘 한국 휴장 · 국내 종목은 직전 거래일 등락");
    expect(render(<AccountBriefingCard briefing={ITEM} />).text()).not.toContain("직전 거래일");
  });

  it("(2차 검증) 지난밤 미국 평일 휴장이면 기여 표 아래·브리핑 탭 카드(화면 읽기 포함)에 미국 등락이 직전 거래일 것임을 밝힌다", () => {
    h.flags = { accountBriefing: true };
    h.detail = { ...DETAIL, data: { ...DATA, usPreviousDay: true } };
    expect(render(<AccountBriefingScreen />).text()).toContain("지난밤 미국은 휴장이라 미국 종목은 직전 거래일 등락입니다");
    const card = render(<AccountBriefingCard briefing={{ ...ITEM, headline: { ...ITEM.headline!, usPreviousDay: true } }} />);
    expect(card.text()).toContain("지난밤 미국 휴장 · 미국 종목은 직전 거래일 등락");
    expect(labels(card).find((l) => l.startsWith("내 계좌 브리핑"))).toContain("지난밤 미국 휴장, 미국 종목은 직전 거래일 등락");
  });

  it("잘못된 주소는 요청하지 않고 안내", () => {
    h.flags = { accountBriefing: true };
    h.params = { id: "abc" };
    const r = render(<AccountBriefingScreen />);
    expect(ofType(r, "ErrorView")).toHaveLength(1);
    expect(h.detailEnabled.every((e) => e === false)).toBe(true);
  });
});
