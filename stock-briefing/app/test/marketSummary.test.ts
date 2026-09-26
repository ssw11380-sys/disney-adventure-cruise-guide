import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { MarketSummary, MarketSummaryData } from "@/api/types";
import { buildDigest, digestMarketOf, KR_PREVIOUS_DAY_LINE, planNotifications, US_PREVIOUS_DAY_LINE, type DigestAccount, type NotifyPrefs } from "@/lib/briefingDigest";
import {
  basisText,
  bodyWidthGuess,
  cardRows,
  cardSpeech,
  closeBadge,
  closeBadgeWarn,
  digestLine,
  fitLines,
  chunkSegs,
  chunkText,
  holdingsSegs,
  indexSegs,
  newsLink,
  sectorCardSegs,
  summarySegLines,
  wordGap,
  holdingsAux,
  holdingsShort,
  holdingsTableMode,
  holidayText,
  indexCellCols,
  indexSourceTime,
  indexValueLine,
  indicesTableMode,
  marketCardItem,
  ratesSegs,
  speakPointMove,
  speakText,
  summaryLines,
  textEm,
  titleText,
  widestOf,
  type SummaryLine,
} from "@/lib/marketSummary";
import { KR_HOLIDAYS } from "@/lib/marketTime";
import { font, space } from "@/tokens";

/**
 * 시장 전체 요약 문장 (앱). 서버(backend marketSummaryCalc)와 같은 글인지 공용 픽스처로 본다 — 알림 첫 줄·카드·상세가 같은 숫자와 말을 쓰게.
 * '오늘/밤사이'는 볼 때 날짜로 (저장한 문구가 아님)
 */
const root = fileURLToPath(new URL("../../", import.meta.url));
const shared = JSON.parse(readFileSync(join(root, "shared/fixtures/marketSummary.json"), "utf8")) as {
  cases: Array<{ name: string; data: MarketSummaryData; views: Array<{ at: string; title: string; basis: string; holiday: string | null; lines: string[] | null }>; digest: { at: string; line: string }; aux: string | null }>;
  variants: Array<{ name: string; base: number; patch: Partial<MarketSummaryData>; at: string; digest: string; basis: string }>;
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
  for (const v of shared.variants) {
    it(`변형: ${v.name}`, () => {
      const d = { ...shared.cases[v.base]!.data, ...v.patch } as MarketSummaryData;
      expect(digestLine(d, at(v.at))).toBe(v.digest);
      expect(basisText(d, at(v.at))).toBe(v.basis);
    });
  }
});

describe("미국 제목은 숫자의 거래일로 (월요일·휴장 다음 날은 '밤사이'가 아니라 날짜 — 서버와 같다)", () => {
  const us = (marketDate: string, basisDate: string, holiday: { date: string; name: string | null } | null) => ({ market: "US" as const, marketDate, basisDate, holiday });
  it("추수감사절 다음 날 '수요일(11/25)', 노동절 다음 날 '금요일(9/4)', 성금요일 다음 월요일 '목요일(3/25)', 평일 보통 아침은 '밤사이'", () => {
    expect(titleText(us("2026-11-26", "2026-11-25", { date: "2026-11-26", name: "추수감사절" }), at("2026-11-27T08:31:00+09:00"))).toBe("수요일(11/25) 미국 시장");
    expect(titleText(us("2026-09-07", "2026-09-04", { date: "2026-09-07", name: "노동절" }), at("2026-09-08T08:31:00+09:00"))).toBe("금요일(9/4) 미국 시장");
    expect(titleText(us("2027-03-26", "2027-03-25", { date: "2027-03-26", name: "성금요일" }), at("2027-03-29T08:31:00+09:00"))).toBe("목요일(3/25) 미국 시장");
    expect(titleText(us("2026-09-24", "2026-09-24", null), at("2026-09-25T08:31:00+09:00"))).toBe("밤사이 미국 시장");
    // 휴장 배너는 그대로 '지난밤 미국 휴장(…)'
    expect(holidayText(us("2026-09-07", "2026-09-04", { date: "2026-09-07", name: "노동절" }), at("2026-09-08T08:31:00+09:00"))).toBe("지난밤 미국 휴장(노동절) · 아래는 직전 거래일 9/4(금) 기준");
    // 한국 휴장 오후는 '오늘 한국 시장' 그대로
    expect(titleText(KR_HOLIDAY, at("2026-09-25T16:01:00+09:00"))).toBe("오늘 한국 시장");
  });

  it("휴장 다음 날 환율·금리 줄: 금리에 '11/25 기준', 원/달러 고시일을 모르면 '(고시일 확인 못 함)'", () => {
    const text = (segs: { text: string }[] | null) => (segs ?? []).map((x) => x.text).join("");
    const ushol = shared.cases[3]!.data;
    expect(text(ratesSegs(ushol))).toBe("원/달러 1,400.00원 -2.50원 (11/26 고시) · 미 10년물 4.90% +0.02%p (11/25 기준 · 미 재무부)");
    expect(text(ratesSegs({ ...MORNING, fx: { ...MORNING.fx!, date: null } }))).toBe("원/달러 1,359.00원 +3.50원 (고시일 확인 못 함) · 미 10년물 5.17% -0.01%p (미 재무부)");
  });
});

describe("상세 표 배치 (좁은 칸·큰 글씨에서 이름이 쪼개지지 않게 3칸으로)", () => {
  it("폴드8 접은 화면(475) 글자 100%는 목업처럼 4칸, 펼친 세로 두 칸(704 → 한 칸 약 350)은 두 표 모두 3칸", () => {
    expect(holdingsTableMode(bodyWidthGuess(475, "stack"), 1)).toBe("full");
    expect(indicesTableMode(bodyWidthGuess(475, "stack"), 1)).toBe("full");
    expect(bodyWidthGuess(704, "split")).toBe(351);
    expect(holdingsTableMode(bodyWidthGuess(704, "split"), 1)).toBe("compact");
    expect(indicesTableMode(bodyWidthGuess(704, "split"), 1)).toBe("compact");
  });
  it("큰 글씨(130%): 475 에서 보유 종목 표는 3칸(지수 표는 4칸 그대로), 울트라 바깥 화면(411)은 보유 종목 표가 3칸, 2단 오른쪽 칸(933 → 532)은 4칸", () => {
    expect(holdingsTableMode(475, 1.3)).toBe("compact");
    expect(indicesTableMode(475, 1.3)).toBe("full");
    expect(holdingsTableMode(411, 1)).toBe("compact");
    expect(indicesTableMode(411, 1)).toBe("full");
    expect(bodyWidthGuess(933, "pane")).toBe(532);
    expect(holdingsTableMode(532, 1.3)).toBe("full");
  });
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
    // 미국 마감 직후 최종값 전이면 목록 줄에서도 '최종값 전' (경고색)
    expect(closeBadge({ ...MORNING, phase: "prelim" })).toBe("최종값 전");
    expect(closeBadgeWarn({ ...MORNING, phase: "prelim" })).toBe(true);
    expect(closeBadgeWarn(MORNING)).toBe(false);
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
    // 금리 전일 대비는 지수와의 차이(높음·낮음)가 아니라 움직임(상승·하락)으로 읽는다
    expect(speakText("미 10년물 5.17% -0.01%p (미 재무부)")).toBe("미 10년물 5.17% 0.01%포인트 하락 (미 재무부)");
    expect(speakText("미 10년물 4.90% +0.02%p (11/25 기준 · 미 재무부)")).toBe("미 10년물 4.90% 0.02%포인트 상승 (11/25 기준, 미 재무부)");
    expect(speakPointMove("-0.01%p")).toBe("0.01%포인트 하락");
    // 받지 못한 지수 칸 '—' 만 '받지 못함', 안내 문단의 줄표는 쉼표 (3차 검토: 상세 안내를 한 문장으로 읽게 되면서), '±1.00%p' 도 말로
    expect(speakText("나스닥 — · S&P500 +0.51% · 다우 —")).toBe("나스닥 받지 못함, S&P500 0.51% 상승, 다우 받지 못함");
    expect(speakText("정규장 종가 기준 — 잔고 화면 값과 다를 수 있음")).toBe("정규장 종가 기준, 잔고 화면 값과 다를 수 있음");
    expect(speakText("'비슷'은 차이가 ±1.00%p 안")).toBe("'비슷'은 차이가 플러스마이너스 1.00%포인트 안");
    const s = cardSpeech(item(7, MORNING), at("2026-09-28T08:31:00+09:00"));
    expect(s).toContain("금요일(9/25) 미국 시장");
    expect(s).toContain("매매 권유가 아닙니다");
    expect(s).not.toMatch(/[+]\d/);
    expect(cardSpeech(item(8, MORNING, "failed"), at("2026-09-28T08:31:00+09:00"))).toContain("생성 실패");
  });
});

describe("카드 지수 칸 배치·줄바꿈 묶음·출처 시각 (요구 검사 보정)", () => {
  it("지수 칸: 칸이 등락률·종가 글자보다 좁으면 4칸을 2×2 로 — 울트라 411·130% 카드(칸 약 74dp, '+0.48%' 약 75dp)", () => {
    const card = (w: number) => w - 2 * space.lg;
    expect(textEm("+0.48%") * font.h2 * 1.3).toBeGreaterThan((card(411) - 3 * space.sm) / 4 - 2 * space.sm);
    expect(indexCellCols(MORNING, card(411), 1.3)).toBe(2);
    expect(indexCellCols(MORNING, card(411), 1)).toBe(4);
    expect(indexCellCols(MORNING, card(475), 1.3)).toBe(4);
    expect(indexCellCols(MORNING, card(475), 1.4)).toBe(4);
    // 두 자리 등락률('-10.33%')은 100%에서도 좁은 칸이면 2×2
    const crash = { ...MORNING, indices: MORNING.indices.map((i) => ({ ...i, changeRate: -10.33 })) };
    expect(indexCellCols(crash, card(411), 1.1)).toBe(2);
    // 오후 2칸(종가 · 전일 대비 줄)은 411·140%에서도 한 줄
    expect(indexCellCols(AFTERNOON, card(411), 1.4)).toBe(2);
    // 넓은 창 목록 줄 작은 칸: 2단 목록(400)·글자 140%·두 자리 등락률이면 2×2
    expect(indexCellCols(MORNING, 400 - space.lg - space.md, 1, true)).toBe(4);
    expect(indexCellCols(crash, 400 - space.lg - space.md, 1.4, true)).toBe(2);
  });

  it("줄바꿈 덩어리: 한글 낱말은 덩어리 안에서 갈라지지 않고, 이름표+숫자·등락 숫자·출처 괄호·한 글자 낱말은 묶인다 — 글자는 그대로(보이지 않는 글자 없음) (3차 검토)", () => {
    const texts = (segs: Parameters<typeof chunkSegs>[0]) => chunkSegs(segs).map(chunkText);
    // 아침 카드 환율·금리: '미 10년물'이 '미 10년 / 물'로 갈라지지 않게 '미 10년물 5.17% -0.01%p' 한 덩어리, 출처 괄호도 한 덩어리
    expect(texts(ratesSegs(MORNING)!)).toEqual(["원/달러 1,359.00원 +3.50원", "(9/23 고시) ·", "미 10년물 5.17% -0.01%p", "(미 재무부)"]);
    // 내 종목: '비슷 7'·'높음 2'·'차이 +3.18%p)'·'(마이크로소프트 +3.66%,' — '지수와'·'마이크로소프트'는 통째로
    const hold = texts(holdingsSegs(MORNING, { mine: false })!);
    expect(hold).toEqual(["미국 12종목 ·", "지수보다", "높음 2", "(마이크로소프트 +3.66%,", "지수와", "차이 +3.18%p) ·", "낮음 3", "(메타 -3.33%,", "차이 -3.81%p) ·", "비슷 7"]);
    // 한국 휴장 카드: 'M/D 기준 ·' 흐린 머리는 한 덩어리, '비슷 2'
    const kh = chunkSegs(holdingsSegs(KR_HOLIDAY, { mine: false })!);
    expect(kh[0]).toEqual([{ text: "9/23 기준 ·", muted: true }]);
    expect(kh.map(chunkText).at(-1)).toBe("비슷 2");
    // 업종 카드 줄: '강 석유와가스 +3.13% ·' (한 글자 이름표는 다음 낱말과), 긴 업종 이름은 통째로
    expect(texts(sectorCardSegs(AFTERNOON)![0])).toEqual(["강 석유와가스 +3.13% ·", "반도체와반도체장비 +2.80%"]);
    // 줄 끝 한 글자 낱말·개수는 앞 낱말과: '±1%p 안', '(+1.00%p 이상) 2'
    expect(texts([{ text: "미국 3종목 모두 지수와 ±1%p 안" }])).toEqual(["미국 3종목", "모두", "지수와", "±1%p 안"]);
    expect(texts([{ text: "지수보다 높음 (+1.00%p 이상) 2" }])).toEqual(["지수보다", "높음", "(+1.00%p", "이상) 2"]);
    // 받지 못한 칸 '—' 과 괄호 속 날짜는 앞 이름과: '나스닥 —'·'코스피 (9/23) +0.90% ·'
    expect(texts(indexSegs(KR_HOLIDAY)!)).toEqual(["코스피 (9/23) +0.90% ·", "코스닥 (9/23) +1.21%"]);
    expect(texts([{ text: "나스닥 —" }, { text: " · " }, { text: "S&P500 " }, { text: "+0.51%", tone: 0.51 }])).toEqual(["나스닥 — ·", "S&P500 +0.51%"]);
    // 시각 뒤 '생성·마감·기준'은 시각과 한 덩어리: 상세 기준 줄 끝 '08:30 생성'('생성'만 다음 줄로 넘어가지 않게 — 4차 검토)·'오늘 16:30 마감'·'값(16:00 기준) ·'
    expect(texts([{ text: "9/25(금) 뉴욕 장 마감 기준 · 9월 28일 (월) 08:30 생성" }]).at(-1)).toBe("08:30 생성");
    expect(texts([{ text: "장중 값(16:00 기준) · 오늘 16:30 마감" }])).toEqual(["장중", "값(16:00 기준) ·", "오늘 16:30 마감"]);
    expect(texts([{ text: "오늘 21:30 미국 9월 소비자물가(CPI) 발표" }])).toEqual(["오늘 21:30", "미국 9월", "소비자물가(CPI)", "발표"]);
    // 색·흐림은 조각마다 그대로
    const ratesChunks = chunkSegs(ratesSegs(MORNING)!);
    expect(ratesChunks[0]).toEqual([{ text: "원/달러 1,359.00원 " }, { text: "+3.50원", tone: 3.5 }]);
    // 모든 줄·카드 줄: 덩어리를 ' '로 이으면 원래 글 (글자를 바꾸지 않는다), 보이지 않는 글자(WJ·NBSP) 없음, 덩어리 끝·처음은 공백이 아니다
    for (const d of [MORNING, AFTERNOON, KR_HOLIDAY]) {
      const view = at(d.asOf);
      const lines = [...summarySegLines(d, view).map((l) => l.segs), ...cardRows(d, view).flatMap((r) => (r.kind === "news" ? [] : r.lines))];
      for (const segs of lines) {
        const cs = chunkSegs(segs).map(chunkText);
        expect(cs.join(" ")).toBe(segs.map((s) => s.text).join("").trim());
        expect(cs.some((c) => /[⁠ ]/.test(c) || c !== c.trim() || !c)).toBe(false);
      }
    }
    expect(wordGap(font.body, 1)).toBe(4);
    expect(wordGap(font.body, 1.3)).toBe(5);
  });

  it("뉴스 원문 링크는 http(s) 주소만 연다 (javascript:·intent: 는 열지 않는다)", () => {
    expect(newsLink("https://news.google.com/rss/articles/x")).toBe("https://news.google.com/rss/articles/x");
    expect(newsLink(" http://a.b/c ")).toBe("http://a.b/c");
    for (const u of ["javascript:alert(1)", "intent://x#Intent;end", "file:///etc/passwd", "", "https://a b", null, undefined]) expect(newsLink(u), String(u)).toBeNull();
  });

  it("한 줄 괄호 종목(widestOf)은 묶음에서 차이가 가장 큰 것 — 서버가 묶음 안을 부호 그대로 큰 순(낮음은 0에 가까운 것부터)으로 줘도, 같으면 이름 순 앞", () => {
    expect(MORNING.holdings!.low.map((r) => r.name)).toEqual(["팔란티어", "테슬라", "메타"]);
    expect(widestOf(MORNING.holdings!.low)?.name).toBe("메타");
    expect(widestOf(MORNING.holdings!.high)?.name).toBe("마이크로소프트");
    const row = (name: string, diff: number) => ({ ...MORNING.holdings!.low[0]!, name, diff });
    expect(widestOf([row("나", -2.5), row("가", -2.5), row("다", -1.5)])?.name).toBe("가");
    expect(widestOf([])).toBeUndefined();
  });

  it("지수 이름 아래 시각: 미국은 저장한 현지 출처 시각 그대로 '뉴욕 17:15', 한국은 마감 '15:30 마감'(장중 요약이면 출처 시각), 모르면 없음", () => {
    expect(indexSourceTime(MORNING.indices[0]!, MORNING)).toBe("뉴욕 17:15");
    expect(indexSourceTime(MORNING.indices[1]!, MORNING)).toBe("뉴욕 16:39");
    expect(AFTERNOON.indices[0]!.asOf).toMatch(/T20:15/); // 네이버가 값을 다시 적는 시각 — 보이지 않는다
    expect(indexSourceTime(AFTERNOON.indices[0]!, AFTERNOON)).toBe("15:30 마감");
    expect(indexSourceTime(AFTERNOON.indices[0]!, { ...AFTERNOON, closeTime: "16:30" })).toBe("16:30 마감"); // 수능일 (마감 뒤 요약)
    expect(indexSourceTime({ asOf: "2026-11-19T16:00:05+09:00" }, { market: "KR", phase: "intraday", closeTime: "16:30" })).toBe("서울 16:00");
    expect(indexSourceTime({ asOf: null }, MORNING)).toBeNull();
    expect(indexValueLine(AFTERNOON.indices[0]!, "KR")).toMatch(/^7,080\.92 · [+-]/);
    expect(indexValueLine(MORNING.indices[0]!, "US")).toBe("27,068.72");
  });

  it("카드 화면 읽기(card): 카드에 보이는 뉴스 제목 2개를 원문 그대로, 목록 줄은 예전처럼 언론사·시각만", () => {
    const view = at("2026-09-28T08:31:00+09:00");
    const card = cardSpeech(item(7, MORNING), view, { card: true });
    expect(card).toContain("뉴스 3건, 뉴스1 9/26 05:32, [예시] 뉴욕증시 3대 지수 상승 마감…나스닥 0.48%↑, KBS 9/26 05:22, [예시] 뉴욕증시, 기술주 강세 속 상승 마감, 외 1건");
    const row = cardSpeech(item(7, MORNING), view);
    expect(row).toContain("뉴스 3건, 뉴스1 9/26 05:32, KBS 9/26 05:22, 한국경제 9/26 05:38");
    expect(row).not.toContain("[예시]");
    // 휴장 카드처럼 뉴스 줄이 없으면 제목도 없다
    expect(cardSpeech(item(8, KR_HOLIDAY), at("2026-09-25T16:01:00+09:00"), { card: true })).not.toContain("뉴스");
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
