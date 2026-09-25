import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { MarketStatus, QuoteSession } from "@/api/types";
import { liveCounts, marketChip, marketSessions, sessionStatus, widgetChip, type MarketChip } from "@/lib/liveDot";
import { quote } from "./helpers";

/**
 * 위젯 장 상태 칩: 위젯이 스스로 받은 값(서버 /api/widget — widgetPayload.marketChip)과 앱이 위젯에 바로 넘기는 값
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

describe("추석 09:59 (검증 지적 재현)", () => {
  const c = fixture.cases.find((x) => x.name.startsWith("추석 09:59 · 미국 주간거래"))!;
  it("앱이 넘기는 칩도 '미국 주간거래', 세션이 끝나는 뉴욕 04:00 에 칩을 감춘다", () => {
    const chip = widgetChip(c.status, stocksOf(c), Date.parse(c.now))!;
    expect(chip).toMatchObject({ label: "미국 주간거래", open: false, nextChangeAt: "2026-09-25T08:00:00.000Z" });
    expect(marketSessions(stocksOf(c).map((s) => s.quote), Date.parse(c.now)).map((s) => s.label).join(" · ")).toBe("미국 주간거래 · 한국 휴장");
  });
});
