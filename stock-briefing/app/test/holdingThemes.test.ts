import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { HoldingThemes, HoldingThemesSnapshot, HtGroup } from "@/api/types";
import {
  accountThemesView,
  allAppTexts,
  byHoldingView,
  dayShort,
  holdingThemesEvery,
  defaultMarket,
  holdingLabel,
  marketChips,
  marketView,
  mostView,
  rowView,
  statusView,
  tvSpeech,
  tvText,
} from "@/lib/holdingThemes";

/**
 * 3-35 내 종목 테마 — 앱 보기 모델 (순수): 줄 문구·화면 읽기 문장·거래대금 5상태·레버리지/인버스 표시·'외 N종목'·높은/낮은 3개·계좌 카드 줄·문구 검사
 */

/** 서버 검사기의 금지어·미래형 + 이 기능이 더 막는 말 (backend 파일을 그대로 읽는다) */
const score = readFileSync(new URL("../../backend/src/analysis/scoreWording.ts", import.meta.url), "utf8");
const calc = readFileSync(new URL("../../backend/src/services/holdingThemesCalc.ts", import.meta.url), "utf8");
const BANNED = new RegExp(/SCORE_BANNED_RE =\s*\/(.+)\/;/.exec(score)![1]!, "g");
const FUTURE = new RegExp(/SCORE_FUTURE_RE = \/(.+)\/;/.exec(score)![1]!, "g");
const THEME = new RegExp(/THEME_BANNED_RE = \/(.+)\/;/.exec(calc)![1]!, "g");
const clean = (s: string) => {
  expect(s.match(BANNED), s).toBeNull();
  expect(s.match(FUTURE), s).toBeNull();
  expect(s.match(THEME), s).toBeNull();
};

const tv = (over: Partial<HtGroup["tradingValue"]> = {}): HtGroup["tradingValue"] => ({ today: 1.8e7, avg: 1e7, days: 12, ratioPct: 182, state: "final", day: "2026-09-25", currency: "USD", ...over });
const group = (over: Partial<HtGroup> & Pick<HtGroup, "key" | "name">): HtGroup => ({
  market: "US",
  kind: "theme",
  id: over.key.split(":")[2]!,
  day: { changeRate: 1, up: 3, flat: 0, down: 1 },
  week: { changeRate: 2, up: null, flat: null, down: null },
  tradingValue: tv(),
  inDiscoverList: true,
  holdings: [],
  ...over,
});

const QUANTUM = group({
  key: "US:theme:956",
  name: "양자컴퓨터",
  day: { changeRate: 6.21, up: 8, flat: 0, down: 2 },
  holdings: [{ code: "RGTX", name: "RGTX", via: { code: "RGTI", name: "리게티 컴퓨팅", L: 2, inverse: false, index: null }, changeRate: 12.4, inCalc: true }],
});

const US_GROUPS: HtGroup[] = [
  QUANTUM,
  group({ key: "US:theme:179", name: "반도체팹리스", day: { changeRate: 2.1, up: 20, flat: 1, down: 9 }, holdings: [
    { code: "NVDA", name: "엔비디아", via: null, changeRate: 1.2, inCalc: true },
    { code: "AVGO", name: "브로드컴", via: null, changeRate: -0.3, inCalc: true },
    { code: "AMD", name: "AMD", via: null, changeRate: 2, inCalc: true },
    { code: "SMALL", name: "작은회사", via: null, changeRate: 5, inCalc: false },
    { code: "QCOM", name: "퀄컴", via: null, changeRate: 0.5, inCalc: true },
  ] }),
  group({ key: "US:theme:389", name: "소프트웨어", day: { changeRate: 1.4, up: 15, flat: 0, down: 15 } }),
  group({ key: "US:theme:359", name: "인터넷", day: { changeRate: -1.1, up: 5, flat: 0, down: 25 } }),
  group({ key: "US:theme:475", name: "클라우드", day: { changeRate: -0.8, up: 8, flat: 0, down: 22 } }),
  group({ key: "US:theme:203", name: "스마트폰제조", day: { changeRate: -0.3, up: 1, flat: 0, down: 2 } }),
  group({ key: "US:sector:57101010", name: "반도체", kind: "sector", day: { changeRate: 2.3, up: 30, flat: 1, down: 10 }, week: { changeRate: 4.6, up: 35, flat: 0, down: 6 }, holdings: [{ code: "SOXS", name: "SOXS", via: { code: "SOXS", name: "반도체 지수", L: 3, inverse: true, index: null }, changeRate: -6.9, inCalc: null }] }),
];
const KR_GROUPS: HtGroup[] = [
  group({ key: "KR:theme:543", name: "HBM(고대역폭메모리)", market: "KR", day: { changeRate: -4.12, up: 1, flat: 0, down: 2 }, week: { changeRate: 5.1, up: 3, flat: 0, down: 0 }, tradingValue: tv({ state: "partial", ratioPct: 62, currency: "KRW", days: 20 }), holdings: [{ code: "005930", name: "삼성전자", via: null, changeRate: -5, inCalc: null }] }),
  group({ key: "KR:sector:278", name: "반도체와반도체장비", market: "KR", kind: "sector", day: { changeRate: -5.47, up: 10, flat: 2, down: 40 }, tradingValue: tv({ state: "collecting", ratioPct: null, days: 3, currency: "KRW" }) }),
];

const D: HoldingThemes = {
  enabled: true,
  asOf: "2026-09-29T11:00:00+09:00",
  markets: {
    US: { session: "closed", marketOpen: false, asOf: "2026-09-29T05:00:00+09:00", tvDay: "2026-09-28", preparing: false, note: null, weekNote: "1주는 상승·하락 종목 수 없이 등락률만", heldValue: 30_000_000 },
    KR: { session: "regular", marketOpen: true, asOf: "2026-09-29T11:00:00+09:00", tvDay: "2026-09-29", preparing: false, note: null, weekNote: null, heldValue: 9_000_000 },
  },
  coverage: { held: 17, mapped: 15, unmapped: [{ code: "QQQ", name: "QQQ", market: "US", reason: "index", text: "QQQ · 나스닥100 지수 전체를 따르는 상품이라 테마로 묶지 않았습니다" }, { code: "ABCD", name: "ABCD", market: "US", reason: "none", text: "ABCD · 미분류 · 테마·업종 정보가 없습니다" }] },
  mostHeld: [
    { key: "US:theme:179", name: "반도체팹리스", count: 3, codes: ["NVDA", "AVGO", "AMD"] },
    { key: "US:theme:823", name: "인공지능", count: 3, codes: ["NVDA", "MSFT", "AMZN"] },
    { key: "US:theme:956", name: "양자컴퓨터", count: 2, codes: ["RGTX", "RGTI"] },
  ],
  groups: [...US_GROUPS, ...KR_GROUPS],
  byHolding: [{ code: "005930", name: "삼성전자", market: "KR", keys: ["KR:theme:543", "KR:sector:278"] }],
  basis: ["기준: 등락률과 오른·내린 종목 수는 발견 탭과 같은 값입니다."],
  krIndexAt: "9월 27일 (일) 05:40",
  disclaimer: "투자 판단의 책임은 본인에게 있으며, 본 서비스는 투자 권유가 아닙니다.",
};

describe("테마 한 줄 (설계 2.2 ⑤)", () => {
  it("오늘: 종류·넓이, 거래대금, 내 종목(레버리지 표시), 화면 읽기 한 문장, 누르면 발견 탭 테마 상세", () => {
    const r = rowView(QUANTUM, "day");
    expect(r.rateText).toBe("+6.21%");
    expect(r.kindLine).toBe("미국 테마 · 오른 8 · 내린 2 · 보합 0");
    expect(r.tvLine).toBe("거래대금 평소의 182%");
    expect(r.holdings).toEqual([{ label: "RGTX(리게티 컴퓨팅 2배)", rate: 12.4, rateText: "+12.40%", note: null }]);
    expect(r.speech).toBe(
      "양자컴퓨터, 미국 테마, 오늘 6.21% 상승, 오른 종목 8개, 내린 종목 2개, 보합 0개, 거래대금 평소의 182퍼센트, 최근 12거래일 평균 기준, 내 종목 RGTX, 리게티 컴퓨팅 2배 상품, 12.40% 상승. 누르면 발견 탭 테마 상세",
    );
    expect(r.href).toBe("/discover/theme/956?market=US&kind=theme&name=%EC%96%91%EC%9E%90%EC%BB%B4%ED%93%A8%ED%84%B0&period=day&rate=6.21");
  });

  it("1주: 미국 테마는 넓이 없이 종류만, 거래대금 줄 없음, 상세도 1주로", () => {
    const r = rowView(QUANTUM, "week");
    expect(r.kindLine).toBe("미국 테마");
    expect(r.tvLine).toBeNull();
    expect(r.href).toContain("period=week&rate=2");
  });

  it("1주 칩: 테마는 1주 등락률, 내 종목은 오늘 등락률 — 화면·화면 읽기 모두 '오늘'이라고 밝힌다 (기간이 섞여 보이지 않게)", () => {
    const hbm = KR_GROUPS[0]!;
    const w = rowView(hbm, "week");
    expect(w.rateText).toBe("+5.10%");
    expect(w.mineLabel).toBe("내 종목 (오늘)");
    expect(w.holdings[0]).toMatchObject({ label: "삼성전자", rateText: "-5.00%" });
    expect(w.speech).toBe("HBM(고대역폭메모리), 한국 테마, 1주 5.10% 상승, 오른 종목 3개, 내린 종목 0개, 보합 0개, 내 종목 오늘 등락률 삼성전자, 5.00% 하락. 누르면 발견 탭 테마 상세");
    // 오늘 칩은 그대로 '내 종목'
    const d = rowView(hbm, "day");
    expect(d.mineLabel).toBe("내 종목");
    expect(d.speech).toContain(", 내 종목 삼성전자, 5.00% 하락.");
  });

  it("거래정지 종목(설계 E10): 등락률 대신 '거래정지' (색 없음), 화면 읽기도", () => {
    const g = { ...KR_GROUPS[0]!, holdings: [{ code: "010140", name: "삼성중공업", via: null, changeRate: null, inCalc: null, halted: true }, { code: "005930", name: "삼성전자", via: null, changeRate: null, inCalc: null }] };
    const r = rowView(g, "day");
    expect(r.holdings.map((h) => [h.label, h.rateText, h.rate])).toEqual([
      ["삼성중공업", "거래정지", null],
      ["삼성전자", "시세 없음", null],
    ]);
    expect(r.speech).toContain("내 종목 삼성중공업, 거래정지, 삼성전자, 시세 없음.");
  });

  it("내 종목 3개 넘으면 '외 N종목', 계산 30종목 밖이면 작은 글, 인버스는 -3배", () => {
    const r = rowView(US_GROUPS[1]!, "day");
    expect(r.holdings.map((h) => h.label)).toEqual(["엔비디아", "브로드컴", "AMD"]);
    expect(r.more).toBe(2);
    expect(rowView({ ...US_GROUPS[1]!, holdings: US_GROUPS[1]!.holdings.slice(3) }, "day").holdings[0]).toMatchObject({ label: "작은회사", note: "등락률 계산에는 안 듦" });
    expect(holdingLabel(US_GROUPS[6]!.holdings[0]!)).toBe("SOXS(반도체 지수 -3배)");
    expect(holdingLabel({ code: "SOXL", name: "SOXL", via: { code: "SOXX", name: "반도체 지수", L: 3, inverse: false, index: null } })).toBe("SOXL(반도체 지수 3배)");
  });

  it("발견 탭 목록에서 빠진 미국 테마는 한 줄 더", () => {
    expect(rowView({ ...QUANTUM, inDiscoverList: false }, "day").note).toBe("발견 탭 목록에는 없는 테마(거래대금 100만 달러 미만)");
    expect(rowView(QUANTUM, "day").note).toBeNull();
  });
});

describe("거래대금 문구 5상태 (설계 표 2-A)", () => {
  it("마감 뒤·장중·직전 거래일·기록 모으는 중·값 없음", () => {
    expect(tvText(tv({ state: "final", ratioPct: 134 }))).toBe("거래대금 평소의 134%");
    expect(tvText(tv({ state: "partial", ratioPct: 62 }))).toBe("거래대금 지금까지 평소 하루의 62%");
    expect(tvText(tv({ state: "lastDay", ratioPct: 118, day: "2026-09-25" }))).toBe("거래대금 9/25(금) 평소의 118%");
    expect(tvText(tv({ state: "collecting", ratioPct: null, days: 3 }))).toBe("거래대금 평소 비교 · 기록 모으는 중 (3/5거래일)");
    expect(tvText(tv({ state: "none", ratioPct: null }))).toBe("거래대금 값 없음");
  });

  it("1,000% 넘으면 '넘음', 20일보다 적게 모은 평소는 화면 읽기에만 밝힘", () => {
    expect(tvText(tv({ ratioPct: 1234 }))).toBe("거래대금 평소의 1,000% 넘음");
    expect(tvSpeech(tv({ ratioPct: 134, days: 20 }))).toBe("거래대금 평소의 134퍼센트");
    expect(tvSpeech(tv({ ratioPct: 134, days: 12 }))).toBe("거래대금 평소의 134퍼센트, 최근 12거래일 평균 기준");
  });

  it("화면 읽기는 날짜·분수를 말로 ('9/25(금)' → '9월 25일 금요일', '(3/5거래일)' → '5거래일 중 3거래일')", () => {
    expect(tvSpeech(tv({ state: "lastDay", ratioPct: 118, day: "2026-09-25", days: 20 }))).toBe("거래대금 9월 25일 금요일 평소의 118퍼센트");
    expect(tvSpeech(tv({ state: "collecting", ratioPct: null, days: 3 }))).toBe("거래대금 평소 비교, 기록 모으는 중, 5거래일 중 3거래일");
    for (const st of ["final", "partial", "lastDay", "collecting", "none"] as const) expect(tvSpeech(tv({ state: st, days: 3, ratioPct: st === "collecting" ? null : 50 }))).not.toMatch(/\d\/\d/);
  });

  it("구성 종목이 300개 넘는 업종: 합을 내지 않았다고 밝힌다 (예전 서버는 칸이 없어 지금 문구 그대로)", () => {
    expect(tvText(tv({ state: "none", ratioPct: null, today: null, truncated: true }))).toBe("거래대금 평소 비교 없음 (구성 종목이 300개가 넘는 업종)");
    expect(tvSpeech(tv({ state: "none", ratioPct: null, today: null, truncated: true }))).toBe("거래대금 평소 비교 없음 (구성 종목이 300개가 넘는 업종)");
    expect(tvText(tv({ state: "none", ratioPct: null }))).toBe("거래대금 값 없음");
  });

  it("날짜 짧게", () => {
    expect(dayShort("2026-09-25")).toBe("9/25(금)");
    expect(dayShort(null)).toBe("");
  });
});

describe("상태 줄", () => {
  it("미국 장 마감: 기준 거래일(뉴욕 날짜)과 한국 시각을 따로 밝힌다 — 거래대금 줄 날짜와 두 날짜로 보이지 않게", () => {
    const v = statusView({ session: "closed", asOf: "2026-09-26T05:00:00+09:00", tvDay: "2026-09-25", note: null }, "US");
    expect(v).toEqual({
      text: "장 마감 · 미국 9/25(금) 정규장 기준 · 한국 시각 9월 26일 (토) 05:00",
      speech: "장 마감, 미국 9월 25일 금요일 정규장 기준, 한국 시각 9월 26일 토요일 5시",
      moving: false,
    });
  });

  it("한국 장중·미국 장중은 지금까지처럼 (안내가 있으면 붙인다)", () => {
    expect(statusView({ session: "regular", asOf: "2026-09-29T11:00:00+09:00", tvDay: "2026-09-29", note: null }, "KR")).toMatchObject({ text: "장중 · 1분마다 갱신 · 9월 29일 (화) 11:00 기준", moving: true });
    expect(statusView({ session: "regular", asOf: "2026-09-29T23:00:00+09:00", tvDay: "2026-09-29", note: "안내" }, "US").text).toBe("장중 · 1분마다 갱신 · 9월 29일 (화) 23:00 기준 · 안내");
    expect(statusView({ session: "closed", asOf: null, tvDay: null, note: null }, "US").text).toBe("장 마감 · 직전 정규장 기준");
    expect(statusView({ session: "closed", asOf: "2026-09-29T11:00:00+09:00", tvDay: null, note: null }, "KR").speech).toBe("장 마감, 마지막 거래 기준, 9월 29일 화요일 11시 기준");
  });
});

describe("시장별 목록 · 높은/낮은 3개 · 칩", () => {
  it("미국 7개: 높은 3개와 낮은 3개(낮은 것부터), 전체는 높은 순", () => {
    const v = marketView(D, "US", "day");
    expect(v.split).toBe(true);
    expect(v.top.map((r) => r.name)).toEqual(["양자컴퓨터", "반도체", "반도체팹리스"]);
    expect(v.bottom.map((r) => r.name)).toEqual(["인터넷", "클라우드", "스마트폰제조"]);
    expect(v.allTitle).toBe("내 테마 7개 · 등락률 높은 순");
  });

  it("한국 2개: 나누지 않음", () => {
    const v = marketView(D, "KR", "day");
    expect(v.split).toBe(false);
    expect(v.rows.map((r) => r.rateText)).toEqual(["-4.12%", "-5.47%"]);
  });

  it("칩: 묶음이 있는 시장만 · 처음 시장은 기억한 값 → 원화 보유액이 큰 시장", () => {
    expect(marketChips(D).map((c) => [c.label, c.speech])).toEqual([
      ["미국 7", "미국, 내 테마 7개"],
      ["한국 2", "한국, 내 테마 2개"],
    ]);
    expect(defaultMarket(D, null)).toBe("US");
    expect(defaultMarket(D, "KR")).toBe("KR");
    expect(defaultMarket({ ...D, markets: { ...D.markets, KR: { ...D.markets.KR!, heldValue: 90_000_000 } } }, null)).toBe("KR");
    expect(defaultMarket({ ...D, groups: KR_GROUPS }, "US")).toBe("KR");
  });

  it("다시 받기 간격: 값이 바뀌는 시장이 있으면 60초, 첫 준비 중이면 30초, 모두 마감이면 없음", () => {
    expect(holdingThemesEvery(D)).toBe(60_000);
    expect(holdingThemesEvery({ ...D, markets: { US: { ...D.markets.US!, preparing: true } } })).toBe(30_000);
    expect(holdingThemesEvery({ ...D, markets: { US: D.markets.US! } })).toBe(false);
    expect(holdingThemesEvery(null)).toBe(false);
  });
});

describe("계좌 한 줄 · 종목별로 보기", () => {
  it("많이 속한 테마 · 연결 수 · 연결하지 못한 N종목", () => {
    const m = mostView(D);
    expect(m.parts.map((p) => p.text)).toEqual(["반도체팹리스 3종목", "인공지능 3종목", "양자컴퓨터 2종목"]);
    expect(m.coverage).toBe("보유 17종목 중 15종목을 테마·업종에 연결했습니다");
    expect(m.unmapped).toBe("연결하지 못한 2종목");
    expect(m.speech).toBe("내 종목이 많이 속한 테마, 반도체팹리스 3종목, 인공지능 3종목, 양자컴퓨터 2종목. 보유 17종목 중 15종목 연결");
  });

  it("종목별로 보기: '삼성전자 · 한국 테마 1개 · 한국 업종 1개' + 등락률 순", () => {
    expect(byHoldingView(D, "day")).toEqual([
      {
        code: "005930",
        head: "삼성전자 · 한국 테마 1개 · 한국 업종 1개",
        items: [
          { name: "HBM(고대역폭메모리)", rate: -4.12, rateText: "-4.12%" },
          { name: "반도체와반도체장비", rate: -5.47, rateText: "-5.47%" },
        ],
        // 한 종목 한 문장 (테마가 수십 개여도 화면 읽기가 한 번에 넘어간다)
        speech: "삼성전자, 한국 테마 1개, 한국 업종 1개, 오늘 등락률 높은 순, HBM(고대역폭메모리) 4.12퍼센트 하락, 반도체와반도체장비 5.47퍼센트 하락",
      },
    ]);
  });
});

describe("계좌 브리핑 카드 (설계 2.3)", () => {
  const SNAP: HoldingThemesSnapshot = {
    asOf: "2026-09-29T08:38:00+09:00",
    coverage: { held: 17, mapped: 15 },
    mostHeld: [
      { name: "반도체팹리스", count: 3 },
      { name: "인공지능", count: 3 },
    ],
    markets: {
      US: { basisDay: "2026-09-25", session: "closed", split: true, top: [{ name: "양자컴퓨터", changeRate: 6.21 }, { name: "반도체팹리스", changeRate: 2.1 }, { name: "소프트웨어", changeRate: 1.4 }], bottom: [{ name: "인터넷", changeRate: -1.1 }, { name: "클라우드", changeRate: -0.8 }, { name: "스마트폰제조", changeRate: -0.3 }], more: 0 },
      KR: { basisDay: "2026-09-23", session: "closed", split: false, top: [{ name: "반도체와반도체장비", changeRate: -5.47 }], bottom: [], more: 2 },
    },
  };

  it("많이 속한 테마 · 미국 높은/낮은 3개 · 한국 한 줄(외 N개) · 기준 줄 · 지금 기준 버튼", () => {
    const v = accountThemesView(SNAP, "08:38");
    expect(v.lines.map((l) => [l.head, l.parts.map((p) => (p.rateText ? `${p.name} ${p.rateText}` : p.name)).join(" · "), l.tail])).toEqual([
      ["내 종목이 많이 속한 테마", "반도체팹리스 3종목 · 인공지능 3종목", null],
      ["미국 · 등락률 높은 3개", "양자컴퓨터 +6.21% · 반도체팹리스 +2.10% · 소프트웨어 +1.40%", null],
      ["미국 · 등락률 낮은 3개", "인터넷 -1.10% · 클라우드 -0.80% · 스마트폰제조 -0.30%", null],
      ["한국", "반도체와반도체장비 -5.47%", "외 2개"],
    ]);
    expect(v.basis).toBe("보유 17종목 중 15종목 연결 · 미국 9/25(금) 정규장 · 한국 9/23(수) 마감 · 08:38 기준");
    expect(v.button).toBe("지금 기준으로 전체 보기");
    expect(v.lines[1]!.speech).toBe("미국 · 등락률 높은 3개, 양자컴퓨터 6.21% 상승, 반도체팹리스 2.10% 상승, 소프트웨어 1.40% 상승");
  });

  it("한국 장 시작 전에 만든 브리핑: 날짜 대신 '장 시작 전 · 직전 거래일 값', 장중이면 '장중'", () => {
    const pre = accountThemesView({ ...SNAP, markets: { KR: { ...SNAP.markets.KR!, session: "pre", basisDay: null } } }, "08:38");
    expect(pre.basis).toBe("보유 17종목 중 15종목 연결 · 한국 장 시작 전 · 직전 거래일 값 · 08:38 기준");
    const live = accountThemesView({ ...SNAP, markets: { KR: { ...SNAP.markets.KR!, session: "regular", basisDay: "2026-09-29" } } }, "11:00");
    expect(live.basis).toBe("보유 17종목 중 15종목 연결 · 한국 9/29(화) 장중 · 11:00 기준");
    clean(pre.basis);
  });

  it("묶음이 없으면 줄 없음 (카드를 그리지 않는다)", () => {
    expect(accountThemesView({ ...SNAP, mostHeld: [], markets: {} }, "08:38").lines).toEqual([]);
  });

  it("문구 검사: 카드 줄·화면 읽기에 권유·판단하는 말 0건", () => {
    const v = accountThemesView(SNAP, "08:38");
    for (const l of v.lines) {
      clean(l.head);
      clean(l.speech);
    }
    clean(v.basis);
    clean(v.basisSpeech);
  });

  it("기준 줄 화면 읽기: 날짜·시각을 말로", () => {
    expect(accountThemesView(SNAP, "08:38").basisSpeech).toBe("보유 17종목 중 15종목 연결, 미국 9월 25일 금요일 정규장, 한국 9월 23일 수요일 마감, 8시 38분 기준");
  });
});

describe("문구 검사 (설계 2.6)", () => {
  it("앱 고정 글 전부와 줄 문장이 금지어·미래형·판단하는 말을 쓰지 않는다", () => {
    const texts = [...allAppTexts(), ...D.groups.flatMap((g) => ["day", "week"].map((p) => rowView(g, p as "day" | "week"))).flatMap((r) => [r.kindLine, r.tvLine ?? "", r.speech, r.note ?? "", ...r.holdings.map((h) => h.label)]), mostView(D).speech];
    expect(texts.length).toBeGreaterThan(40);
    for (const s of texts) clean(s);
  });

  it("검사가 실제로 잡는다", () => {
    expect("반도체 강세".match(THEME)).not.toBeNull();
    expect("주목할 테마".match(BANNED)).not.toBeNull();
  });
});
