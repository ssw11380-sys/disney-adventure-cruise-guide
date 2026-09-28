import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { EdgarProvider, secUserAgent } from "../src/providers/dart/edgar.js";
import { acceptedIso, FilingShapeError, filingUrl, isAlertForm, parseRecentFilings, splitItems } from "../src/providers/dart/edgarFilings.js";

/**
 * 3-38 새 공시 알림 — SEC EDGAR submissions 줄 뽑기. 녹화한 응답(2026-09-29 02:24~02:26 KST 이 PC 에서 받은 원본을 줄인 것,
 * test/fixtures/secFilings/: 알림 서식은 3월 이후 전부 + 그 밖 서식 6줄 + 3월 이전 알림 서식 1줄)으로 본다. 네트워크 없음
 */
export const SEC = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/secFilings/${name}.json`, import.meta.url), "utf8")) as { filings: { recent: Record<string, unknown[]> } } & Record<string, unknown>;

describe("parseRecentFilings", () => {
  it("MSFT: 알림 서식만(Form 4 제외), 최신 먼저, 항목 쪼개기·접수 시각 UTC·주 문서", () => {
    const rows = parseRecentFilings(SEC("sub_MSFT"), "2026-04-30");
    expect(rows.map((r) => `${r.form} ${r.filingDate}`)).toEqual(["8-K 2026-09-02", "10-K 2026-07-29", "8-K 2026-07-29", "8-K 2026-06-05", "8-K 2026-05-14"]);
    expect(rows[2]).toEqual({
      accession: "0001193125-26-323632",
      form: "8-K",
      items: ["2.02", "9.01"],
      acceptedAt: "2026-07-29T20:04:53Z",
      filingDate: "2026-07-29",
      reportDate: "2026-07-29",
      primaryDoc: "msft-20260729.htm",
      description: "8-K",
    });
    // 8-K 가 아니면 항목 없음
    expect(rows[1]).toMatchObject({ form: "10-K", items: [], acceptedAt: "2026-07-29T20:08:01Z" });
  });

  it("보관 기간(sinceDate) 앞의 줄은 뺀다 — 90일", () => {
    const all = parseRecentFilings(SEC("sub_MSFT"), "2000-01-01");
    expect(all.at(-1)).toMatchObject({ form: "10-Q", filingDate: "2026-01-28", acceptedAt: "2026-01-28T21:07:34Z" });
    expect(parseRecentFilings(SEC("sub_MSFT"), "2026-07-01").map((r) => r.filingDate)).toEqual(["2026-09-02", "2026-07-29", "2026-07-29"]);
  });

  it("정정(/A) · 외국 기업 6-K · 17:30(동부) 뒤 접수는 다음 날짜가 붙어도 접수 시각은 그대로", () => {
    expect(parseRecentFilings(SEC("sub_AAPL"), "2026-08-01")[0]).toMatchObject({ form: "8-K/A", items: ["5.02"], acceptedAt: "2026-09-01T20:30:35Z" });
    const tsm = parseRecentFilings(SEC("sub_TSM"), "2026-09-01");
    expect(tsm.every((r) => r.form === "6-K" && r.items.length === 0)).toBe(true);
    expect(tsm[0]).toMatchObject({ accession: "0001046179-26-000660", acceptedAt: "2026-09-24T10:02:44Z" });
    const rgti = parseRecentFilings(SEC("sub_RGTI"), "2026-08-19").find((r) => r.accession === "0001104659-26-098877")!;
    expect(rgti).toMatchObject({ filingDate: "2026-08-20", acceptedAt: "2026-08-19T23:16:15Z", items: ["5.02", "7.01", "8.01", "9.01"] });
  });

  it("알림 서식을 내지 않는 펀드 신탁(SPY)은 줄이 없다", () => {
    expect(parseRecentFilings(SEC("sub_SPY"), "2026-01-01")).toEqual([]);
  });

  it("모양이 바뀌면 FilingShapeError (열 없음 · 열 길이가 다름 · recent 없음)", () => {
    const base = SEC("sub_MSFT");
    const without = (col: string) => ({ ...base, filings: { recent: Object.fromEntries(Object.entries(base.filings.recent).filter(([k]) => k !== col)) } });
    expect(() => parseRecentFilings(without("form"), "2026-01-01")).toThrow(FilingShapeError);
    expect(() => parseRecentFilings(without("accessionNumber"), "2026-01-01")).toThrow(FilingShapeError);
    const short = { ...base, filings: { recent: { ...base.filings.recent, filingDate: base.filings.recent["filingDate"]!.slice(1) } } };
    expect(() => parseRecentFilings(short, "2026-01-01")).toThrow(/길이가 다릅니다/);
    expect(() => parseRecentFilings({ cik: "1" }, "2026-01-01")).toThrow(FilingShapeError);
    expect(() => parseRecentFilings(null, "2026-01-01")).toThrow(FilingShapeError);
    // 있으면 좋은 열(acceptanceDateTime·items)이 없으면 그 값만 비운다
    const noAccepted = parseRecentFilings(without("acceptanceDateTime"), "2026-07-29");
    expect(noAccepted.find((r) => r.accession === "0001193125-26-323632")).toMatchObject({ acceptedAt: null, items: ["2.02", "9.01"] });
  });

  it("작은 규칙: 서식 · 항목 · 접수 시각 · 원문 주소", () => {
    expect(["8-K", "8-K/A", "10-Q", "10-K/A", "6-K", "20-F", "40-F/A"].every(isAlertForm)).toBe(true);
    expect(["4", "144", "SC 13G", "DEF 14A", "S-8", "SD", "497", "8-K12B"].some(isAlertForm)).toBe(false);
    expect(splitItems("2.02,9.01, 2.02,x,10")).toEqual(["2.02", "9.01"]);
    expect(splitItems(undefined)).toEqual([]);
    expect(acceptedIso("2026-01-28T21:04:38.000Z")).toBe("2026-01-28T21:04:38Z");
    expect(acceptedIso("2026-01-28T21:04:38")).toBe("2026-01-28T21:04:38Z");
    expect(acceptedIso("nope")).toBeNull();
    expect(acceptedIso("")).toBeNull();
    expect(filingUrl("0000789019", "0001193125-26-323632", "msft-20260729.htm")).toBe("https://www.sec.gov/Archives/edgar/data/789019/000119312526323632/msft-20260729.htm");
    expect(filingUrl("0000789019", "0001193125-26-323632", "")).toBe("https://www.sec.gov/Archives/edgar/data/789019/000119312526323632/0001193125-26-323632-index.htm");
    for (const bad of ["../x?y", "../../x.htm", "a/../b.htm", ".hidden", "a//b.htm"]) expect(filingUrl("0000789019", "0001193125-26-323632", bad), bad).toMatch(/0001193125-26-323632-index\.htm$/);
    expect(filingUrl("0001046179", "0001046179-26-000656", "xslF345X06/wk-form4_1788948541.xml")).toBe("https://www.sec.gov/Archives/edgar/data/1046179/000104617926000656/xslF345X06/wk-form4_1788948541.xml");
  });
});

describe("EdgarProvider.submissionsJson", () => {
  it("같은 User-Agent 로 submissions 원본을 받고, 요청 사이를 160ms 띄운다 (가치 지표 배치와 같은 gate) — 가짜 시계", async () => {
    // 실제 시계로 fetch 시각 차이를 재면 전체 실행에서 147ms 처럼 짧게 보여 자주 실패했다 (첫 fetch 가 gate 를 지난 뒤 몇 ms 늦게 찍힘).
    // Date·setTimeout 만 가짜로 두고 gate 가 잡은 자리 시각을 그대로 본다 (Response.json 은 진짜 비동기 그대로)
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: Date.UTC(2026, 8, 29, 13, 0, 0) });
    try {
      const t0 = Date.now();
      const calls: Array<{ url: string; ua: string | null; at: number }> = [];
      const fetchFn = (async (url: string, init?: RequestInit) => {
        calls.push({ url, ua: new Headers(init?.headers).get("user-agent"), at: Date.now() - t0 });
        return new Response(JSON.stringify(SEC("sub_MSFT")), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch;
      const edgar = new EdgarProvider(fetchFn);
      const all = Promise.all([edgar.submissionsJson("0000789019"), edgar.submissionsJson("0001045810"), edgar.submissionsJson("0000320193")]);
      // 두 번째·세 번째는 자리가 올 때까지 fetch 하지 않는다
      await vi.advanceTimersByTimeAsync(0);
      expect(calls.map((c) => c.at)).toEqual([0]);
      await vi.advanceTimersByTimeAsync(159);
      expect(calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(200);
      await all;
      expect(calls.map((c) => c.url)).toEqual([
        "https://data.sec.gov/submissions/CIK0000789019.json",
        "https://data.sec.gov/submissions/CIK0001045810.json",
        "https://data.sec.gov/submissions/CIK0000320193.json",
      ]);
      expect(calls.every((c) => /stock-briefing\/1\.0 .*contact:/.test(c.ua ?? ""))).toBe(true);
      expect(calls.map((c) => c.at)).toEqual([0, 160, 320]);
      // 간격이 지난 뒤의 요청은 기다리지 않는다
      await vi.advanceTimersByTimeAsync(1_000);
      const later = edgar.submissionsJson("0000789019");
      await vi.advanceTimersByTimeAsync(0);
      await later;
      expect(calls.at(-1)!.at).toBe(1_360);
    } finally {
      vi.useRealTimers();
    }
  });

  it("SEC_USER_AGENT 를 주면 그 User-Agent 로 (회사 이름 + 연락 메일 — SEC 공정 접근 규칙), 비우면 기본값", async () => {
    const seen: string[] = [];
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("user-agent") ?? "");
      return new Response(JSON.stringify(SEC("sub_MSFT")), { status: 200 });
    }) as typeof fetch;
    await new EdgarProvider(fetchFn, undefined, { minGapMs: 0, userAgent: "Example Co ops@example.com" }).submissionsJson("0000789019");
    await new EdgarProvider(fetchFn, undefined, { minGapMs: 0, userAgent: "  " }).submissionsJson("0000789019");
    expect(seen[0]).toBe("Example Co ops@example.com");
    expect(seen[1]).toMatch(/^stock-briefing\/1\.0 .*contact:/);
    expect(secUserAgent("")).toBeUndefined();
    expect(secUserAgent("  Example Co ops@example.com ")).toBe("Example Co ops@example.com");
    // 연락 메일 모양이 없으면 쓰지 않는다 (SEC 가 이름 없는 봇으로 막지 않게 — 기본값 그대로)
    expect(secUserAgent("my-bot")).toBeUndefined();
  });

  it("403(SEC 요청 제한)은 ProviderError — 이유에 'SEC 요청 제한'", async () => {
    const edgar = new EdgarProvider((async () => new Response("", { status: 403 })) as unknown as typeof fetch, undefined, { minGapMs: 0 });
    await expect(edgar.submissionsJson("0000789019")).rejects.toThrow(/HTTP 403.*SEC 요청 제한/);
  });
});
