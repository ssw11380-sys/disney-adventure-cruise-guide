import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { MarketSummary, MarketSummaryData } from "@/api/types";
import { buildDigest, digestMarketOf, KR_PREVIOUS_DAY_LINE, planNotifications, US_PREVIOUS_DAY_LINE, type DigestAccount, type NotifyPrefs } from "@/lib/briefingDigest";
import {
  basisText,
  cardRows,
  cardSpeech,
  closeBadge,
  digestLine,
  fitLines,
  holdingsAux,
  holdingsShort,
  holidayText,
  marketCardItem,
  speakText,
  summaryLines,
  titleText,
  type SummaryLine,
} from "@/lib/marketSummary";
import { KR_HOLIDAYS } from "@/lib/marketTime";

/**
 * 시장 전체 요약 문장 (앱). 서버(backend marketSummaryCalc)와 같은 글인지 공용 픽스처로 본다 — 알림 첫 줄·카드·상세가 같은 숫자와 말을 쓰게.
 * '오늘/밤사이'는 볼 때 날짜로 (저장한 문구가 아님)
 */
const root = fileURLToPath(new URL("../../", import.meta.url));
const shared = JSON.parse(readFileSync(join(root, "shared/fixtures/marketSummary.json"), "utf8")) as {
  cases: Array<{ name: string; data: MarketSummaryData; views: Array<{ at: string; title: string; basis: string; holiday: string | null; lines: string[] | null }>; digest: { at: string; line: string }; aux: string | null }>;
};
const at = (iso: string) => new Date(iso);
const item = (id: number, data: MarketSummaryData, status: "ok" | "failed" = "ok"): MarketSummary => ({ id, date: data.date, session: data.session, market: data.market, status, summary: "s", createdAt: data.asOf, data });
const MORNING = shared.cases[0]!.data;
const AFTERNOON = shared.cases[1]!.data;
const KR_HOLIDAY = shared.cases[2]!.data;

describe("공용 픽스처 — 앱 문장이 서버와 같다", () => {
  for (const c of shared.cases) {
    it(c.name, () => {
      for (const v of c.views) {
        const view = at(v.at);
        expect(titleText(c.data, view), `${v.at} 제목`).toBe(v.title);
        expect(basisText(c.data, view), `${v.at} 기준 줄`).toBe(v.basis);
        expect(holidayText(c.data, view)).toBe(v.holiday);
        if (v.lines) expect(summaryLines(c.data, view).map((l) => l.text)).toEqual(v.lines);
      }
      expect(digestLine(c.data, at(c.digest.at))).toBe(c.digest.line);
      if (c.aux) expect(holdingsAux(c.data.holdings!)).toBe(c.aux);
    });
  }
});

describe("카드 이름표 줄 (최대 6줄 규칙과 같은 줄)", () => {
  it("아침: 환율·금리 / 업종(강·약 두 줄, 섹터 ETF 기준) / 내 종목('내 ' 없이) / 뉴스 3건(제목 2개 + 외 1건)", () => {
    const rows = cardRows(MORNING, at("2026-09-28T08:31:00+09:00"));
    expect(rows.map((r) => r.label)).toEqual(["환율·금리", "업종", "내 종목", "뉴스 3건"]);
    const text = (segs: { text: string }[]) => segs.map((s) => s.text).join("");
    const r0 = rows[0]!;
    if (r0.kind === "news") throw new Error("news");
    expect(text(r0.lines[0]!)).toBe("원/달러 1,359.00원 +3.50원 (9/23 고시) · 미 10년물 5.17% -0.01%p (미 재무부)");
    const sec = rows[1]!;
    if (sec.kind === "news") throw new Error("news");
    expect(sec.lines.map(text)).toEqual(["강 산업재 +0.95% · 기술 +0.80%", "약 커뮤니케이션 -0.90% · 에너지 -0.89% (섹터 ETF 기준)"]);
    const hold = rows[2]!;
    if (hold.kind === "news") throw new Error("news");
    expect(text(hold.lines[0]!)).toBe("미국 12종목 · 지수보다 높음 2 (마이크로소프트 +3.66%, 지수와 차이 +3.18%p) · 낮음 3 (메타 -3.33%, 차이 -3.81%p) · 비슷 7");
    const news = rows[3]!;
    if (news.kind !== "news") throw new Error("not news");
    expect(news.items.map((n) => n.outlet)).toEqual(["뉴스1", "KBS"]);
    expect(news.more).toBe(1);
    // 등락에만 색(tone)이 있고, 높음·낮음·비슷 개수는 색 없이
    expect(hold.lines[0]!.filter((s) => s.tone !== undefined).map((s) => s.text)).toEqual(["+3.66%", "-3.33%"]);
  });

  it("오후: '환율' 이름표, 일정 줄이 있고, 휴장일은 뉴스 줄 없이 다음 개장", () => {
    expect(cardRows(AFTERNOON, at("2026-09-23T16:01:00+09:00")).map((r) => r.label)).toEqual(["환율", "업종", "내 종목", "일정", "뉴스 3건"]);
    const holiday = cardRows(KR_HOLIDAY, at("2026-09-25T16:01:00+09:00"));
    expect(holiday.map((r) => r.label)).toEqual(["환율", "업종", "내 종목", "일정"]);
    const ev = holiday[3]!;
    if (ev.kind === "news") throw new Error("news");
    expect(ev.lines[0]![0]!.text).toBe("다음 개장 9/28(월) 09:00");
  });

  it("줄 수 상한: 7줄이면 뉴스를, 뉴스가 없으면 일정을 뺀다", () => {
    const L = (kind: SummaryLine["kind"]): SummaryLine => ({ kind, text: kind });
    expect(fitLines(["holiday", "indices", "rates", "sectors", "holdings", "events", "news"].map((k) => L(k as SummaryLine["kind"]))).map((l) => l.kind)).toEqual(["holiday", "indices", "rates", "sectors", "holdings", "events"]);
    const withNews: MarketSummaryData = { ...shared.cases[3]!.data, news: { ...shared.cases[3]!.data.news, fresh: true } };
    expect(summaryLines(withNews, at("2026-11-27T08:31:00+09:00"))).toHaveLength(6);
  });

  it("목록 줄: 마감일 배지·괄호 없는 한 줄, 플래그가 꺼지거나 목록이 비면 카드 없음", () => {
    expect(closeBadge(MORNING)).toBe("9/25(금) 마감");
    expect(closeBadge(KR_HOLIDAY)).toBe("휴장");
    expect(closeBadge(shared.cases[4]!.data)).toBe("장중");
    expect(holdingsShort(MORNING.holdings)).toBe("내 미국 12종목 · 지수보다 높음 2 · 낮음 3 · 비슷 7");
    expect(holdingsShort(null)).toBeNull();
    expect(marketCardItem(false, [item(1, MORNING)])).toBeUndefined();
    expect(marketCardItem(true, [])).toBeUndefined();
    expect(marketCardItem(true, [item(2, AFTERNOON), item(1, MORNING)])?.id).toBe(2);
  });

  it("화면 읽기: 기호를 말로 ('+0.48%' → '0.48% 상승', '%p' → '%포인트 높음/낮음', '±1%p')", () => {
    expect(speakText("나스닥 +0.48% · S&P500 -0.51%")).toBe("나스닥 0.48% 상승, S&P500 0.51% 하락");
    expect(speakText("지수와 차이 +3.18%p · 차이 -3.81%p")).toBe("지수와 차이 3.18%포인트 높음, 차이 3.81%포인트 낮음");
    expect(speakText("원/달러 1,359.00원 +3.50원")).toBe("원/달러 1,359.00원 3.50원 상승");
    expect(speakText("내 미국 3종목 모두 지수와 ±1%p 안")).toBe("내 미국 3종목 모두 지수와 플러스마이너스 1%포인트 안");
    const s = cardSpeech(item(7, MORNING), at("2026-09-28T08:31:00+09:00"));
    expect(s).toContain("금요일(9/25) 미국 시장");
    expect(s).toContain("매매 권유가 아닙니다");
    expect(s).not.toMatch(/[+]\d/);
    expect(cardSpeech(item(8, MORNING, "failed"), at("2026-09-28T08:31:00+09:00"))).toContain("생성 실패");
  });
});

describe("세션 알림 첫 줄 (앱 로컬 알림 — 서버 digest.ts 와 같은 문구)", () => {
  const prefs: NotifyPrefs = { digest: true, accountBriefing: true, quietEnabled: false, quietStart: "22:00", quietEnd: "07:00", mutedCodes: [] };
  const fresh = [{ briefingId: 1, code: "005930", name: "삼성전자", summary: "요약", changeRate: 1.2, session: "morning" as const, date: "2026-09-28" }];
  const accounts = [{ id: 9, date: "2026-09-28", session: "morning" as const, status: "ok" as const, headline: { dayPnl: 423_788, dayRate: 0.6, top: [{ name: "마이크로소프트", amount: 148_403 }], krPreviousDay: true } }];
  const morning = item(3, MORNING);

  it("같은 날짜·세션의 요약이 있으면 본문 첫 줄, 제목·나머지 줄은 그대로, data 에 marketSummaryId", () => {
    const [m] = planNotifications(fresh, prefs, at("2026-09-28T08:40:00+09:00"), accounts, { newAccountIds: [9], markets: [morning] });
    expect(m!.title).toBe("오전 계좌 브리핑 · 당일 +423,788원 (+0.60%)");
    expect(m!.body.split("\n")[0]).toBe("금요일(9/25) 미국 나스닥 +0.48% · S&P500 +0.51% · 내 미국 12종목 중 지수보다 높음 2 · 낮음 3");
    expect(m!.body).toContain(KR_PREVIOUS_DAY_LINE); // 첫 줄은 미국 — 한국 휴장 줄은 남긴다
    expect(m!.data).toMatchObject({ accountBriefingId: 9, marketSummaryId: 3 });
    // 다른 세션의 요약이면 첫 줄 없음, 요약이 없어도 예전 그대로
    const other = planNotifications(fresh, prefs, at("2026-09-28T08:40:00+09:00"), accounts, { newAccountIds: [9], markets: [item(4, AFTERNOON)] });
    expect(other[0]!.body.split("\n")[0]).toBe("기여 1위 마이크로소프트 +148,403원");
    expect(planNotifications(fresh, prefs, at("2026-09-28T08:40:00+09:00"), accounts, { newAccountIds: [9] })).toEqual(other);
  });

  it("첫 줄이 같은 시장 휴장이면 그 시장의 예전 휴장 줄만 빼고, 요약만으로는 알림을 만들지 않는다", () => {
    const hol = digestMarketOf(item(5, KR_HOLIDAY), at("2026-09-25T16:01:00+09:00"))!;
    expect(hol).toEqual({ id: 5, line: "오늘 한국 휴장(추석) · 코스피 +0.90% · 코스닥 +1.21% (9/23 기준)", market: "KR", holiday: true });
    const account: DigestAccount = { id: 9, dayPnl: 1, dayRate: null, top: [], krPreviousDay: true, usPreviousDay: true };
    const m = buildDigest("afternoon", "2026-09-25", [], account, hol)!;
    expect(m.body.split("\n")).toEqual([hol.line, US_PREVIOUS_DAY_LINE]);
    expect(buildDigest("afternoon", "2026-12-25", [], null, hol)).toBeNull();
    expect(digestMarketOf(item(6, MORNING, "failed"), at("2026-09-28T08:40:00+09:00"))).toBeNull();
  });
});

describe("한국 평일 휴장일 목록 (서버 marketContext.KR_HOLIDAYS 와 같다)", () => {
  const listOf = (rel: string) => {
    const m = /KR_HOLIDAYS: Readonly<Record<string, string>> = \{([\s\S]*?)\};/.exec(readFileSync(join(root, rel), "utf8"));
    return [...(m?.[1] ?? "").matchAll(/"(\d{4}-\d{2}-\d{2})": "([^"]+)"/g)].map((x) => `${x[1]} ${x[2]}`);
  };

  it("앱 목록이 서버 목록과 같다 (날짜·이름) — 해마다 둘 다 추가", () => {
    const app = listOf("app/src/lib/marketTime.ts");
    expect(app.length).toBeGreaterThan(20);
    expect(app).toEqual(listOf("backend/src/services/marketContext.ts"));
    expect(KR_HOLIDAYS["2026-09-25"]).toBe("추석");
    expect(KR_HOLIDAYS["2026-10-05"]).toBe("개천절 대체공휴일");
  });

  it("한국 휴장일 목록이 내년 끝까지 있다 — 12월 KRX 공지로 다음 해 휴장일을 앱·서버에 같이 넣는다", () => {
    const last = Math.max(...Object.keys(KR_HOLIDAYS).map((d) => Number(d.slice(0, 4))));
    const need = new Date().getUTCFullYear() + 1;
    expect(last, `KR_HOLIDAYS 가 ${last}년까지뿐 — ${need}년 KRX 휴장일을 app/src/lib/marketTime.ts 와 backend/src/services/marketContext.ts 에 추가`).toBeGreaterThanOrEqual(need);
  });
});
