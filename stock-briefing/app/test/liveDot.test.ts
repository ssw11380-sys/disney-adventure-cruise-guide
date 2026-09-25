import { describe, expect, it } from "vitest";
import type { Quote, QuoteSession } from "@/api/types";
import { capToBoundary, feedHealthy, liveCounts, marketSessions, nextBoundary, quoteLive, quotesOf, recheckIn, sessionNote, sessionOpen, sessionStatus } from "@/lib/liveDot";
import { applyTick } from "@/lib/liveTick";
import { holding, quote } from "./helpers";

/**
 * 초록 점(실시간)의 뜻: "이 종목 가격이 지금 열린 거래 시간에 실시간으로 갱신되고 있다".
 * 서버가 종목마다 세션(session)과 실시간 여부(realtime)를 주고, 앱은 자기 연결 상태와 세션 경계를 더해 점을 켠다.
 */

const NOW = Date.parse("2026-09-25T09:59:27+09:00"); // 뉴욕 9/24(목) 20:59 — 미국 주간거래, 한국 추석 휴장

const US_OVERNIGHT: QuoteSession = { market: "US", phase: "overnight", label: "미국 주간거래", open: true, eligible: true, until: "2026-09-25T08:00:00Z" };
const KR_HOLIDAY: QuoteSession = { market: "KR", phase: "holiday", label: "한국 휴장", open: false, eligible: null, until: "2026-09-27T23:00:00Z" };
const OK = { offline: false, stale: false, asOf: NOW - 2_000 };

describe("quoteLive: 줄의 초록 점", () => {
  const q = (extra: Partial<Quote>) => quote("VRT", 100, { currency: "USD", ...extra });

  it("새 서버: realtime 이고 앱이 값을 제때 받고 있고 세션이 아직 안 끝났을 때만", () => {
    expect(quoteLive(q({ realtime: true, session: US_OVERNIGHT }), NOW, true)).toBe(true);
    expect(quoteLive(q({ realtime: true, session: US_OVERNIGHT }), NOW, false)).toBe(false); // 앱 연결 끊김·지연
    expect(quoteLive(q({ realtime: false, session: US_OVERNIGHT, live: true }), NOW, true)).toBe(false); // 체결이 붙었어도 서버가 아니라면 아님
    expect(quoteLive(q({ realtime: true, session: US_OVERNIGHT }), Date.parse("2026-09-25T08:00:00Z"), true)).toBe(false); // 주간거래 끝(뉴욕 04:00)
  });

  it("예전 서버(realtime 없음)는 예전처럼 live 로 — 새 앱 + 예전 서버도 지금보다 나빠지지 않게", () => {
    expect(quoteLive(q({ live: true }), NOW, true)).toBe(true);
    expect(quoteLive(q({}), NOW, true)).toBe(false);
    expect(quoteLive(null, NOW, true)).toBe(false);
  });

  it("체결을 덮어써도 세션·실시간 값은 그대로 따라간다 (체결은 가격만 바꾼다)", () => {
    const base = q({ realtime: true, session: US_OVERNIGHT, prevClose: 99, asOf: "2026-09-25T09:58:00+09:00" });
    const next = applyTick(base, { code: "VRT", price: 101, volume: 1, timestamp: "2026-09-25T09:59:00+09:00", source: "toss-openapi" })!;
    expect(next.price).toBe(101);
    expect(next).toMatchObject({ realtime: true, session: US_OVERNIGHT });
  });
});

describe("feedHealthy: 앱이 값을 제때 받고 있는지", () => {
  it("체결 스트림이 붙어 있으면(조용한 세션이어도 ping 으로 살아 있음) 받는 중", () => expect(feedHealthy(true, { ...OK, stale: true })).toBe(true));
  it("스트림이 없으면 폴링 값이 15초 안일 때만", () => {
    expect(feedHealthy(false, OK)).toBe(true);
    expect(feedHealthy(false, { ...OK, stale: true })).toBe(false);
  });
  it("오프라인(요청 실패)이면 스트림이 붙어 있어도 아님", () => expect(feedHealthy(true, { ...OK, offline: true })).toBe(false));
});

describe("잔고 상태 줄: 시장별 세션", () => {
  it("목록에 있는 시장만, 열린 시장 먼저", () => {
    const list = [quote("035420", 1, { session: KR_HOLIDAY }), quote("VRT", 1, { session: US_OVERNIGHT }), null];
    expect(marketSessions(list, NOW).map((s) => s.label)).toEqual(["미국 주간거래", "한국 휴장"]);
    expect(marketSessions([quote("035420", 1, { session: KR_HOLIDAY })], NOW).map((s) => s.label)).toEqual(["한국 휴장"]);
    expect(marketSessions([quote("035420", 1)], NOW)).toEqual([]); // 예전 서버
  });

  it("문구: 세션 → 실시간 N종목 / 지연 / 연결 끊김 / 실시간 종목 없음, 아무 시장도 열려 있지 않으면 세션만", () => {
    const sessions = [
      { market: "US" as const, label: "미국 주간거래", open: true },
      { market: "KR" as const, label: "한국 휴장", open: false },
    ];
    const ok = { sessions, liveCount: 9, eligibleCount: 9, feedOk: true, offline: false };
    expect(sessionStatus(ok)).toEqual({ text: "미국 주간거래 · 한국 휴장 · 실시간 9종목", tone: "live" });
    expect(sessionStatus({ ...ok, offline: true })).toEqual({ text: "미국 주간거래 · 한국 휴장 · 연결 끊김", tone: "offline" });
    expect(sessionStatus({ ...ok, feedOk: false, liveCount: 0 })).toEqual({ text: "미국 주간거래 · 한국 휴장 · 지연", tone: "delayed" });
    expect(sessionStatus({ ...ok, liveCount: 0 })).toEqual({ text: "미국 주간거래 · 한국 휴장 · 지연", tone: "delayed" }); // 거래 대상인데 서버가 못 받는 중
    expect(sessionStatus({ ...ok, liveCount: 0, eligibleCount: 0 })).toEqual({ text: "미국 주간거래 · 한국 휴장 · 실시간 종목 없음", tone: "closed" });
    const closed = [{ market: "KR" as const, label: "한국 장 마감", open: false }];
    expect(sessionStatus({ ...ok, sessions: closed, liveCount: 0 })).toEqual({ text: "한국 장 마감", tone: "closed" });
  });

  it("NXT 애프터마켓에 NXT 비대상 종목이 섞이면 실시간 수가 한국 보유 수보다 작다", () => {
    const after: QuoteSession = { market: "KR", phase: "nxt_after", label: "한국 NXT 애프터마켓", open: true, eligible: true, until: "2026-09-22T07:00:00Z" };
    const t = Date.parse("2026-09-22T15:45:00+09:00");
    const list = [
      quote("035420", 1, { session: after, realtime: true }),
      quote("005930", 1, { session: after, realtime: true }),
      quote("900340", 1, { session: { ...after, eligible: false }, realtime: false }),
    ];
    const live = list.filter((q) => quoteLive(q, t, true)).length;
    expect(live).toBe(2);
    expect(sessionStatus({ sessions: marketSessions(list, t), liveCount: live, eligibleCount: 2, feedOk: true, offline: false }).text).toBe("한국 NXT 애프터마켓 · 실시간 2종목");
  });

  it("애프터마켓(16:00~20:00): 대상인지 모르는 종목(한국거래소만 거래)은 체결이 있어야 켜지고, 점이 없어도 '지연'으로 세지 않는다", () => {
    const after: QuoteSession = { market: "KR", phase: "after", label: "한국 애프터마켓", open: true, eligible: true, until: "2026-09-22T11:00:00Z" };
    const t = Date.parse("2026-09-22T16:30:00+09:00");
    const list = [
      quote("035420", 1, { session: after, realtime: true }), // NXT 종목
      quote("000660", 1, { session: { ...after, eligible: null }, realtime: true }), // 16:10 체결 있음
      quote("900340", 1, { session: { ...after, eligible: null }, realtime: false }), // 체결 없음 — 대상인지 모름
      quote("069500", 1, { session: { ...after, eligible: false }, realtime: false }), // ETF
    ];
    const c = liveCounts(list, t, true);
    expect(c).toEqual({ live: 2, eligible: 1 });
    expect(sessionStatus({ sessions: marketSessions(list, t), liveCount: c.live, eligibleCount: c.eligible, feedOk: true, offline: false }).text).toBe("한국 애프터마켓 · 실시간 2종목");
    // 대상인지 모르는 종목만 있고 아직 체결이 없으면: 지연이 아니라 "실시간 종목 없음"(회색)
    const unknownOnly = [list[2]!, list[3]!];
    const u = liveCounts(unknownOnly, t, true);
    expect(sessionStatus({ sessions: marketSessions(unknownOnly, t), liveCount: u.live, eligibleCount: u.eligible, feedOk: true, offline: false })).toEqual({ text: "한국 애프터마켓 · 실시간 종목 없음", tone: "closed" });
  });
});

describe("갱신 주기: 세션이 열린 시장이 있으면 짧게, 세션 경계에서 한 번 더", () => {
  it("열린 세션(거래 대상)이 있는지. 세션 정보가 없으면 null(예전 규칙)", () => {
    expect(sessionOpen([quote("VRT", 1, { session: US_OVERNIGHT }), quote("035420", 1, { session: KR_HOLIDAY })])).toBe(true);
    expect(sessionOpen([quote("035420", 1, { session: KR_HOLIDAY })])).toBe(false);
    expect(sessionOpen([quote("VRT", 1, { session: { ...US_OVERNIGHT, eligible: false } })])).toBe(false); // 주간거래 미지원만
    expect(sessionOpen([quote("VRT", 1)])).toBeNull();
  });

  it("가장 가까운 경계 + 1초까지만 기다린다 (경계가 지났거나 멀면 원래 주기)", () => {
    const list = [quote("VRT", 1, { session: US_OVERNIGHT }), quote("035420", 1, { session: KR_HOLIDAY })];
    const b = nextBoundary(list, NOW);
    expect(b).toBe(Date.parse("2026-09-25T08:00:00Z"));
    expect(capToBoundary(60_000, b, Date.parse("2026-09-25T07:59:50Z"))).toBe(11_000);
    expect(capToBoundary(3_000, b, Date.parse("2026-09-25T07:59:50Z"))).toBe(3_000);
    expect(capToBoundary(60_000, b, Date.parse("2026-09-25T08:00:02Z"))).toBe(3_000); // 방금 지났는데 받은 값이 아직 지난 세션 것 → 3초 뒤 한 번 더
    expect(capToBoundary(60_000, b, Date.parse("2026-09-25T08:00:30Z"))).toBe(60_000); // 기기 시계가 한참 앞서도 계속 두드리지 않는다
    expect(nextBoundary(list, Date.parse("2026-09-25T08:00:02Z"))).toBe(b);
    expect(capToBoundary(60_000, null, NOW)).toBe(60_000);
  });

  it("목록·상세 응답 모두에서 시세를 꺼낸다 (refetchInterval 이 받은 값)", () => {
    const q = quote("VRT", 1, { session: US_OVERNIGHT });
    expect(quotesOf([holding("VRT", q, 1, 1), holding("X", null, null, null)])).toEqual([q, null]);
    expect(quotesOf({ quote: q })).toEqual([q]);
    expect(quotesOf(undefined)).toEqual([]);
  });
});

describe("recheckIn: 화면이 시각을 새로 읽을 때 (몇 초마다 화면 전체를 다시 그리지 않게)", () => {
  const list = [quote("VRT", 1, { session: US_OVERNIGHT })];
  const B = Date.parse(US_OVERNIGHT.until!);
  it("받은 값이 15초가 되는 때와 세션 경계 중 가까운 때", () => {
    expect(recheckIn(NOW, NOW, NOW - 2_000, list, 15_000)).toBe(13_001);
    expect(recheckIn(B - 5_000, B - 5_000, B - 1_000, list, 15_000)).toBe(5_000); // 경계가 더 가깝다
  });
  it("마지막으로 읽은 뒤 이미 지났으면 바로(0), 한 번 읽고 나면 다시 부르지 않는다", () => {
    expect(recheckIn(B - 3_000, B + 200, B + 100, list, 15_000)).toBe(0);
    expect(recheckIn(B + 200, B + 200, B + 100, list, 15_000)).toBe(14_901); // 다음은 받은 값이 15초가 되는 때

  });
  it("오래전에 받은 값(기기에 저장해 둔 잔고)은 이미 지연이라 다시 읽을 필요 없음", () => {
    expect(recheckIn(NOW, NOW, NOW - 3_600_000, [], 15_000)).toBeNull();
  });
});

describe("liveCounts: 점이 켜진 수와 열린 세션의 거래 대상으로 확인된 수", () => {
  it("주간거래 미지원·대상인지 모름·닫힌 시장은 대상에서 뺀다", () => {
    const list = [
      quote("VRT", 1, { session: US_OVERNIGHT, realtime: true }),
      quote("X", 1, { session: { ...US_OVERNIGHT, eligible: false }, realtime: false }),
      // 모름(토스 정보를 못 받음) → 세지 않는다: 이 세션 체결이 없어 점이 없는 것이지 지연이 아니다
      quote("Y", 1, { session: { ...US_OVERNIGHT, eligible: null }, realtime: false }),
      quote("035420", 1, { session: KR_HOLIDAY, realtime: false }),
    ];
    expect(liveCounts(list, NOW, true)).toEqual({ live: 1, eligible: 1 });
    expect(liveCounts(list, NOW, false)).toEqual({ live: 0, eligible: 1 });
  });

  it("모든 종목의 자격을 모르고 아직 체결이 없으면(주간거래가 막 시작) 상태 줄은 '지연'이 아니다", () => {
    const unknown = [quote("VRT", 1, { session: { ...US_OVERNIGHT, eligible: null }, realtime: false }), quote("035420", 1, { session: KR_HOLIDAY })];
    const c = liveCounts(unknown, NOW, true);
    expect(sessionStatus({ sessions: marketSessions(unknown, NOW), liveCount: c.live, eligibleCount: c.eligible, feedOk: true, offline: false })).toEqual({ text: "미국 주간거래 · 한국 휴장 · 실시간 종목 없음", tone: "closed" });
  });
});

describe("상세 화면: 점이 없을 때 까닭", () => {
  it("주간거래 미지원·NXT 비대상·거래정지·닫힌 세션", () => {
    expect(sessionNote(quote("X", 1, { session: { ...US_OVERNIGHT, eligible: false } }))).toBe("주간거래 미지원 종목");
    const nxt: QuoteSession = { market: "KR", phase: "nxt_pre", label: "한국 NXT 프리마켓", open: true, eligible: false, until: null };
    expect(sessionNote(quote("900340", 1, { session: nxt }))).toBe("NXT 거래 대상 아님 · 09:00 정규장부터 갱신");
    // 15:40~16:00: 16:00 한국거래소 애프터마켓에서 거래될 수도 있어 다음 갱신 시각을 약속하지 않는다
    expect(sessionNote(quote("900340", 1, { session: { ...nxt, phase: "nxt_after", label: "한국 NXT 애프터마켓" } }))).toBe("NXT 거래 대상 아님");
    const after: QuoteSession = { market: "KR", phase: "after", label: "한국 애프터마켓", open: true, eligible: false, until: null };
    expect(sessionNote(quote("069500", 1, { session: after }))).toBe("애프터마켓 거래 대상 아님"); // ETF·ETN
    expect(sessionNote(quote("900340", 1, { session: { ...after, eligible: null } }))).toBeNull(); // 대상인지 모름 — 까닭을 지어내지 않는다
    expect(sessionNote(quote("900340", 1, { session: { ...nxt, phase: "regular", label: "한국 정규장", halted: true } }))).toBe("거래정지");
    expect(sessionNote(quote("035420", 1, { session: KR_HOLIDAY }))).toBe("한국 휴장");
    expect(sessionNote(quote("VRT", 1, { session: US_OVERNIGHT }))).toBeNull();
    expect(sessionNote(quote("VRT", 1))).toBeNull(); // 예전 서버
  });
});

describe("보고된 장면 (2026-09-25 09:59 KST): 미국 주간거래 중인 보유 9종목 모두 초록 점, NAVER 는 휴장", () => {
  const US = ["버티브 홀딩스", "퀀티넘", "암페놀", "제너럴 다이내믹스", "윙입푸드(ADR)", "이튼", "QQQI", "RGTX", "RTX"];
  // 새 서버가 주는 값: 체결이 있었든 없든 주간거래 지원 종목은 realtime, 예전 live 는 가격이 달라진 두 종목에만
  const list = [
    ...US.map((name, i) => holding(`US${i}`, quote(`US${i}`, 100, { currency: "USD", session: US_OVERNIGHT, realtime: true, live: i < 2 ? true : undefined }), 1, 90, undefined, name)),
    holding("035420", quote("035420", 250_000, { session: KR_HOLIDAY, realtime: false }), 1, 200_000, undefined, "NAVER"),
  ];

  it("줄마다 점: 미국 9종목 모두 켜지고 NAVER 는 꺼진다", () => {
    const on = list.filter((s) => quoteLive(s.quote, NOW, true)).map((s) => s.name);
    expect(on).toEqual(US);
  });

  it("상태 줄: '미국 주간거래 · 한국 휴장 · 실시간 9종목'", () => {
    const quotes = list.map((s) => s.quote);
    const liveCount = quotes.filter((q) => quoteLive(q, NOW, true)).length;
    const s = sessionStatus({ sessions: marketSessions(quotes, NOW), liveCount, eligibleCount: 9, feedOk: true, offline: false });
    expect(s).toEqual({ text: "미국 주간거래 · 한국 휴장 · 실시간 9종목", tone: "live" });
  });
});
