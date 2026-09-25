import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { MarketStatus, QuoteSession } from "@/api/types";
import { liveCounts, marketChip, marketSessions, sessionStatus, widgetChip, type MarketChip } from "@/lib/liveDot";
import { currentMarket, shouldSkipFetch } from "@/widgets/payload";
import { quote } from "./helpers";

/**
 * 위젯 장 상태 칩: 위젯이 스스로 받은 값(서버 /api/widget?sessions=1 — widgetPayload.marketChip)과 앱이 위젯에 바로 넘기는 값
 * (components/WidgetBridge — lib/liveDot widgetChip)이 같아야 한다. 다르면 앱·위젯이 번갈아 그릴 때마다 칩이
 * "미국 주간거래" ↔ "한국 휴장"으로 바뀐다 (2026-09-25 09:59 추석 · 미국 주간거래).
 * 서버가 만든 공용 픽스처(stock-briefing/shared/fixtures/marketChip.json)로 세션 표 전체를 묶고, 잔고 상태 줄 앞머리도 같은 세션을 말하는지 본다.
 */
interface Case {
  name: string;
  now: string;
  status: MarketStatus;
  holdings: { code: string; session: QuoteSession | null }[];
  chip: MarketChip;
  head: string;
}
const fixture = JSON.parse(readFileSync(new URL("../../shared/fixtures/marketChip.json", import.meta.url), "utf8")) as { cases: Case[] };

/** 토스 달력 문구 (세션 이름이 아닌 것) */
const CALENDAR_LABELS = new Set(["실시간", "한국 장중", "미국 장중", "휴장", "한국 휴장", "장 마감"]);

const stocksOf = (c: Case) => c.holdings.map((h) => ({ quote: quote(h.code, 1, h.session ? { session: h.session } : {}) }));

describe("위젯 칩: 앱(WidgetBridge) = 서버(/api/widget) (공용 픽스처)", () => {
  it("세션 표가 충분하다 (미국 주간거래·프리마켓·애프터마켓 포함)", () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(20);
    const labels = new Set(fixture.cases.map((c) => c.chip.label));
    for (const l of ["미국 주간거래", "미국 프리마켓", "미국 애프터마켓", "한국 장중", "미국 장중", "휴장", "한국 휴장", "장 마감"]) expect(labels).toContain(l);
  });

  for (const c of fixture.cases) {
    it(`같은 칩: ${c.name}`, () => {
      const now = Date.parse(c.now);
      expect(widgetChip(c.status, stocksOf(c), now)).toStrictEqual(c.chip);
      expect(marketChip(c.status, c.holdings.map((h) => h.session), now)).toStrictEqual(c.chip);
    });
  }

  it("장 상태를 모르면 칩 없음", () => expect(widgetChip(undefined, [], Date.parse("2026-09-25T00:59:27Z"))).toBeNull());
});

describe("잔고 상태 줄 = 위젯 칩 (같은 세션 고르기)", () => {
  for (const c of fixture.cases) {
    it(`상태 줄 앞머리: ${c.name}`, () => {
      const now = Date.parse(c.now);
      const quotes = stocksOf(c).map((s) => s.quote);
      const sessions = marketSessions(quotes, now);
      expect(sessions.map((s) => s.label).join(" · ")).toBe(c.head);
      // 칩이 세션 이름이면 상태 줄 맨 앞 세션과 같은 말 (상태 줄 글자도 그 이름으로 시작)
      if (!CALENDAR_LABELS.has(c.chip.label)) {
        expect(sessions[0]?.label).toBe(c.chip.label);
        const counts = liveCounts(quotes, now, true);
        expect(sessionStatus({ sessions, liveCount: counts.live, eligibleCount: counts.eligible, feedOk: true, offline: false }).text.startsWith(c.chip.label)).toBe(true);
      }
      // 달력으로 두 시장이 닫혀 있는데 상태 줄에 열린 세션(경계 전)이 있으면 칩은 그 이름
      const openNow = c.holdings.map((h) => h.session).find((s) => s?.open && !(s.until && now >= Date.parse(s.until)));
      if (!c.status.KR.isOpen && !c.status.US.isOpen && openNow) expect(c.chip.label).toBe(openNow.label);
    });
  }
});

describe("다음 바뀌는 시각: 아직 열리지 않은 세션의 시작도 넣는다 (2027-03-01 삼일절 · 검증 지적)", () => {
  // 한국 삼일절 휴장 · 뉴욕 일요일 19:29(EST). 토스 달력은 둘 다 닫힘, 미국 주간거래는 10:00 KST(01:00Z)에 시작
  const status = {
    now: "2027-03-01T00:29:00.000Z",
    KR: { market: "KR", isTradingDay: false, isOpen: false, opensAt: "2027-03-01T23:00:00.000Z", closesAt: null, lastClose: "2027-02-26T11:00:00.000Z", source: "toss" },
    US: { market: "US", isTradingDay: false, isOpen: false, opensAt: "2027-03-01T14:30:00.000Z", closesAt: null, lastClose: "2027-02-26T21:00:00.000Z", source: "toss" },
  } as MarketStatus;
  const kr: QuoteSession = { market: "KR", phase: "holiday", label: "한국 휴장", open: false, eligible: null, until: "2027-03-01T23:00:00.000Z" };
  const us: QuoteSession = { market: "US", phase: "holiday", label: "미국 휴장", open: false, eligible: null, until: "2027-03-01T01:00:00.000Z" };
  const at = Date.parse(status.now);

  it("09:29 에 두 시장이 닫힌 채 그린 칩도 10:00 주간거래 시작에 감추고, 휴장 중 건너뛰던 갱신을 다시 한다", () => {
    const chip = marketChip(status, [kr, us], at);
    expect(chip.label).toBe("휴장");
    expect(chip.nextChangeAt).toBe("2027-03-01T01:00:00.000Z"); // 예전: 14:30Z(23:30 KST 정규장)까지 "휴장"
    const at1005 = Date.parse("2027-03-01T01:05:00.000Z");
    expect(currentMarket(chip, at1005)).toBeNull();
    expect(shouldSkipFetch({ at, market: chip }, at1005)).toBe(false);
    // 앱이 바로 넘기는 칩도 같다
    expect(widgetChip(status, [{ quote: quote("005930", 1, { session: kr }) }, { quote: quote("VRT", 1, { currency: "USD", session: us }) }], at)).toStrictEqual(chip);
  });

  it("보유 종목 세션이 없으면(예전 서버·예전 앱이 물을 때) 달력만 — 예전 값 그대로", () => {
    expect(marketChip(status, [], at)).toStrictEqual({ label: "휴장", open: false, kr: false, us: false, nextChangeAt: "2027-03-01T14:30:00.000Z" });
  });
});

describe("다듬은 잔고 위젯 칩의 시장별 문구 (markets, widgetPolish)", () => {
  const c = fixture.cases.find((x) => x.name === "추석 09:59 · 미국 주간거래 · 한국 휴장")!;

  it("달력으로 열린 시장은 '한국 장중'·'미국 장중', 닫힌 시장은 그 시장 세션 이름 (앱 = 서버, 공용 픽스처)", () => {
    expect(widgetChip(c.status, stocksOf(c), Date.parse(c.now))!.markets).toEqual([
      { market: "US", label: "미국 주간거래" },
      { market: "KR", label: "한국 휴장" },
    ]);
    const krOpen = fixture.cases.find((x) => x.name === "평일 10:00 · 한국 정규장 · 미국 주간거래")!;
    const chip = widgetChip(krOpen.status, stocksOf(krOpen), Date.parse(krOpen.now))!;
    expect(chip.markets).toEqual([
      { market: "KR", label: "한국 장중" },
      { market: "US", label: "미국 주간거래" },
    ]);
    // 미국 주간거래가 끝나는 17:00 에 칩(미국 쪽 문구)이 바뀌므로 그때 감추고 다시 받는다
    expect(chip.nextChangeAt).toBe("2026-09-22T08:00:00.000Z");
  });

  it("오프라인·옛 값: 세션 경계가 지났으면 끝난 세션 이름을 지금 것처럼 넣지 않는다 (앱이 넘기는 칩도)", () => {
    // 09:59 에 받은 잔고(주간거래 세션)로 17:30 에 칩을 만든다 — 연결이 끊겨 잔고를 다시 받지 못한 경우
    const later = Date.parse("2026-09-25T08:30:00.000Z");
    const chip = widgetChip({ ...c.status, now: new Date(later).toISOString() }, stocksOf(c), later)!;
    expect(chip.label).not.toBe("미국 주간거래");
    expect(chip.markets).toEqual([{ market: "KR", label: "한국 휴장" }]);
    expect(chip.markets!.some((m) => m.label === "미국 주간거래")).toBe(false);
  });

  it("세션을 모르면(예전 서버·보유 없음) markets 가 없다 → 위젯은 예전 칩 한 개", () => {
    const none = fixture.cases.find((x) => x.name === "추석 09:59 · 예전 서버 (세션 없음)")!;
    expect(widgetChip(none.status, stocksOf(none), Date.parse(none.now))).not.toHaveProperty("markets");
  });
});

describe("추석 09:59 (검증 지적 재현)", () => {
  const c = fixture.cases.find((x) => x.name.startsWith("추석 09:59 · 미국 주간거래"))!;
  it("앱이 넘기는 칩도 '미국 주간거래', 세션이 끝나는 뉴욕 04:00 에 칩을 감춘다", () => {
    const chip = widgetChip(c.status, stocksOf(c), Date.parse(c.now))!;
    expect(chip).toMatchObject({ label: "미국 주간거래", open: false, nextChangeAt: "2026-09-25T08:00:00.000Z" });
    expect(marketSessions(stocksOf(c).map((s) => s.quote), Date.parse(c.now)).map((s) => s.label).join(" · ")).toBe("미국 주간거래 · 한국 휴장");
  });
});
