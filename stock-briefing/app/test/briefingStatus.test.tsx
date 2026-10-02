import { readFileSync } from "node:fs";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Briefing, BriefingStatus, BriefingWithData } from "@/api/types";
import { cleanupRenders, render, type HostNode } from "./miniRender";

/**
 * 브리핑 3차 2 — 늦음·실패 안내 (플래그 briefingStatus, 앱 fallback 꺼짐).
 *  - 꺼짐(앱 기본): 예전 안내 '최근 실행에서 N개 종목이 실패했습니다' + 오류 원문, 실패 카드·줄은 원문 — 지금 그대로 (상태를 부르지도 않음)
 *  - 켬: 서버 상태로 새 안내(문제가 없으면 안 보임), 받는 중이면 비움, 못 받으면(404·연결 오류) 예전 안내.
 *    못 만든 종목 이름(5개까지 · '외 N종목')을 누르면 폰·카드 격자는 그 브리핑 상세, 2단은 오른쪽 칸. 실패 카드·줄·상세는 쉬운 말
 * 시계는 고정 (useNow: 월 9/28 08:40), RN 부품·공용 UI 는 문자열 요소로, API 훅은 가짜로 바꿔 끼운다
 */
const h = vi.hoisted(() => ({
  win: { width: 475, height: 751, scale: 2.625, fontScale: 1 },
  flags: {} as Record<string, boolean>,
  now: Date.parse("2026-09-28T08:40:00+09:00"),
  status: undefined as unknown,
  statusError: false,
  statusCalls: 0,
  statusRefetch: vi.fn(async () => undefined),
  health: { llmConfigured: true, lastBriefing: null } as unknown,
  latest: [] as unknown[],
  detail: null as unknown,
  push: vi.fn(),
  alert: vi.fn(),
  mutate: vi.fn(),
  store: new Map<string, string>(),
}));

vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  RefreshControl: "RefreshControl",
  StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 },
  Alert: { alert: h.alert },
  Linking: { openURL: vi.fn() },
  Platform: { OS: "android" },
  useWindowDimensions: () => h.win,
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (k: string) => h.store.get(k) ?? null,
    setItem: async (k: string, v: string) => void h.store.set(k, v),
    removeItem: async (k: string) => void h.store.delete(k),
  },
}));
vi.mock("@expo/vector-icons/Ionicons", () => ({ default: "Ionicons" }));
vi.mock("expo-router", () => ({ router: { push: h.push, dismissTo: vi.fn(), replace: vi.fn() }, Stack: { Screen: "StackScreen" }, Tabs: { Screen: "TabsScreen" }, useLocalSearchParams: () => ({ id: "12" }) }));
vi.mock("@/theme", async () => {
  const tokens = await import("@/tokens");
  return { ...tokens, useTheme: () => tokens.dark, useFontScale: () => 1 };
});
vi.mock("@/lib/useNow", () => ({ useNow: () => h.now }));
vi.mock("@/components/Screen", () => ({ Screen: "Screen" }));
vi.mock("@/components/RouteError", () => ({ RouteErrorBoundary: "RouteErrorBoundary" }));
vi.mock("@/components/Freshness", () => ({ StaleBanner: "StaleBanner", usePull: () => ({ pulling: false, onPull: () => undefined }) }));
vi.mock("@/components/Skeleton", () => ({ CardsSkeleton: "CardsSkeleton" }));
vi.mock("@/components/MarkdownView", () => ({ MarkdownView: "MarkdownView" }));
vi.mock("@/components/BriefingCard", () => ({ BriefingCard: "BriefingCard" }));
vi.mock("@/components/BriefingSources", () => ({ BriefingSources: "BriefingSources" }));
vi.mock("@/components/ui", () => ({
  Badge: "Badge", Button: "Button", Card: "Card", ChangeText: "ChangeText", Empty: "Empty", ErrorView: "ErrorView", Muted: "Muted", Row: "Row", SectionTitle: "SectionTitle", Segmented: "Segmented", TableHead: "TableHead",
}));
vi.mock("@/api/hooks", () => {
  const q = (data: unknown) => ({ data, isError: false, error: null, isSuccess: data !== undefined, refetch: vi.fn(async () => undefined), dataUpdatedAt: 1, errorUpdatedAt: 0, fetchStatus: "idle" });
  return {
    useFeature: (key: string, fallback = false) => h.flags[key] ?? fallback,
    useFeatures: () => ({ data: { features: h.flags }, isFetching: false, refetch: vi.fn() }),
    useMarketSummaries: () => q(undefined),
    useMarketSummary: () => q(undefined),
    useAccountBriefings: () => q(undefined),
    useAccountBriefing: () => q(undefined),
    useLatestBriefings: () => q(h.latest),
    useRegisteredStocks: () => q([]),
    useHealth: () => q(h.health),
    useMarketStatus: () => q({ KR: { isTradingDay: true, opensAt: null }, US: { isTradingDay: true } }),
    useStockMutations: () => ({ run: { mutate: h.mutate, isPending: false, variables: undefined } }),
    useBriefing: () => q(h.detail),
    useBriefings: () => q(undefined),
    useBriefingStatus: (enabled: boolean) => {
      h.statusCalls++;
      return { ...q(enabled ? h.status : undefined), isError: h.statusError, refetch: h.statusRefetch };
    },
  };
});

const { default: BriefingsScreen } = await import("@/app/(tabs)/briefings");
const { BriefingStatusBanner, NAME_H, nameSlop, nameTarget } = await import("@/components/BriefingStatusBanner");
const { BriefingCard } = await vi.importActual<typeof import("@/components/BriefingCard")>("@/components/BriefingCard");
const { BriefingRow, BriefingTile } = await import("@/components/BriefingList");
const { BriefingBody } = await import("@/components/BriefingBody");
const { forgetWindowClass } = await import("@/lib/useFoldLayout");
const { UX_OFF, UxFlagsContext } = await import("@/lib/uxFlags");
const pick = await import("@/lib/briefingPick");
const readStore = await import("@/lib/briefingRead");
const { failedCardText, failedLine, failedRunText, failureKind, nextWhen, problemSpeech, statusView } = await import("@/lib/briefingStatus");
const { dark, touch } = await import("@/tokens");

const fixture = JSON.parse(readFileSync(new URL("../../shared/fixtures/briefingFailure.json", import.meta.url), "utf8")) as { cases: Array<{ error: string | null; kind: string }> };
/** 서버 검사기(backend/src/analysis/scoreWording.ts)의 금지어 정규식을 그대로 읽어 쓴다 */
const src = readFileSync(new URL("../../backend/src/analysis/scoreWording.ts", import.meta.url), "utf8");
const BANNED = new RegExp(/SCORE_BANNED_RE =\s*\/(.+)\/;/.exec(src)![1]!, "g");
const FUTURE = new RegExp(/SCORE_FUTURE_RE = \/(.+)\/;/.exec(src)![1]!, "g");
/** 오류 원문이 새지 않았는지: 종류 접두·영어 오류 이름·상태 번호·영어 문장 */
const RAW = /api:|config:|refusal:|truncated:|Error|\((4|5)\d\d\)|[A-Za-z]{3,}/;

const iso = (s: string) => `${s}+09:00`;
const RATE_LIMIT = "api: API 사용량 제한에 걸렸습니다 (429). 잠시 뒤 다시 시도해 주세요";
const S = (over: Partial<BriefingStatus>): BriefingStatus => ({
  session: "morning", date: "2026-09-28", scheduledAt: iso("2026-09-28T08:30:00"), state: "ok", late: false,
  startedAt: iso("2026-09-28T08:30:31"), finishedAt: iso("2026-09-28T08:39:12"), total: 17, done: 17, problems: [], reasonKind: null,
  nextRunAt: iso("2026-09-28T16:00:00"), retryAt: null, manualRun: true, ...over,
});
const P = (code: string, name: string, briefingId: number | null = 700, over: Partial<BriefingStatus["problems"][number]> = {}) => ({ code, name, briefingId, kind: "busy" as const, missing: false, ...over });
const PARTIAL = S({ state: "partial", done: 15, reasonKind: "busy", problems: [P("TSLA", "테슬라", 701), P("PLTR", "팔란티어", 702)] });

const B = (id: number, code: string, name: string, over: Partial<Briefing> = {}): Briefing => ({
  id, code, name, session: "morning", date: "2026-09-28", status: "ok", summary: `${name} 요약`, detail: "## 한 줄", missing: [], model: "m", error: null, createdAt: iso("2026-09-28T08:32:00"), ...over,
});
const FAILED = B(701, "TSLA", "테슬라", { status: "failed", summary: `브리핑 생성 실패: ${RATE_LIMIT}`, error: RATE_LIMIT, detail: "", createdAt: iso("2026-09-28T08:36:10") });
const LIST = [
  { code: "005930", name: "삼성전자", latest: B(700, "005930", "삼성전자") },
  { code: "TSLA", name: "테슬라", latest: FAILED },
  { code: "PLTR", name: "팔란티어", latest: B(702, "PLTR", "팔란티어", { status: "failed", summary: `브리핑 생성 실패: ${RATE_LIMIT}`, error: RATE_LIMIT }) },
];
const OLD_HEALTH = { llmConfigured: true, lastBriefing: { session: "morning", date: "2026-09-28", startedAt: iso("2026-09-28T08:30:31"), finishedAt: iso("2026-09-28T08:39:12"), ok: 15, failed: 2, skipped: 0, lastError: RATE_LIMIT, trigger: "schedule" } };

type R = ReturnType<typeof render>;
const rawOf = (n: HostNode | string): string => (typeof n === "string" ? n : n.children.map(rawOf).join(""));
const ofType = (r: R, type: string) => r.all().filter((n) => n.type === type);
const kids = (n: HostNode) => n.children.filter((c): c is HostNode => typeof c !== "string");
const all = (n: HostNode): HostNode[] => [n, ...kids(n).flatMap(all)];
const flat = (n: HostNode): Record<string, unknown> => Object.assign({}, ...[n.props.style].flat(Infinity).filter(Boolean));
/** 안내 카드 (왼쪽 막대가 있는 Card) */
const bannerOf = (r: R) => ofType(r, "Card").find((c) => flat(c).borderLeftWidth === 3) ?? null;
/** 안내 첫 묶음(화면 읽기 한 문장) */
const speechOf = (card: HostNode) => all(card).find((n) => n.type === "View" && n.props.accessible === true && typeof n.props.accessibilityLabel === "string" && String(n.props.accessibilityLabel).startsWith("브리핑 안내"));
const nameLinks = (card: HostNode) => all(card).filter((n) => n.type === "Pressable");
const settle = async (r: R) => {
  for (let i = 0; i < 3; i++) await new Promise((res) => setTimeout(res, 0));
  r.rerender();
};
const tab = async () => {
  const r = render(<BriefingsScreen />);
  await settle(r);
  return r;
};
/** 보이는 글 모두 (안내가 만드는 모든 상태) */
const viewTexts = (v: NonNullable<ReturnType<typeof statusView>>) => [v.title, v.line, ...v.names.map((p) => p.name), ...(v.small?.parts ?? []), v.small?.note, v.speech].filter((x): x is string => !!x);

beforeEach(() => {
  cleanupRenders();
  h.win = { width: 475, height: 751, scale: 2.625, fontScale: 1 };
  h.flags = { briefingManualRun: true };
  h.now = Date.parse("2026-09-28T08:40:00+09:00");
  h.status = PARTIAL;
  h.statusError = false;
  h.statusCalls = 0;
  h.statusRefetch.mockClear();
  h.health = OLD_HEALTH;
  h.latest = LIST;
  h.detail = { ...FAILED, data: null } satisfies BriefingWithData;
  h.push.mockReset();
  h.alert.mockReset();
  h.mutate.mockReset();
  h.store.clear();
  forgetWindowClass();
  pick.forgetPick();
  readStore.forgetRead();
});

describe("오류 글 → 종류 (공용 픽스처 — 서버와 같은 표)", () => {
  it.each(fixture.cases)("$error → $kind", ({ error, kind }) => expect(failureKind(error)).toBe(kind));
});

describe("안내 글 (상태별 · 고정 시계 월 9/28 08:40)", () => {
  it("일부 못 만듦: 첫 줄 · 누르는 이름 · '이유 · 완료' · 버튼 안내 · 화면 읽기 한 문장", () => {
    const v = statusView(PARTIAL, h.now)!;
    expect(v.tone).toBe("warn");
    expect(v.title).toBe("오전 브리핑 17종목 중 2종목을 만들지 못했습니다");
    expect(v.names.map((p) => p.name)).toEqual(["테슬라", "팔란티어"]);
    expect(v.more).toBe(0);
    expect(v.line).toBeNull();
    expect(v.small).toEqual({ parts: ["이유: AI 서비스가 잠시 붐볐습니다", "08:39 완료"], note: "이름을 누르면 그 종목만 다시 만드는 버튼이 있습니다." });
    expect(v.speech).toBe("브리핑 안내, 오전 브리핑 17종목 중 2종목을 만들지 못했습니다, 이유 AI 서비스가 잠시 붐볐습니다, 8시 39분 완료, 이름을 누르면 그 종목만 다시 만드는 버튼이 있습니다");
    expect(problemSpeech(v.names[0]!, v.session)).toBe("테슬라 오전 브리핑, 만들지 못함, 열기");
  });

  it("이름은 5개까지, 넘으면 '외 N종목' · 늦음이 같이면 '예정 08:30 → 09:12 완료' · 이유가 여럿이면 이유 없이", () => {
    const eight = ["테슬라", "팔란티어", "엔비디아", "마이크로소프트", "애플", "브로드컴", "메타", "SOXL"].map((n, i) => P(`C${i}`, n, 800 + i));
    const v = statusView(S({ state: "partial", late: true, finishedAt: iso("2026-09-28T09:12:00"), problems: eight, reasonKind: null, done: 9 }), h.now)!;
    expect(v.title).toBe("오전 브리핑 17종목 중 8종목을 만들지 못했습니다");
    expect(v.names).toHaveLength(5);
    expect(v.more).toBe(3);
    expect(v.small!.parts).toEqual(["예정 08:30 → 09:12 완료"]);
    expect(v.speech).toContain("예정 8시 30분, 9시 12분 완료");
  });

  it("다시 만들기 버튼이 꺼져 있으면 다음 예약 브리핑: 오전 → '16:00', 오후 → '내일 08:30', 금요일 오후 → '9/28(월) 08:30'", () => {
    expect(statusView({ ...PARTIAL, manualRun: false }, h.now)!.small!.note).toBe("다음 브리핑(16:00)에 새로 만듭니다.");
    const pm = Date.parse(iso("2026-09-28T16:20:00"));
    expect(statusView({ ...PARTIAL, session: "afternoon", manualRun: false, nextRunAt: iso("2026-09-29T08:30:00") }, pm)!.small!.note).toBe("다음 브리핑(내일 08:30)에 새로 만듭니다.");
    const fri = Date.parse(iso("2026-09-25T16:20:00"));
    expect(nextWhen(iso("2026-09-28T08:30:00"), fri)).toBe("9/28(월) 08:30");
    expect(statusView({ ...PARTIAL, manualRun: false, nextRunAt: iso("2026-09-28T08:30:00") }, fri)!.speech).toContain("다음 브리핑 9월 28일 월요일 8시 30분에 새로 만듭니다");
    // 누를 이름이 없으면(지난 브리핑도 없음) 버튼 안내 대신 다음 브리핑
    expect(statusView({ ...PARTIAL, problems: [P("NEW", "새종목", null, { missing: true, kind: "restart" })], reasonKind: "restart" }, h.now)!.small!.note).toBe("다음 브리핑(16:00)에 새로 만듭니다.");
  });

  it("도중에 다시 켜짐: 이유 '서버가 도중에 다시 시작되어 …', 완료 시각은 모르면 빼기", () => {
    const v = statusView(S({ state: "partial", finishedAt: null, startedAt: null, reasonKind: "restart", problems: [P("O", "리얼티인컴", 90, { missing: true, kind: "restart" })], done: 16 }), h.now)!;
    expect(v.small!.parts).toEqual(["이유: 서버가 도중에 다시 시작되어 끝까지 만들지 못했습니다"]);
  });

  it("모두 못 만듦: 둘째 줄 이유(한 가지일 때만) · 수동 생성 안내 · 막대 danger · 이름 없음", () => {
    const v = statusView(S({ state: "allFailed", done: 0, reasonKind: "busy", problems: [P("A", "가")] }), h.now)!;
    expect(v.tone).toBe("danger");
    expect(v.title).toBe("오전 브리핑을 하나도 만들지 못했습니다");
    expect(v.line).toBe("이유: AI 서비스가 잠시 붐볐습니다");
    expect(v.names).toEqual([]);
    expect(v.small).toEqual({ parts: [], note: "지금 만들려면 아래 '수동 생성'을 누르세요. 다음 브리핑(16:00)에도 새로 만듭니다." });
    expect(v.speech).toBe("브리핑 안내, 오전 브리핑을 하나도 만들지 못했습니다, 이유 AI 서비스가 잠시 붐볐습니다, 지금 만들려면 아래 수동 생성을 누르세요, 다음 브리핑 16시에도 새로 만듭니다");
    expect(statusView(S({ state: "allFailed", reasonKind: null }), h.now)!.line).toBeNull();
  });

  it("설정 문제(키·크레딧·권한): 고치기 전에는 다시 만들어도 실패 → '다음 브리핑에 새로 만듭니다'·'이름을 누르면 …' 약속 없이 관리자 확인", () => {
    const all = statusView(S({ state: "allFailed", done: 0, reasonKind: "setup", problems: [P("A", "가")] }), h.now)!;
    expect(all.line).toBe("이유: 서버 설정 문제로 만들지 못했습니다 (관리자 확인 필요)");
    expect(all.small).toEqual({ parts: [], note: "관리자가 설정을 고친 뒤 아래 '수동 생성'을 누르세요." });
    expect(all.speech).toBe("브리핑 안내, 오전 브리핑을 하나도 만들지 못했습니다, 이유 서버 설정 문제로 만들지 못했습니다 (관리자 확인 필요), 관리자가 설정을 고친 뒤 아래 수동 생성을 누르세요");
    const partSetup = S({ state: "partial", done: 15, reasonKind: "setup", problems: [P("TSLA", "테슬라", 701, { kind: "setup" }), P("PLTR", "팔란티어", 702, { kind: "setup" })] });
    expect(statusView(partSetup, h.now)!.small!.note).toBe("관리자가 설정을 고친 뒤 이름을 눌러 그 종목만 다시 만드세요.");
    expect(statusView({ ...partSetup, manualRun: false }, h.now)!.small!.note).toBe("관리자가 설정을 고친 뒤 아래 '수동 생성'을 누르세요.");
    for (const v of [all, statusView(partSetup, h.now)!, statusView({ ...partSetup, manualRun: false }, h.now)!]) {
      for (const text of viewTexts(v)) expect(text).not.toMatch(/새로 만듭니다|다시 만드는 버튼이 있습니다|지금 만들려면/);
    }
  });

  it("브리핑이 하나도 없어 빈 화면의 '지금 만들기'가 수동 생성을 맡으면(emptyGuide) 안내도 그 버튼을 가리킨다", () => {
    const missed = statusView(S({ state: "missed", finishedAt: null, startedAt: null }), h.now, { nowButton: true })!;
    expect(missed.small!.note).toBe("지금 만들려면 '지금 만들기'를 누르세요.");
    expect(missed.speech).toContain("지금 만들려면 지금 만들기를 누르세요");
    const all = statusView(S({ state: "allFailed", reasonKind: "busy" }), h.now, { nowButton: true })!;
    expect(all.small!.note).toBe("지금 만들려면 '지금 만들기'를 누르세요. 다음 브리핑(16:00)에도 새로 만듭니다.");
    expect(statusView(S({ state: "allFailed", reasonKind: "setup" }), h.now, { nowButton: true })!.small!.note).toBe("관리자가 설정을 고친 뒤 '지금 만들기'를 누르세요.");
    for (const v of [missed, all]) for (const text of viewTexts(v)) expect(text).not.toContain("수동 생성");
  });

  it("늦음 · 만드는 중 · 빠짐 · 모델 없음", () => {
    const late = statusView(S({ state: "late", late: true, finishedAt: iso("2026-09-28T09:12:00") }), h.now)!;
    expect([late.title, late.line, late.small?.note]).toEqual(["오전 브리핑이 평소보다 늦게 만들어졌습니다", "예정 08:30 → 09:12 완료", "숫자는 09:12 기준입니다."]);
    expect(late.speech).toBe("브리핑 안내, 오전 브리핑이 평소보다 늦게 만들어졌습니다, 예정 8시 30분, 9시 12분 완료, 숫자는 9시 12분 기준입니다");
    const slow = statusView(S({ state: "slow", total: 17, done: 9, finishedAt: null }), h.now)!;
    expect([slow.title, slow.line, slow.small]).toEqual(["오전 브리핑을 아직 만드는 중입니다", "예정 08:30 · 지금 17종목 중 9종목 끝남", null]);
    const missed = statusView(S({ state: "missed", finishedAt: null, startedAt: null }), h.now)!;
    expect([missed.title, missed.line, missed.small?.note]).toEqual(["오늘 오전 브리핑이 만들어지지 않았습니다", "예정 08:30 에 실행된 기록이 없습니다.", "지금 만들려면 아래 '수동 생성'을 누르세요."]);
    const off = statusView(S({ state: "llmOff", session: null }), h.now)!;
    expect(off.tone).toBe("danger");
    expect(off.title).toBe("브리핑 모델이 설정되지 않았습니다");
  });

  it("문제가 없으면(ok·none·못 받음) 아무것도 없음", () => {
    expect(statusView(S({ state: "ok" }), h.now)).toBeNull();
    expect(statusView(S({ state: "none", session: null }), h.now)).toBeNull();
    expect(statusView(null, h.now)).toBeNull();
    expect(statusView(undefined, h.now)).toBeNull();
  });

  it("모든 상태의 글: 권유·전망 표현 0건, 오류 원문·영어 문장 0건, '다시 만들어집니다' 약속 없음", () => {
    const states: BriefingStatus[] = [
      PARTIAL,
      { ...PARTIAL, manualRun: false },
      ...(["busy", "outage", "setup", "cutoff", "other", "restart"] as const).flatMap((k) => [S({ state: "partial", reasonKind: k, problems: [P("A", "가")] }), S({ state: "allFailed", reasonKind: k, problems: [P("A", "가")] })]),
      S({ state: "late", late: true, finishedAt: iso("2026-09-28T09:12:00") }),
      S({ state: "slow", done: 3 }),
      S({ state: "missed" }),
      S({ state: "llmOff" }),
    ];
    for (const s of states) {
      for (const text of [...viewTexts(statusView(s, h.now)!), ...viewTexts(statusView(s, h.now, { nowButton: true })!)]) {
        expect(text.match(BANNED) ?? [], text).toEqual([]);
        expect(text.match(FUTURE) ?? [], text).toEqual([]);
        expect(text.replace(/\bAI\b/g, ""), text).not.toMatch(RAW);
        expect(text).not.toMatch(/다시 만들어집니다|잠시 뒤/);
      }
    }
    for (const c of fixture.cases) {
      const b = { error: c.error, summary: `브리핑 생성 실패: ${c.error}`, createdAt: iso("2026-09-28T08:36:00") };
      for (const text of [failedLine(b), failedCardText(b), failedRunText(c.error, "테슬라")]) {
        expect(text.replace(/\bAI\b/g, ""), text).not.toMatch(RAW);
        expect(text.match(BANNED) ?? [], text).toEqual([]);
      }
    }
  });

  it("실패 브리핑 쉬운 말: 목록 줄 · 상세 카드 · 다시 만들기 결과", () => {
    expect(failedLine(FAILED)).toBe("만들지 못함 · AI 서비스가 잠시 붐빔");
    expect(failedCardText(FAILED)).toBe("이 브리핑을 만들지 못했습니다 · 이유: AI 서비스가 잠시 붐볐습니다 (08:36)");
    expect(failedRunText(`${RATE_LIMIT} (이전 브리핑은 그대로 둡니다)`, "테슬라")).toBe("테슬라: AI 서비스가 잠시 붐볐습니다 (이전 브리핑은 그대로 둡니다)");
    // 오류 글이 없으면 요약('브리핑 생성 실패: …')에서 읽는다
    expect(failedLine({ error: null, summary: "브리핑 생성 실패: config: API 키/자격 증명이 올바르지 않습니다 (401)" })).toBe("만들지 못함 · 서버 설정 문제 (관리자 확인 필요)");
  });
});

describe("안내 한 덩어리 (부품)", () => {
  it("카드 + 왼쪽 막대(warn) · 아이콘 · 첫 줄 굵게 · 이름 링크 44dp · 작은 글은 화면 읽기에서 숨김", () => {
    const onOpen = vi.fn();
    const r = render(<BriefingStatusBanner view={statusView(PARTIAL, h.now)!} onOpen={onOpen} />);
    const card = bannerOf(r)!;
    expect(flat(card).borderLeftColor).toBe(dark.warn);
    expect(ofType(r, "Ionicons")[0]!.props.name).toBe("information-circle-outline");
    expect(speechOf(card)!.props.accessibilityLabel).toMatch(/^브리핑 안내, 오전 브리핑 17종목 중 2종목을/);
    const links = nameLinks(card);
    expect(links.map((n) => [n.props.accessibilityRole, n.props.accessibilityLabel])).toEqual([
      ["link", "테슬라 오전 브리핑, 만들지 못함, 열기"],
      ["link", "팔란티어 오전 브리핑, 만들지 못함, 열기"],
    ]);
    // 보이는 칸은 촘촘하게(높이 28 — 짧은 이름 뒤가 벌어지지 않게), 누르는 곳은 hitSlop 으로 44×44 이상
    for (const l of links) {
      const name = PARTIAL.problems[links.indexOf(l)]!.name;
      expect(flat(l).minHeight).toBe(NAME_H);
      expect(flat(l).minWidth ?? 0).toBeLessThan(touch.min);
      expect(l.props.hitSlop).toEqual(nameSlop(name));
      expect(nameTarget(name).height).toBeGreaterThanOrEqual(touch.min);
      expect(nameTarget(name).width).toBeGreaterThanOrEqual(touch.min);
    }
    r.act(() => (links[1]!.props.onPress as () => void)());
    expect(onOpen).toHaveBeenCalledWith(PARTIAL.problems[1]);
    const hidden = all(card).filter((n) => n.props.importantForAccessibility === "no-hide-descendants").map(rawOf);
    expect(hidden).toContain("이유: AI 서비스가 잠시 붐볐습니다 ·08:39 완료이름을 누르면 그 종목만 다시 만드는 버튼이 있습니다.");
    // 글자를 줄이지 않는다 (130·200% 에서 줄바꿈 — numberOfLines 없음), 이름·작은 글은 묶음째 줄바꿈
    expect(ofType(r, "Text").every((n) => n.props.numberOfLines === undefined && n.props.adjustsFontSizeToFit === undefined)).toBe(true);
    expect(all(card).filter((n) => n.type === "View" && flat(n).flexWrap === "wrap")).toHaveLength(2);
  });

  it("짧은 이름('이튼'·'O')도 누르는 곳 44×44 · 좌우 넓힘은 이웃 이름과 겹치지 않게(10 이하) · 이름 사이는 고르게", () => {
    for (const name of ["이튼", "퀀티넘", "테슬라", "O", "MS", "SOXL", "마이크로소프트"]) {
      const t = nameTarget(name);
      expect(t.width, name).toBeGreaterThanOrEqual(touch.min);
      expect(t.height, name).toBeGreaterThanOrEqual(touch.min);
      const slop = nameSlop(name);
      expect(slop.left, name).toBeLessThanOrEqual(10);
      expect(slop.right, name).toBe(slop.left);
    }
    expect(nameSlop("마이크로소프트").left).toBe(0);
    const v = statusView({ ...PARTIAL, problems: [P("TSLA", "테슬라", 701), P("ETN", "이튼", 703), P("QNTM", "퀀티넘", 704)] }, h.now)!;
    const card = bannerOf(render(<BriefingStatusBanner view={v} onOpen={vi.fn()} />))!;
    const names = all(card).find((n) => n.type === "View" && flat(n).flexWrap === "wrap" && all(n).some((x) => x.type === "Pressable"))!;
    // 이름 줄: 간격 8 · 두 줄로 넘어가도 줄 사이 8 (44 칸이 빈 줄처럼 보이지 않게), '이름 ·' 묶음 안도 8
    expect([flat(names).columnGap, flat(names).rowGap]).toEqual([8, 8]);
    expect(kids(names).map((u) => flat(u).columnGap)).toEqual([8, 8, 8]);
  });

  it("모두 못 만듦은 막대 danger · 이름 없는 종목(briefingId 없음)은 누를 수 없음 · 2단은 role button", () => {
    const danger = render(<BriefingStatusBanner view={statusView(S({ state: "allFailed", reasonKind: "busy" }), h.now)!} onOpen={vi.fn()} />);
    expect(flat(bannerOf(danger)!).borderLeftColor).toBe(dark.danger);
    const v = statusView({ ...PARTIAL, problems: [P("TSLA", "테슬라", 701), P("NEW", "새종목", null, { missing: true })] }, h.now)!;
    const r = render(<BriefingStatusBanner view={v} onOpen={vi.fn()} role="button" />);
    expect(nameLinks(bannerOf(r)!).map((n) => n.props.accessibilityRole)).toEqual(["button"]);
    expect(r.text()).toContain("새종목");
  });
});

describe("꺼짐 (앱 기본): 지금 그대로", () => {
  it("예전 안내(오류 원문) · 상태를 부르지 않음 · 끔을 받은 것과 같은 트리 · 카드에 plainFail 없음", async () => {
    const r = await tab();
    expect(r.text()).toContain("최근 실행에서 2개 종목이 실패했습니다");
    expect(r.text()).toContain(RATE_LIMIT);
    expect(h.statusCalls).toBe(0);
    expect(ofType(r, "BriefingCard").some((c) => "plainFail" in c.props)).toBe(false);
    const base = JSON.stringify(r.tree);
    h.flags.briefingStatus = false;
    expect(JSON.stringify((await tab()).tree)).toBe(base);
  });
});

describe("켬: 접은 화면 475×751 · 폰 360×752", () => {
  beforeEach(() => {
    h.flags.briefingStatus = true;
  });

  it("새 안내가 예전 안내 자리에(맨 위 묶음 아래 · 보기 탭 위), 오류 원문 없음 · 이름을 누르면 그 실패 브리핑 상세", async () => {
    const r = await tab();
    expect(r.text()).not.toContain("최근 실행에서");
    expect(r.text()).not.toContain(RATE_LIMIT);
    const card = bannerOf(r)!;
    expect(rawOf(card)).toContain("오전 브리핑 17종목 중 2종목을 만들지 못했습니다");
    expect(rawOf(card)).not.toMatch(RAW);
    const screenKids = kids(ofType(r, "Screen")[0]!).map((n) => n.type);
    expect(screenKids.indexOf("Card")).toBeLessThan(screenKids.indexOf("Segmented"));
    r.act(() => (nameLinks(card)[0]!.props.onPress as () => void)());
    expect(h.push).toHaveBeenCalledWith("/briefings/701");
    // 실패 카드는 쉬운 말로 (속성 plainFail)
    expect(ofType(r, "BriefingCard").filter((c) => c.props.plainFail === true)).toHaveLength(3);
  });

  it("문제가 없으면 안 보임 · 받는 중이면 비움 · 못 받으면(404 = null · 연결 오류) 예전 안내", async () => {
    h.status = S({ state: "ok" });
    expect(bannerOf(await tab())).toBeNull();
    h.status = undefined;
    const loading = await tab();
    expect(bannerOf(loading)).toBeNull();
    expect(loading.text()).not.toContain("최근 실행에서");
    h.status = null;
    expect((await tab()).text()).toContain("최근 실행에서 2개 종목이 실패했습니다");
    h.status = undefined;
    h.statusError = true;
    const failed = (await tab()).text();
    expect(failed).toContain("최근 실행에서 2개 종목이 실패했습니다");
    // 켠 채 상태를 못 받아 예전 안내로 돌아와도 오류 원문 대신 쉬운 말 (아래 목록 줄과 같게)
    expect(failed).not.toContain(RATE_LIMIT);
    expect(failed).toContain("AI 서비스가 잠시 붐볐습니다");
  });

  it("브리핑이 하나도 없고 빈 화면의 '지금 만들기'만 있으면(emptyGuide) 빠짐 안내도 '지금 만들기'를 가리킨다", async () => {
    h.latest = LIST.map((i) => ({ ...i, latest: null }));
    h.status = S({ state: "missed", finishedAt: null, startedAt: null });
    const r = render(
      <UxFlagsContext.Provider value={{ ...UX_OFF, emptyGuide: true }}>
        <BriefingsScreen />
      </UxFlagsContext.Provider>,
    );
    await settle(r);
    const card = bannerOf(r)!;
    expect(rawOf(card)).toContain("지금 만들려면 '지금 만들기'를 누르세요.");
    expect(rawOf(card)).not.toContain("수동 생성");
    expect((ofType(r, "Empty")[0]!.props.action as React.ReactElement<{ title: string }>).props.title).toBe("지금 만들기");
    expect(ofType(r, "SectionTitle").some((n) => rawOf(n) === "수동 생성")).toBe(false);
    // emptyGuide 가 꺼져 있으면 '수동 생성' 카드가 있으므로 그대로
    const off = await tab();
    expect(rawOf(bannerOf(off)!)).toContain("아래 '수동 생성'을 누르세요");
  });

  it("360×752 · 글자 130%·200%: 같은 안내, 글을 자르지 않음", async () => {
    for (const fontScale of [1, 1.3, 2]) {
      h.win = { width: 360, height: 752, scale: 3, fontScale };
      forgetWindowClass();
      const r = await tab();
      const card = bannerOf(r)!;
      expect(rawOf(card)).toContain("테슬라");
      expect(all(card).filter((n) => n.type === "Text").every((n) => n.props.numberOfLines === undefined)).toBe(true);
    }
  });

  it.each([
    [true, "1개 실패\n테슬라: AI 서비스가 잠시 붐볐습니다"],
    [false, `1개 실패\n테슬라: ${RATE_LIMIT}`],
  ])("수동 생성 결과 창 (켬 %s): 실패 줄", async (on, line) => {
    h.flags.briefingStatus = on;
    const r = await tab();
    (ofType(r, "Button").find((b) => b.props.title === "오전 브리핑")!.props.onPress as () => void)();
    const buttons = h.alert.mock.calls[0]![2] as Array<{ text: string; onPress?: () => void }>;
    buttons.find((b) => b.text === "만들기")!.onPress!();
    const [, opts] = h.mutate.mock.calls[0]! as [unknown, { onSuccess: (r: unknown) => void }];
    opts.onSuccess({ results: [{ code: "005930", name: "삼성전자", status: "ok", error: null }, { code: "TSLA", name: "테슬라", status: "failed", error: RATE_LIMIT }] });
    expect(h.alert).toHaveBeenLastCalledWith("브리핑 생성 완료", `2개 중 1개 생성, ${line}`);
  });
});

describe("계정 A단계: 주인 아닌 계정", () => {
  it("늦음·실패 안내를 그리지 않고 상태도 묻지 않는다 (주인 브리핑 실행 상태 — 서버도 403) · 켬·끔 모두, 맨 위 차분한 안내만. 주인은 그대로", async () => {
    const { resetSessionForTests, saveSession } = await import("@/lib/session");
    const { MEMBER_NOTICE } = await import("@/lib/account");
    // 서버가 주인 아닌 계정에게 주는 모습: 개인 목록은 빈 값, /health 는 공유 모습(실행 기록 없음 — 모델 설정만)
    h.latest = [];
    h.health = { llmConfigured: false };
    await saveSession({ apiUrl: "https://prod.test", token: "gzs1_m", remember: true, user: { id: 7, loginId: "newbie", email: null, isOwner: false, usingInitialPassword: false } });
    try {
      for (const on of [true, false]) {
        h.flags = { accounts: true, briefingStatus: on };
        h.statusCalls = 0;
        const r = await tab();
        expect(bannerOf(r), `briefingStatus ${on}`).toBeNull();
        expect(r.text()).not.toContain("브리핑 모델이 설정되지 않았습니다");
        expect(r.text()).toContain(MEMBER_NOTICE);
        expect(h.statusCalls).toBe(0);
      }
      // 주인(세션 없음 — 계정 전과 같음)은 예전 안내 그대로
      resetSessionForTests();
      h.flags = { briefingStatus: false };
      expect((await tab()).text()).toContain("브리핑 모델이 설정되지 않았습니다");
    } finally {
      resetSessionForTests();
    }
  });
});

describe("켬: 넓은 창", () => {
  beforeEach(() => {
    h.flags.briefingStatus = true;
    h.flags.foldLayout = true;
  });

  it("2단 933×704: 왼쪽 목록 맨 위(스크롤 안 첫 줄), 이름을 누르면 새 화면 없이 오른쪽 칸에서 고름 (role button)", async () => {
    h.win = { width: 933, height: 704, scale: 2.625, fontScale: 1 };
    forgetWindowClass();
    const r = await tab();
    const scroll = ofType(r, "ScrollView")[0]!;
    const first = kids(scroll)[0]!;
    expect(flat(first).borderLeftWidth).toBe(3);
    const links = nameLinks(first);
    expect(links.map((n) => n.props.accessibilityRole)).toEqual(["button", "button"]);
    r.act(() => (links[1]!.props.onPress as () => void)());
    expect(h.push).not.toHaveBeenCalled();
    expect(pick.currentPick().pick).toEqual({ kind: "stock", id: 702, code: "PLTR" });
  });

  it("카드 격자 704×933: 목록 위, 이름을 누르면 전체 화면 상세", async () => {
    h.win = { width: 704, height: 933, scale: 2.625, fontScale: 1 };
    forgetWindowClass();
    const r = await tab();
    const card = bannerOf(r)!;
    const screen = ofType(r, "Screen")[0]!;
    const order = kids(screen);
    const at = order.indexOf(card);
    expect(at).toBeGreaterThan(-1);
    expect(order.findIndex((n) => n.type === "View" && flat(n).flexWrap === "wrap" && flat(n).flexDirection === "row" && n !== card)).toBeGreaterThan(at);
    r.act(() => (nameLinks(card)[0]!.props.onPress as () => void)());
    expect(h.push).toHaveBeenCalledWith("/briefings/701");
  });
});

describe("실패 브리핑 글 (카드 · 목록 줄 · 격자 칸 · 상세)", () => {
  it("폰 카드: 켜면 '만들지 못함 · AI 서비스가 잠시 붐빔'(화면 읽기는 기호 없이), 끄면 원문", () => {
    const on = render(<BriefingCard briefing={FAILED} mode="summary" plainFail />);
    expect(on.text()).toContain("만들지 못함 · AI 서비스가 잠시 붐빔");
    expect(ofType(on, "Text").find((n) => rawOf(n).startsWith("만들지 못함"))!.props.accessibilityLabel).toBe("만들지 못함, 이유 AI 서비스가 잠시 붐빔");
    expect(ofType(render(<BriefingCard briefing={FAILED} mode="summary" />), "Text").some((n) => "accessibilityLabel" in n.props)).toBe(false);
    const off = render(<BriefingCard briefing={FAILED} mode="summary" />).text();
    expect(off).toContain(RATE_LIMIT);
    expect(off).not.toContain("만들지 못함");
  });

  it("2단 줄·격자 칸: 글과 화면 읽기가 쉬운 말", () => {
    const row = render(<BriefingRow briefing={FAILED} name="테슬라" unread={false} selected={false} onPress={vi.fn()} plainFail />);
    expect(row.text()).toContain("만들지 못함 · AI 서비스가 잠시 붐빔");
    // 화면 읽기: '생성 실패'와 '만들지 못함'이 겹치지 않고 기호 없이 '이유 …'
    const rowSpeech = String(ofType(row, "Pressable")[0]!.props.accessibilityLabel);
    expect(rowSpeech).toContain("생성 실패, 이유 AI 서비스가 잠시 붐빔");
    expect(rowSpeech).not.toMatch(/만들지 못함|·/);
    const tile = render(<BriefingTile briefing={FAILED} name="테슬라" unread={false} selected={false} onPress={vi.fn()} mode="summary" width={320} plainFail />);
    expect(tile.text()).toContain("만들지 못함 · AI 서비스가 잠시 붐빔");
    expect(tile.text()).not.toContain("api:");
    const tileSpeech = String(ofType(tile, "Pressable")[0]!.props.accessibilityLabel);
    expect(tileSpeech).toContain("생성 실패, 이유 AI 서비스가 잠시 붐빔");
    expect(tileSpeech).not.toMatch(/만들지 못함|·/);
    // 꺼지면 화면 읽기도 지금 그대로 (원문)
    expect(String(ofType(render(<BriefingRow briefing={FAILED} name="테슬라" unread={false} selected={false} onPress={vi.fn()} />), "Pressable")[0]!.props.accessibilityLabel)).toContain(RATE_LIMIT);
    expect(render(<BriefingRow briefing={FAILED} name="테슬라" unread={false} selected={false} onPress={vi.fn()} />).text()).toContain(RATE_LIMIT);
  });

  it("상세 실패 카드: 켜면 '이 브리핑을 만들지 못했습니다 · 이유: … (08:36)', 끄면 원문", () => {
    h.flags.briefingStatus = true;
    expect(render(<BriefingBody id={701} layout="stack" />).text()).toContain("이 브리핑을 만들지 못했습니다 · 이유: AI 서비스가 잠시 붐볐습니다 (08:36)");
    h.flags.briefingStatus = false;
    const off = render(<BriefingBody id={701} layout="stack" />).text();
    expect(off).toContain(RATE_LIMIT);
    expect(off).not.toContain("이 브리핑을 만들지 못했습니다");
    h.flags.briefingStatus = true;
    expect(render(<BriefingBody id={701} layout="pane" />).text()).toContain("이 브리핑을 만들지 못했습니다");
  });

  it("실패 브리핑 상세: 켜면 '이 종목 다시 만들기'가 실패 카드 바로 아래(근거 자료 위) — 폰 첫 화면에 보이게, 끄면 지금 자리(근거 자료 아래)", () => {
    h.detail = { ...FAILED, data: { news: [], disclosures: [] } } as unknown as BriefingWithData;
    const REGEN = "이 종목 오늘 오전 브리핑 다시 만들기";
    const order = (layout: "stack" | "pane") => {
      const r = render(<BriefingBody id={701} layout={layout} />);
      const top = kids(ofType(r, "Screen")[0]!);
      const at = (pred: (n: HostNode) => boolean) => top.findIndex((n) => all(n).some(pred));
      return {
        failed: at((n) => n.type === "Text" && /이 브리핑을 만들지 못했습니다|사용량 제한/.test(rawOf(n))),
        regen: at((n) => n.type === "Button" && n.props.title === REGEN),
        sources: at((n) => n.type === "BriefingSources"),
      };
    };
    for (const layout of ["stack", "pane"] as const) {
      h.flags.briefingStatus = true;
      const on = order(layout);
      expect(on.regen, layout).toBeGreaterThan(-1);
      expect(on.regen, layout).toBeLessThan(on.sources);
      if (layout === "stack") expect(on.regen).toBe(on.failed + 1);
      h.flags.briefingStatus = false;
      const off = order(layout);
      expect(off.regen, layout).toBeGreaterThan(off.sources);
    }
    // 성공 브리핑은 켜도 지금 자리 그대로
    h.flags.briefingStatus = true;
    h.detail = { ...B(700, "005930", "삼성전자"), data: { news: [], disclosures: [] } } as unknown as BriefingWithData;
    const ok = order("stack");
    expect(ok.regen).toBeGreaterThan(ok.sources);
  });
});
