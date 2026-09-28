import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createMigratedDb } from "../src/db/index.js";
import { TossOpenApiProvider } from "../src/providers/market/tossOpenApi.js";
import type { ReconcileBadgeBody } from "../src/routes/admin.js";
import { basisTagOf, quoteBasisOf, type AccountHolding } from "../src/services/accountNumbers.js";
import { FeatureService } from "../src/services/featureService.js";
import { regularOpenAt } from "../src/services/marketContext.js";
import { reconcileAfterSync } from "../src/services/reconcileAfterSync.js";
import { intradayWithin, type ReconcileEntry } from "../src/services/reconcileService.js";
import type { ImportResult } from "../src/services/tossSyncService.js";
import { fakeProviders } from "./helpers.js";
import { client, NOW } from "./tossFake.js";

/**
 * 숫자 기준·토스 대조 배지 (3-32 PR 1, 플래그 numberBasis — 서버 쪽).
 *  - regularOpenAt: 한국·미국 정규장 시간인지 (휴장·조기 폐장·수능일 목록)
 *  - intradayWithin: 최근 7일 정규장 시간 기록만 — 비교한 수·0.1% 이하 비율·비교 못 한 수
 *  - GET /api/admin/toss/reconcile/badge: 켬 → 대조 상태·장중 비율·동기화 다섯 칸, 끔·토스 없음 → { on: false }
 *  - 대조 기록 뒤 after(실시간 알림)는 numberBasis 가 켜져 있을 때만
 *  - /health·토스 상태 응답의 reconcile 칸은 켜도 꺼도 그대로
 */

describe("regularOpenAt: 한국 또는 미국 정규장 시간인지 (3-32)", () => {
  it.each([
    ["2026-09-28T10:00:00+09:00", true, "한국 정규장"],
    ["2026-09-28T15:45:00+09:00", false, "한국 마감 뒤, 뉴욕 새벽"],
    ["2026-11-19T15:45:00+09:00", true, "수능일 16:30 마감"],
    ["2026-09-25T10:00:00+09:00", false, "추석, 뉴욕은 전날 21시"],
    ["2026-09-28T23:00:00+09:00", true, "뉴욕 10:00"],
    ["2026-11-28T02:30:00+09:00", true, "뉴욕 11/27 12:30, 조기 폐장 전"],
    ["2026-11-28T03:30:00+09:00", false, "조기 폐장 13:00 뒤"],
    ["2026-11-27T00:00:00+09:00", false, "추수감사절"],
    ["2026-09-26T10:00:00+09:00", false, "토요일"],
    ["x", false, "읽을 수 없는 시각"],
  ])("%s → %s (%s)", (iso, want) => {
    expect(regularOpenAt(iso)).toBe(want);
  });
});

const entry = (at: string, diffPct: number, missing = 0): ReconcileEntry => ({ at, tossKrw: 0, tossUsd: 0, appKrw: 0, appUsd: 0, fx: null, diffKrw: 0, diffPct, n: 3, missing });

describe("intradayWithin: 최근 7일 정규장 시간 기록 (3-32 '장중' 기준)", () => {
  const now = new Date("2026-10-05T09:00:00+09:00");

  it("정규장 밖·7일 밖은 빼고, 비교 못 한 기록은 skipped 로 따로 센다", () => {
    const history = [
      // 7일 밖인데 정규장 (뉴욕 9/25 금 12:00) — 날짜 창으로만 빠진다
      entry("2026-09-26T01:00:00+09:00", 0.5),
      // 창 안 정규장·비교함 4개
      entry("2026-09-29T10:00:00+09:00", 0.05),
      entry("2026-09-30T10:00:00+09:00", 0.1),
      entry("2026-10-01T23:00:00+09:00", 0.2),
      entry("2026-10-02T14:00:00+09:00", -0.08),
      // 창 안 장 밖 2개 (뉴욕 05:00 · 토요일) — skipped 에도 안 셈
      entry("2026-09-29T18:00:00+09:00", 0.5),
      entry("2026-10-03T10:00:00+09:00", 0.5),
      // 창 안 정규장·비교 못 함
      entry("2026-10-01T10:00:00+09:00", 0.01, 1),
    ];
    expect(intradayWithin(history, now)).toEqual({ n: 4, withinPct: 75, skipped: 1 });
  });

  it("기록 없음 → n 0 · 비율 null, 정확히 7일 전 기록은 창 안, 3개 중 2개는 66.7", () => {
    expect(intradayWithin([], now)).toEqual({ n: 0, withinPct: null, skipped: 0 });
    expect(intradayWithin([entry("2026-09-28T09:00:00+09:00", 0.05)], now)).toEqual({ n: 1, withinPct: 100, skipped: 0 });
    const three = [entry("2026-09-29T10:00:00+09:00", 0.05), entry("2026-09-30T10:00:00+09:00", 0.1), entry("2026-10-02T14:00:00+09:00", 0.3)];
    expect(intradayWithin(three, now)).toEqual({ n: 3, withinPct: 66.7, skipped: 0 });
  });
});

async function server(toss = true) {
  const db = await createMigratedDb(":memory:");
  const app = await buildApp({
    config: loadConfig({ DATABASE_URL: ":memory:" }),
    db,
    providers: toss ? fakeProviders({ tossOpenApi: new TossOpenApiProvider(client(), { now: NOW }) }) : fakeProviders(),
    logger: false,
    enableScheduler: false,
    now: NOW,
  });
  return { app, db };
}

const OFF: ReconcileBadgeBody = { on: false, status: null, intraday: null, sync: null };
const RECONCILE_KEYS = ["last", "streakOver", "qtyStreak", "week", "alert"];

describe("GET /api/admin/toss/reconcile/badge (3-32)", () => {
  it("켬: 대조 상태·장중 비율·동기화 다섯 칸, 동기화 뒤에는 마지막 기록이 생긴다", async () => {
    const { app, db } = await server();
    try {
      const badge = async () => {
        const res = await app.inject({ method: "GET", url: "/api/admin/toss/reconcile/badge" });
        expect(res.statusCode).toBe(200);
        return res.json() as ReconcileBadgeBody;
      };
      const before = await badge();
      expect(before.on).toBe(true);
      expect(before.status?.last).toBeNull();
      expect(before.intraday).toEqual({ n: 0, withinPct: null, skipped: 0 });
      // enableScheduler: false → 자동 동기화 꺼짐, 다음 실행 없음
      expect(before.sync).toEqual({ enabled: false, intervalMin: expect.any(Number), idleIntervalMin: expect.any(Number), lastRunAt: null, nextRunAt: null });
      expect(Object.keys(before.sync!).sort()).toEqual(["enabled", "idleIntervalMin", "intervalMin", "lastRunAt", "nextRunAt"]);

      expect((await app.inject({ method: "POST", url: "/api/admin/toss/import-holdings" })).statusCode).toBe(200);
      await vi.waitFor(async () => expect((await badge()).status?.last).not.toBeNull()); // 대조는 동기화 뒤에서 돈다
      const after = await badge();
      expect(after.sync?.lastRunAt).not.toBeNull();
    } finally {
      await app.close();
      await db.destroy();
    }
  });

  it("numberBasis 끔 · tossReconcile 끔 · 토스 연동 없음 → { on: false } (200)", async () => {
    const { app, db } = await server();
    try {
      const badge = async () => (await app.inject({ method: "GET", url: "/api/admin/toss/reconcile/badge" })).json();
      await app.inject({ method: "PUT", url: "/api/admin/features", payload: { numberBasis: false } });
      expect(await badge()).toEqual(OFF);
      await app.inject({ method: "PUT", url: "/api/admin/features", payload: { numberBasis: true, tossReconcile: false } });
      expect(await badge()).toEqual(OFF);
    } finally {
      await app.close();
      await db.destroy();
    }
    const bare = await server(false);
    try {
      const res = await bare.app.inject({ method: "GET", url: "/api/admin/toss/reconcile/badge" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(OFF);
    } finally {
      await bare.app.close();
      await bare.db.destroy();
    }
  });

  it("켜도 꺼도 /health 와 토스 상태의 reconcile 칸은 그대로", async () => {
    const { app, db } = await server();
    try {
      const keys = async () => {
        const health = (await app.inject({ method: "GET", url: "/health" })).json() as { tossOpenApi: { reconcile: object } };
        const status = (await app.inject({ method: "GET", url: "/api/admin/toss/status" })).json() as { reconcile: object };
        return [Object.keys(health.tossOpenApi.reconcile), Object.keys(status.reconcile)];
      };
      expect(await keys()).toEqual([RECONCILE_KEYS, RECONCILE_KEYS]);
      await app.inject({ method: "PUT", url: "/api/admin/features", payload: { numberBasis: false } });
      expect(await keys()).toEqual([RECONCILE_KEYS, RECONCILE_KEYS]);
    } finally {
      await app.close();
      await db.destroy();
    }
  });
});

describe("동기화 뒤 대조 → 실시간 알림 (3-32)", () => {
  const r = { excluded: [], holdings: [{ code: "005930", currency: "KRW", quantity: 1, marketValueAfterCost: 1 }] } as unknown as ImportResult;

  async function setup(withAfter = true) {
    const db = await createMigratedDb(":memory:");
    const features = new FeatureService(db, NOW);
    const calls = { record: 0, after: 0 };
    const handler = reconcileAfterSync({
      features,
      reconcile: { record: async () => void calls.record++ } as never,
      stocks: { listWithFreshQuotes: async () => [] },
      ...(withAfter ? { after: () => void calls.after++ } : {}),
    });
    return { db, features, calls, handler };
  }

  it("켬 → 기록 1번 뒤 알림 1번, numberBasis 끔 → 알림 0번, tossReconcile 끔 → 둘 다 0번", async () => {
    const { db, features, calls, handler } = await setup();
    await handler(r);
    expect(calls).toEqual({ record: 1, after: 1 });
    await features.set({ numberBasis: false });
    await handler(r);
    expect(calls).toEqual({ record: 2, after: 1 });
    await features.set({ numberBasis: true, tossReconcile: false });
    await handler(r);
    expect(calls).toEqual({ record: 2, after: 1 });
    await db.destroy();
  });

  it("after 가 없으면 지금처럼 기록만, 기록이 던지면 알림 없이 위로 던진다", async () => {
    const plain = await setup(false);
    await plain.handler(r);
    expect(plain.calls).toEqual({ record: 1, after: 0 });
    await plain.db.destroy();

    const db = await createMigratedDb(":memory:");
    let after = 0;
    const failing = reconcileAfterSync({
      features: new FeatureService(db, NOW),
      reconcile: { record: async () => Promise.reject(new Error("db down")) } as never,
      stocks: { listWithFreshQuotes: async () => [] },
      after: () => void after++,
    });
    await expect(failing(r)).rejects.toThrow("db down");
    expect(after).toBe(0);
    await db.destroy();
  });
});

// ── PR 2: 계좌 브리핑에 저장하는 시세 기준 (quoteBasisOf) ──

const fixture = JSON.parse(readFileSync(new URL("../../shared/fixtures/numberBasis.json", import.meta.url), "utf8")) as {
  tags: Array<[string | null, string | null]>;
};

describe("basisTagOf: 앱 basisTag 와 같은 표 (공용 픽스처, 3-32 PR 2)", () => {
  it.each(fixture.tags)("%j → %j", (raw, tag) => {
    expect(basisTagOf(raw)).toBe(tag);
  });
});

describe("quoteBasisOf: 합계에 넣은 종목의 시장별 시세 기준 (3-32 PR 2)", () => {
  const ev = { marketValue: 1, costBasis: 1, profit: 0, profitRate: 0, costRate: null, afterCost: null, costBasisKrw: null, krwCostSource: null } as const;
  let seq = 0;
  const h = (currency: "KRW" | "USD", priceBasis: string | undefined, o: { evaluation?: boolean; code?: string } = {}): AccountHolding => {
    const code = o.code ?? `X${++seq}`;
    return {
      code,
      name: code,
      quantity: 1,
      avgPrice: 1,
      quote: { currency, price: 1, change: 0, changeRate: 0, ...(priceBasis ? { priceBasis } : {}) },
      evaluation: o.evaluation === false ? null : { ...ev },
    };
  };
  const rep = <T>(n: number, f: () => T) => Array.from({ length: n }, f);

  it("국내 3(NXT) + 미국 14(주간거래 12·정규장 2) + 미국 기준 없음 1 + 합계 제외 1 + 평가 없음 1", () => {
    const list = [
      ...rep(3, () => h("KRW", "KRX+NXT 통합")),
      ...rep(12, () => h("USD", "주간거래")),
      ...rep(2, () => h("USD", "정규장")),
      h("USD", undefined),
      h("USD", "주간거래", { code: "NOFX" }), // 환율을 몰라 computeAccount 가 excluded 에 넣은 종목
      h("KRW", "KRX+NXT 통합", { evaluation: false }), // 평가 없음 (평단·수량 없음)
    ];
    expect(quoteBasisOf(list, { excluded: [{ code: "NOFX", name: "NOFX", reason: "환율을 받지 못해 원화 합계에서 뺐습니다" }] })).toEqual({
      kr: { count: 3, tags: [{ tag: "NXT", count: 3 }] },
      us: {
        count: 15,
        tags: [
          { tag: "주간거래", count: 12 },
          { tag: "정규장", count: 2 },
          { tag: "모름", count: 1 },
        ],
      },
    });
  });

  it("국내만 → us: null, 시세 없는 종목은 세지 않음", () => {
    const noQuote: AccountHolding = { code: "NQ", name: "NQ", quantity: 1, avgPrice: 1, quote: null, evaluation: null };
    expect(quoteBasisOf([h("KRW", "KRX 정규장"), noQuote], { excluded: [] })).toEqual({ kr: { count: 1, tags: [{ tag: "정규장", count: 1 }] }, us: null });
    expect(quoteBasisOf([], { excluded: [] })).toEqual({ kr: null, us: null });
  });

  it("같은 수(1·1)면 NXT 가 정규장 앞, 주간거래가 시간외 앞", () => {
    expect(quoteBasisOf([h("KRW", "KRX 정규장"), h("KRW", "KRX+NXT 통합")], { excluded: [] }).kr).toEqual({
      count: 2,
      tags: [
        { tag: "NXT", count: 1 },
        { tag: "정규장", count: 1 },
      ],
    });
    expect(quoteBasisOf([h("USD", "최근 체결(시간외 포함)"), h("USD", "주간거래"), h("USD", "알 수 없는 기준")], { excluded: [] }).us!.tags.map((x) => x.tag)).toEqual(["주간거래", "시간외", "모름"]);
  });
});
