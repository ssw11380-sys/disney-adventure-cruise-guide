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
  GROUP_SPEECH,
  GROUP_TITLE,
  SIMILAR_BAND_BP,
  SIMILAR_NOTE,
  fitLines,
  fitNewsTitle,
  fitNewsLine,
  charEm,
  visibleLength,
  lineEm,
  NEWS_FIT_MARGIN_EM,
  NEWS_MIN_HEAD,
  NEWS_OUTLET_SEP,
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
import { NEWS_CUT_CORPUS } from "./newsCutCorpus";

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

describe("'비슷' 기준은 상수 하나 (6차 검토)", () => {
  it("앱 SIMILAR_BAND_BP 는 서버 값과 같고, 상세 묶음 머리·화면 읽기·안내 글은 그 상수로 만든다", () => {
    const server = /export const SIMILAR_BAND_BP = (\d+);/.exec(readFileSync(join(root, "backend/src/services/marketSummaryCalc.ts"), "utf8"));
    expect(Number(server?.[1])).toBe(SIMILAR_BAND_BP);
    expect(GROUP_TITLE).toEqual({ high: "지수보다 높음 (+1.00%p 이상)", similar: "비슷 (±1.00%p 안)", low: "지수보다 낮음 (-1.00%p 이하)" });
    expect(GROUP_SPEECH).toEqual({ high: "지수보다 높음, 차이 1%포인트 이상", similar: "비슷, 차이 플러스마이너스 1%포인트 안", low: "지수보다 낮음, 차이 마이너스 1%포인트 이하" });
    expect(SIMILAR_NOTE).toBe("'비슷'은 지수와의 차이가 ±1.00%p 안인 종목입니다 (좋고 나쁨의 뜻이 아님).");
    // 상세 화면에 글자로 박아 둔 기준이 남아 있지 않다
    const body = readFileSync(join(root, "app/src/components/MarketSummaryBody.tsx"), "utf8");
    expect(body).not.toMatch(/1\.00%p|1%포인트/);
  });
});

describe("카드 뉴스 한 줄 자르기 (7차 검토 must: 숫자 가운데서 말줄임하지 않는다)", () => {
  /** 서비스 창에서 실제로 뽑힌 제목 가운데 숫자가 든 것 (말뭉치 2026-09-08~25, 구글 뉴스 RSS) */
  const REAL: Array<[string, string]> = [
    ["뉴스1", "[뉴욕마감]국채금리 급등에도 AI주 랠리…나스닥 0.48%↑"],
    ["뉴스1", "[뉴욕마감]국채금리 20년래 최고에 혼조…다우 0.31%↓·나스닥 0.01%↑"],
    ["뉴스1", "[뉴욕마감] 美국채금리 상승에 증시 혼조 마감…다우 0.18%↓"],
    ["뉴시스", "뉴욕증시, AI 훈풍에 상승 마감…나스닥 2.26%↑사상 최고"],
    ["뉴시스", "뉴욕증시, 인플레 우려에 하락…美 10년물 금리 5.11% 돌파"],
    ["마켓인", "유가 101달러·美10년물 4.85% 돌파…뉴욕증시 일제히 하락"],
    ["MTN 머니투데이방송", "뉴욕증시 연준 금리 인상·추가 긴축 우려에 하락…다우 1.21%↓[뉴욕마감]"],
    ["중소기업신문", "뉴욕증시, 유가 하락에 반등…다우 0.98%↑"],
    ["뉴스핌", "[마감시황] 美 국채 금리 영향에…상승하던 코스피 0.85% 하락, 6627 마감"],
    ["머니투데이", "[스팟] 코스피 2.56포인트(0.04%) 내린 6715.41 마감 - 머니투데이"],
    ["뉴스1", "코스피, 0.90% 상승한 7080.92 마감…코스닥 1.21%↑(2보)"],
    ["뉴시스", "코스피 2.68% 상승해 6,894.23 마감"],
    ["연합뉴스", "[오늘의 증시] 코스피 7080선 상승 마감…반도체 강세에도 상승폭은 반납"],
    ["뉴스1", "[코스피] 10.19p(0.15%) 오른 7017.91 마감"],
  ];
  /** 카드 뉴스 줄 폭 = 창 − 카드 안쪽 여백(좌우 space.lg) − 이름표 칸(글자 배율만큼) − 칸 사이 간격 */
  const rowWidth = (win: number, scale: number) => win - 2 * space.lg - Math.round(56 * scale) - space.sm;
  /** 폰 폭 22개 조건: 창 360·384·405~411·430·475dp × 글자 100·130% */
  const PHONE: Array<[number, number]> = [360, 384, 405, 406, 407, 408, 409, 410, 411, 430, 475].flatMap((w): Array<[number, number]> => [
    [w, 1],
    [w, 1.3],
  ]);

  /*
   * 테스트가 따로 보는 '낱말 경계' (검증 보정 4 — 앱의 wordBreaks·정규식·상수를 쓰지 않고 규칙을 그대로 적은 판정. 낱말은 유니코드 글자·숫자 속성으로 가른다):
   *  - 낱말 = 글자·숫자(\p{L}\p{N})와 & 가 붙은 덩어리 — 한글·영문·숫자가 섞여도 한 낱말('SK하이닉스'·'106.6으로'·'국채금리까지'). 'ㆍ'(U+318D)·'ʼ'(U+02BC)는 문장 부호
   *  - 한 낱말로 잇는 것: 숫자 사이 . , : / -, 영문 사이 ' ’ ., 한쪽이 한 글자(한글·한자 1음절, 영문·숫자 2자까지)인 가운뎃점·붙임표·빗금('원·달러'·'미·이란'·
   *    'AI·반도체주'·'K-반도체'·'D-1'), 부호·숫자 덩어리('+1.82%'·'0.48%↑'), 복합 수(숫자…만·천·억·조·년·월·시 + 띄어쓰기 + 숫자 — '7만 8581달러'),
   *    범위·바뀜(숫자가 든 낱말 + → ~ + 숫자 — '2.6%→3.7%'·'6,300~7,600')
   *  - 폭 없는 글자(U+200B~U+200F·U+2060·U+FEFF)는 없는 것처럼 본다
   * 판정: mid = 낱말 가운데서 끝남, trail = 구분자·여는 괄호·짝 없는 따옴표로 끝남, fallback = 낱말 가운데지만 그 앞 낱말 경계로 물리면 보이는 글자가 8자가
   * 안 되는 아주 좁은 칸(앱이 글자 단위로 끊는 문서화된 예외)
   */
  const isWordCh = (c: string | undefined) => !!c && c !== "ㆍ" && c !== "ʼ" && /[\p{L}\p{N}&]/u.test(c);
  const isDig = (c: string | undefined) => !!c && /[0-9]/.test(c);
  const isLat = (c: string | undefined) => !!c && /[A-Za-z]/.test(c);
  const TRAIL_CH = /[\s·ㆍ∙‧・･•,:;；~∼→▶…⋯‥\-‐‑–—/|｜[(（［「『【《〈<{｢〔‘“]$/;
  const unitCache = new Map<string, { vis: string[]; unit: number[]; visAt: number[] }>();
  /** 제목의 보이는 글자와 글자마다 낱말 번호(문장 부호는 -1) */
  const wordUnits = (title: string) => {
    const hit = unitCache.get(title);
    if (hit) return hit;
    const vis: string[] = [];
    const visAt: number[] = [];
    [...title].forEach((c, i) => {
      if (!/[\u200B-\u200F\u2060\uFEFF]/.test(c)) {
        vis.push(c);
        visAt.push(i);
      }
    });
    const m = vis.length;
    const parent = vis.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
    const inW = vis.map((c) => isWordCh(c));
    const join = (a: number, b: number) => {
      inW[a] = inW[b] = true;
      parent[find(a)] = find(b);
    };
    for (let i = 1; i < m; i++) if (inW[i - 1] && inW[i]) join(i - 1, i);
    /** 가운뎃점 한쪽 낱말 (숫자는 소수점·쉼표까지 — '78.3'은 네 글자) */
    const run = (i: number, step: number) => {
      let s = "";
      for (let j = i; j >= 0 && j < m && (isWordCh(vis[j]) || (/[.,:/\-‐‑–]/.test(vis[j]!) && isDig(vis[j - 1]) && isDig(vis[j + 1]))); j += step) s += vis[j];
      return s;
    };
    const oneChar = (s: string) => [...s].length === 1 || /^[A-Za-z0-9]{2}$/.test(s);
    for (let i = 1; i < m - 1; i++) {
      const [a, c, b] = [vis[i - 1], vis[i]!, vis[i + 1]];
      if (
        (/[.,:/\-‐‑–]/.test(c) && isDig(a) && isDig(b)) ||
        (/['’.]/.test(c) && isLat(a) && isLat(b)) ||
        (/[·ㆍ∙‧・･\-‐‑–/]/.test(c) && isWordCh(a) && isWordCh(b) && (oneChar(run(i - 1, -1)) || oneChar(run(i + 1, 1))))
      ) {
        join(i - 1, i);
        join(i, i + 1);
      }
    }
    const text = vis.join("");
    const at: number[] = [];
    vis.forEach((c, q) => [...Array(c.length)].forEach(() => at.push(q)));
    const span = (s: number, e: number) => {
      for (let q = at[s]!; q < at[e - 1]!; q++) join(q, q + 1);
    };
    for (const re of [/[+\-−▲▼△▽]?\d(?:[\d,.:]*\d)?(?:%p|%|bp|pt|p)?[↑↓]?/g, /\d[\d,.]*[만천억조년월시]\s\d/g, /\d[^\s→~∼]{0,4}\s?[→~∼]\s?[+\-−▲▼]?\d/g])
      for (const x of text.matchAll(re)) span(x.index!, x.index! + x[0].length);
    const out = { vis, visAt, unit: vis.map((_, i) => (inW[i] ? find(i) : -1)) };
    unitCache.set(title, out);
    return out;
  };
  /** 보이는 글자 q 개 뒤에서 끊으면 낱말 가운데인지 */
  const midAt = (unit: number[], q: number) => q > 0 && q < unit.length && unit[q - 1] !== -1 && unit[q - 1] === unit[q];
  /** head 끝이 짝 없는 곧은 따옴표인지 (영문 사이 줄임표는 세지 않음) */
  const openStraight = (vis: string[], q: number) => {
    const c = vis[q - 1] ?? "";
    return /['"`＇＂]/.test(c) && vis.slice(0, q).filter((x, i) => x === c && !(isLat(vis[i - 1]) && isLat(vis[i + 1]))).length % 2 === 1;
  };
  type Cut = "mid" | "trail" | "fallback";
  /** 잘린 글 shown('…' 붙음)을 원문 title 에 대어 판정 — 문제가 없으면 null */
  const judgeCut = (title: string, shown: string): { kind: Cut; at: string } | null => {
    const head = shown.replace(/…$/, "");
    if (head === title) return null;
    if (!title.startsWith(head)) return { kind: "mid", at: `원문 앞부분 아님: ${shown}` };
    const { vis, unit } = wordUnits(title);
    let q = [...head].filter((c) => !/[\u200B-\u200F\u2060\uFEFF]/.test(c)).length;
    const at = `${vis.slice(Math.max(0, q - 8), q).join("")}|${vis.slice(q, q + 6).join("")}`;
    if (midAt(unit, q)) {
      // 그 앞 낱말 경계로 물리고 끝 구분자를 떼면 몇 자가 남는지 — 8자보다 적으면 문서화된 아주 좁은 칸 예외
      while (midAt(unit, q)) q--;
      for (;;) {
        const c = vis[q - 1] ?? "";
        if (q > 0 && (TRAIL_CH.test(c) || openStraight(vis, q) || (c === "." && (vis[q - 2] === "." || vis[q] === ".")))) q--;
        else break;
      }
      return { kind: q < 8 ? "fallback" : "mid", at };
    }
    if (TRAIL_CH.test(vis[q - 1] ?? "") || openStraight(vis, q) || /\.\.$/.test(head)) return { kind: "trail", at };
    return null;
  };
  /** 한 줄을 요구 사항대로 모두 본다: 머리가 붙으면 제목 전체·폭 안, 잘리면 원문 앞부분 + '…'·폭 안·낱말 경계·8자 이상 (fallback 은 따로 센다) */
  const checkLine = (n: { outlet: string; title: string }, w: number, scale: number, left: string[], counts: { cut: number; heads: number; fallback: number; two: number }) => {
    const f = fitNewsLine(n, w, font.body, scale);
    const at = `${w}·${scale}: ${f.outlet ? `${f.outlet} · ` : ""}${f.text}`;
    if (f.outlet) {
      counts.heads++;
      if (f.text !== n.title || f.lines !== 1) left.push(`머리+잘림 ${at}`);
      if ((lineEm(`${f.outlet}${NEWS_OUTLET_SEP}${n.title}`) + NEWS_FIT_MARGIN_EM) * font.body * scale > w + 1e-9) left.push(`넘침 ${at}`);
      return;
    }
    if (f.text === n.title && f.lines === 1) return;
    if (f.lines === 2) {
      counts.two++;
      return;
    }
    counts.cut++;
    const head = f.text.replace(/…$/, "");
    if (!f.text.endsWith("…") || !n.title.startsWith(head)) left.push(`앞부분 ${at}`);
    if (visibleLength(head) < NEWS_MIN_HEAD) left.push(`8자 미만 ${at}`);
    if ((lineEm(f.text) + NEWS_FIT_MARGIN_EM) * font.body * scale > w + 1e-9) left.push(`넘침 ${at}`);
    const j = judgeCut(n.title, f.text);
    if (j?.kind === "fallback") counts.fallback++;
    else if (j) left.push(`${j.kind} ${j.at} ${at}`);
  };
  const newCounts = () => ({ cut: 0, heads: 0, fallback: 0, two: 0 });

  it("판정 자체: 낱말 경계 판정이 규칙대로 가른다 (앱 코드와 따로 만든 판정의 예)", () => {
    const t = "유가 100달러·국채금리 5% 뚫자…원·달러 환율 '1400원대' 앞";
    expect(judgeCut(t, "유가 100달러·국채금리 5% 뚫자…원…")?.kind).toBe("mid"); // 원·달러는 한 낱말
    expect(judgeCut(t, "유가 100달러·국채금리 5% 뚫자…")).toBeNull();
    expect(judgeCut(t, "유가 100달러…")).toBeNull(); // 100달러·국채금리는 두 낱말
    expect(judgeCut(t, "유가 100달러·국채금리 5% 뚫자…원·달러 환율 '…")?.kind).toBe("trail");
    expect(judgeCut("유가 다시 100달러 돌파…국채금리까지 증시 압박[뉴욕마감]", "유가 다시 100달러 돌파…국채금리까…")?.kind).toBe("mid");
    expect(judgeCut("[코인뉴스] 비트코인 7만 8581달러…나스닥 하락에도 2.32%↑", "[코인뉴스] 비트코인 7만…")?.kind).toBe("mid"); // 복합 수
    expect(judgeCut("반도체 호황에…OECD, 올해 韓성장률 2.6%→3.7% 상향", "반도체 호황에…OECD, 올해 韓성장률 2.6%…")?.kind).toBe("mid"); // 범위
    expect(judgeCut("[뉴스프레소] 브레이크 없이 치솟는 국채금리… FOMC D-1, 금리 동결이 오히려 악재?", "[뉴스프레소] 브레이크 없이 치솟는 국채금리… FOMC D…")?.kind).toBe("mid");
    expect(judgeCut("Leader’s Advantage Acquisition, 나스닥에서 1억 5천만 달러 IPO 가격 확정", "Leader…")?.kind).toBe("fallback"); // 'Leader’s' 한 낱말, 앞 경계면 0자
    expect(judgeCut("코스피 2.68% 상승해 6,894.23 마감", "코스피 2.68% 상승해 6,894.23…")).toBeNull(); // 숫자도 낱말 — 덩어리 전체 뒤는 경계
  });

  it("다 들어가면 제목 그대로, 아니면 낱말 경계에서 끊고 '…' — '나스닥 0.4…'가 아니라 '나스닥…' (숫자 덩어리는 한 낱말)", () => {
    const t = "[뉴욕마감]국채금리 급등에도 AI주 랠리…나스닥 0.48%↑";
    expect(fitNewsTitle(t, 500, font.body, 1)).toEqual({ text: t, lines: 1 });
    // 폭을 1dp 씩 줄여 가며: 늘 원문의 앞부분 + '…', 낱말 가운데서 끝나지 않고, 어림 폭 + 여유가 줄 폭을 넘지 않는다
    const seen = new Set<string>();
    for (let w = 520; w >= 120; w--) {
      const f = fitNewsTitle(t, w, font.body, 1);
      seen.add(f.text);
      if (f.text === t) continue;
      expect(f.lines, `${w}`).toBe(1);
      expect(f.text.endsWith("…"), `${w}: ${f.text}`).toBe(true);
      expect(t.startsWith(f.text.slice(0, -1)), `${w}: ${f.text}`).toBe(true);
      expect(judgeCut(t, f.text)?.kind ?? "ok", `${w}: ${f.text}`).not.toMatch(/mid|trail/);
      expect((lineEm(f.text) + NEWS_FIT_MARGIN_EM) * font.body, `${w}: ${f.text}`).toBeLessThanOrEqual(w);
    }
    // '0.48%↑' 가 들어가지 않는 폭에서는 숫자 앞 '나스닥' 뒤에서 끊는다
    expect(seen).toContain("[뉴욕마감]국채금리 급등에도 AI주 랠리…나스닥…");
    expect([...seen].some((s) => /\d…$|[.,]…$/.test(s))).toBe(false);
    // 숫자 뒤 단위('선')까지 한 덩어리 — '7,08…'·'7,080…'이 아니라 숫자 앞에서
    const k = "코스피 7,080선 상승 마감…반도체 강세";
    for (let w = 300; w >= 60; w--) expect(fitNewsTitle(k, w, font.body, 1).text, String(w)).not.toMatch(/7,0?8?0?…$|7,080…$/);
  });

  it("검증 보정 5: 통화 기호·'='·'+'·'%' 뒤 낱말·낱말 뒤 화살표 — '…신저가 $…'·'…1달러=…'·'…30년물 5.5%…'·'…일제히…'(↓ 빠짐)로 끝나지 않는다", () => {
    const cases: [string, RegExp][] = [
      ["Wingstop 주가 52주 신저가 $105.40 기록", /[$€£¥₩]…$|\$10?5?\.?4?…$/], // '$105.40' 전체 뒤는 경계(숫자도 낱말), 가운데는 안 됨
      ["Oura, 나스닥 IPO 신청…주당 $40~$44 제시", /[$~]…$|\$40…$/],
      ["엔화, 일본 시장 개입 경계에 1달러=145엔 돌파", /=…$|1달러…$/],
      ["메모리 슈퍼사이클…디램·낸드 공급난+HBM 수요 폭증", /\+…$|공급난…$/],
      ["美 국채금리 급등에 뉴욕증시 혼조…30년물 5.5%까지 올라", /5\.5%…$/],
      ["필라델피아 반도체지수 5.86%급락…엔비디아 약세", /5\.86%…$/],
      ["중동 긴장에 물가 우려...3대 지수 일제히↓ 마감", /일제히…$/],
    ];
    for (const [t, bad] of cases)
      for (const scale of [1, 1.3])
        for (let w = 520; w >= 150; w--) {
          const f = fitNewsTitle(t, w, font.body, scale);
          if (f.text === t || f.lines === 2) continue;
          expect(f.text, `${w}·${scale}`).not.toMatch(bad);
          expect(f.text, `${w}·${scale}`).not.toMatch(/[=+$€£¥₩]…$/);
          expect(t.startsWith(f.text.slice(0, -1)), `${w}·${scale}: ${f.text}`).toBe(true);
        }
    // 붙은 덩어리는 통째로: '5.5%까지'가 다 들어가면 그 뒤에서, 아니면 그 앞에서
    const seen = new Set<string>();
    for (let w = 520; w >= 150; w--) seen.add(fitNewsTitle("美 국채금리 급등에 뉴욕증시 혼조…30년물 5.5%까지 올라", w, font.body, 1).text);
    expect([...seen].some((s) => s.endsWith("30년물…") || s.endsWith("5.5%까지…"))).toBe(true);
  });

  it("8차 검토 must: 복합 수('2만7000선'·'2조4907억원'·'27만3000원'·'7만 8581달러'·'3시30분')는 한 덩어리 — '나스닥 2만…'·'외국인 2조…'처럼 끊지 않는다", () => {
    for (const t of ["[속보] 뉴욕증시, 나스닥 2만7000선 돌파… 국제유가 급락 여파", "코스피, 외국인 2조4907억원 던졌으나 7000선 방어 마감", "삼성전자 27만3000원 4.6% 급등…AI 반도체주 강세에 매수세 집중", "[코인뉴스] 비트코인 7만 8581달러…나스닥 하락에도 2.32%↑", "원·달러 환율 13.6원 오른 1382.2원(오후 3시30분)"])
      for (let w = 420; w >= 100; w--) {
        const f = fitNewsTitle(t, w, font.body, 1);
        expect(judgeCut(t, f.text)?.kind ?? "ok", `${w}: ${f.text}`).not.toMatch(/mid|trail/);
        expect(/(?:2만|2조|27만|7만 ?|3시)…$/.test(f.text), `${w}: ${f.text}`).toBe(false);
      }
  });

  /** 말뭉치(2026-09-08~26 구글 뉴스 RSS)에서 복합 수·시각이 든 제목 전부 (통과 제목 + 서비스 창에서 뽑힌 제목) */
  const COMPOUND: string[] = [
    "코스피, 외국인 2조4907억원 던졌으나 7000선 방어 마감",
    "증시 활황에…국내 자산운용사 2분기 순이익 2조7000억원 육박",
    "[코인뉴스] 비트코인 7만 8581달러…나스닥 하락에도 2.32%↑",
    "뉴암스테르담 파마 주가, CEO 22만 6,500달러 주식 매입 후 상승",
    "전력 반도체로 말 갈아탄 인피니언…특수 메모리 판 1조 5000억에 넘겼다",
    "원·달러 환율 13.6원 오른 1382.2원(오후 3시30분)",
    "[26.9.17 증시 인싸잇] 코스피, 외국인 2조 2772억 매도에 약보합… 6715선 마감",
    "NH투자증권 주가 급락에…농협금융, 1천500억 장내매수",
    "외국인, 8개월 만에 주식 순매수…채권은 4조7천억원 회수",
    "비트코인 변동성 둔화…美 증시 반등 속 7만6500달러선 횡보",
    "Leader’s Advantage Acquisition, 나스닥에서 1억 5천만 달러 IPO 가격 확정",
    "8월 외국인 주식 3440억 순매수·채권 4조7360억 순회수…4조3900억 유출",
    "[일본 증시] 닛케이, 반도체株·엔화 약세에 상승...6만5000선 재진입",
    "닛케이, 금리 인상 소화하며 6만5000선 회복… 반도체 독식 장세",
    "오리온180 보험, 상장 첫날 주가 하락 속 기업가치 11억 4천만 달러 평가",
    "비트코인, 2주만에 8만1000달러 회복…솔라나 11% 급등",
    "서학개미, 14~17일 나흘간 미 증시 13억1,400만 달러(약 1조8,200억원) 순매수하며 월간 순매수 전환",
    "비트코인 8만1000달러 회복에 국내 가상화폐 관련주 강세",
    "삼성전자 27만3000원 4.6% 급등…AI 반도체주 강세에 매수세 집중",
    "김천에 반도체 생태계 조성…3천470억 원 규모 TGV 유리기판 공장 유치",
    "원·달러 환율 2.3원 내린 1381.0원(오후 3시30분)",
    "[속보] 뉴욕증시, 나스닥 2만7000선 돌파… 국제유가 급락 여파",
    "[오늘의증시] 코스피, 삼성전자 5% 급등에 7000선 탈환…기관 1조5천억원 순매수",
    "미 증시 시총 하루 1조2000억달러 늘었다는 주장",
    "원·달러 환율 22.8원 내린 1358.2원(오후 3시30분)",
    "[표] 개인, 코스피서 1조4543억원 순매도…삼성전자 집중 매도",
    "외국인 유출액 4,682억 6천만 루피아, BBRI는 여전히 최대 매도 종목",
    "비트코인, 금리 인상 우려에 8만4천달러선으로 하락…미 증시도 동반 약세 (BTC, 금리인상, 미국 증시, 나스닥)",
    "삼성전자 반도체(DS) 부문, 세계 최고가 사무용 의자 7만5000명에게 순차 지급",
    "외국인 투자자금 1조 4,200억 루피아 순유출, 국영기업 주식이 매도 상위 차지",
    "Live Oak Acquisition Corp. VI, 나스닥 IPO로 2억 3천만 달러 조달",
    "Bluerock Acquisition Corp. II, 나스닥에서 1억 5천만 달러 IPO 가격 책정",
    "Leader’s Advantage, 나스닥에서 1억 5천만 달러 규모 스팩 IPO 완료",
    "Leader’s Advantage Acquisition Corp., 나스닥에서 1억 5천만 달러 IPO 완료",
    "9월 4주차 우리기술 주가 하락폭 확대 1만2980원 기록",
    "[뉴욕증시 28일] 나스닥지수 1만7000 돌파 마감",
  ];

  it("말뭉치의 복합 수 제목 전부: 폭 475·411 × 글자 100%·130% 에서 낱말(숫자 덩어리) 가운데서 끊기지 않고, 어림 폭이 줄 폭을 넘지 않는다", () => {
    expect(COMPOUND.length).toBeGreaterThanOrEqual(34);
    const left: string[] = [];
    const c = newCounts();
    for (const title of COMPOUND) for (const win of [475, 411]) for (const scale of [1, 1.3]) checkLine({ outlet: "", title }, rowWidth(win, scale), scale, left, c);
    expect(left).toEqual([]);
    expect(c.two + c.fallback).toBe(0);
    expect(c.cut).toBeGreaterThan(40);
  });

  it("서비스 창에 실제로 뽑힌 제목(숫자가 든 14건): 폰 폭 475·411·360, 글자 100%·130% 에서 낱말 경계에서 끊기고, 제목이 '…'만 남지 않는다 (8자 이상)", () => {
    const left: string[] = [];
    const c = newCounts();
    for (const [, title] of REAL) for (const win of [475, 411, 360]) for (const scale of [1, 1.3]) checkLine({ outlet: "", title }, rowWidth(win, scale), scale, left, c);
    expect(left).toEqual([]);
    expect(c.two + c.fallback).toBe(0);
    expect(c.cut).toBeGreaterThan(20); // 좁은 폭에서는 대부분 잘린다 (자르는 길이 실제로 쓰였다)
  });

  it("줄 끝 빈 곳: 실측 표(한글 0.92)로 잘라 475·411 × 100·130% 에서 잘린 줄의 남는 폭(어림) 가운데 값이 한글 2자 이하, 여유보다 좁지 않다 (낱말 경계에서만 끊어도)", () => {
    const tails: number[] = [];
    for (const title of [...REAL.map((r) => r[1]), ...COMPOUND])
      for (const win of [475, 411])
        for (const scale of [1, 1.3]) {
          const width = rowWidth(win, scale);
          const f = fitNewsTitle(title, width, font.body, scale);
          if (f.text === title) continue;
          tails.push(width / (font.body * scale) - lineEm(f.text));
        }
    tails.sort((a, b) => a - b);
    const median = tails[Math.floor(tails.length / 2)]!;
    expect(median).toBeLessThanOrEqual(2 * 0.92);
    expect(tails[0]!).toBeGreaterThanOrEqual(NEWS_FIT_MARGIN_EM - 1e-9);
    // 글자 폭 어림: 한글 0.92, 숫자·영문·문장 부호는 실측 표, 모르는 글자(한자·전각)는 1
    expect(lineEm("가나다")).toBeCloseTo(2.76);
    expect(lineEm("0123456789")).toBeCloseTo(5.7);
    expect(lineEm("…·")).toBeCloseTo(1.01);
    expect(lineEm("美【")).toBe(2);
  });

  it("아주 좁은 칸(큰 글씨 + 좁은 창)에서는 '…'만 남기지 않고 두 줄에 앞부분 8자 이상", () => {
    const t = "[뉴욕마감]국채금리 급등에도 AI주 랠리…나스닥 0.48%↑";
    for (let w = 160; w >= 60; w -= 4) {
      const f = fitNewsTitle(t, w, font.body, 2);
      expect(f.text, String(w)).not.toBe("…");
      expect(Array.from(f.text.replace(/…$/, "")).length, `${w}: ${f.text}`).toBeGreaterThanOrEqual(NEWS_MIN_HEAD);
      if (f.lines === 1) expect(Array.from(f.text).length, `${w}: ${f.text}`).toBeGreaterThan(NEWS_MIN_HEAD);
      expect(/0\.4?…$|0\.…$/.test(f.text), `${w}: ${f.text}`).toBe(false);
    }
    expect(fitNewsTitle(t, 120, font.body, 2).lines).toBe(2);
    expect(fitNewsTitle(t, rowWidth(411, 1.3), font.body, 1.3).lines).toBe(1);
  });

  /** 말뭉치 픽스처 6)절 — 검증 보정 4에서 짚은 제목 */
  const FIX4 = NEWS_CUT_CORPUS.slice(NEWS_CUT_CORPUS.findIndex(([, t]) => t.startsWith("50대 이상 주식투자")));
  const titleOf = (start: string) => NEWS_CUT_CORPUS.find(([, t]) => t.startsWith(start))![1];

  it("검증 보정 4 must: 낱말 경계에서만 끊는다 — 검증이 짚은 실제 제목이 낱말 가운데('…국채금리까…'·'…반도체주까…'·'…공모가보…'·'…원…'(원·달러)·'…106.6으…')에서 끝나지 않는다", () => {
    for (const [start, win, scale, want] of [
      ["유가 2% 급락하자", 409, 1, "유가 2% 급락하자 뉴욕증시 웃었다…"],
      ["유가 다시 100달러 돌파", 409, 1.3, "유가 다시 100달러 돌파…"],
      ["50대 이상 주식투자", 360, 1, "50대 이상 주식투자 660만 명…"],
      ["한국제17호스팩", 430, 1, "한국제17호스팩, 코스닥 상장 첫날 장중 주가…"],
      ["[뉴욕증시 14일] 국채금리·유가", 430, 1, "[뉴욕증시 14일] 국채금리·유가 상승에 AI…"],
      ["[추석증시]", 475, 1, "[추석증시] ㊤ 코스피 고향 가도 뉴욕은 3연전···미·중…"],
      ["매그나칩, 나비타스", 360, 1.3, "매그나칩, 나비타스…"],
      ["유가 100달러·국채금리 5% 뚫자", 411, 1.3, "유가 100달러·국채금리 5% 뚫자…"],
      ["증시 진정되고 소득 기대", 409, 1, "증시 진정되고 소득 기대 커지며 소비심리…"],
      ["반도체 호황에…OECD", 384, 1, "반도체 호황에…OECD, 올해 韓성장률…"],
      ["삼성자산운용, KODEX 미국반도체에", 475, 1.3, "삼성자산운용, KODEX 미국반도체에…"],
      ["[오늘의 글로벌마켓] 뉴욕증시, 미-이란", 411, 1.3, "[오늘의 글로벌마켓] 뉴욕증시…"],
    ] as const)
      expect(fitNewsTitle(titleOf(start), rowWidth(win, scale), font.body, scale).text, `${start} ${win}·${scale}`).toBe(want);
    // 6)절 제목 전부 × 폭 200~620dp × 100·130%: 낱말 가운데·구분자로 끝나는 줄 없음 (아주 좁은 칸 예외만)
    expect(FIX4.length).toBe(22);
    const left: string[] = [];
    const c = newCounts();
    for (const [outlet, title] of FIX4) for (const scale of [1, 1.3]) for (let w = 620; w >= 200; w--) checkLine({ outlet, title }, w, scale, left, c);
    expect(left).toEqual([]);
    expect(c.cut).toBeGreaterThan(9_000);
  });

  it("가운뎃점·붙임표·빗금: 한쪽이 한 글자면 한 낱말('원·달러'·'미·이란'·'미-이란'·'K-반도체'·'FOMC D-1'), 두 쪽 다 길면 낱말 사이('100달러·국채금리'·'미국-이란'·'삼전·닉스')", () => {
    const shown = (t: string) => {
      const s = new Set<string>();
      for (const scale of [1, 1.3]) for (let w = 620; w >= 100; w--) s.add(fitNewsTitle(t, w, font.body, scale).text);
      return s;
    };
    const has = (t: string, re: RegExp) => [...shown(t)].some((x) => re.test(x));
    // 한 글자 쪽이 있는 낱말은 가운데서 끝나지 않는다
    expect(has(titleOf("유가 100달러·국채금리 5% 뚫자"), /…원…$/)).toBe(false);
    expect(has(titleOf("[지난밤 뉴욕에선] 3대 지수, 미·이란"), /미…$/)).toBe(false);
    expect(has(titleOf("[오늘의 글로벌마켓] 뉴욕증시, 미-이란"), /미…$/)).toBe(false);
    expect(has(titleOf("트럼프-시진핑 ‘반도체 빅딜’"), /K…$/)).toBe(false);
    expect(has(titleOf("[뉴스프레소]"), /D…$/)).toBe(false);
    expect(has(titleOf("유가 2% 급락하자"), /AI…$/)).toBe(false);
    // 두 쪽 다 긴 낱말은 가운뎃점·붙임표 앞에서 끊을 수 있다
    expect(shown(titleOf("유가 100달러·국채금리 5% 뚫자"))).toContain("유가 100달러…");
    expect(has(titleOf("이틀째 급락 원·달러"), /…미국…$/)).toBe(true);
    expect(has(titleOf("미 금리인상 하루 만에"), /…삼전…$/)).toBe(true);
  });

  it("검증 보정 2: 가운뎃점 'ㆍ'(U+318D)는 '·'처럼 가운뎃점 — '…우려ㆍ국…'·'…네오사피엔스ㆍ파…'가 아니라 '…우려…'·'…네오사피엔스…'", () => {
    const fed = "뉴욕증시, 연준 추가 인상 우려ㆍ국채금리 급등에 하락 [종합]";
    const best = "[베스트&워스트] 네오사피엔스ㆍ파두 웃고⋯상폐 악재에 코스닥 무더기 급락";
    expect(fitNewsTitle(fed, 219, font.body, 1).text).toBe("뉴욕증시, 연준 추가 인상 우려…");
    expect(fitNewsTitle(best, 230, font.body, 1).text).toBe("[베스트&워스트] 네오사피엔스…");
    // 'ㆍ' 제목 전부: 폭을 1dp씩 줄여도 'ㆍ…'로 끝나거나 'ㆍ' 뒤 낱말 가운데서 끝나지 않는다
    const dots = NEWS_CUT_CORPUS.filter(([, t]) => t.includes("ㆍ"));
    expect(dots.length).toBeGreaterThanOrEqual(8);
    const left: string[] = [];
    const c = newCounts();
    for (const [outlet, title] of dots) for (const scale of [1, 1.3]) for (let w = 620; w >= 200; w--) checkLine({ outlet, title }, w, scale, left, c);
    expect(left).toEqual([]);
  });

  it("검증 보정 2 must: 영문·숫자가 섞인 낱말도 한 낱말 — 'SK하이|닉스'·'원익IPS|까지'·'6,600선|에서' 가운데서 끊지 않고 그 낱말 앞에서", () => {
    const sk = { outlet: "일간투데이", title: "삼성자산운용, KODEX 미국반도체에 SK하이닉스 ADR 신규 편입" };
    const ips = { outlet: "핀포인트뉴스", title: "[코스닥 외국인] 하나마이크론부터 원익IPS까지… 반도체주 집중 공략" };
    expect(fitNewsLine(sk, rowWidth(475, 1.3), font.body, 1.3)).toEqual({ outlet: null, text: "삼성자산운용, KODEX 미국반도체에…", lines: 1 });
    expect(fitNewsLine(ips, rowWidth(475, 1.3), font.body, 1.3)).toEqual({ outlet: null, text: "[코스닥 외국인] 하나마이크론부터…", lines: 1 });
    for (const [n, word] of [
      [sk, "SK하이닉스"],
      [ips, "원익IPS까지"],
    ] as const) {
      const at = n.title.indexOf(word);
      const shown = new Set<string>();
      for (const scale of [1, 1.3])
        for (let w = 620; w >= 100; w--) {
          const f = fitNewsLine(n, w, font.body, scale);
          if (f.lines !== 1 || f.text === n.title) continue;
          const head = f.text.replace(/…$/, "");
          shown.add(f.text);
          // 끊은 자리가 그 낱말 안이 아니다 (물리면 8자보다 짧아지는 아주 좁은 폭만 예외)
          if (head.length > at && head.length < at + word.length) expect(judgeCut(n.title, f.text)?.kind, `${w}·${scale}: ${f.text}`).toBe("fallback");
        }
      expect(shown, word).toContain(`${n.title.slice(0, at).trimEnd()}…`);
    }
    // 뒤에 토씨가 붙은 숫자 낱말('6,600선에서')도 한 낱말이라 통째로 앞에서
    expect(fitNewsTitle("코스피, 장 초반 6,600선에서 등락 반복‥코스닥 하락 출발", 175, font.body, 1).text).toBe("코스피, 장 초반…");
  });

  it("SS3/SS7: 폭 없는 글자(U+200B~U+200F·U+2060·U+FEFF)는 폭 0 — 실제 아주경제 '[속보] +U+200B×7 코스피, 63.01p(0.90%) 오른 7080.92 마감'이 보이는 제목과 같게 잘린다", () => {
    const ZW = "​".repeat(7);
    const clean = "[속보] 코스피, 63.01p(0.90%) 오른 7080.92 마감";
    const raw = `[속보] ${ZW}코스피, 63.01p(0.90%) 오른 7080.92 마감`;
    expect(lineEm(raw)).toBeCloseTo(lineEm(clean));
    for (const ch of ["​", "‌", "‍", "‎", "‏", "⁠", "﻿"]) expect(charEm(ch), ch.codePointAt(0)!.toString(16)).toBe(0);
    expect(visibleLength(raw)).toBe(Array.from(clean).length);
    // 355dp(475 접은 화면 100%)에서는 다 들어간다 (예전에는 '…오른…'으로 잘림), 274dp(411·130%)·200dp 에서도 보이는 제목과 같은 자리까지
    expect(fitNewsTitle(raw, 355, font.body, 1)).toEqual({ text: raw, lines: 1 });
    for (const [w, s] of [
      [rowWidth(411, 1.3), 1.3],
      [200, 1],
      [150, 1],
    ] as const) {
      const a = fitNewsTitle(raw, w, font.body, s);
      const b = fitNewsTitle(clean, w, font.body, s);
      expect(a.text.replace(/​/g, ""), `${w}`).toBe(b.text);
      expect(a.lines).toBe(b.lines);
      expect(visibleLength(a.text.replace(/…$/, ""))).toBeGreaterThanOrEqual(NEWS_MIN_HEAD);
    }
  });

  /**
   * 머리 규칙(검증 보정 2)을 한 줄에 대해 확인한다 — 머리는 머리를 붙이고도 제목 전체가 한 줄에 들어갈 때만: 머리가 붙은 줄은 늘 제목 전체·한 줄·폭 안이고,
   * 머리가 없으면 제목만 둔 줄(fitNewsTitle) 그대로. 그래서 머리가 방향 낱말·숫자를 밀어내는 일이 없다
   */
  const checkHead = (n: { outlet: string; title: string }, w: number, scale: number) => {
    const f = fitNewsLine(n, w, font.body, scale);
    const plain = fitNewsTitle(n.title, w, font.body, scale);
    const at = `${w}·${scale}: ${f.outlet ?? ""} · ${f.text}`;
    const fits = (lineEm(`${n.outlet.trim()}${NEWS_OUTLET_SEP}${n.title}`) + NEWS_FIT_MARGIN_EM) * font.body * scale <= w + 1e-9;
    if (!f.outlet) {
      expect(f, at).toEqual({ ...plain, outlet: null });
      // 머리 + 제목 전체가 들어가는데 머리를 빼지 않는다 (언론사가 있을 때)
      if (n.outlet.trim()) expect(fits, at).toBe(false);
      return false;
    }
    expect(f, at).toEqual({ outlet: n.outlet.trim(), text: n.title, lines: 1 });
    expect(fits, at).toBe(true);
    return true;
  };

  it("SS5/SS11 · 검증 보정 2: 카드 뉴스 줄 언론사 머리 — 머리를 붙이고도 제목 전체가 들어갈 때만 '연합뉴스 · 제목', 아니면 제목만 (잘린 제목에는 붙이지 않는다, 두 줄 모드에도)", () => {
    const n = { outlet: "연합뉴스", title: "[뉴욕마감]국채금리 급등에도 AI주 랠리…나스닥 0.48%↑" };
    // 넓으면 머리 + 제목 전체
    expect(fitNewsLine(n, 600, font.body, 1)).toEqual({ outlet: "연합뉴스", text: n.title, lines: 1 });
    // 짧은 제목은 다 들어가면 머리를 붙인다
    expect(fitNewsLine({ outlet: "뉴스1", title: "코스피 상승 마감" }, 200, font.body, 1)).toEqual({ outlet: "뉴스1", text: "코스피 상승 마감", lines: 1 });
    let withHead = 0;
    let without = 0;
    for (let w = 600; w >= 60; w--) {
      if (checkHead(n, w, 1)) withHead++;
      else without++;
    }
    expect(withHead).toBeGreaterThan(50);
    expect(without).toBeGreaterThan(50);
    // 머리 + 제목 전체가 들어가지 않는 폭부터는 제목만
    expect(fitNewsLine(n, 300, font.body, 1)).toEqual({ outlet: null, text: "[뉴욕마감]국채금리 급등에도 AI주 랠리…나스닥…", lines: 1 });
    // 언론사가 없거나 두 줄 모드면 머리 없음
    expect(fitNewsLine({ outlet: "", title: n.title }, 600, font.body, 1).outlet).toBeNull();
    expect(fitNewsLine(n, 120, font.body, 2)).toEqual({ ...fitNewsTitle(n.title, 120, font.body, 2), outlet: null });
    // 폰 폭(475·411 × 100·130%)에서 실제로 뽑힌 제목: 카드 줄은 한 줄, 머리가 붙으면 제목 전체
    for (const [outlet, title] of REAL)
      for (const win of [475, 411])
        for (const scale of [1, 1.3]) {
          expect(fitNewsLine({ outlet, title }, rowWidth(win, scale), font.body, scale).lines).toBe(1);
          checkHead({ outlet, title }, rowWidth(win, scale), scale);
        }
  });

  it("검증 should·보정 2: 머리가 제목을 해치지 않는다 — 'BBS불교방송 · …국채금…'·'연합뉴스 · …상승…유…'·'아주경제 · …상승에 일제히…'(제목만이면 '…일제히 하락…')가 되지 않는다", () => {
    const bbs = { outlet: "BBS불교방송", title: "미국 뉴욕증시, 국채금리 급등에 약세…나스닥 1%대 하락" };
    const yna = { outlet: "연합뉴스", title: "코스피, 미 금리인상에도 상승…유가 하락 영향" };
    const aju = { outlet: "아주경제", title: "[뉴욕증시 마감] 美국채 금리·유가 상승에 일제히 하락…나스닥 1%대↓" };
    // 411·130%·411·100%: 제목만 낱말 사이에서 (예전 'BBS불교방송 · 미국 뉴욕증시, 국채금…'·'BBS불교방송 · 미국 뉴욕증시, 국채금리 급등에 약세…')
    expect(fitNewsLine(bbs, rowWidth(411, 1.3), font.body, 1.3)).toEqual({ outlet: null, text: "미국 뉴욕증시, 국채금리 급등에 약세…", lines: 1 });
    expect(fitNewsLine(bbs, rowWidth(411, 1), font.body, 1)).toEqual({ outlet: null, text: "미국 뉴욕증시, 국채금리 급등에 약세…나스닥 1%대…", lines: 1 });
    // 475·130%·411·100%: 제목만이면 다 들어가므로 머리 없이 제목 전체 (예전 '연합뉴스 · 코스피, 미 금리인상에도 상승…유…')
    for (const [win, scale] of [
      [475, 1.3],
      [411, 1],
    ] as const) {
      expect(fitNewsTitle(yna.title, rowWidth(win, scale), font.body, scale).text).toBe(yna.title);
      expect(fitNewsLine(yna, rowWidth(win, scale), font.body, scale), `${win}·${scale}`).toEqual({ outlet: null, text: yna.title, lines: 1 });
    }
    // 475·100%: 머리를 붙여도 다 들어가면 붙인다
    expect(fitNewsLine(yna, rowWidth(475, 1), font.body, 1)).toEqual({ outlet: "연합뉴스", text: yna.title, lines: 1 });
    // 잘리는 제목에는 머리가 없어서, 제목만 둔 줄에 보이던 방향 낱말('하락')·숫자가 머리 때문에 빠지지 않는다
    for (const scale of [1, 1.3])
      for (let w = 560; w >= 100; w--) {
        const f = fitNewsLine(aju, w, font.body, scale);
        if (f.text !== aju.title) expect(f, `${w}·${scale}`).toEqual({ ...fitNewsTitle(aju.title, w, font.body, scale), outlet: null });
      }
    // 폭을 1dp씩 줄여도 규칙이 늘 지켜진다
    for (const n of [bbs, yna, aju, ...FIX4.slice(0, 8).map(([outlet, title]) => ({ outlet, title }))]) for (const scale of [1, 1.3]) for (let w = 560; w >= 100; w--) checkHead(n, w, scale);
  });

  it("검증 보정 4: 폰 폭(창 360·384·405~411·430·475dp × 글자 100·130%)에서 말뭉치 픽스처 제목 전부 — 낱말 가운데·구분자로 끝나는 줄·넘침·8자 미만이 없고, 머리가 붙은 줄은 제목 전체", () => {
    const left: string[] = [];
    const c = newCounts();
    for (const [outlet, title] of NEWS_CUT_CORPUS) for (const [win, scale] of PHONE) checkLine({ outlet, title }, rowWidth(win, scale), scale, left, c);
    expect(left).toEqual([]);
    expect(c.two).toBe(0);
    // 아주 좁은 칸 예외는 폰 폭에서 글자 130%·360·384 창 몇 줄뿐 (말뭉치 픽스처 기준)
    expect(c.fallback).toBeLessThanOrEqual(10);
    expect(c.cut).toBeGreaterThan(3000);
  });

  it("검증 보정 4: 말뭉치 픽스처 전부(1~6절) × 폭 200~620dp(1dp마다) × 글자 100·130% — 따로 만든 낱말 경계 판정으로 낱말 가운데·구분자로 끝나는 줄·넘침·8자 미만이 없고(아주 좁은 칸 예외만), 머리가 붙은 줄은 늘 제목 전체", () => {
    expect(NEWS_CUT_CORPUS.length).toBeGreaterThanOrEqual(286);
    const left: string[] = [];
    const c = newCounts();
    let maxFallbackW = 0;
    for (const [outlet, title] of NEWS_CUT_CORPUS)
      for (const scale of [1, 1.3])
        for (let w = 620; w >= 200; w--) {
          const before = c.fallback;
          checkLine({ outlet, title }, w, scale, left, c);
          if (c.fallback > before) maxFallbackW = Math.max(maxFallbackW, w);
        }
    expect(left).toEqual([]);
    expect(c.cut).toBeGreaterThan(90_000); // 폭마다 대부분 잘린다 (자르는 길이 실제로 쓰였다)
    expect(c.heads).toBeGreaterThan(10_000); // 넓은 폭에서는 머리 + 제목 전체
    // 아주 좁은 칸 예외(낱말 경계로 물리면 8자가 안 됨)는 줄 폭 300dp 아래에서만
    expect(maxFallbackW).toBeLessThan(300);
  });
});
