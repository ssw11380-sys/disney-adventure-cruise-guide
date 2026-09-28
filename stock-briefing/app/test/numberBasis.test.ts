import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { QuoteBasis, ReconcileBadgeBody, RegisteredWithQuote } from "@/api/types";
import { reconcileLabel } from "@/lib/freshness";
import {
  BASIS_FOOT,
  basisLine,
  basisRows,
  basisShort,
  basisSpeech,
  basisTag,
  countedHoldings,
  diffPctText,
  hmLabel,
  marketBasis,
  quoteBasisChunks,
  quoteBasisLine,
  quoteBasisSpeech,
  RECONCILE_OFF,
  RECONCILE_POLL_MS,
  reconcileBadge,
  staleAfterMin,
  WARN_PCT,
} from "@/lib/numberBasis";
import { excludedLabel, summarize } from "@/lib/portfolio";
import { holding, quote } from "./helpers";

/**
 * 숫자 기준·토스 대조 배지 순수 함수 (3-32 PR 1, 플래그 numberBasis). 시각은 모두 인자로 고정한다.
 *  - basisTag·basisShort: 서버와 같은 공용 픽스처(shared/fixtures/numberBasis.json)
 *  - countedHoldings·marketBasis·basisLine: 기준을 세는 종목 = 바로 옆 합계(summarize)에 들어간 종목
 *  - reconcileBadge: 일곱 상태의 글·색·화면 읽기(오늘·어제), '오래됨' 경계(장중 20분·장 밖 70분·실패 계속)
 *  - basisRows: '숫자 기준' 창의 줄 (작업지시 1.5-2 표 그대로)
 */
const NOW = Date.parse("2026-09-28T14:03:30+09:00");
const at = (hhmmss: string, day = "2026-09-28") => `${day}T${hhmmss}+09:00`;
const ms = (hhmmss: string, day = "2026-09-28") => Date.parse(at(hhmmss, day));

const fixture = JSON.parse(readFileSync(new URL("../../shared/fixtures/numberBasis.json", import.meta.url), "utf8")) as {
  tags: [string | null, string | null][];
  short: { bases: (string | null)[]; label: string | null }[];
};

describe("basisTag · basisShort (공용 픽스처)", () => {
  it.each(fixture.tags)("%j → %j", (raw, want) => {
    expect(basisTag(raw)).toBe(want);
  });

  it.each(fixture.short.map((c) => [c.bases, c.label] as const))("%j → %j", (bases, label) => {
    expect(basisShort(bases.map((b) => (b === null ? {} : { priceBasis: b })))).toBe(label);
  });

  it("시세 없는 항목(null·undefined)은 건너뛰고, 남은 것이 없으면 null", () => {
    expect(basisShort([{ priceBasis: "KRX+NXT 통합" }, null, undefined])).toBe("NXT 포함");
    expect(basisShort([null])).toBeNull();
  });

  it("화면 읽기는 가운뎃점을 쉼표로", () => {
    expect(basisSpeech("NXT·주간거래 포함")).toBe("NXT, 주간거래 포함");
    expect(basisSpeech("정규장")).toBe("정규장");
  });
});

const FX = 1_390;
/** priceBasis null = 칸 없음 (예전 서버) */
const kr = (i: number, asOf: string, priceBasis: string | null = "KRX+NXT 통합", extra: object = {}) =>
  holding(`10000${i}`, quote(`10000${i}`, 10_000, { asOf, ...(priceBasis ? { priceBasis } : {}), ...extra }), 10, 9_000, undefined, `국내${i}`);
const us = (i: number, asOf: string, priceBasis: string, fx: boolean, extra: object = {}) =>
  holding(`US${i}`, quote(`US${i}`, 100, { currency: "USD", asOf, priceBasis, ...(fx ? { fxRate: FX } : {}), ...extra }), 1, 90, undefined, `미국${i}`);

/** 국내 3 · 미국 14(주간거래 12 · 정규장 2, 환율은 한 종목에만) · 관심 1 · 시세 없는 보유 1 */
const MIXED: RegisteredWithQuote[] = [
  kr(1, at("14:02:00")),
  kr(2, at("14:03:00")),
  kr(3, at("14:02:30")),
  ...Array.from({ length: 12 }, (_, k) => us(k + 1, k === 0 ? at("05:00:00", "2026-09-26") : at("14:01:00"), "주간거래", k === 0)),
  us(13, at("14:03:00"), "정규장", false),
  us(14, at("14:00:00"), "정규장", false),
  holding("200001", quote("200001", 5_000, { asOf: at("14:03:00"), priceBasis: "KRX+NXT 통합" }), null, null, undefined, "관심"),
  holding("999999", null, 5, 10_000, undefined, "거래정지"),
];

describe("countedHoldings · marketBasis · basisLine: 합계에 들어간 종목의 시세 기준", () => {
  it("국내 3 · 미국 14(공용 환율로 모두 들어감) — 관심·시세 없는 보유는 뺀다", () => {
    const counted = countedHoldings(MIXED);
    expect(counted).toHaveLength(17);
    // 잔고 합계(summarize)와 같은 종목 수
    expect(summarize(MIXED, true).krw?.count).toBe(17);
    const m = marketBasis(MIXED);
    expect(m.map((x) => x.market)).toEqual(["KR", "US"]);
    expect(m.map((x) => basisLine(x, NOW))).toEqual(["국내 3종목 · NXT 포함 · 14:02~14:03", "미국 14종목 · 주간거래 12 · 정규장 2 · 9/26 05:00~14:03"]);
  });

  it("priceBasis 가 없는 종목은 '기준 모름', 같은 수면 NXT·주간거래·시간외·정규장·기준 모름 순서", () => {
    const list = [kr(1, at("14:02:00")), kr(2, at("14:02:00")), kr(3, at("14:02:00"), null), kr(4, at("14:02:00"), "KRX 정규장")];
    expect(basisLine(marketBasis(list)[0]!, NOW)).toBe("국내 4종목 · NXT 포함 2 · 정규장 1 · 기준 모름 1 · 14:02");
    const one = [kr(1, at("14:02:00"), null)];
    expect(basisLine(marketBasis(one)[0]!, NOW)).toBe("국내 1종목 · 기준 모름 · 14:02");
  });

  it("환율 없는 미국 종목은 늘 모두 함께 빠져 미국 줄이 없다 — 화면 총액 '(원화 종목)'과 같다", () => {
    const list = [kr(1, at("14:02:00")), us(1, at("14:01:00"), "주간거래", false), us(2, at("14:01:00"), "주간거래", false)];
    expect(countedHoldings(list).map((s) => s.code)).toEqual(["100001"]);
    expect(marketBasis(list).map((x) => x.market)).toEqual(["KR"]);
    const s = summarize(list, true);
    expect(s.krw).toBeNull();
    expect(s.excluded.noFx).toBe(2);
  });

  it("평가 없는 보유(평단 없음)는 빠진다", () => {
    const noAvg = holding("100009", quote("100009", 10_000, { priceBasis: "KRX+NXT 통합" }), 10, null, undefined, "평단없음");
    expect(countedHoldings([kr(1, at("14:02:00")), noAvg]).map((s) => s.code)).toEqual(["100001"]);
  });

  it("시세 지연 종목 이름을 모은다, 시각을 못 읽으면 시각 부분이 없다", () => {
    const m = marketBasis([kr(1, "x", "KRX+NXT 통합", { stale: true }), kr(2, "y")]);
    expect(m[0]).toMatchObject({ from: null, to: null, stale: ["국내1"] });
    expect(basisLine(m[0]!, NOW)).toBe("국내 2종목 · NXT 포함");
  });

  it("hmLabel: 오늘(한국 날짜)이면 '14:03', 아니면 '9/26 05:00'", () => {
    expect(hmLabel(ms("14:03:00"), NOW)).toBe("14:03");
    expect(hmLabel(ms("00:00:00"), NOW)).toBe("00:00");
    expect(hmLabel(ms("05:00:00", "2026-09-26"), NOW)).toBe("9/26 05:00");
    expect(hmLabel(ms("23:59:00", "2026-09-27"), NOW)).toBe("9/27 23:59");
  });
});

describe("diffPctText: 0.1% 초과를 0.10% 로 보이지 않게", () => {
  it.each([
    [0.12, "0.12"],
    [0.104, "0.104"],
    [0.1, "0.10"],
    [1.5, "1.50"],
  ])("%s → %s", (abs, want) => expect(diffPctText(abs)).toBe(want));
});

type Last = NonNullable<NonNullable<ReconcileBadgeBody["status"]>["last"]>;
const SYNC_NOW: NonNullable<ReconcileBadgeBody["sync"]> = { enabled: true, intervalMin: 10, idleIntervalMin: 60, lastRunAt: at("14:00:00"), nextRunAt: at("14:10:00") };
function body(last: Partial<Last> | null, o: { sync?: ReconcileBadgeBody["sync"]; streakOver?: number; intraday?: ReconcileBadgeBody["intraday"] } = {}): ReconcileBadgeBody {
  return {
    on: true,
    status: {
      last: last ? { at: at("14:00:00"), diffKrw: 1_000, diffPct: 0.05, missing: 0, n: 17, ...last } : null,
      streakOver: o.streakOver ?? 0,
      qtyStreak: 0,
      week: { n: 0, withinPct: null },
      alert: false,
    },
    intraday: o.intraday === undefined ? { n: 0, withinPct: null, skipped: 0 } : o.intraday,
    sync: o.sync === undefined ? SYNC_NOW : o.sync,
  };
}

describe("reconcileBadge: 점 옆 글 (작업지시 1.5-1 표)", () => {
  it("상수: 경고 기준 0.1%, 30초마다 다시 받음, 꺼짐 본문", () => {
    expect(WARN_PCT).toBe(0.1);
    expect(RECONCILE_POLL_MS).toBeLessThanOrEqual(30_000);
    expect(RECONCILE_OFF).toEqual({ on: false, status: null, intraday: null, sync: null });
    expect(BASIS_FOOT).toBe("앱이 받은 시세로 계산한 숫자입니다 · 매매 권유가 아닙니다");
  });

  it("none: 받기 전·실패·꺼짐·대조 상태를 못 읽음 → '숫자 기준'", () => {
    const none = { kind: "none", text: "숫자 기준", tone: "muted", speech: "토스 대조 없음" };
    expect(reconcileBadge(undefined, NOW)).toEqual(none);
    expect(reconcileBadge(null, NOW)).toEqual(none);
    expect(reconcileBadge(RECONCILE_OFF, NOW)).toEqual(none);
    expect(reconcileBadge({ ...body(null), status: null }, NOW)).toEqual(none);
  });

  it("오늘 기록 (14:00, 같은 종목 17개): 일곱 상태의 글·색·화면 읽기", () => {
    expect(reconcileBadge(body(null), NOW)).toEqual({ kind: "wait", text: "토스 대조 대기", tone: "muted", speech: "토스 대조 기록 없음" });
    expect(reconcileBadge(body({ at: at("13:40:00") }, { sync: { ...SYNC_NOW, lastRunAt: at("13:40:00"), nextRunAt: at("13:50:00") } }), NOW)).toEqual({
      kind: "old",
      text: "토스 대조 13:40",
      tone: "muted",
      speech: "13시 40분 뒤로 새 토스 대조 기록 없음",
    });
    expect(reconcileBadge(body({ qtyMismatch: ["005930", "AAPL"], missing: 2 }), NOW)).toEqual({ kind: "qty", text: "토스와 수량 다름", tone: "warn", speech: "보유 수량이 토스와 다른 종목 2개, 14시 대조" });
    expect(reconcileBadge(body({ missing: 1 }), NOW)).toEqual({ kind: "missing", text: "토스 대조 대기", tone: "muted", speech: "시세 지연 등으로 비교 못 함, 14시 대조" });
    expect(reconcileBadge(body({ diffPct: 0.12 }), NOW)).toEqual({ kind: "over", text: "토스와 차이 0.12%", tone: "warn", speech: "토스 계좌와 0.12% 차이, 같은 종목 17개 비교, 14시 대조" });
    expect(reconcileBadge(body({ diffPct: -0.3 }), NOW).text).toBe("토스와 차이 0.30%");
    expect(reconcileBadge(body({}), NOW)).toEqual({ kind: "ok", text: "토스와 0.1% 이내", tone: "ok", speech: "토스 계좌와 0.1% 이내, 같은 종목 17개 비교, 14시 대조" });
    // 비교 종목 수가 없는 예전 기록은 그 말을 빼고, 분이 있으면 '14시 3분'
    expect(reconcileBadge(body({ n: undefined, at: at("14:03:00") }), NOW).speech).toBe("토스 계좌와 0.1% 이내, 14시 3분 대조");
    expect(reconcileBadge(body({ n: 0 }), NOW).speech).toBe("토스 계좌와 0.1% 이내, 14시 대조");
  });

  it("0.1% 경계: 0.1 은 이내, 0.104 는 '토스와 차이 0.104%'", () => {
    expect(reconcileBadge(body({ diffPct: 0.1 }), NOW).kind).toBe("ok");
    expect(reconcileBadge(body({ diffPct: -0.1 }), NOW).kind).toBe("ok");
    expect(reconcileBadge(body({ diffPct: 0.104 }), NOW)).toMatchObject({ kind: "over", text: "토스와 차이 0.104%" });
  });

  it("어제 기록 (23:58 을 다음 날 00:05 에 봄): 화면 읽기는 날짜·시각 그대로, 20분 넘으면 '토스 대조 9/28 23:58'", () => {
    const now = Date.parse("2026-09-29T00:05:00+09:00");
    const sync = { ...SYNC_NOW, lastRunAt: at("23:58:00"), nextRunAt: at("00:08:00", "2026-09-29") };
    const b = (last: Partial<Last>) => body({ at: at("23:58:00"), ...last }, { sync });
    expect(reconcileBadge(b({}), now).speech).toBe("토스 계좌와 0.1% 이내, 같은 종목 17개 비교, 9월 28일 (월) 23:58 대조");
    expect(reconcileBadge(b({ diffPct: 0.2 }), now).speech).toBe("토스 계좌와 0.20% 차이, 같은 종목 17개 비교, 9월 28일 (월) 23:58 대조");
    expect(reconcileBadge(b({ qtyMismatch: ["AAPL"] }), now).speech).toBe("보유 수량이 토스와 다른 종목 1개, 9월 28일 (월) 23:58 대조");
    expect(reconcileBadge(b({ missing: 1 }), now).speech).toBe("시세 지연 등으로 비교 못 함, 9월 28일 (월) 23:58 대조");
    expect(reconcileBadge(b({}), Date.parse("2026-09-29T00:18:01+09:00"))).toEqual({
      kind: "old",
      text: "토스 대조 9/28 23:58",
      tone: "muted",
      speech: "9월 28일 (월) 23:58 뒤로 새 토스 대조 기록 없음",
    });
  });

  it("'오래됨' 경계 (> 이므로 딱 그 시각은 이전 상태): 장중 20분 · 장 밖 70분 · 주기를 모르면 70분", () => {
    const kind = (b: ReconcileBadgeBody, now: number) => reconcileBadge(b, now).kind;
    // 장중: 기록·마지막 동기화 14:00, 다음 14:10 → 20분
    const intraday = body({});
    expect(kind(intraday, ms("14:19:59"))).toBe("ok");
    expect(kind(intraday, ms("14:20:00"))).toBe("ok");
    expect(kind(intraday, ms("14:20:01"))).toBe("old");
    // 장 밖: 기록·마지막 동기화 15:00, 다음 16:00 → 70분
    const idle = body({ at: at("15:00:00") }, { sync: { ...SYNC_NOW, lastRunAt: at("15:00:00"), nextRunAt: at("16:00:00") } });
    expect(kind(idle, ms("16:09:59"))).toBe("ok");
    expect(kind(idle, ms("16:10:01"))).toBe("old");
    // 동기화 정보 없음 · 다음 실행 없음(자동 동기화 꺼짐) · 다음 실행이 마지막보다 앞 → idleIntervalMin(없으면 60) + 10
    for (const sync of [null, { ...SYNC_NOW, nextRunAt: null }, { ...SYNC_NOW, nextRunAt: at("13:00:00") }]) {
      const b = body({}, { sync });
      expect(kind(b, ms("15:09:59"))).toBe("ok");
      expect(kind(b, ms("15:10:01"))).toBe("old");
    }
    expect(staleAfterMin(null)).toBe(70);
    expect(staleAfterMin({ ...SYNC_NOW, nextRunAt: null, idleIntervalMin: 30 })).toBe(40);
    expect(staleAfterMin(SYNC_NOW)).toBe(20);
  });

  it("동기화가 실패만 해도(다음 실행이 계속 앞으로 가도) 마지막 기록 시각에서 재 '오래됨'이 된다", () => {
    const failing = body({}, { sync: { ...SYNC_NOW, lastRunAt: at("14:20:00"), nextRunAt: at("14:30:00") } });
    expect(reconcileBadge(failing, ms("14:20:01"))).toMatchObject({ kind: "old", text: "토스 대조 14:00", speech: "14시 뒤로 새 토스 대조 기록 없음" });
  });

  it("배지는 마지막 기록 그대로: 0.1% 초과가 한 번만이어도 '차이' (3번 연속 규칙은 서버 경고에만)", () => {
    expect(reconcileBadge(body({ diffPct: 0.15 }, { streakOver: 1 }), NOW).kind).toBe("over");
  });
});

const ROW_KEYS = (rows: ReturnType<typeof basisRows>) => rows.map((r) => r.key);
const base = { stocks: MIXED, afterCost: true, fxNote: null, excluded: null, reconcile: body({}), now: NOW };

describe("basisRows: '숫자 기준' 창의 줄 (작업지시 1.5-2 표)", () => {
  it("시세 · 평가금액 · 당일손익 · 토스 대조 — 비용 차감 켬/끔 글", () => {
    const rows = basisRows(base);
    expect(ROW_KEYS(rows)).toEqual(["quote", "value", "day", "toss"]);
    expect(rows[0]).toEqual({ key: "quote", label: "시세", lines: ["국내 3종목 · NXT 포함 · 14:02~14:03", "미국 14종목 · 주간거래 12 · 정규장 2 · 9/26 05:00~14:03"] });
    expect(rows[1]).toEqual({ key: "value", label: "평가금액", lines: ["수수료·세금 예상액을 뺀 값 (설정 '수수료·세금 차감 평가' 켬)"] });
    expect(rows[2]).toEqual({ key: "day", label: "당일손익", lines: ["종목마다 전일 대비 × 수량 (미국 종목은 적용 환율로 원화 환산 — 환율 변동은 넣지 않음)"] });
    expect(basisRows({ ...base, afterCost: false })[1]!.lines).toEqual(["수수료·세금을 빼기 전 값 (설정 '수수료·세금 차감 평가' 꺼짐)"]);
  });

  it("시세 지연 4종목 → '4종목 · A, B, C 외 1' (경고색), 합계 제외·원화 환산 줄", () => {
    const stocks = ["A", "B", "C", "D"].map((n, i) => holding(`30000${i}`, quote(`30000${i}`, 1_000, { stale: true, priceBasis: "KRX+NXT 통합", asOf: at("14:00:00") }), 1, 900, undefined, n));
    const excluded = excludedLabel({ noQuote: 1, noEval: 0, noFx: 2 });
    const rows = basisRows({ ...base, stocks, excluded, fxNote: "토스 적용 환율 1,390원 · 원화 손익은 매수 당시 환율 기준" });
    expect(ROW_KEYS(rows)).toEqual(["quote", "stale", "excluded", "value", "fx", "day", "toss"]);
    expect(rows[1]).toEqual({ key: "stale", label: "시세 지연", lines: ["4종목 · A, B, C 외 1"], warn: true });
    expect(rows[2]).toEqual({ key: "excluded", label: "합계 제외", lines: ["시세 없음 1종목 · 환율 없음 2종목 제외"], warn: true });
    expect(rows[4]).toEqual({ key: "fx", label: "원화 환산", lines: ["토스 적용 환율 1,390원 · 원화 손익은 매수 당시 환율 기준"] });
    expect(basisRows({ ...base, stocks: stocks.slice(0, 1) })[1]!.lines).toEqual(["1종목 · A"]);
  });

  it("토스 대조 끔(on 거짓)·상태를 못 읽음(status null)·받기 전 → '토스 대조' 줄 없음 (나머지 줄은 그대로)", () => {
    for (const reconcile of [RECONCILE_OFF, { ...body({}), status: null }, undefined, null]) expect(ROW_KEYS(basisRows({ ...base, reconcile }))).toEqual(["quote", "value", "day"]);
  });

  it("토스 대조 줄 다섯 개가 모두 나오는 경우 (글자 그대로)", () => {
    const reconcile = body({ diffKrw: 104_000, diffPct: 0.104, n: 17 }, { streakOver: 2, intraday: { n: 42, withinPct: 97.6, skipped: 3 } });
    const toss = basisRows({ ...base, reconcile }).find((r) => r.key === "toss")!;
    expect(toss).toEqual({
      key: "toss",
      label: "토스 대조",
      lines: [
        "차이 +104,000원 (+0.104%) · 9월 28일 (월) 14:00",
        "같은 종목 17개의 토스 평가금액(수수료·세금 차감)과 비교",
        "0.1% 넘는 차이 2회 연속",
        "최근 7일 장중(정규장) 42회 중 97.6%가 0.1% 이내 · 비교 못 함 3회",
        "토스 동기화 때마다 대조합니다 (장중 10분, 장 밖 60분마다)",
      ],
      muted: [4],
    });
  });

  it("비율은 서버 숫자 그대로(75 → '75%'), 비교 기록 없음 · 비율 없음 · 동기화 꺼짐 · 대조 기록 없음", () => {
    const toss = (o: Parameters<typeof body>[1], last: Partial<Last> | null = {}) => basisRows({ ...base, reconcile: body(last, o) }).find((r) => r.key === "toss")!;
    expect(toss({ intraday: { n: 4, withinPct: 75, skipped: 0 } }).lines).toContain("최근 7일 장중(정규장) 4회 중 75%가 0.1% 이내");
    expect(toss({ intraday: { n: 3, withinPct: 66.7, skipped: 0 } }).lines).toContain("최근 7일 장중(정규장) 3회 중 66.7%가 0.1% 이내");
    expect(toss({ intraday: { n: 0, withinPct: null, skipped: 2 } }).lines).toContain("최근 7일 장중(정규장) 비교 기록 없음 · 비교 못 함 2회");
    expect(toss({ intraday: null }).lines.some((l) => l.startsWith("최근 7일"))).toBe(false);
    const off = toss({ sync: { ...SYNC_NOW, enabled: false, nextRunAt: null } });
    expect(off.lines.at(-1)).toBe("자동 동기화가 꺼져 있어 설정의 '지금 계좌 동기화' 때만 대조합니다");
    expect(off.muted).toEqual([off.lines.length - 1]);
    expect(toss({ sync: { ...SYNC_NOW, intervalMin: 0 } }).lines.at(-1)).toBe("자동 동기화가 꺼져 있어 설정의 '지금 계좌 동기화' 때만 대조합니다");
    // 동기화 정보가 없으면 그 줄·흐린 글 없음, 연속 0 이면 연속 줄 없음, 비교 종목 수가 없으면 그 줄 없음
    const bare = toss({ sync: null }, { n: undefined });
    expect(bare.lines).toEqual(["차이 +1,000원 (+0.05%) · 9월 28일 (월) 14:00", "최근 7일 장중(정규장) 비교 기록 없음"]);
    expect(bare.muted).toBeUndefined();
    expect(toss({}, null).lines[0]).toBe("아직 없음 (동기화 뒤 표시)");
  });
});

describe("reconcileLabel: 설정 화면(두 인자)은 지금과 같은 글", () => {
  it("두 인자 부름은 소수 둘째 자리, 셋째 인자로 % 글자를 바꿀 수 있다", () => {
    const r = { last: { at: "x", diffKrw: 104_000, diffPct: 0.104, missing: 0 } };
    expect(reconcileLabel(r, () => "9/28 14:00")).toBe("차이 +104,000원 (+0.10%) · 9/28 14:00");
    expect(reconcileLabel(r, () => "9/28 14:00", diffPctText)).toBe("차이 +104,000원 (+0.104%) · 9/28 14:00");
  });
});

describe("quoteBasisLine · quoteBasisSpeech: 계좌 브리핑 상세 '시세 기준' 줄 (3-32 PR 2)", () => {
  // 서버 quoteBasisOf 순수 테스트(backend/test/numberBasis.test.ts)의 결과 그대로
  const server: QuoteBasis = {
    kr: { count: 3, tags: [{ tag: "NXT", count: 3 }] },
    us: {
      count: 15,
      tags: [
        { tag: "주간거래", count: 12 },
        { tag: "정규장", count: 2 },
        { tag: "모름", count: 1 },
      ],
    },
  };
  const krOnly: QuoteBasis = { kr: server.kr, us: null };

  it("줄: 시장마다 기준이 하나면 말만, 여럿이면 '말 수'를 가운뎃점으로, 끝에 계산 시각", () => {
    expect(quoteBasisLine(server, "08:38")).toBe("국내 NXT 포함 · 미국 주간거래 12·정규장 2·기준 모름 1 · 08:38 계산");
    expect(quoteBasisLine(krOnly, "08:38")).toBe("국내 NXT 포함 · 08:38 계산");
    expect(quoteBasisLine({ kr: server.kr, us: { count: 1, tags: [{ tag: "정규장", count: 1 }] } }, "08:38")).toBe("국내 NXT 포함 · 미국 정규장 · 08:38 계산");
  });

  it("없음(예전 기록)·두 시장 모두 없음 → null", () => {
    expect(quoteBasisLine(undefined, "08:38")).toBeNull();
    expect(quoteBasisLine(null, "08:38")).toBeNull();
    expect(quoteBasisLine({ kr: null, us: null }, "08:38")).toBeNull();
    expect(quoteBasisSpeech(undefined, "08:38")).toBeNull();
    expect(quoteBasisSpeech({ kr: null, us: null }, "08:38")).toBeNull();
  });

  it("화면 읽기: 가운뎃점 대신 쉼표, 여럿이면 기준마다 'N종목', 시각은 말로", () => {
    expect(quoteBasisSpeech(server, "08:38")).toBe("시세 기준, 국내 NXT 포함, 미국 주간거래 12종목, 정규장 2종목, 기준 모름 1종목, 8시 38분 계산");
    expect(quoteBasisSpeech(krOnly, "08:38")).toBe("시세 기준, 국내 NXT 포함, 8시 38분 계산");
    expect(quoteBasisSpeech(krOnly, "16:00")).toBe("시세 기준, 국내 NXT 포함, 16시 계산");
  });

  // 합친 모습 리뷰: 한 글로 그리면 좁은 칸·큰 글씨에서 '· 09:13 계산'(줄 첫머리 '·'), '…시간외 포함' / '1 · 09:13 계산'(수가 이름과 떨어짐),
  // '미국 정규장 9·주' / '간거래 2'(낱말 가운데)로 꺾였다 → 기준 하나('말 수')가 한 묶음, 이음표는 앞 묶음 끝, 묶음 안 빈칸은 줄바꿈 없는 공백
  describe("quoteBasisChunks: 묶음째 줄바꿈할 조각", () => {
    const plain = (s: string) => s.replace(/ /g, " ");
    const mixed: QuoteBasis = {
      kr: { count: 9, tags: [{ tag: "NXT", count: 9 }] },
      us: {
        count: 12,
        tags: [
          { tag: "정규장", count: 9 },
          { tag: "주간거래", count: 2 },
          { tag: "시간외", count: 1 },
        ],
      },
    };

    it("기준 하나가 한 조각, 시장 이름은 그 시장 첫 조각에, 이음표는 앞 조각 끝 (시장 안 '·', 시장·시각 사이 ' · ')", () => {
      expect(quoteBasisChunks(mixed, "09:13")!.map(plain)).toEqual(["시세 기준: ", "국내 NXT 포함 · ", "미국 정규장 9·", "주간거래 2·", "시간외 포함 1 · ", "09:13 계산"]);
      expect(quoteBasisChunks(server, "08:38")!.map(plain)).toEqual(["시세 기준: ", "국내 NXT 포함 · ", "미국 주간거래 12·", "정규장 2·", "기준 모름 1 · ", "08:38 계산"]);
      expect(quoteBasisChunks(krOnly, "08:38")!.map(plain)).toEqual(["시세 기준: ", "국내 NXT 포함 · ", "08:38 계산"]);
      // 시각을 모르면 마지막 시장 조각에 이음표 없음
      expect(quoteBasisChunks(krOnly, "")!.map(plain)).toEqual(["시세 기준: ", "국내 NXT 포함"]);
      expect(quoteBasisChunks(mixed, "")!.map(plain).at(-1)).toBe("시간외 포함 1");
    });

    it("조각을 이으면 '시세 기준: ' + 한 줄 글 그대로 (한 줄에 들어가면 지금 모양)", () => {
      for (const [q, at] of [[mixed, "09:13"], [server, "08:38"], [krOnly, "08:38"], [krOnly, ""], [{ kr: null, us: mixed.us }, "16:00"]] as const) {
        expect(plain(quoteBasisChunks(q, at)!.join(""))).toBe(`시세 기준: ${quoteBasisLine(q, at)}`);
      }
    });

    it("어느 조각도 '·'·빈칸으로 시작하지 않고(줄이 바뀌어도 새 줄 첫머리가 '·'가 아님), 조각 안에 보통 빈칸이 없다(수·낱말이 떨어지지 않음)", () => {
      for (const q of [mixed, server, krOnly]) {
        for (const p of quoteBasisChunks(q, "09:13")!) {
          expect(p).not.toMatch(/^[\s ·]/);
          expect(p).not.toMatch(/ /);
        }
      }
    });

    it("없음(예전 기록)·두 시장 모두 없음 → null", () => {
      expect(quoteBasisChunks(undefined, "08:38")).toBeNull();
      expect(quoteBasisChunks(null, "08:38")).toBeNull();
      expect(quoteBasisChunks({ kr: null, us: null }, "08:38")).toBeNull();
    });
  });
});
