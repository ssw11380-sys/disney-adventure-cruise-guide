import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AccountBriefing, AccountData, AccountSinceLast } from "@/api/types";
import { accountCardSpeech } from "@/lib/accountBriefing";
import { QTY_LINES_MAX, qtyText, sinceLastView, sinceLine, sinceNone, sinceTitle, speakDay, valueChangeText } from "@/lib/accountSinceLast";

/**
 * 브리핑 3차 3 — 지난 브리핑과 비교 (플래그 accountSinceLast), 앱 글·화면 읽기 (순수).
 * 공용 픽스처(shared/fixtures/accountSinceLast.json)의 서버 결과(expected)로 만든 글이 픽스처의 app 과 같아야 한다 — 서버 테스트는 같은 픽스처로 계산을 본다
 */
type Case = { name: string; now: Pick<AccountData, "session" | "date" | "asOf">; expected: AccountSinceLast; app: Record<string, unknown> & { value: { change: string; fromTo: string }; profit: { change: string; fromTo: string }; qty: string[] | null; weights: string[] | null; notes: string[] } };
const fixture = JSON.parse(readFileSync(new URL("../../shared/fixtures/accountSinceLast.json", import.meta.url), "utf8")) as { cases: Case[] };

/** 서버 검사기(backend/src/analysis/scoreWording.ts)의 금지어·미래형 정규식을 그대로 읽어 쓴다 */
const src = readFileSync(new URL("../../backend/src/analysis/scoreWording.ts", import.meta.url), "utf8");
const BANNED = new RegExp(/SCORE_BANNED_RE =\s*\/(.+)\/;/.exec(src)![1]!, "g");
const FUTURE = new RegExp(/SCORE_FUTURE_RE = \/(.+)\/;/.exec(src)![1]!, "g");
/** 판단하는 말 (사실만 — 쏠림·위험·주의·좋·나쁘) */
const JUDGE = /쏠림|위험|주의|좋|나쁘|많이|너무|걱정|조심/;

/** 서버 accountBriefingService.sinceHeadline 과 같은 값 */
const headlineSince = (s: AccountSinceLast) => ({
  date: s.prev.date,
  session: s.prev.session,
  change: s.value.change,
  qtyChanged: s.positions ? s.positions.added.length + s.positions.removed.length + s.positions.increased.length + s.positions.decreased.length : null,
});
const briefing = (since: ReturnType<typeof headlineSince> | undefined, over: Partial<AccountBriefing> = {}): AccountBriefing => ({
  id: 12,
  date: "2026-09-28",
  session: "morning",
  status: "ok",
  summary: "당일 +1원",
  detail: "",
  model: "template",
  template: true,
  createdAt: "2026-09-28T08:38:30+09:00",
  headline: { totalValue: 11_926_340, dayPnl: 12_000, dayRate: 0.1, holdings: 6, top: [], ...(since ? { since } : {}) },
  ...over,
});

const allText = (v: ReturnType<typeof sinceLastView>) => [
  v.title, v.range, valueChangeText(v.value), v.value.fromTo, v.profit.amount, v.profit.fromTo,
  ...(v.qty?.lines.flatMap((l) => [l.label, l.body, l.speech]) ?? []), ...(v.weights?.flatMap((w) => [w.body, w.change]) ?? []), ...v.notes,
  v.headSpeech, v.qtySpeech ?? "", v.weightSpeech ?? "",
];

describe("공용 픽스처: 서버가 저장한 비교 → 카드 글·화면 읽기", () => {
  for (const c of fixture.cases) {
    it(c.name, () => {
      const v = sinceLastView(c.expected, c.now);
      expect(v.title).toBe(c.app.title);
      expect(v.range).toBe(c.app.range);
      expect(valueChangeText(v.value)).toBe(c.app.value.change);
      expect(v.value.fromTo).toBe(c.app.value.fromTo);
      expect(v.profit.amount).toBe(c.app.profit.change);
      expect(v.profit.fromTo).toBe(c.app.profit.fromTo);
      expect(v.qty ? v.qty.lines.map((l) => `${l.label} · ${l.body}`) : null).toEqual(c.app.qty);
      expect(v.weights ? v.weights.map((w) => `${w.body} ${w.change}`) : null).toEqual(c.app.weights);
      expect(v.notes).toEqual(c.app.notes);
      expect(v.headSpeech).toBe(c.app.headSpeech);
      const l = sinceLine(briefing(headlineSince(c.expected)))!;
      expect(l.text).toBe(c.app.line);
      expect(l.speech).toBe(c.app.lineSpeech);
      // 문구 검사 (권유·전망·미래형·판단하는 말 0건)
      for (const s of [...allText(v), l.text, l.speech]) {
        expect(s.match(BANNED), s).toBeNull();
        expect(s.match(FUTURE), s).toBeNull();
        expect(JUDGE.test(s), s).toBe(false);
      }
    });
  }

  it("화면 읽기: 수량·비중 묶음 한 문장 (기호 없이)", () => {
    const monday = fixture.cases.find((c) => c.name === "monday")!;
    const v = sinceLastView(monday.expected, monday.now);
    expect(v.qtySpeech).toBe("수량이 바뀐 종목 4개, 새 종목 삼성전자 10주, 없어진 종목 테슬라 전에 3주, 수량 늘어남 엔비디아 5주에서 8주, 수량 줄어듦 SK하이닉스 10주에서 8주");
    expect(v.weightSpeech).toBe(
      "비중 변화가 큰 종목, 엔비디아 18.2퍼센트에서 22.7퍼센트로 4.5퍼센트포인트 늘어남, SK하이닉스 26.7퍼센트에서 28.9퍼센트로 2.2퍼센트포인트 늘어남, 마이크로소프트 8.1퍼센트에서 9.4퍼센트로 1.3퍼센트포인트 늘어남",
    );
    for (const s of [v.headSpeech, v.qtySpeech!, v.weightSpeech!]) expect(s).not.toMatch(/[→·%+()]/);
    const quiet = fixture.cases.find((c) => c.name === "afternoonQuiet")!;
    const q = sinceLastView(quiet.expected, quiet.now);
    expect(q.qtySpeech).toBe("수량이 바뀐 종목 없음");
    expect(q.weightSpeech).toBe("비중이 0.5퍼센트포인트 이상 바뀐 종목 없음");
    // 첫날(종목별 값 없음): 수량·비중 묶음 자체가 없다
    const first = fixture.cases.find((c) => c.name === "firstDay")!;
    expect(sinceLastView(first.expected, first.now)).toMatchObject({ qty: null, weights: null, qtySpeech: null, weightSpeech: null });
  });

  it("색: 변화 금액·%p 에만 보이는 부호로 (0원이면 색 없음), 비중 줄의 부호", () => {
    const [monday, , excluded] = fixture.cases as [Case, Case, Case];
    const v = sinceLastView(monday.expected, monday.now);
    expect([v.value.sign, v.value.rateSign, v.profit.sign]).toEqual([-1, -1, 1]);
    expect(v.weights!.map((w) => w.sign)).toEqual([1, 1, 1]);
    const e = sinceLastView(excluded.expected, excluded.now);
    expect(e.profit).toMatchObject({ amount: "0원", sign: 0 });
  });
});

describe("모양·예외", () => {
  const base: AccountSinceLast = {
    prev: { id: 1, date: "2026-09-25", session: "morning", asOf: "2026-09-25T08:38:00+09:00" },
    value: { from: 1_000, to: 1_000, change: 0, rate: 0 },
    profit: { from: 0, to: 0, change: 0 },
    positions: { added: [], removed: [], increased: [], decreased: [] },
    weights: [],
    excludedNow: [],
    excludedPrev: [],
  };
  const now = { session: "morning" as const, date: "2026-09-28", asOf: "2026-09-28T08:38:00+09:00" };

  it("제목·없음 줄: 오전·오후", () => {
    expect(sinceTitle("afternoon")).toBe("지난 오후 브리핑과 비교");
    expect(sinceNone("morning")).toBe("비교할 지난 오전 브리핑이 없습니다.");
    expect(sinceNone("afternoon")).toBe("비교할 지난 오후 브리핑이 없습니다.");
  });

  it("총 평가 변화 0원: 변화율 없이 '0원', 화면 읽기 '변화 없음' · 줄도 '0원'", () => {
    const v = sinceLastView(base, now);
    expect(valueChangeText(v.value)).toBe("0원");
    expect(v.value.sign).toBe(0);
    expect(v.headSpeech).toContain("총 평가금액 변화 없음, 평가손익 변화 없음");
    const l = sinceLine(briefing({ date: "2026-09-25", session: "morning", change: 0, qtyChanged: 0 }))!;
    expect(l.text).toBe("9/25(금) 오전보다 총 평가 0원");
    expect(l.speech).toBe("9월 25일 금요일 오전 브리핑보다 총 평가금액 변화 없음");
  });

  it(`수량 줄은 ${QTY_LINES_MAX}개까지 (넘으면 '외 N종목'), 화면 읽기는 모두 · 소수 주식`, () => {
    const added = Array.from({ length: 10 }, (_, i) => ({ code: `C${i}`, name: `종목${i}`, from: 0, to: i + 1 }));
    const v = sinceLastView({ ...base, positions: { added, removed: [], increased: [{ code: "U", name: "퀀티넘", from: 0.5, to: 1.25 }], decreased: [] } }, now);
    expect(v.qty!.lines).toHaveLength(QTY_LINES_MAX);
    expect(v.qty!.more).toBe(3);
    expect(v.qty!.count).toBe(11);
    expect(v.qtySpeech).toContain("수량 늘어남 퀀티넘 0.5주에서 1.25주");
    expect(qtyText(0.123456)).toBe("0.1235주");
    expect(qtyText(1200)).toBe("1,200주");
  });

  it("합계에서 뺀 종목: 이번·지난을 한 번씩 이름으로", () => {
    const v = sinceLastView({ ...base, excludedNow: [{ code: "T", name: "테슬라" }], excludedPrev: [{ code: "T", name: "테슬라" }, { code: "A", name: "애플" }] }, now);
    expect(v.notes).toContain("시세가 없어 합계에서 뺀 종목(테슬라, 애플)은 비교에서 뺐습니다.");
  });

  it("계좌 줄: 실패 브리핑·비교 없는 브리핑은 없음 · 수량 모름(null)·0 이면 수량 조각 없음", () => {
    expect(sinceLine(briefing(undefined))).toBeNull();
    expect(sinceLine(briefing({ date: "2026-09-25", session: "morning", change: 5, qtyChanged: 2 }, { status: "failed" }))).toBeNull();
    expect(sinceLine({ status: "ok", headline: null })).toBeNull();
    expect(sinceLine(briefing({ date: "2026-09-25", session: "afternoon", change: 5, qtyChanged: null }))!.text).toBe("9/25(금) 오후보다 총 평가 +5원");
  });

  it("읽는 날짜: '9월 25일 금요일' · 12/28 월", () => {
    expect(speakDay("2026-09-25")).toBe("9월 25일 금요일");
    expect(speakDay("2026-12-28")).toBe("12월 28일 월요일");
  });
});

describe("계좌 카드 화면 읽기 (accountCardSpeech)", () => {
  const since = { date: "2026-09-25", session: "morning" as const, change: 544_322, qtyChanged: 2 };
  it("since 옵션을 주면 총 평가금액 바로 뒤에 비교 한 조각, 안 주면 예전 문장 그대로", () => {
    const b = briefing(since);
    const old = accountCardSpeech(briefing(undefined));
    expect(accountCardSpeech(b)).toBe(old); // 옵션이 없으면 칸이 있어도 예전 그대로
    const on = accountCardSpeech(b, { since: true });
    expect(on).toContain("총 평가금액 11,926,340원, 9월 25일 금요일 오전 브리핑보다 총 평가금액 544,322원 늘어남, 수량이 바뀐 종목 2개");
    // 비교가 없는 브리핑은 옵션을 줘도 예전 문장
    expect(accountCardSpeech(briefing(undefined), { since: true })).toBe(old);
  });
});
