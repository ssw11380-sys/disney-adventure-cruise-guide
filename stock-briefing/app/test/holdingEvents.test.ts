import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AccountBriefing, AccountEventItem, AccountEvents } from "@/api/types";
import { accountCardSpeech } from "@/lib/accountBriefing";
import {
  amountText,
  DIVIDENDS_FAILED,
  EARNINGS_FAILED,
  EARNINGS_NOTE,
  eventLine,
  EVENTS_FAILED,
  EVENTS_LINES_MAX,
  eventsView,
  EX_DIVIDEND_NOTE,
  KR_DIVIDEND_NOTE,
  WEEK_HEAD,
  weekLine,
} from "@/lib/holdingEvents";

/**
 * 브리핑 3차 5 — 다가오는 일정 (플래그 holdingEvents) 화면용 순수 함수.
 * 공용 픽스처(shared/fixtures/holdingEvents.json): 서버가 녹화한 토스·네이버 응답으로 모은 events → 카드 줄·작은 글·기준·화면 읽기
 */
type Case = {
  name: string;
  events: AccountEvents;
  app: { title: string; sub: string; lines: string[]; more: number; empty: string | null; notes: string[]; basis: string; speech: { head: string; lines: string[]; basis: string } };
};
type WeekCase = { name: string; week: NonNullable<NonNullable<AccountBriefing["headline"]>["week"]>; app: { parts: string[]; text: string; speech: string } };
const fixture = JSON.parse(readFileSync(new URL("../../shared/fixtures/holdingEvents.json", import.meta.url), "utf8")) as { cases: Case[]; week: WeekCase[] };

/** 서버 검사기(backend/src/analysis/scoreWording.ts)의 금지어·미래형 정규식을 그대로 읽어 쓴다 */
const src = readFileSync(new URL("../../backend/src/analysis/scoreWording.ts", import.meta.url), "utf8");
const BANNED = new RegExp(/SCORE_BANNED_RE =\s*\/(.+)\/;/.exec(src)![1]!, "g");
const FUTURE = new RegExp(/SCORE_FUTURE_RE = \/(.+)\/;/.exec(src)![1]!, "g");

describe("공용 픽스처: 서버가 저장한 일정 → 카드 글·화면 읽기", () => {
  for (const c of fixture.cases) {
    it(c.name, () => {
      const v = eventsView(c.events);
      expect(v.title).toBe(c.app.title);
      expect(v.sub).toBe(c.app.sub);
      expect(v.lines.map((l) => l.text)).toEqual(c.app.lines);
      expect(v.lines.map((l) => l.parts.join(" · "))).toEqual(c.app.lines);
      expect(v.more).toBe(c.app.more);
      expect(v.empty).toBe(c.app.empty);
      expect(v.notes).toEqual(c.app.notes);
      expect(v.basis).toBe(c.app.basis);
      expect(v.headSpeech).toBe(c.app.speech.head);
      expect(v.lines.map((l) => l.speech)).toEqual(c.app.speech.lines);
      expect(v.basisSpeech).toBe(c.app.speech.basis);
    });
  }
});

describe("줄 모양", () => {
  const I = (over: Partial<AccountEventItem>): AccountEventItem => ({ code: "X", name: "엑스", kind: "exDividend", date: "2026-10-01", usDate: true, source: "toss", ...over });

  it("주당 금액: 달러는 소수 둘째~넷째 자리 ($0.90 · $0.2715 · $1,234.50), 원화는 원, 없거나 0 이면 없음", () => {
    expect(amountText({ amount: 0.9, currency: "USD" })).toBe("$0.90");
    expect(amountText({ amount: 0.2715, currency: "USD" })).toBe("$0.2715");
    expect(amountText({ amount: 0.09291, currency: "USD" })).toBe("$0.0929");
    expect(amountText({ amount: 1234.5, currency: "USD" })).toBe("$1,234.50");
    expect(amountText({ amount: 1875, currency: "KRW" })).toBe("1,875원");
    expect(amountText({ currency: "USD" })).toBeNull();
    expect(amountText({ amount: 0, currency: "USD" })).toBeNull();
  });

  it("한국 배당락일은 '(미국 날짜)' 없이 · 네이버로만 안 날짜는 금액 없이", () => {
    expect(eventLine(I({ code: "005930", name: "삼성전자", date: "2026-12-29", amount: 370, currency: "KRW", usDate: false })).text).toBe("12/29(화) · 삼성전자 배당락일 · 주당 370원");
    expect(eventLine(I({ name: "애플", date: "2026-12-07", source: "naver" })).text).toBe("12/7(월) · 애플 배당락일 (미국 날짜)");
  });

  it("한국 실적 발표: 시각 없이 날짜만 · 미국 실적은 토스 시각 글, 글이 없으면 한국 시각", () => {
    expect(eventLine(I({ code: "005930", name: "삼성전자", kind: "earnings", date: "2026-07-30", usDate: false })).text).toBe("7/30(목) · 삼성전자 실적 발표 (예정)");
    expect(eventLine(I({ code: "005930", name: "삼성전자", kind: "earnings", date: "2026-07-30", usDate: false })).speech).toBe("7월 30일 목요일, 삼성전자 실적 발표 예정");
    const noText = eventLine(I({ name: "팔란티어", kind: "earnings", date: "2026-11-03", kstTime: "06:00", usDate: false }));
    expect(noText.text).toBe("11/3(화) 06:00 · 팔란티어 실적 발표 (예정)");
    expect(noText.speech).toBe("11월 3일 화요일 6시, 팔란티어 실적 발표 예정");
  });

  it(`줄은 ${EVENTS_LINES_MAX}개까지, 넘으면 '외 N건' (날짜 순 그대로)`, () => {
    const items = Array.from({ length: 11 }, (_, i) => I({ code: `C${i}`, name: `종목${i}`, date: `2026-10-${String(i + 1).padStart(2, "0")}` }));
    const v = eventsView({ asOf: "2026-09-30T08:38:00+09:00", days: 30, items, earnings: false, failed: [], earningsFailed: false, conflicts: [], kr: 0, us: 11, week: null });
    expect(v.lines).toHaveLength(EVENTS_LINES_MAX);
    expect(v.lines[0]!.text).toBe("10/1(목) · 종목0 배당락일 (미국 날짜)");
    expect(v.more).toBe(3);
    expect(v.headSpeech).toBe("다가오는 일정, 보유 종목 30일 안, 11건");
  });

  it("실적 켬 + 캘린더를 받지 못함 + 배당은 받음: 없음 한 줄은 배당락일만 말하고 '실적 발표일을 받지 못했습니다' 작은 글", () => {
    const v = eventsView({ asOf: "2026-09-28T08:38:00+09:00", days: 30, items: [], earnings: true, failed: [], earningsFailed: true, conflicts: [], kr: 0, us: 2, week: null });
    expect(v.empty).toBe("30일 안에 알려진 배당락일이 없습니다.");
    expect(v.notes).toEqual([EARNINGS_FAILED]);
  });

  it("배당 일정을 모두 받지 못했지만 실적 발표일은 받음: 없음 한 줄은 받은 실적만 말하고('배당락일이 없습니다'라고 하지 않음) '배당 일정을 받지 못했습니다' 작은 글", () => {
    const failed = [{ code: "TSLA", name: "테슬라" }, { code: "AAPL", name: "애플" }];
    const v = eventsView({ asOf: "2026-09-28T08:38:00+09:00", days: 30, items: [], earnings: true, failed, earningsFailed: false, conflicts: [], kr: 0, us: 2, week: null });
    expect(v.empty).toBe("30일 안에 알려진 실적 발표일이 없습니다.");
    expect(v.notes).toEqual([EARNINGS_NOTE, DIVIDENDS_FAILED]);
    // 실적 발표 줄이 있어도 같은 작은 글 (이름을 모두 늘어놓지 않음)
    const withEarnings = eventsView({ asOf: "2026-10-26T08:38:00+09:00", days: 30, items: [{ code: "AAPL", name: "애플", kind: "earnings", date: "2026-10-30", kstTime: "05:00", timeText: "오전 5시 이후", usDate: false, source: "toss" }], earnings: true, failed, earningsFailed: false, conflicts: [], kr: 0, us: 2, week: null });
    expect(withEarnings.empty).toBeNull();
    expect(withEarnings.notes).toEqual([EARNINGS_NOTE, DIVIDENDS_FAILED]);
    // 실적 꺼짐이면 모두 받지 못한 것
    expect(eventsView({ asOf: "2026-09-28T08:38:00+09:00", days: 30, items: [], earnings: false, failed, earningsFailed: false, conflicts: [], kr: 0, us: 2, week: null }).empty).toBe(EVENTS_FAILED);
  });

  it("일부 종목만 받지 못함: 이름은 5개까지, 넘으면 '외 N종목'", () => {
    const failed = ["가", "나", "다", "라", "마", "바", "사"].map((n, i) => ({ code: `C${i}`, name: `종목${n}` }));
    const v = eventsView({ asOf: "2026-09-28T08:38:00+09:00", days: 30, items: [], earnings: false, failed, earningsFailed: false, conflicts: [], kr: 0, us: 10, week: null });
    expect(v.empty).toBe("30일 안에 알려진 배당락일이 없습니다.");
    expect(v.notes).toEqual(["배당 일정을 받지 못한 종목: 종목가, 종목나, 종목다, 종목라, 종목마 외 2종목 (다음 브리핑 때 다시 받습니다)"]);
  });

  it("기준 시각을 읽지 못하면 시각 조각을 뺀다 (틀린 시각을 보이지 않게)", () => {
    const v = eventsView({ asOf: "모름", days: 30, items: [], earnings: false, failed: [], earningsFailed: false, conflicts: [], kr: 0, us: 1, week: null });
    expect(v.basis).toBe("출처 토스증권");
  });
});

describe("이번 주 한 줄 (headline.week)", () => {
  const ACCOUNT: AccountBriefing = {
    id: 21, date: "2026-10-26", session: "morning", status: "ok", summary: "요약", detail: "", model: "template", template: true, createdAt: "2026-10-26T08:38:00+09:00",
    headline: { totalValue: 10_000_000, dayPnl: 12_000, dayRate: 0.12, holdings: 6, top: [{ code: "MSFT", name: "마이크로소프트", amount: 12_000, changeRate: 0.5 }] },
  };
  for (const c of fixture.week) {
    it(c.name, () => {
      const l = weekLine({ ...ACCOUNT, headline: { ...ACCOUNT.headline!, week: c.week } })!;
      expect(l.parts).toEqual(c.app.parts);
      expect(l.text).toBe(c.app.text);
      expect(l.speech).toBe(c.app.speech);
      expect(l.parts[0]).toBe(WEEK_HEAD);
    });
  }

  it("칸이 없거나 빈 배열·실패한 브리핑이면 없음", () => {
    expect(weekLine(ACCOUNT)).toBeNull();
    expect(weekLine({ ...ACCOUNT, headline: { ...ACCOUNT.headline!, week: [] } })).toBeNull();
    expect(weekLine({ ...ACCOUNT, status: "failed", headline: { ...ACCOUNT.headline!, week: fixture.week[0]!.week } })).toBeNull();
  });

  it("카드 화면 읽기: week 옵션이 있을 때만 기여 뒤·'자세히 보기' 앞에 이번 주 조각 (옵션이 없으면 예전 문장 그대로)", () => {
    const b = { ...ACCOUNT, headline: { ...ACCOUNT.headline!, week: fixture.week[0]!.week } };
    const on = accountCardSpeech(b, { week: true });
    expect(on).toContain(`기여 1위 마이크로소프트 12,000원 이익, ${fixture.week[0]!.app.speech}, 자세히 보기`);
    expect(accountCardSpeech(b)).toBe(accountCardSpeech(ACCOUNT));
    expect(accountCardSpeech(ACCOUNT, { week: true })).toBe(accountCardSpeech(ACCOUNT));
  });
});

describe("문구 검사 (사실만 — 매매·전망·판단하는 말 없음)", () => {
  it("고정 글과 픽스처의 모든 글·읽는 말", () => {
    const texts = [
      EX_DIVIDEND_NOTE,
      EARNINGS_NOTE,
      KR_DIVIDEND_NOTE,
      EVENTS_FAILED,
      EARNINGS_FAILED,
      DIVIDENDS_FAILED,
      "배당 일정을 받지 못한 종목: 종목가, 종목나, 종목다, 종목라, 종목마 외 2종목 (다음 브리핑 때 다시 받습니다)",
      "토스증권과 네이버의 배당락일이 달라 뺀 종목: 마이크로소프트",
      ...fixture.cases.flatMap((c) => [c.app.title, c.app.sub, ...c.app.lines, c.app.empty ?? "", ...c.app.notes, c.app.basis, c.app.speech.head, ...c.app.speech.lines, c.app.speech.basis]),
      ...fixture.week.flatMap((c) => [c.app.text, c.app.speech]),
    ];
    for (const t of texts) {
      expect(t.match(BANNED) ?? [], t).toEqual([]);
      expect(t.match(FUTURE) ?? [], t).toEqual([]);
    }
  });
});
