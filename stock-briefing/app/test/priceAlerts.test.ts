import { describe, expect, it } from "vitest";
import type { PriceAlertRule, Quote, QuoteSession, VolumeStatus } from "@/api/types";
import { alertBarLabel } from "@/lib/detailLayout";
import {
  activeRules,
  ALERT_TEXT,
  announceText,
  checkQuoteRules,
  checkVolumeRules,
  codesKey,
  diffSpeech,
  diffText,
  firedBook,
  firedLine,
  firedSpeech,
  hasCents,
  hitBody,
  hitSpeech,
  hitTitle,
  isDetailPath,
  metNow,
  notificationContent,
  presetDrafts,
  quoteDate,
  quoteLine,
  quoteSpeech,
  ratioText,
  removeConfirmText,
  removeLabel,
  rowSpeech,
  ruleLabel,
  ruleSpeech,
  sessionEdges,
  stepDraft,
  validateDraft,
  volumeNote,
  type AlertDraft,
  type Hit,
} from "@/lib/priceAlerts";
import { quote } from "./helpers";

/**
 * 가격·등락률·거래량 알림 순수 함수 (3-29, 작업지시 3장·4장). 글자는 작업지시 4.2 표 그대로 기대한다.
 * 시계는 2026-12-08 10:12:05 (서울) 고정 — 함수에 nowMs 로 넘긴다
 */
const NOW = Date.parse("2026-12-08T10:12:05+09:00");
const SESSION: QuoteSession = { market: "KR", phase: "regular", label: "한국 정규장", open: true, eligible: true, until: "2026-12-08T15:20:00+09:00" };
const kq = (price: number, extra: Partial<Quote> = {}) => quote("005930", price, { asOf: "2026-12-08T10:12:01+09:00", session: SESSION, ...extra });
const uq = (price: number, extra: Partial<Quote> = {}) => quote("AAPL", price, { currency: "USD", asOf: "2026-12-08T23:40:00+09:00", ...extra });
const rule = (over: Partial<PriceAlertRule> = {}): PriceAlertRule => ({
  id: 12,
  code: "005930",
  kind: "priceAbove",
  value: 88_600,
  currency: "KRW",
  createdAt: "2026-12-01T09:00:00+09:00",
  firedOn: null,
  firedAt: null,
  firedValue: null,
  registered: true,
  ...over,
});
const d = (kind: AlertDraft["kind"], value: number, currency: AlertDraft["currency"] = null): AlertDraft => ({ kind, value, currency });
const none = firedBook([], {}, new Set());
const vol = (over: Partial<VolumeStatus> = {}): VolumeStatus => ({ code: "000660", status: "ok", date: "2026-12-08", volume: 3_120_000, expected: 948_328, ratio: 3.29, days: 18, minutes: 105, asOf: "2026-12-08T10:45:00+09:00", reason: null, ...over });

/** 만든 글 전부 (권유 말 검사용) */
const made: string[] = [];
const keep = <T extends string>(s: T): T => {
  made.push(s);
  return s;
};

describe("조건 글 · 미리 채우는 값", () => {
  it("ruleLabel 여섯 글", () => {
    expect(keep(ruleLabel(d("priceAbove", 88_600, "KRW")))).toBe("88,600원 이상");
    expect(keep(ruleLabel(d("priceBelow", 80_000, "KRW")))).toBe("80,000원 이하");
    expect(keep(ruleLabel(d("priceAbove", 12, "USD")))).toBe("$12.00 이상");
    expect(keep(ruleLabel(d("rateUp", 5)))).toBe("전일 대비 +5.00% 이상");
    expect(keep(ruleLabel(d("rateDown", 5)))).toBe("전일 대비 -5.00% 이하");
    expect(keep(ruleLabel(d("volume", 3)))).toBe("거래량 같은 시각 평균 3배 이상");
  });

  it("presetDrafts: 84,300원(+3.56%) → 가격 위·아래(5%, 보기 좋은 단위) · 등락률 위·아래 · 거래량", () => {
    const rows = presetDrafts(kq(84_300, { changeRate: 3.56 }), "KRW");
    expect(rows.map((r) => [r.title, r.note])).toEqual([
      ["88,600원 이상", "지금보다 +5.10%"],
      ["80,000원 이하", "지금보다 -5.10%"],
      ["전일 대비 +5.00% 이상", "지금 전일 대비 +3.56%"],
      ["전일 대비 -5.00% 이하", "지금 전일 대비 +3.56%"],
      ["거래량 같은 시각 평균 3배 이상", "정규장 시간에 30분봉으로 확인합니다"],
    ]);
    for (const r of rows) keep(r.title), keep(r.note);
    expect(rows.map((r) => r.draft)).toEqual([d("priceAbove", 88_600, "KRW"), d("priceBelow", 80_000, "KRW"), d("rateUp", 5), d("rateDown", 5), d("volume", 3)]);
  });

  it("가격은 정수로 계산한다 (원 단위 · 만분의 1 달러) — $3.00 → $3.15·$2.85, $0.60 → $0.63·$0.57", () => {
    const price = (p: number, cur: "KRW" | "USD") => presetDrafts(cur === "USD" ? uq(p) : kq(p), cur).slice(0, 2).map((r) => r.title);
    expect(price(9_870, "KRW")).toEqual(["10,370원 이상", "9,370원 이하"]);
    expect(price(100, "KRW")).toEqual(["105원 이상", "95원 이하"]);
    expect(price(11.34, "USD")).toEqual(["$12.00 이상", "$10.70 이하"]);
    expect(price(0.4321, "USD")).toEqual(["$0.46 이상", "$0.41 이하"]);
    expect(price(3, "USD")).toEqual(["$3.15 이상", "$2.85 이하"]);
    expect(price(0.6, "USD")).toEqual(["$0.63 이상", "$0.57 이하"]);
    const cents = presetDrafts(uq(0.6), "USD").slice(0, 2).map((r) => r.draft);
    expect(cents.map((x) => x.value)).toEqual([0.63, 0.57]);
    for (const x of cents) expect(validateDraft(x, [])).toBeNull();
  });

  it("등락률 단계: +6.2% → +10%·-5%, +5% → +10%, +31% → 위 줄 없음. 시세가 없으면 거래량 줄만", () => {
    const rates = (r: number) => presetDrafts(kq(84_300, { changeRate: r }), "KRW").filter((x) => x.key === "rateUp" || x.key === "rateDown").map((x) => x.title);
    expect(rates(6.2)).toEqual(["전일 대비 +10.00% 이상", "전일 대비 -5.00% 이하"]);
    expect(rates(5)[0]).toBe("전일 대비 +10.00% 이상");
    expect(rates(31)).toEqual(["전일 대비 -5.00% 이하"]);
    expect(rates(-6.2)).toEqual(["전일 대비 +5.00% 이상", "전일 대비 -10.00% 이하"]);
    expect(presetDrafts(null, "KRW").map((x) => x.key)).toEqual(["volume"]);
  });

  it("거래량 줄 둘째 글은 받은 상태로", () => {
    expect(keep(volumeNote(vol({ ratio: 1.4, days: 18 })))).toBe("지금 1.4배 · 최근 18거래일 같은 시각 평균과 견줌");
    expect(keep(volumeNote(vol({ status: "early", ratio: null })))).toBe("개장 뒤 30분이 지나면 확인합니다");
    expect(keep(volumeNote(vol({ status: "closed", ratio: null })))).toBe("정규장 시간에만 확인합니다");
    expect(keep(volumeNote(vol({ status: "short", ratio: null })))).toBe("거래량 기준을 만들 수 없어 지금은 확인하지 않습니다");
    expect(volumeNote(vol({ status: "unavailable", ratio: null }))).toBe("거래량 기준을 만들 수 없어 지금은 확인하지 않습니다");
    expect(volumeNote(undefined)).toBe("정규장 시간에 30분봉으로 확인합니다");
    expect(volumeNote(null)).toBe("정규장 시간에 30분봉으로 확인합니다");
  });

  it("stepDraft: 가격은 max(단위, 지금 가격 1%), 달러도 정수로 — $12.00 + 1 = $12.10 이고 저장 가능. 등락률은 1~30", () => {
    const q = kq(84_300);
    expect(stepDraft(d("priceAbove", 88_600, "KRW"), 1, q).value).toBe(89_400);
    expect(stepDraft(d("priceAbove", 88_600, "KRW"), -1, q).value).toBe(87_800);
    const us = stepDraft(d("priceAbove", 12, "USD"), 1, uq(11.34));
    expect(us.value).toBe(12.1);
    expect(validateDraft(us, [])).toBeNull();
    expect(stepDraft(d("rateUp", 5), 1, q).value).toBe(6);
    expect(stepDraft(d("rateUp", 5), -1, q).value).toBe(4);
    expect(stepDraft(d("rateDown", 1), -1, q).value).toBe(1);
    expect(stepDraft(d("rateUp", 30), 1, q).value).toBe(30);
    expect(stepDraft(d("rateUp", 1.15), 1, q).value).toBe(2.15);
    expect(stepDraft(d("volume", 3), 1, q).value).toBe(3);
  });

  it("stepDraft: 입력칸을 비웠거나 읽을 수 없는 값(NaN)이면 미리 채운 값(start)에서 한 칸 — NaN 을 돌려주지 않는다", () => {
    const q = kq(84_300);
    const nan = Number.NaN;
    // 미리 채운 값에서
    expect(stepDraft(d("priceAbove", nan, "KRW"), 1, q, 88_600).value).toBe(89_400);
    expect(stepDraft(d("priceBelow", nan, "KRW"), -1, q, 80_000).value).toBe(79_200);
    expect(stepDraft(d("priceAbove", nan, "USD"), 1, uq(11.34), 12).value).toBe(12.1);
    expect(stepDraft(d("rateUp", nan), 1, q, 5).value).toBe(6);
    expect(stepDraft(d("rateDown", nan), -1, q, 5).value).toBe(4);
    expect(stepDraft(d("rateUp", Infinity), 1, q, 5).value).toBe(6);
    // 미리 채운 값이 없으면 가격은 지금 시세, 등락률은 1 에서
    expect(stepDraft(d("priceAbove", nan, "KRW"), 1, q).value).toBe(85_100);
    expect(stepDraft(d("rateUp", nan), -1, q).value).toBe(1);
    expect(stepDraft(d("rateUp", nan), 1, q, nan).value).toBe(2);
    // 시작할 값이 하나도 없으면 그대로 (값을 지어내지 않음)
    const stuck = d("priceAbove", nan, "KRW");
    expect(stepDraft(stuck, 1, null)).toBe(stuck);
    for (const [draft, start] of [[d("priceAbove", nan, "KRW"), 88_600], [d("rateUp", nan), 5], [d("rateDown", nan), undefined]] as const) {
      for (const dir of [1, -1] as const) expect(Number.isFinite(stepDraft(draft, dir, q, start).value), `${draft.kind} ${dir}`).toBe(true);
    }
  });

  it("stepDraft: 저장 단위보다 잘게 넣은 값에서 시작해도 결과는 1센트 · 1원 단위 → 값 검사를 통과한다 (12.345 + → 12.45)", () => {
    const up = stepDraft(d("priceAbove", 12.345, "USD"), 1, uq(11.34));
    expect(up.value).toBe(12.45);
    expect(validateDraft(up, [])).toBeNull();
    const down = stepDraft(d("priceBelow", 12.345, "USD"), -1, uq(11.34));
    expect(down.value).toBe(12.25);
    expect(validateDraft(down, [])).toBeNull();
    const krw = stepDraft(d("priceAbove", 84_350.5, "KRW"), 1, kq(84_300));
    expect(krw.value).toBe(85_151);
    expect(validateDraft(krw, [])).toBeNull();
    // 이미 단위에 맞는 값은 그대로 (전과 같은 결과)
    expect(stepDraft(d("priceAbove", 12, "USD"), 1, uq(11.34)).value).toBe(12.1);
    expect(stepDraft(d("priceAbove", 88_600, "KRW"), 1, kq(84_300)).value).toBe(89_400);
  });
});

describe("값 검사 (서버 checkValue 와 같은 규칙 · hasCents)", () => {
  it("hasCents: 부동소수 꼬리에 걸리지 않는다", () => {
    for (const v of [12.1, 0.29, 0.57, 4.35, 1.15, 1.1]) expect(hasCents(v), String(v)).toBe(true);
    for (const v of [12.101, 12.345, 1.155, 0.001, Number.NaN]) expect(hasCents(v), String(v)).toBe(false);
  });

  it("통과하는 값과 '소수 둘째 자리까지'", () => {
    for (const v of [12.1, 0.29, 0.57, 4.35]) expect(validateDraft(d("priceAbove", v, "USD"), []), String(v)).toBeNull();
    for (const v of [1.15, 1.1]) expect(validateDraft(d("rateUp", v), []), String(v)).toBeNull();
    for (const v of [12.101, 12.345]) expect(validateDraft(d("priceBelow", v, "USD"), [])).toBe("소수 둘째 자리까지 넣어 주세요");
    expect(validateDraft(d("rateDown", 1.155), [])).toBe("소수 둘째 자리까지 넣어 주세요");
  });

  it("값 오류 글 여섯 가지 (범위 → 자리 → 같은 조건 → 한 종목 5개), 정상은 null", () => {
    expect(validateDraft(d("priceAbove", 0, "KRW"), [])).toBe("1원 이상 1억 원 이하로 넣어 주세요");
    expect(validateDraft(d("priceAbove", 88_600.5, "KRW"), [])).toBe("1원 이상 1억 원 이하로 넣어 주세요");
    expect(validateDraft(d("priceAbove", Number.NaN, "KRW"), [])).toBe("1원 이상 1억 원 이하로 넣어 주세요");
    expect(validateDraft(d("priceAbove", 0.001, "USD"), [])).toBe("$0.01 이상 $1,000,000 이하로 넣어 주세요");
    expect(validateDraft(d("rateUp", 31), [])).toBe("1~30 사이로 넣어 주세요");
    expect(validateDraft(d("rateUp", 0.5), [])).toBe("1~30 사이로 넣어 주세요");
    expect(validateDraft(d("priceBelow", 80_000, "KRW"), [rule({ kind: "priceBelow", value: 80_000 })])).toBe("같은 알림이 이미 있습니다");
    const five = [1, 2, 3, 4, 5].map((i) => rule({ id: i, kind: "priceAbove", value: 90_000 + i }));
    expect(validateDraft(d("rateUp", 5), five)).toBe("한 종목에 알림은 5개까지입니다");
    expect(validateDraft(d("priceAbove", 88_600, "KRW"), [])).toBeNull();
    expect(validateDraft(d("volume", 3), [])).toBeNull();
    expect(validateDraft(d("volume", 4), [])).toBe("2·3·5·10배 중 하나로 골라 주세요");
  });

  it("metNow: 지금 이미 맞는지 (시트의 '이미 맞음')", () => {
    expect(metNow(d("rateUp", 5), kq(88_000, { changeRate: 6.2 }))).toBe(true);
    expect(metNow(d("rateUp", 10), kq(88_000, { changeRate: 6.2 }))).toBe(false);
    expect(metNow(d("priceBelow", 90_000, "KRW"), kq(88_000))).toBe(true);
    expect(metNow(d("volume", 3), null, vol({ ratio: 3.29 }))).toBe(true);
    expect(metNow(d("priceAbove", 1, "KRW"), null)).toBe(false);
  });
});

describe("쉬는 중 규칙 · 코드 모음", () => {
  it("activeRules: registered 거짓은 빠지고, listCodes 가 있으면 그 안의 코드만, null 이면 registered 만", () => {
    const rs = [rule({ id: 1 }), rule({ id: 2, registered: false }), rule({ id: 3, code: "000660" })];
    expect(activeRules(rs, null).map((r) => r.id)).toEqual([1, 3]);
    expect(activeRules(rs, new Set(["005930"])).map((r) => r.id)).toEqual([1]);
    expect(activeRules(rs, new Set()).map((r) => r.id)).toEqual([]);
  });

  it("codesKey: 정렬해 이은 글자 (줄 순서가 바뀌어도 같다)", () => {
    expect(codesKey([{ code: "B" }, { code: "A" }])).toBe("A,B");
    expect(codesKey([{ code: "A" }, { code: "B" }])).toBe(codesKey([{ code: "B" }, { code: "A" }]));
  });
});

describe("울려도 되는 시세 · 가격·등락률 확인 (now 2026-12-08 10:12:05)", () => {
  const stock = (q: Quote | null, extra: { registered?: boolean } = {}) => [{ code: q?.code ?? "005930", name: "삼성전자", quote: q, ...extra }];
  const hits = (rs: PriceAlertRule[], q: Quote | null, o: { fired?: ReturnType<typeof firedBook>; list?: Set<string> | null; registered?: boolean } = {}) =>
    checkQuoteRules(rs, stock(q, o.registered === undefined ? {} : { registered: o.registered }), NOW, o.fired ?? none, o.list ?? null);

  it("가격 위·아래 · 등락률 위·아래가 각각 울리고 / 울리지 않는다", () => {
    expect(hits([rule()], kq(88_700))).toHaveLength(1);
    expect(hits([rule()], kq(88_500))).toHaveLength(0);
    expect(hits([rule({ kind: "priceBelow", value: 80_000 })], kq(79_900))).toHaveLength(1);
    expect(hits([rule({ kind: "priceBelow", value: 80_000 })], kq(80_100))).toHaveLength(0);
    expect(hits([rule({ kind: "rateUp", value: 5, currency: null })], kq(88_700, { changeRate: 8.97 }))).toHaveLength(1);
    expect(hits([rule({ kind: "rateUp", value: 5, currency: null })], kq(88_700, { changeRate: 4.9 }))).toHaveLength(0);
    expect(hits([rule({ kind: "rateDown", value: 5, currency: null })], kq(77_300, { changeRate: -5.04 }))).toHaveLength(1);
    expect(hits([rule({ kind: "rateDown", value: 5, currency: null })], kq(77_300, { changeRate: -4.99 }))).toHaveLength(0);
  });

  it("하루 한 번: 서버 firedOn·기기 기록·이번 실행 메모리가 오늘이면 울리지 않고, 어제면 울린다", () => {
    expect(hits([rule({ firedOn: "2026-12-08" })], kq(88_700), { fired: firedBook([rule({ firedOn: "2026-12-08" })], {}, new Set()) })).toHaveLength(0);
    expect(hits([rule()], kq(88_700), { fired: firedBook([rule()], { "12": "2026-12-08" }, new Set()) })).toHaveLength(0);
    expect(hits([rule()], kq(88_700), { fired: firedBook([rule()], {}, new Set(["12|2026-12-08"])) })).toHaveLength(0);
    expect(hits([rule({ firedOn: "2026-12-07" })], kq(88_700), { fired: firedBook([rule({ firedOn: "2026-12-07" })], { "12": "2026-12-07" }, new Set()) })).toHaveLength(1);
  });

  it("지연 · 동시호가(open 거짓) · 대상 아님 · 지난 세션 경계 · 어제 시세는 울리지 않는다", () => {
    expect(hits([rule()], kq(88_700, { stale: true }))).toHaveLength(0);
    expect(hits([rule()], kq(88_700, { session: { ...SESSION, open: false } }))).toHaveLength(0);
    expect(hits([rule()], kq(88_700, { session: { ...SESSION, eligible: false } }))).toHaveLength(0);
    expect(hits([rule()], kq(88_700, { session: { ...SESSION, eligible: null } }))).toHaveLength(1);
    expect(hits([rule()], kq(88_700, { session: { ...SESSION, until: "2026-12-08T10:00:00+09:00" } }))).toHaveLength(0);
    expect(hits([rule()], kq(88_700, { session: { ...SESSION, until: null } }))).toHaveLength(1);
    expect(hits([rule()], kq(88_700, { asOf: "2026-12-07T19:59:00+09:00" }))).toHaveLength(0);
    expect(hits([rule()], kq(88_700, { session: undefined }))).toHaveLength(1);
    expect(hits([rule()], null)).toHaveLength(0);
  });

  it("미국: 뉴욕 20:00 전은 그날, 뒤(주간거래)는 다음 거래일", () => {
    const at = "2026-12-08T09:30:00+09:00"; // 뉴욕 12/7 19:30 (애프터)
    expect(quoteDate(uq(180, { asOf: at, session: { ...SESSION, market: "US", until: null } }), "AAPL", Date.parse(at))).toBe("2026-12-07");
    const late = "2026-12-08T10:30:00+09:00"; // 뉴욕 12/7 20:30 (주간거래)
    expect(quoteDate(uq(180, { asOf: late, session: { ...SESSION, market: "US", until: null } }), "AAPL", Date.parse(late))).toBe("2026-12-08");
  });

  it("쉬는 중: 조건 registered 거짓 · 등록 종목이 아닌 상세 값 · 목록 코드에 없음 → 울리지 않는다", () => {
    expect(hits([rule({ registered: false })], kq(88_700))).toHaveLength(0);
    expect(hits([rule()], kq(88_700), { registered: false })).toHaveLength(0);
    expect(hits([rule()], kq(88_700), { list: new Set(["000660"]) })).toHaveLength(0);
    expect(hits([rule()], kq(88_700), { list: new Set(["005930"]) })).toHaveLength(1);
  });

  it("sessionEdges: 지난 경계 중 가장 늦은 것 · 앞으로 올 경계 중 가장 이른 것 (경계 없는 시세는 건너뜀)", () => {
    const at = (hm: string) => `2026-12-08T${hm}:00+09:00`;
    const s = (until: string | null) => kq(84_300, { session: { ...SESSION, until } });
    expect(sessionEdges([s(at("09:00")), s(at("10:00")), s(at("15:20")), s(at("15:30")), s(null), kq(1, { session: undefined }), null], NOW)).toEqual({ passed: Date.parse(at("10:00")), next: Date.parse(at("15:20")) });
    expect(sessionEdges([], NOW)).toEqual({ passed: null, next: null });
    // 바로 그 순간은 지난 것으로 (quoteDate 가 until ≤ now 를 울리지 않으므로 같은 기준)
    expect(sessionEdges([s(new Date(NOW).toISOString())], NOW)).toEqual({ passed: NOW, next: null });
  });

  it("isDetailPath: 지금 경로가 그 종목 상세인지 (끝 빗금·인코딩 무시, 편집·차트 화면은 아님)", () => {
    expect(isDetailPath("/stocks/005930", "005930")).toBe(true);
    expect(isDetailPath("/stocks/005930/", "005930")).toBe(true);
    expect(isDetailPath("/stocks/BRK%2EB", "BRK.B")).toBe(true);
    expect(isDetailPath("/stocks/000660", "005930")).toBe(false);
    expect(isDetailPath("/stocks/005930/edit", "005930")).toBe(false);
    expect(isDetailPath("/", "005930")).toBe(false);
    expect(isDetailPath("/stocks/%E0%A4%A", "005930")).toBe(false);
    expect(isDetailPath(null, "005930")).toBe(false);
  });

  it("울린 값(firedValue): 가격 조건은 가격, 등락률 조건은 등락률", () => {
    expect(hits([rule()], kq(88_700))[0]!.firedValue).toBe(88_700);
    expect(hits([rule({ kind: "rateDown", value: 5, currency: null })], kq(77_300, { changeRate: -5.04 }))[0]!.firedValue).toBe(-5.04);
  });
});

describe("거래량 확인", () => {
  const vr = (over: Partial<PriceAlertRule> = {}) => rule({ id: 30, code: "000660", kind: "volume", value: 3, currency: null, ...over });
  const names = (c: string) => (c === "000660" ? "SK하이닉스" : c);
  it("ok 3.0 이 3배를 울리고, 2.99·early·closed·short·오늘 기록·쉬는 중은 아니다", () => {
    expect(checkVolumeRules([vr()], [vol({ ratio: 3 })], names, none, null)).toHaveLength(1);
    expect(checkVolumeRules([vr()], [vol({ ratio: 2.99 })], names, none, null)).toHaveLength(0);
    for (const status of ["early", "closed", "short"] as const) expect(checkVolumeRules([vr()], [vol({ status, ratio: null })], names, none, null)).toHaveLength(0);
    expect(checkVolumeRules([vr()], [vol()], names, firedBook([vr()], { "30": "2026-12-08" }, new Set()), null)).toHaveLength(0);
    expect(checkVolumeRules([vr({ registered: false })], [vol({ ratio: 3.5 })], names, none, null)).toHaveLength(0);
    const h = checkVolumeRules([vr()], [vol()], names, none, null)[0]!;
    expect(h).toMatchObject({ name: "SK하이닉스", date: "2026-12-08", firedValue: 3.29 });
  });
});

describe("알림 글 (카드 · 알림 목록)", () => {
  const priceHit = (over: Partial<Hit> = {}): Hit => ({
    rule: rule(),
    code: "005930",
    name: "삼성전자",
    date: "2026-12-08",
    firedValue: 88_700,
    quote: { price: 88_700, changeRate: 8.97, asOf: "2026-12-08T10:12:01+09:00", priceBasis: "KRX 정규장", currency: "KRW" },
    ...over,
  });
  const usHit = priceHit({ rule: rule({ id: 20, code: "AAPL", kind: "priceBelow", value: 180, currency: "USD" }), code: "AAPL", name: "AAPL", firedValue: 179.95, quote: { price: 179.95, changeRate: -1.23, asOf: "2026-12-08T23:40:00+09:00", priceBasis: "정규장", currency: "USD" } });
  const downHit = priceHit({ rule: rule({ id: 21, kind: "rateDown", value: 5, currency: null }), firedValue: -5.04, quote: { price: 77_300, changeRate: -5.04, asOf: "2026-12-08T10:12:01+09:00", priceBasis: null, currency: "KRW" } });
  const volHit: Hit = { rule: rule({ id: 30, code: "000660", kind: "volume", value: 3, currency: null }), code: "000660", name: "SK하이닉스", date: "2026-12-08", firedValue: 3.29, volume: { volume: 3_120_000, ratio: 3.29, days: 18, asOf: "2026-12-08T10:45:00+09:00" } };
  const nxtHit = priceHit({ quote: { price: 88_700, changeRate: 8.97, asOf: "2026-12-08T10:12:01+09:00", priceBasis: "KRX+NXT 통합", currency: "KRW" } });

  it("카드 제목·본문 (4.2 표 그대로)", () => {
    expect(keep(hitTitle(priceHit()))).toBe("삼성전자 · 88,600원 이상");
    expect(keep(hitBody(priceHit()))).toBe("지금 88,700원 · 전일 대비 +8.97% · 10:12 기준");
    expect(keep(hitBody(nxtHit))).toBe("지금 88,700원 · 전일 대비 +8.97% · 10:12 기준 · NXT 포함");
    expect(keep(hitTitle(usHit))).toBe("AAPL · $180.00 이하");
    expect(keep(hitBody(usHit))).toBe("지금 $179.95 · 전일 대비 -1.23% · 23:40 기준");
    expect(keep(hitTitle(downHit))).toBe("삼성전자 · 전일 대비 -5.00% 이하");
    expect(keep(hitBody(downHit))).toBe("지금 77,300원 · 전일 대비 -5.04% · 10:12 기준");
    expect(keep(hitTitle(volHit))).toBe("SK하이닉스 · 거래량 같은 시각 평균 3배 이상");
    expect(keep(hitBody(volHit))).toBe("오늘 거래량 312만주 · 최근 18거래일 같은 시각 평균의 3.2배 · 10:45 기준");
  });

  it("배율은 내림 소수 한 자리", () => {
    expect(ratioText(3.29)).toBe("3.2배");
    expect(ratioText(3)).toBe("3.0배");
    expect(ratioText(2.3)).toBe("2.3배");
    expect(ratioText(1.4)).toBe("1.4배");
  });

  it("알림 목록 한 줄: 제목 '가격 알림 · 이름', 글 = 조건 글 · 카드 본문 (기준 표시 포함), data 는 종목·조건", () => {
    expect(notificationContent(priceHit())).toEqual({ title: "가격 알림 · 삼성전자", body: "88,600원 이상 · 지금 88,700원 · 전일 대비 +8.97% · 10:12 기준", data: { type: "priceAlert", code: "005930", ruleId: 12 } });
    expect(notificationContent(nxtHit).body).toBe("88,600원 이상 · 지금 88,700원 · 전일 대비 +8.97% · 10:12 기준 · NXT 포함");
    expect(notificationContent(volHit).body).toBe("거래량 같은 시각 평균 3배 이상 · 오늘 거래량 312만주 · 최근 18거래일 같은 시각 평균의 3.2배 · 10:45 기준");
    for (const h of [priceHit(), nxtHit, usHit, downHit, volHit]) keep(notificationContent(h).title), keep(notificationContent(h).body);
  });

  it("화면 읽기 문장 (4.2 '화면 읽기 문장' 표 그대로, + · $ 를 읽지 않음)", () => {
    const say: string[] = [];
    const s = (x: string) => (say.push(x), keep(x));
    // ruleSpeech 여섯
    expect(s(ruleSpeech(d("priceAbove", 88_600, "KRW")))).toBe("88,600원 이상");
    expect(s(ruleSpeech(d("priceBelow", 80_000, "KRW")))).toBe("80,000원 이하");
    expect(s(ruleSpeech(d("priceBelow", 180, "USD")))).toBe("180.00달러 이하");
    expect(s(ruleSpeech(d("rateUp", 5)))).toBe("전일 대비 5.00% 이상 상승");
    expect(s(ruleSpeech(d("rateDown", 5)))).toBe("전일 대비 5.00% 이상 하락");
    expect(s(ruleSpeech(d("volume", 3)))).toBe("거래량 같은 시각 평균 3배 이상");
    // diffSpeech 셋
    expect(s(diffSpeech(88_600, 84_300))).toBe("지금보다 5.10% 높음");
    expect(s(diffSpeech(80_000, 84_300))).toBe("지금보다 5.10% 낮음");
    expect(s(diffSpeech(84_300, 84_300))).toBe("지금과 같음");
    expect(diffText(84_300, 84_300)).toBe("지금보다 0.00%");
    // quoteSpeech 셋
    const q = kq(84_300, { changeRate: 3.56, asOf: "2026-12-08T10:12:00+09:00" });
    expect(s(quoteSpeech(q))).toBe("지금 84,300원, 3.56% 상승, 10시 12분 기준");
    expect(s(quoteSpeech({ ...q, priceBasis: "KRX+NXT 통합" }))).toBe("지금 84,300원, 3.56% 상승, 10시 12분 기준, NXT 포함");
    expect(s(quoteSpeech(uq(11.34, { changeRate: -1.2 })))).toBe("지금 11.34달러, 1.20% 하락, 23시 40분 기준");
    expect(keep(quoteLine({ ...q, priceBasis: "KRX+NXT 통합" }))).toBe("지금 84,300원 · 전일 대비 +3.56% · 10:12 기준 · NXT 포함");
    // rowSpeech 여섯
    expect(s(rowSpeech(d("priceAbove", 88_600, "KRW"), q))).toBe("88,600원 이상, 지금보다 5.10% 높음");
    expect(s(rowSpeech(d("priceBelow", 80_000, "KRW"), q))).toBe("80,000원 이하, 지금보다 5.10% 낮음");
    expect(s(rowSpeech(d("rateUp", 5), q))).toBe("전일 대비 5.00% 이상 상승, 지금 전일 대비 3.56% 상승");
    expect(s(rowSpeech(d("rateDown", 5), q))).toBe("전일 대비 5.00% 이상 하락, 지금 전일 대비 3.56% 상승");
    expect(s(rowSpeech(d("volume", 3), q, vol({ ratio: 1.4, days: 18 })))).toBe("거래량 같은 시각 평균 3배 이상, 지금 1.4배, 최근 18거래일 같은 시각 평균과 견줌");
    expect(s(rowSpeech(d("volume", 3), q, undefined))).toBe("거래량 같은 시각 평균 3배 이상, 정규장 시간에 30분봉으로 확인합니다");
    // firedSpeech 셋
    const today = rule({ firedOn: "2026-12-08", firedAt: "2026-12-08T09:41:00+09:00" });
    expect(s(firedSpeech(today, NOW))).toBe("오늘 9시 41분 울림");
    expect(s(firedSpeech(rule({ firedOn: "2026-12-07", firedAt: "2026-12-07T09:41:00+09:00" }), NOW))).toBe("오늘 아직 울리지 않음");
    expect(s(firedSpeech(rule({ registered: false }), NOW))).toBe("등록 종목이 아니라 확인하지 않음");
    // hitSpeech 다섯
    expect(s(hitSpeech(priceHit()))).toBe("가격 알림, 삼성전자, 88,600원 이상에 닿음, 지금 88,700원, 8.97% 상승, 10시 12분 기준");
    expect(s(hitSpeech(nxtHit))).toBe("가격 알림, 삼성전자, 88,600원 이상에 닿음, 지금 88,700원, 8.97% 상승, 10시 12분 기준, NXT 포함");
    expect(s(hitSpeech(usHit))).toBe("가격 알림, AAPL, 180.00달러 이하에 닿음, 지금 179.95달러, 1.23% 하락, 23시 40분 기준");
    expect(s(hitSpeech(downHit))).toBe("가격 알림, 삼성전자, 전일 대비 5.00% 이상 하락에 닿음, 지금 77,300원, 5.04% 하락, 10시 12분 기준");
    expect(s(hitSpeech(volHit))).toBe("가격 알림, SK하이닉스, 거래량 같은 시각 평균 3배 이상에 닿음, 오늘 거래량 312만주, 최근 18거래일 같은 시각 평균의 3.2배, 10시 45분 기준");
    // announceText 둘
    expect(s(announceText([priceHit()]))).toBe(hitSpeech(priceHit()));
    const five = [priceHit(), usHit, downHit, volHit, nxtHit];
    expect(s(announceText(five))).toBe(`${hitSpeech(priceHit())}. ${hitSpeech(usHit)}. ${hitSpeech(downHit)}. 외 2건`);
    for (const x of say) expect(x, x).not.toMatch(/[+$]/);
  });

  it("켜진 알림 둘째 글 · 지우기 확인 창 글", () => {
    expect(keep(firedLine(rule({ firedOn: "2026-12-08", firedAt: "2026-12-08T09:41:00+09:00" }), NOW))).toBe("오늘 09:41 울림");
    expect(keep(firedLine(rule({ firedOn: "2026-12-07", firedAt: "2026-12-07T09:41:00+09:00" }), NOW))).toBe("오늘 아직 울리지 않음");
    expect(keep(firedLine(rule({ registered: false }), NOW))).toBe("등록 종목이 아니라 확인하지 않음");
    const c = removeConfirmText(rule({ kind: "rateUp", value: 3, currency: null }));
    expect(c).toEqual({ title: "알림 지우기", message: "'전일 대비 +3.00% 이상' 알림을 지울까요?", cancel: "취소", ok: "지우기" });
    for (const x of Object.values(c)) keep(x);
    // 설정 칸 (여러 종목이 한 목록): 확인 창·지우기 이름표에 종목 이름
    expect(keep(removeConfirmText(rule(), "삼성전자").message)).toBe("'삼성전자 · 88,600원 이상' 알림을 지울까요?");
    expect(keep(removeLabel(rule()))).toBe("알림 지우기, 88,600원 이상");
    expect(keep(removeLabel(rule({ kind: "rateUp", value: 5, currency: null }), "삼성전자"))).toBe("알림 지우기, 삼성전자, 전일 대비 5.00% 이상 상승");
  });
});

describe("아래 막대 알림 버튼 글자 (alertBarLabel)", () => {
  it("475 · 100% · '관심 해제' 는 글자와 함께, 320 · 150% · '동기화 제외' 는 종 아이콘만", () => {
    expect(alertBarLabel(475, 1, "관심 해제", "알림")).toBe(true);
    expect(alertBarLabel(320, 1.5, "동기화 제외", "알림 2")).toBe(false);
  });
});

describe("권유 말 없음 (이 작업이 만든 글 — 함수가 돌려준 글자만)", () => {
  it("모든 글에 권유·전망 말이 없고, '권유'는 '매매 권유가 아닙니다' 에만", () => {
    const all = [...made, ...Object.values(ALERT_TEXT)];
    expect(all.length).toBeGreaterThan(60);
    const banned = /매수|매도|추천|목표 ?가|기회|전망|타이밍|손절|익절/;
    expect(all.filter((x) => banned.test(x))).toEqual([]);
    expect(all.filter((x) => x.includes("권유"))).toEqual([ALERT_TEXT.sheetFoot]);
    expect(ALERT_TEXT.sheetFoot).toContain("매매 권유가 아닙니다");
  });
});
