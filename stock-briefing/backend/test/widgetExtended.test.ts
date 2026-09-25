import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createMigratedDb, type Db } from "../src/db/index.js";
import type { QuoteSession } from "../src/domain/types.js";
import type { MarketCalendar, MarketStatus } from "../src/providers/market/calendar.js";
import { FEATURES } from "../src/services/featureService.js";
import { buildWidgetPayload, extendedOpen } from "../src/services/widgetPayload.js";
import { fakeProviders, FakeGenerator } from "./helpers.js";

/**
 * 위젯 리뷰 1번: 미국 프리·애프터·주간거래(와 한국 연장 세션) 시간에 보유 종목이 거래되고 있으면 위젯이 장중처럼 15분마다 갱신하고
 * 시세가 30분 넘게 묵으면 '지연'을 띄우도록, /api/widget 칩에 시장별 연장 세션 표시(ext)를 더한다 (플래그 widgetExtended).
 * 예전 칩은 이 시간에 글자만 세션 이름으로 바꾸고 open 은 false 라, 앱이 휴장으로 보고 2시간 동안 묻지 않고 '지연'도 따지지 않았다.
 */

interface ChipCase {
  name: string;
  now: string;
  status: MarketStatus;
  holdings: { code: string; session: QuoteSession | null }[];
  chip: unknown;
  polished: unknown;
}
const chips = JSON.parse(readFileSync(new URL("../../shared/fixtures/marketChip.json", import.meta.url), "utf8")) as { cases: ChipCase[] };
const expected = JSON.parse(readFileSync(new URL("../../shared/fixtures/widgetExtended.json", import.meta.url), "utf8")) as { cases: { name: string; ext: { kr: boolean; us: boolean } }[] };

describe("연장 세션 표시 (widgetExtended): 공용 픽스처 (앱 widgets/payload.extendedOpen 과 같은 답)", () => {
  it("모든 칩 사례에 답이 있고, 미국 연장 세션이 열린 사례와 닫힌 사례가 모두 있다", () => {
    expect(expected.cases.map((c) => c.name)).toEqual(chips.cases.map((c) => c.name));
    expect(expected.cases.some((c) => c.ext.us)).toBe(true);
    expect(expected.cases.some((c) => !c.ext.us)).toBe(true);
  });

  for (const c of chips.cases) {
    it(`같은 답: ${c.name}`, () => {
      const want = expected.cases.find((x) => x.name === c.name)!.ext;
      expect(extendedOpen({ kr: c.status.KR.isOpen, us: c.status.US.isOpen }, c.holdings.map((h) => h.session), Date.parse(c.now))).toEqual(want);
    });
  }

  it("한국 연장 세션: 달력으로 닫혀 있는데 거래 대상 한국 종목의 세션이 열려 있으면 kr (달력으로 열려 있으면 false)", () => {
    const now = Date.parse("2026-09-22T11:30:00.000Z");
    const nxt: QuoteSession = { market: "KR", phase: "after", label: "한국 애프터마켓", open: true, eligible: true, until: "2026-09-22T12:00:00.000Z" };
    expect(extendedOpen({ kr: false, us: false }, [nxt], now)).toEqual({ kr: true, us: false });
    expect(extendedOpen({ kr: true, us: false }, [nxt], now)).toEqual({ kr: false, us: false });
    // 거래 대상인지 모르면(eligible null) 가격이 바뀐다고 볼 수 없다 (앱 상태 줄 '지연' 판단과 같다)
    expect(extendedOpen({ kr: false, us: false }, [{ ...nxt, eligible: null }], now)).toEqual({ kr: false, us: false });
    // 경계가 지난 세션(받아 둔 값이 지난 세션 것)은 쓰지 않는다
    expect(extendedOpen({ kr: false, us: false }, [nxt], Date.parse("2026-09-22T12:00:00.000Z"))).toEqual({ kr: false, us: false });
  });
});

describe("buildWidgetPayload: 칩의 ext 는 묻고(extended) 켜져 있을 때만 — 예전 칩은 그대로", () => {
  const c = chips.cases.find((x) => x.name === "평일 20:30 · 한국 마감 · 미국 프리마켓")!;
  const stocks = c.holdings.map((h) => ({ code: h.code, name: h.code, market: "NYSE", quantity: 1, avgPrice: 1, memo: null, createdAt: "", updatedAt: "", quote: h.session ? ({ code: h.code, price: 1, change: 0, changeRate: 0, currency: "USD", asOf: c.now, session: h.session } as never) : null, quoteError: null, evaluation: null }));
  const status = { ...c.status, now: c.now };

  it("extended 면 칩에 시장별 ext (미국 프리마켓 → us), 아니면 칸이 없다 (예전 응답과 같다)", () => {
    const on = buildWidgetPayload(stocks as never, [], status, { sessions: true, extended: true });
    expect(on.market).toMatchObject({ label: "미국 프리마켓", open: false, ext: { kr: false, us: true } });
    const off = buildWidgetPayload(stocks as never, [], status, { sessions: true });
    expect(off.market).not.toHaveProperty("ext");
    expect({ ...on.market, ext: undefined }).toEqual({ ...off.market, ext: undefined });
  });
});

describe("GET /api/widget: ext 는 세션 칩을 묻는 앱(&sessions=1)에만, widgetExtended 가 켜져 있을 때만", () => {
  let db: Db;
  let app: Awaited<ReturnType<typeof buildApp>>;
  /** 한국 네이버·미국 버티브를 가진 서버를 그 사례의 시각·달력으로 (세션은 서버 sessionAt 이 만든다 — 토스 종목 정보는 모름) */
  const start = async (name: string) => {
    const c = chips.cases.find((x) => x.name === name)!;
    db = await createMigratedDb(":memory:");
    await db
      .insertInto("registered_stocks")
      .values(["035420", "VRT"].map((code, i) => ({ code, name: code, market: code === "VRT" ? "NYSE" : "KOSPI", quantity: 1, avg_price: 100, memo: null, created_at: `2026-09-01T00:00:0${i}+09:00`, updated_at: "2026-09-01T00:00:00+09:00" })))
      .execute();
    const calendar = { status: async () => c.status } as unknown as MarketCalendar;
    app = await buildApp({ config: loadConfig({ DATABASE_URL: ":memory:" }), db, providers: fakeProviders({ generator: new FakeGenerator(), calendar }), logger: false, enableScheduler: false, now: () => new Date(c.now) });
    return c;
  };
  const get = async (url: string) => (await app.inject({ method: "GET", url })).json();
  beforeEach(() => {
    db = undefined as unknown as Db;
  });
  afterEach(async () => {
    await app?.close();
    await db?.destroy();
  });

  it("플래그 기본값은 켜짐 (서버), features 칸으로 위젯에 전한다", async () => {
    await start("추석 17:30 · 미국 프리마켓");
    expect(FEATURES.widgetExtended.default).toBe(true);
    expect((await get("/api/widget?indices=1&sessions=1&ui=2")).features.widgetExtended).toBe(true);
  });

  it("새 앱(1.4.0 지금 JS 포함 — &sessions=1): 추석 17:30 미국 프리마켓에 ext.us, 칩의 나머지 칸은 끈 서버와 같다", async () => {
    await start("추석 17:30 · 미국 프리마켓");
    const urls = ["/api/widget?indices=1&sessions=1", "/api/widget?indices=1&sessions=1&ui=2", "/api/widget?indices=1&sessions=1&ui=2&board=1"];
    const on = await Promise.all(urls.map(get));
    await app.inject({ method: "PUT", url: "/api/admin/features", payload: { widgetExtended: false } });
    const off = await Promise.all(urls.map(get));
    urls.forEach((url, i) => {
      expect(on[i].market.label, url).toBe("미국 프리마켓");
      expect(on[i].market.ext, url).toEqual({ kr: false, us: true });
      const { ext: _ext, ...rest } = on[i].market;
      expect(rest, url).toEqual(off[i].market);
      // 끄면 칸이 없고 features 에 false (앱은 예전 휴장 규칙)
      expect(off[i].market, url).not.toHaveProperty("ext");
      expect(off[i].features.widgetExtended, url).toBe(false);
    });
  });

  it("주간거래는 토스가 지원 종목이라고 알려 준 종목만 — 모르면(토스 종목 정보를 못 받음) ext 도 false (예전처럼 휴장 규칙)", async () => {
    await start("추석 09:59 · 미국 주간거래 · 한국 휴장");
    const body = await get("/api/widget?indices=1&sessions=1&ui=2");
    expect(body.market.label).toBe("미국 주간거래");
    expect(body.market.ext).toEqual({ kr: false, us: false });
  });

  it("예전 앱(&sessions=1 없음): 칩에 ext 를 넣지 않는다 (달력만 본 예전 칩 그대로)", async () => {
    await start("추석 17:30 · 미국 프리마켓");
    for (const url of ["/api/widget", "/api/widget?indices=1", "/api/widget?indices=1&board=1"]) expect((await get(url)).market, url).not.toHaveProperty("ext");
  });
});

describe("위젯 자동 갱신 기록 (widgetRefreshLog)", () => {
  it("앱 설정 화면 표시용 플래그: 서버 기본값 켜짐, 설명이 있다", () => {
    expect(FEATURES.widgetRefreshLog.default).toBe(true);
    expect(FEATURES.widgetRefreshLog.description).toMatch(/자동 갱신/);
  });
});
