import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMigratedDb, type Db } from "../src/db/index.js";
import { NotListedError, ProviderError } from "../src/lib/errors.js";
import type { ProductFacts } from "../src/analysis/leveraged.js";
import { BLOCKED_PAUSE_MS, FilingWatchService, inEdgarHours, isExchangeProduct, localMinute, tooOldToAlert, type FilingHolding, type FilingSource } from "../src/services/filingAlerts.js";

/**
 * 3-38 새 공시 알림 — SEC 확인 작업 (FilingWatchService). 녹화한 SEC 응답(test/fixtures/secFilings)을 '그 시각에 SEC 에 있던 줄'만 남겨 돌려주는
 * 가짜 출처로 본다 (시계 고정: 수 7/29 15:00 ET 기준 잡기 → 16:10 ET MSFT 실적 8-K·10-K 새 줄). 네트워크 없음
 */
type SubDoc = { filings: { recent: Record<string, unknown[]> } } & Record<string, unknown>;
const SUB = (t: string): SubDoc => JSON.parse(readFileSync(new URL(`./fixtures/secFilings/sub_${t}.json`, import.meta.url), "utf8")) as SubDoc;
const TICKERS = JSON.parse(readFileSync(new URL("./fixtures/secFilings/company_tickers.json", import.meta.url), "utf8")) as Record<string, { cik_str: number; ticker: string; title: string }>;
const CIK = Object.fromEntries(Object.values(TICKERS).map((v) => [v.ticker, String(v.cik_str).padStart(10, "0")])) as Record<string, string>;

/** 그 시각까지 SEC 에 접수된 줄만 (녹화 응답은 9/29 것이라 앞 시각을 흉내 낸다) */
function asOf(doc: SubDoc, at: Date): SubDoc {
  const r = doc.filings.recent;
  if (!Array.isArray(r["acceptanceDateTime"])) return doc; // 모양이 바뀐 응답은 그대로
  const keep = (r["acceptanceDateTime"] as string[]).map((a, i) => (Date.parse(a) <= at.getTime() ? i : -1)).filter((i) => i >= 0);
  return { ...doc, filings: { ...doc.filings, recent: Object.fromEntries(Object.entries(r).map(([k, v]) => [k, keep.map((i) => v[i])])) } };
}

/** 한 줄 더하기 (공동 제출 흉내 — 다른 회사의 접수 번호) */
function withRow(doc: SubDoc, from: SubDoc, accession: string): SubDoc {
  const src = from.filings.recent;
  const i = (src["accessionNumber"] as string[]).indexOf(accession);
  return { ...doc, filings: { recent: Object.fromEntries(Object.entries(doc.filings.recent).map(([k, v]) => [k, [src[k]![i], ...v]])) } };
}

class FakeSec implements FilingSource {
  resolves: string[] = [];
  subs: string[] = [];
  docs = new Map<string, SubDoc>();
  fail = new Map<string, Error>();
  resolveFail: Error | null = null;
  /** submissionsJson 마다 가짜 시계를 이만큼 (한도 시험) */
  onFetch: (() => void) | null = null;
  gate: Promise<void> | null = null;
  constructor(public at: () => Date) {
    for (const t of ["MSFT", "NVDA", "AAPL", "O", "TSM", "RGTI", "TSLA", "SPY"]) this.docs.set(CIK[t]!, SUB(t));
  }
  /** 티커 목록 받기를 멈춰 둔다 (느린 SEC 흉내) */
  resolveGate: Promise<void> | null = null;
  async resolveCik(code: string): Promise<{ cik: string }> {
    this.resolves.push(code);
    if (this.resolveGate) await this.resolveGate;
    if (this.resolveFail) throw this.resolveFail;
    const cik = CIK[code];
    if (!cik) throw new NotListedError("edgar", `SEC 에 등록된 티커가 아닙니다: ${code}`);
    return { cik };
  }
  async submissionsJson(cik: string): Promise<unknown> {
    this.subs.push(cik);
    this.onFetch?.();
    if (this.gate) await this.gate;
    const f = this.fail.get(cik);
    if (f) throw f;
    const d = this.docs.get(cik);
    if (!d) throw new ProviderError("edgar", `HTTP 404: CIK${cik}`);
    return asOf(d, this.at());
  }
}

const H = (code: string, name: string, groupCode: string | null = "ST"): FilingHolding => ({ code, name, groupCode });
const MSFT = H("MSFT", "마이크로소프트");
const NVDA = H("NVDA", "엔비디아");
const TSM = H("TSM", "TSMC");
const TSLA = H("TSLA", "테슬라");

let db: Db | null = null;
afterEach(async () => {
  await db?.destroy();
  db = null;
});

async function setup(opts: { holdings: FilingHolding[]; at: string; on?: boolean; budgetMs?: number; resolveBudgetMs?: number; product?: (code: string) => Promise<ProductFacts | null> }) {
  db = await createMigratedDb(":memory:");
  const clock = { now: new Date(opts.at), real: 0 };
  const flags = { on: opts.on ?? true };
  const src = new FakeSec(() => clock.now);
  const holdings = { list: opts.holdings };
  const warns: string[] = [];
  const svc = new FilingWatchService({
    db,
    features: { enabled: async () => flags.on },
    source: src,
    holdings: async () => holdings.list,
    now: () => clock.now,
    clock: () => clock.real,
    log: { warn: (_o, m) => void warns.push(m), info: () => undefined },
    ...(opts.budgetMs !== undefined ? { budgetMs: opts.budgetMs } : {}),
    ...(opts.resolveBudgetMs !== undefined ? { resolveBudgetMs: opts.resolveBudgetMs } : {}),
    ...(opts.product ? { product: opts.product } : {}),
  });
  const at = (iso: string) => {
    clock.now = new Date(iso);
  };
  return { svc, src, db: db!, clock, flags, holdings, at, warns };
}

describe("SEC 접수 시간 (미국 동부 평일 06:00~22:59, 서머타임 자동)", () => {
  it.each([
    ["2026-07-29T09:59:00Z", false], // 수 05:59 EDT
    ["2026-07-29T10:00:00Z", true], // 수 06:00
    ["2026-07-30T02:59:00Z", true], // 수 22:59
    ["2026-07-30T03:00:00Z", false], // 수 23:00
    ["2026-08-01T14:00:00Z", false], // 토
    ["2026-08-02T14:00:00Z", false], // 일
    ["2026-03-06T10:59:00Z", false], // 금 05:59 EST (서머타임 전)
    ["2026-03-06T11:00:00Z", true], // 금 06:00 EST
    ["2026-03-09T10:00:00Z", true], // 월 06:00 EDT (3/8 서머타임 시작)
    ["2026-03-09T09:59:00Z", false],
    ["2026-11-02T10:30:00Z", false], // 월 05:30 EST (11/1 서머타임 끝)
    ["2026-11-02T11:00:00Z", true],
  ])("%s → %s", (iso, want) => {
    expect(inEdgarHours(new Date(iso))).toBe(want);
  });

  it("벽시계 글: 여름 21:04Z = 동부 16:04(EDT) · 한국 다음날 05:04, 겨울 21:04Z = 동부 16:04(EST)", () => {
    expect(localMinute("2026-07-29T20:04:53Z", "America/New_York")).toBe("2026-07-29T16:04");
    expect(localMinute("2026-07-29T20:04:53Z", "Asia/Seoul")).toBe("2026-07-30T05:04");
    expect(localMinute("2026-01-28T21:04:38Z", "America/New_York")).toBe("2026-01-28T16:04");
    expect(localMinute("2026-01-28T21:04:38Z", "Asia/Seoul")).toBe("2026-01-29T06:04");
    expect(localMinute(null, "Asia/Seoul")).toBeNull();
    expect(localMinute("x", "Asia/Seoul")).toBeNull();
  });
});

describe("확인 작업", () => {
  it("첫 확인은 기준 잡기(알림 0, 화면에는 보임) → 새 줄(MSFT 실적 8-K·10-K)만 알림 → 같은 응답을 다시 받아도 중복 0", async () => {
    const { svc, src, at } = await setup({ holdings: [MSFT, NVDA], at: "2026-07-29T19:00:00Z" });
    const first = await svc.sweep();
    expect(first).toMatchObject({ ran: true, checked: 2, failed: [], deferred: 0 });
    expect(first.inserted).toBeGreaterThan(5);
    expect(src.subs).toEqual([CIK.MSFT, CIK.NVDA]);
    expect(await svc.alerts({ days: 3, limit: 30 })).toEqual([]);

    at("2026-07-29T20:10:00Z"); // 16:10 ET — 16:04 실적 8-K, 16:08 10-K
    expect(await svc.sweep()).toMatchObject({ checked: 2, inserted: 2 });
    const alerts = await svc.alerts({ days: 3, limit: 30 });
    expect(alerts).toEqual([
      {
        accession: "0001193125-26-323660",
        code: "MSFT",
        name: "마이크로소프트",
        form: "10-K",
        items: [],
        title: "연간 보고서(10-K)",
        acceptedAt: "2026-07-29T20:08:01Z",
        kst: "2026-07-30T05:08",
        et: "2026-07-29T16:08",
        filingDate: "2026-07-29",
        firstSeenAt: "2026-07-29T20:10:00Z",
        url: "https://www.sec.gov/Archives/edgar/data/789019/000119312526323660/msft-20260630.htm",
      },
      {
        accession: "0001193125-26-323632",
        code: "MSFT",
        name: "마이크로소프트",
        form: "8-K",
        items: ["2.02", "9.01"],
        title: "실적 발표(8-K 2.02)",
        acceptedAt: "2026-07-29T20:04:53Z",
        kst: "2026-07-30T05:04",
        et: "2026-07-29T16:04",
        filingDate: "2026-07-29",
        firstSeenAt: "2026-07-29T20:10:00Z",
        url: "https://www.sec.gov/Archives/edgar/data/789019/000119312526323632/msft-20260729.htm",
      },
    ]);
    expect(await svc.newIds()).toEqual(["0001193125-26-323660", "0001193125-26-323632"]);

    at("2026-07-29T20:15:00Z");
    expect(await svc.sweep()).toMatchObject({ checked: 2, inserted: 0 });
    expect((await svc.alerts({ days: 3, limit: 30 })).map((a) => a.accession)).toEqual(["0001193125-26-323660", "0001193125-26-323632"]);
    // 알림 기간(서버가 처음 본 때 days 일 안)이 지나면 빠진다
    at("2026-08-02T20:15:00Z");
    expect(await svc.alerts({ days: 3, limit: 30 })).toEqual([]);
  });

  it("기준을 잡은 뒤에 새로 보인 줄도 접수 24시간이 넘었으면 알리지 않는다 (서버가 오래 멈춤)", async () => {
    const { svc, at } = await setup({ holdings: [NVDA], at: "2026-06-01T12:00:00Z" });
    await svc.sweep();
    at("2026-07-02T14:00:00Z"); // NVDA 8-K 5.02 13:23Z (37분 전) · 6/30 5.07 · 6/18 8.01 은 24시간 넘음
    await svc.sweep();
    expect((await svc.alerts({ days: 3, limit: 30 })).map((a) => `${a.title} ${a.acceptedAt}`)).toEqual(["임원·이사 변경(8-K 5.02) 2026-07-02T13:23:16Z"]);
    const shown = await svc.list({ days: 30, limit: 60 });
    expect(shown.items.map((i) => [i.title, i.isNew])).toEqual([
      ["임원·이사 변경(8-K 5.02)", true],
      ["주주총회 투표 결과(8-K 5.07)", false],
      ["기타 알릴 사항(8-K 8.01)", false],
    ]);
    expect(tooOldToAlert({ acceptedAt: null, filingDate: "2026-07-01" }, new Date("2026-07-02T14:00:00Z"))).toBe(false);
    expect(tooOldToAlert({ acceptedAt: null, filingDate: "2026-06-30" }, new Date("2026-07-02T14:00:00Z"))).toBe(true);
  });

  it("같은 CIK 두 종목(GOOG·GOOGL)은 한 번만 받고 이름은 등록 순 첫 종목, 공동 제출(같은 접수 번호가 두 CIK)은 하나로", async () => {
    const { svc, src, at } = await setup({ holdings: [MSFT, H("GOOGL", "알파벳 A"), H("GOOG", "알파벳 C")], at: "2026-07-29T19:00:00Z" });
    // 알파벳 CIK 에 MSFT 실적 8-K 를 공동 제출로 더한다
    src.docs.set(CIK.GOOGL!, withRow(SUB("TSLA"), SUB("MSFT"), "0001193125-26-323632"));
    expect((await svc.watchPlan()).watched).toEqual([
      { cik: CIK.MSFT, code: "MSFT", name: "마이크로소프트", codes: ["MSFT"] },
      { cik: CIK.GOOGL, code: "GOOGL", name: "알파벳 A", codes: ["GOOGL", "GOOG"] },
    ]);
    await svc.sweep();
    expect(src.subs).toEqual([CIK.MSFT, CIK.GOOGL]);
    at("2026-07-29T20:10:00Z");
    await svc.sweep();
    const a = await svc.alerts({ days: 3, limit: 30 });
    expect(a.map((x) => `${x.code} ${x.accession}`)).toEqual(["MSFT 0001193125-26-323660", "MSFT 0001193125-26-323632"]);
    expect((await svc.status()).watched).toBe(3);
  });

  it("ETF·ETN 은 확인하지 않고(SEC 호출 0), SEC 목록에 없으면 notFound, 한국 종목은 보지 않는다", async () => {
    const { svc, src } = await setup({
      holdings: [H("005930", "삼성전자"), H("QQQ", "인베스코 QQQ", "EF"), H("SOXL", "디렉시온 데일리 반도체 불 3X", null), H("SPYX", "Some Index ETF", null), H("ABCD", "에이비씨디"), MSFT],
      at: "2026-07-29T19:00:00Z",
    });
    const plan = await svc.watchPlan();
    expect(plan.notCovered).toEqual([
      { code: "QQQ", name: "인베스코 QQQ", reason: "etf" },
      { code: "SOXL", name: "디렉시온 데일리 반도체 불 3X", reason: "etf" },
      { code: "SPYX", name: "Some Index ETF", reason: "etf" },
      { code: "ABCD", name: "에이비씨디", reason: "notFound" },
    ]);
    expect(src.resolves).toEqual(["ABCD", "MSFT"]);
    await svc.sweep();
    expect(src.subs).toEqual([CIK.MSFT]);
    // SEC 목록에 없는 종목은 하루 동안 다시 찾지 않는다
    await svc.watchPlan();
    expect(src.resolves).toEqual(["ABCD", "MSFT"]);
    expect(isExchangeProduct(H("O", "리얼티인컴"))).toBe(false);
    expect(isExchangeProduct(H("VNO", "Vornado Realty Trust", null))).toBe(false);
    // 회사 이름의 낱말 조각('etn'·'Bear')으로 빼지 않는다 (종목 마스터 분류를 모를 때도)
    expect(isExchangeProduct(H("BBW", "Build-A-Bear Workshop", null))).toBe(false);
    expect(isExchangeProduct(H("VNET", "VNET Group Vietnam Holdings", null))).toBe(false);
    expect(isExchangeProduct(H("SQQQ", "ProShares UltraPro Short QQQ", null))).toBe(false); // 표·ETF 낱말 없음 → SEC 목록에 없어 notFound 로 빠진다
    expect(isExchangeProduct(H("TQQQ", "프로셰어즈 울트라프로 QQQ", null))).toBe(true); // 레버리지 정적 표
    expect(isExchangeProduct(H("KWEB", "크레인셰어즈 중국 인터넷ETF", null))).toBe(true);
    expect(isExchangeProduct(H("XYZ", "Some ETF", "ST"))).toBe(false); // 종목 마스터가 보통 주식이라고 하면 그대로
    // 토스 상품 정보: EF·EN·파생형 ETF 는 가리고, 주권(ST)·외국 주권(FS)이라고 하면 이름에 'ETF' 가 있어도 회사로
    expect(isExchangeProduct(H("QQQ", "인베스코 QQQ", null), { group: "EF" })).toBe(true);
    expect(isExchangeProduct(H("X1", "X1", null), { group: "EN" })).toBe(true);
    expect(isExchangeProduct(H("X2", "X2", null), { group: null, derivativeEtf: true })).toBe(true);
    expect(isExchangeProduct(H("TSM", "TSMC", null), { group: "FS" })).toBe(false);
    expect(isExchangeProduct(H("ETFX", "Some ETF Holdings Inc", null), { group: "ST" })).toBe(false);
    expect(isExchangeProduct(H("QQQ", "인베스코 QQQ", null), null)).toBe(false);
  });

  it("미국 ETF(종목 마스터에 없음)는 토스 상품 정보(group EF·EN)로 가린다 — QQQ 는 'ETF·ETN', SEC 목록에 있는 상품형 신탁(GLD)도 확인하지 않음 · 주권(ST)·외국 주권(FS)은 확인", async () => {
    // 토스 웹 v2/stock-infos 의 group.code (녹화: MSFT ST · SOXL·RGTX EF). GLD 처럼 SEC 목록에 있고 10-K·8-K 를 내는 신탁은 가리지 않으면 알림이 온다
    const TOSS: Record<string, ProductFacts | null> = {
      QQQ: { group: "EF", leverageFactor: 0 },
      GLD: { group: "EF", leverageFactor: 0 },
      SVIX: { group: "EN", leverageFactor: -1 },
      MSFT: { group: "ST", leverageFactor: 0 },
      TSM: { group: "FS", leverageFactor: 0 },
      NVDA: null, // 받지 못함 → 이름·표 규칙 → SEC 목록으로
    };
    const asked: string[] = [];
    const { svc, src, at } = await setup({
      holdings: [H("QQQ", "인베스코 QQQ", null), H("GLD", "SPDR 골드 트러스트", null), H("SVIX", "SVIX", null), H("MSFT", "마이크로소프트", null), H("TSM", "TSMC", null), H("NVDA", "엔비디아", null), H("SOXL", "디렉시온 데일리 반도체 불 3X", null), H("005930", "삼성전자")],
      at: "2026-07-29T19:00:00Z",
      product: async (code) => {
        asked.push(code);
        return TOSS[code] ?? null;
      },
    });
    const plan = await svc.watchPlan();
    expect(plan.notCovered).toEqual([
      { code: "QQQ", name: "인베스코 QQQ", reason: "etf" },
      { code: "GLD", name: "SPDR 골드 트러스트", reason: "etf" },
      { code: "SVIX", name: "SVIX", reason: "etf" },
      { code: "SOXL", name: "디렉시온 데일리 반도체 불 3X", reason: "etf" },
    ]);
    expect(plan.watched.map((w) => w.code)).toEqual(["MSFT", "TSM", "NVDA"]);
    // 이름·레버리지 표로 이미 가려지는 종목(SOXL)과 한국 종목은 묻지 않는다. ETF 는 티커 목록(CIK)도 찾지 않는다
    expect(asked).toEqual(["QQQ", "GLD", "SVIX", "MSFT", "TSM", "NVDA"]);
    expect(src.resolves).toEqual(["MSFT", "TSM", "NVDA"]);
    // 받은 값은 하루 기억 (위젯·화면 요청마다 토스에 묻지 않음), 받지 못한 값(NVDA)은 10분 뒤 다시
    await svc.watchPlan();
    expect(asked).toHaveLength(6);
    at("2026-07-29T19:11:00Z");
    await svc.sweep();
    expect(asked.slice(6)).toEqual(["NVDA"]);
    expect(src.subs).toEqual([CIK.MSFT, CIK.TSM, CIK.NVDA]);
  });

  it("토스 상품 정보가 느리면 화면·위젯 요청은 한도까지만 기다리고 그 종목은 이번엔 이름·표 규칙으로 — 뒤에서 끝나 다음 요청부터 'ETF·ETN'", async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const { svc } = await setup({
      holdings: [H("QQQ", "인베스코 QQQ", null), MSFT],
      at: "2026-07-29T19:00:00Z",
      resolveBudgetMs: 30,
      product: async (code) => {
        await hold;
        return code === "QQQ" ? { group: "EF", leverageFactor: 0 } : { group: "ST", leverageFactor: 0 };
      },
    });
    const first = await svc.watchPlan();
    expect(first.notCovered).toEqual([{ code: "QQQ", name: "인베스코 QQQ", reason: "notFound" }]);
    release();
    await vi.waitFor(async () => expect((await svc.watchPlan()).notCovered).toEqual([{ code: "QQQ", name: "인베스코 QQQ", reason: "etf" }]));
  });

  it("화면·위젯 요청은 CIK 를 찾느라 한도(기본 2초)보다 오래 기다리지 않고, 찾기는 한 번에 하나 — 끝나면 다음 요청부터 쓴다 (확인 작업은 기다림)", async () => {
    const { svc, src, db } = await setup({ holdings: [MSFT, NVDA], at: "2026-07-29T19:00:00Z", resolveBudgetMs: 50 });
    let release!: () => void;
    src.resolveGate = new Promise<void>((r) => (release = r));
    const t0 = Date.now();
    expect(await svc.newIds()).toEqual([]);
    const plan = await svc.watchPlan();
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(plan.unresolved.map((u) => u.code)).toEqual(["MSFT", "NVDA"]);
    // 느린 받기가 끝나지 않은 동안 새로 찾지 않는다 (티커 목록을 겹쳐 받지 않게)
    expect(src.resolves).toEqual(["MSFT"]);
    release();
    await vi.waitFor(async () => expect((await svc.watchPlan()).watched.map((w) => w.code)).toEqual(["MSFT", "NVDA"]));
    expect(src.resolves).toEqual(["MSFT", "NVDA"]);
    // 확인 작업은 끝까지 기다린다 (처음 켠 서버 — 기억 없음, 받기가 한도보다 느림)
    const at = new Date("2026-07-29T19:00:00Z");
    const src2 = new FakeSec(() => at);
    src2.resolveGate = new Promise<void>((r) => setTimeout(r, 120));
    const svc2 = new FilingWatchService({ db, features: { enabled: async () => true }, source: src2, holdings: async () => [MSFT], now: () => at, resolveBudgetMs: 10 });
    expect(await svc2.sweep()).toMatchObject({ checked: 1, failed: [] });
  });

  it("상태: 새로 산(아직 확인 전) 종목이 있어도 다른 종목의 마지막 확인 시각은 그대로", async () => {
    const { svc, holdings } = await setup({ holdings: [MSFT], at: "2026-07-29T19:00:00Z" });
    await svc.sweep();
    holdings.list = [MSFT, NVDA];
    expect(await svc.status()).toMatchObject({ pending: [{ code: "NVDA", name: "엔비디아" }], lastOkAt: "2026-07-30T04:00:00+09:00", warning: null });
  });

  it("한국 종목만 보유하면 확인 호출 0", async () => {
    const { svc, src } = await setup({ holdings: [H("005930", "삼성전자")], at: "2026-07-29T19:00:00Z" });
    expect(await svc.sweep()).toMatchObject({ ran: true, checked: 0 });
    expect(src.subs).toEqual([]);
    expect(src.resolves).toEqual([]);
    expect((await svc.list({ days: 30, limit: 60 })).status).toMatchObject({ watched: 0, warning: null, lastOkAt: null });
  });

  it("플래그를 끄면 SEC 호출 0 (티커 목록도 부르지 않음)", async () => {
    const { svc, src, db } = await setup({ holdings: [MSFT], at: "2026-07-29T19:00:00Z", on: false });
    expect(await svc.sweep()).toMatchObject({ ran: false, reason: "off", checked: 0 });
    expect(src.subs).toEqual([]);
    expect(src.resolves).toEqual([]);
    expect(await db.selectFrom("sec_filings").selectAll().execute()).toEqual([]);
  });

  it("403(SEC 요청 제한)·시간 초과: 그 종목은 이전 줄 그대로 · 상태에 이름과 경고, 다음 확인에서 성공하면 지운다", async () => {
    const { svc, src, at, db, clock } = await setup({ holdings: [MSFT, NVDA, TSM], at: "2026-07-29T19:00:00Z" });
    await svc.sweep();
    const before = (await db.selectFrom("sec_filings").select("accession").where("cik", "=", CIK.NVDA!).execute()).length;
    at("2026-07-29T20:10:00Z");
    src.fail.set(CIK.NVDA!, new ProviderError("edgar", "시간 초과 15000ms: https://data.sec.gov/submissions/CIK0001045810.json"));
    src.fail.set(CIK.TSM!, new ProviderError("edgar", "HTTP 403: https://data.sec.gov/submissions/CIK0001046179.json (SEC 요청 제한, 잠시 후 재시도)"));
    expect(await svc.sweep()).toMatchObject({ checked: 1, inserted: 2, failed: ["NVDA", "TSM"] });
    expect((await db.selectFrom("sec_filings").select("accession").where("cik", "=", CIK.NVDA!).execute()).length).toBe(before);
    const s = await svc.status();
    expect(s.failed).toEqual([
      { code: "NVDA", name: "엔비디아" },
      { code: "TSM", name: "TSMC" },
    ]);
    expect(s.warning).toBe("blocked");
    // 마지막으로 모두 받은 시각 = 가장 늦게 받은 종목의 마지막 성공 (19:00Z = 한국 04:00)
    expect(s.lastOkAt).toBe("2026-07-30T04:00:00+09:00");
    expect(await svc.health()).toEqual({ lastOkAt: "2026-07-30T04:00:00+09:00", watched: 3, notCovered: 0, failed: ["NVDA", "TSM"], warning: "blocked" });
    src.fail.clear();
    // 403 뒤 10분은 쉰다 (아래 따로 시험) — 10분이 지난 확인에서 모두 받으면 지운다
    clock.real += BLOCKED_PAUSE_MS;
    at("2026-07-29T20:20:00Z");
    await svc.sweep();
    expect(await svc.status()).toMatchObject({ failed: [], warning: null, lastOkAt: "2026-07-30T05:20:00+09:00" });
  });

  it("SEC 가 막으면(403) 남은 종목을 부르지 않고 10분 쉰다 — 그동안 확인은 SEC 호출 0 (같은 IP 의 재무·가치 지표 호출까지 오래 막히지 않게)", async () => {
    const { svc, src, at, clock } = await setup({ holdings: [MSFT, NVDA, TSM], at: "2026-07-29T19:00:00Z" });
    await svc.sweep();
    at("2026-07-29T20:10:00Z");
    src.subs.length = 0;
    src.fail.set(CIK.MSFT!, new ProviderError("edgar", "HTTP 403: https://data.sec.gov/submissions/CIK0000789019.json (SEC 요청 제한, 잠시 후 재시도)"));
    expect(await svc.sweep()).toMatchObject({ ran: true, checked: 0, failed: ["MSFT"], deferred: 2 });
    expect(src.subs).toEqual([CIK.MSFT]);
    expect((await svc.status()).warning).toBe("blocked");
    // 5분 뒤 확인: 쉬는 중 (SEC 호출 0)
    src.fail.clear();
    clock.real += 5 * 60_000;
    at("2026-07-29T20:15:00Z");
    expect(await svc.sweep()).toMatchObject({ ran: false, reason: "blocked", checked: 0 });
    expect(src.subs).toEqual([CIK.MSFT]);
    // 10분이 지나면 다시 모두 확인
    clock.real += 5 * 60_000;
    at("2026-07-29T20:20:00Z");
    expect(await svc.sweep()).toMatchObject({ ran: true, checked: 3, failed: [] });
    expect(await svc.status()).toMatchObject({ failed: [], warning: null });
    // 시간 초과 등 다른 오류는 쉬지 않고 다음 종목을 계속 부른다
    src.subs.length = 0;
    src.fail.set(CIK.MSFT!, new ProviderError("edgar", "시간 초과 15000ms"));
    expect(await svc.sweep()).toMatchObject({ checked: 2, failed: ["MSFT"], deferred: 0 });
    expect(src.subs).toEqual([CIK.MSFT, CIK.NVDA, CIK.TSM]);
  });

  it("모양이 바뀌면 줄을 넣지 않고 'shape', SEC 접수 시간에 30분 넘게 모두 받지 못하면 'stale' (접수 시간 밖·열린 뒤 30분 안은 아님)", async () => {
    const { svc, src, at } = await setup({ holdings: [MSFT], at: "2026-07-29T19:00:00Z" });
    await svc.sweep();
    at("2026-07-29T19:20:00Z");
    expect((await svc.status()).warning).toBeNull();
    at("2026-07-29T19:31:00Z");
    expect(await svc.status()).toMatchObject({ warning: "stale", lastOkAt: "2026-07-30T04:00:00+09:00" });
    // 접수 시간 밖(23:00 ET)
    at("2026-07-30T03:30:00Z");
    expect((await svc.status()).warning).toBeNull();
    // 월요일 06:10 ET — 금요일 밤이 마지막이어도 열린 지 30분이 안 됐으면 멈춤이 아니다
    at("2026-08-03T10:10:00Z");
    expect((await svc.status()).warning).toBeNull();
    src.docs.set(CIK.MSFT!, { cik: "789019", filings: { recent: { form: ["8-K"] } } } as unknown as SubDoc);
    await svc.sweep();
    expect((await svc.status()).warning).toBe("shape");
  });

  it("한 번 도는 한도(90초)를 넘으면 남은 종목은 다음 번, 이미 도는 중이면 건너뜀", async () => {
    const { svc, src, clock } = await setup({ holdings: [MSFT, NVDA, TSM, TSLA], at: "2026-07-29T19:00:00Z" });
    src.onFetch = () => void (clock.real += 40_000);
    expect(await svc.sweep()).toMatchObject({ checked: 3, deferred: 1 });
    expect(src.subs).toEqual([CIK.MSFT, CIK.NVDA, CIK.TSM]);

    src.onFetch = null;
    let release!: () => void;
    src.gate = new Promise<void>((r) => (release = r));
    const running = svc.sweep();
    await vi.waitFor(() => expect(svc.isRunning).toBe(true));
    expect(await svc.sweep()).toMatchObject({ ran: false, reason: "running" });
    release();
    expect(await running).toMatchObject({ ran: true, checked: 4 });
  });

  it("SEC 티커 목록을 받지 못하면 그 종목은 '받지 못함'이고, 10분 안에는 다시 묻지 않는다 (위젯 요청마다 큰 목록을 받지 않게)", async () => {
    const { svc, src, at } = await setup({ holdings: [MSFT], at: "2026-07-29T19:00:00Z" });
    src.resolveFail = new ProviderError("edgar", "네트워크 오류: https://www.sec.gov/files/company_tickers.json");
    expect((await svc.watchPlan()).unresolved).toEqual([{ code: "MSFT", name: "마이크로소프트" }]);
    await svc.alerts({ days: 3, limit: 30 });
    await svc.newIds();
    expect(src.resolves).toEqual(["MSFT"]);
    expect((await svc.status()).failed).toEqual([{ code: "MSFT", name: "마이크로소프트" }]);
    src.resolveFail = null;
    at("2026-07-29T19:11:00Z");
    expect((await svc.watchPlan()).watched.map((w) => w.code)).toEqual(["MSFT"]);
    expect(src.resolves).toEqual(["MSFT", "MSFT"]);
  });

  it("보관: 하루 첫 번째 돌기에서 제출일 90일 넘은 줄을 지운다 (그날 두 번째부터는 지우지 않음)", async () => {
    const { svc, db } = await setup({ holdings: [MSFT], at: "2026-07-29T19:00:00Z" });
    const old = (acc: string) => ({ cik: CIK.MSFT!, accession: acc, form: "8-K", items: "8.01", accepted_at: "2026-04-01T20:00:00Z", filing_date: "2026-04-01", report_date: null, primary_doc: "x.htm", description: "8-K", baseline: 1, first_seen_at: "2026-04-01T20:05:00Z" });
    await db.insertInto("sec_filings").values(old("0000000000-26-000001")).execute();
    await svc.sweep();
    expect(await db.selectFrom("sec_filings").select("accession").where("accession", "=", "0000000000-26-000001").execute()).toEqual([]);
    await db.insertInto("sec_filings").values(old("0000000000-26-000002")).execute();
    await svc.sweep();
    expect((await db.selectFrom("sec_filings").select("accession").where("accession", "=", "0000000000-26-000002").execute()).length).toBe(1);
  });

  it("아직 확인하지 않은 종목(새로 삼)은 화면이 열릴 때 그 종목만 뒤에서 한 번 받는다 — 기준 잡기라 알림은 없음", async () => {
    const { svc, src, holdings } = await setup({ holdings: [MSFT], at: "2026-08-01T14:00:00Z" }); // 토요일 (cron 이 돌지 않음)
    await svc.sweep();
    holdings.list = [MSFT, TSLA];
    src.subs = [];
    const first = await svc.list({ days: 30, limit: 60 });
    expect(first.status.pending).toEqual([{ code: "TSLA", name: "테슬라" }]);
    await vi.waitFor(() => expect(src.subs).toEqual([CIK.TSLA]));
    await vi.waitFor(async () => expect((await svc.list({ days: 30, limit: 60 })).status.pending).toEqual([]));
    expect((await svc.list({ days: 30, limit: 60 })).items.some((i) => i.code === "TSLA")).toBe(true);
    expect(await svc.alerts({ days: 3, limit: 30 })).toEqual([]);
    // 10분 안에는 다시 뒤에서 받지 않는다
    expect(src.subs).toEqual([CIK.TSLA]);
  });

  it("화면용 목록: 제출일 30일 안 · 최신 먼저 · 펼친 내용(항목·설명) · 새 공시 여부(처음 본 뒤 24시간, 기준 줄 아님)", async () => {
    const { svc, at } = await setup({ holdings: [MSFT, TSM], at: "2026-07-29T19:00:00Z" });
    await svc.sweep();
    at("2026-07-29T20:10:00Z");
    await svc.sweep();
    at("2026-07-29T22:03:00Z");
    const r = await svc.list({ days: 30, limit: 3 });
    expect(r.total).toBeGreaterThan(3);
    expect(r.items.map((i) => [i.title, i.isNew, i.detail, i.note])).toEqual([
      ["연간 보고서(10-K)", true, [], "한 해 재무제표와 사업 내용을 담은 정식 보고서"],
      ["실적 발표(8-K 2.02)", true, ["2.02 실적 발표 — 분기·연간 실적 같은 영업 결과를 알림", "9.01 재무제표·첨부 서류 — 다른 항목에 딸린 첨부 서류"], null],
      ["외국 기업 수시 보고(6-K)", false, [], "외국 기업이 본국에서 알린 내용을 SEC에도 올린 것입니다. 무슨 내용인지는 원문을 봐야 알 수 있습니다."],
    ]);
    at("2026-07-30T20:11:00Z");
    expect((await svc.list({ days: 30, limit: 3 })).items.map((i) => i.isNew)).toEqual([false, false, false]);
  });
});
