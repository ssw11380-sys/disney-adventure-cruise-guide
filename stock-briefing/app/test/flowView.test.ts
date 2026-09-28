import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as text from "@/lib/flowText";
import { barLayout, barsSpeech, dateKo, dateLong, detailTabLabels, flowSumRows, formatPp, formatRatio, formatShares, hhmm, linePoints, lineSegments, PHONE_TABS, pickIndex, shortDate, showSumTable, stampKo, WIDE_TABS_BASE } from "@/lib/flowView";
import { parseDetailTab, phoneTab, wideTab } from "@/lib/detailLayout";
import type { FlowDay, FlowSum } from "@/api/types";

/**
 * 3-33 수급 탭 순수 함수 (lib/flowView · lib/flowText). 설계서 3.1 탭 이름 표 · 3.4 숫자 모양 · 3.5 화면 읽기 · 3.6 막대 폭.
 * 문구 검사: 서버 검사기(backend/src/analysis/scoreWording.ts 금지어·미래형 + backend/src/services/flowText.ts 수급 판단 낱말)의 정규식을 파일에서 그대로 읽어 쓴다
 */

// ───────────────────────────── 탭 이름 (설계서 3.1 표) ─────────────────────────────

describe("탭 이름 고르기 detailTabLabels (글자 폭 어림 — 모든 이름이 한 줄에 들어가는 첫 벌 A → D → C)", () => {
  const pick = (kind: "phone" | "wide", w: number, s: number) => detailTabLabels(kind, w, s).set;
  it("휴대폰 5칸: 360·384·411·475 × 100·115·130·200%", () => {
    const want: Record<number, string[]> = { 1: ["D", "A", "A", "A"], 1.15: ["D", "D", "D", "A"], 1.3: ["C", "D", "D", "D"], 2: ["C", "C", "C", "C"] };
    for (const [s, sets] of Object.entries(want)) expect([360, 384, 411, 475].map((w) => pick("phone", w, Number(s))), `${s}`).toEqual(sets);
  });

  it("펼침 세로 704 (6칸): 100·115·130% A, 200% D", () => {
    expect([1, 1.15, 1.3, 2].map((s) => pick("wide", 704, s))).toEqual(["A", "A", "A", "D"]);
  });

  it("펼침 가로 오른쪽 칸(340·366·391·408): 모두 C (200% 는 두 줄 칸 1개 — 끔일 때 3개보다 적음)", () => {
    expect([[340, 1], [366, 1.15], [391, 1.3], [408, 2]].map(([w, s]) => pick("wide", w!, s!))).toEqual(["C", "C", "C", "C"]);
    expect(detailTabLabels("wide", 408, 2).multi).toBe(1);
  });

  it("세 벌의 이름 (휴대폰 · 넓은 창) — 수급은 늘 끝", () => {
    const labels = (kind: "phone" | "wide", w: number, s: number) => detailTabLabels(kind, w, s).options.map((o) => o.label).join(" · ");
    expect(labels("phone", 475, 1)).toBe("기업개요 · 가치분석 · 기술분석 · 뉴스·공시 · 수급");
    expect(labels("phone", 360, 1)).toBe("기업개요 · 가치분석 · 기술분석 · 뉴스 · 수급");
    expect(labels("phone", 360, 2)).toBe("기업 · 가치 · 기술 · 뉴스 · 수급");
    expect(labels("wide", 704, 1)).toBe("브리핑 · 뉴스·공시 · 기업개요 · 가치 · 기술 · 수급");
    expect(labels("wide", 704, 2)).toBe("브리핑 · 뉴스 · 기업개요 · 가치 · 기술 · 수급");
    expect(labels("wide", 340, 1)).toBe("브리핑 · 뉴스 · 기업 · 가치 · 기술 · 수급");
  });

  it("화면 읽기 이름은 늘 원래 이름 (줄인 이름이 아니라)", () => {
    for (const [kind, w, s] of [["phone", 360, 2], ["phone", 475, 1], ["wide", 340, 1], ["wide", 704, 2]] as const) {
      const o = detailTabLabels(kind, w, s).options;
      const base = kind === "phone" ? PHONE_TABS : WIDE_TABS_BASE;
      expect(o.map((x) => x.a11y)).toEqual([...base.map((b) => b.label), "수급, 투자자별 매매"]);
      expect(o.map((x) => x.value)).toEqual([...base.map((b) => b.value), "flow"]);
    }
  });

  it("꺼짐용 목록은 지금 화면의 탭과 같은 내용 (a11y 칸 없음)", () => {
    expect(PHONE_TABS).toEqual([
      { value: "company", label: "기업개요" },
      { value: "value", label: "가치분석" },
      { value: "technical", label: "기술분석" },
      { value: "news", label: "뉴스·공시" },
    ]);
    expect(WIDE_TABS_BASE).toEqual([
      { value: "briefing", label: "브리핑" },
      { value: "news", label: "뉴스·공시" },
      { value: "company", label: "기업개요" },
      { value: "value", label: "가치" },
      { value: "technical", label: "기술" },
    ]);
  });
});

describe("탭 값 flow (주소 검색어 tab=flow)", () => {
  it("켜져 있을 때만 읽는다 — 꺼지면 기본 탭", () => {
    expect(parseDetailTab("flow", true)).toBe("flow");
    expect(parseDetailTab("flow")).toBeNull();
    expect(parseDetailTab("flow", false)).toBeNull();
    expect(parseDetailTab(["flow", "news"], true)).toBe("flow");
    expect(phoneTab("flow", true)).toBe("flow");
    expect(phoneTab("flow")).toBe("company");
    expect(wideTab("flow", true)).toBe("flow");
    expect(wideTab("flow")).toBe("briefing");
    // 예전 값은 그대로
    expect(parseDetailTab("news")).toBe("news");
    expect(phoneTab("briefing")).toBe("company");
    expect(wideTab(null)).toBe("briefing");
  });
});

// ───────────────────────────── 숫자 모양 (설계서 3.4) ─────────────────────────────

describe("주 수 formatShares", () => {
  it("경계: 9,999 · 1만 · 99,999 · 10만 · 99,999,999 · 1억 · 0 · null · 음수", () => {
    expect(formatShares(9_999)).toBe("+9,999주");
    expect(formatShares(10_000)).toBe("+1만 주");
    expect(formatShares(13_469)).toBe("+1.3만 주");
    expect(formatShares(-13_469)).toBe("-1.3만 주");
    expect(formatShares(99_999)).toBe("+10만 주");
    expect(formatShares(100_000)).toBe("+10만 주");
    expect(formatShares(7_422_778)).toBe("+742만 주");
    expect(formatShares(-33_476_518)).toBe("-3,348만 주");
    expect(formatShares(99_999_999)).toBe("+1억 주");
    expect(formatShares(100_000_000)).toBe("+1억 주");
    expect(formatShares(123_456_789)).toBe("+1.2억 주");
    expect(formatShares(0)).toBe("0주");
    expect(formatShares(null)).toBe("—");
    expect(formatShares(-1)).toBe("-1주");
  });

  it("단위 없이 (고른 날 줄) · 부호 없이 (화면 읽기)", () => {
    expect(formatShares(7_422_778, { unit: false })).toBe("+742만");
    expect(formatShares(-598, { unit: false })).toBe("-598");
    expect(formatShares(-33_476_518, { sign: false })).toBe("3,348만 주");
    expect(formatShares(0, { unit: false })).toBe("0");
  });

  it("보유율 · %p · 한도", () => {
    expect(formatRatio(46.52)).toBe("46.52%");
    expect(formatRatio(49)).toBe("49.00%");
    expect(formatPp(0.04)).toBe("+0.04%p");
    expect(formatPp(-0.23)).toBe("-0.23%p");
    expect(formatPp(0)).toBe("0.00%p");
    expect(formatRatio(49, 1)).toBe("49.0%");
    expect(formatRatio(100, 1)).toBe("100.0%");
    expect(shortDate("2026-08-28")).toBe("8월 28일");
  });

  it("날짜·시각 (한국 시간, 기기 시간대와 상관없이)", () => {
    expect(dateKo("2026-09-28")).toBe("9월 28일 (월)");
    expect(dateKo("2026-10-03")).toBe("10월 3일 (토)");
    expect(dateLong("2026-09-28")).toBe("9월 28일 월요일");
    expect(hhmm("2026-09-28T20:15:40+09:00")).toBe("20:15");
    expect(hhmm("2026-09-28T15:05:00Z")).toBe("00:05");
    expect(hhmm(null)).toBeNull();
    expect(stampKo("2026-09-28T20:15:40+09:00")).toBe("9월 28일 (월) 20:15");
    expect(stampKo("2026-09-28T16:00:00Z")).toBe("9월 29일 (화) 01:00");
    expect(stampKo(undefined)).toBe("-");
  });
});

// ───────────────────────────── 합계 줄·화면 읽기 ─────────────────────────────

const SUM20: FlowSum = { individual: -33_476_518, foreign: -13_640_206, institution: 8_385_452, otherCorp: 38_799_061, days: 20, missing: 0 };

describe("합계 줄 (flowSumRows)", () => {
  it("토스 웹: 네 줄 (개인·외국인·기관·기타법인) — 글자·부호·화면 읽기", () => {
    const rows = flowSumRows(SUM20, 20, true);
    expect(rows.map((r) => [r.name, r.text, r.sign])).toEqual([
      ["개인", "-3,348만 주", -1],
      ["외국인", "-1,364만 주", -1],
      ["기관", "+839만 주", 1],
      ["기타법인", "+3,880만 주", 1],
    ]);
    expect(rows[0]!.speech).toBe("개인, 최근 20일 합계, 판 주식이 산 주식보다 3,348만 주 많았습니다");
    expect(rows[2]!.speech).toBe("기관, 최근 20일 합계, 산 주식이 판 주식보다 839만 주 많았습니다");
  });

  it("네이버: 기타법인 줄 없음 · 0 은 '같았습니다' · null 은 '값 없음'", () => {
    const rows = flowSumRows({ ...SUM20, individual: 0, institution: null, otherCorp: null }, 5, false);
    expect(rows.map((r) => r.name)).toEqual(["개인", "외국인", "기관"]);
    expect(rows[0]).toMatchObject({ text: "0주", sign: 0, speech: "개인, 최근 5일 합계, 산 주식과 판 주식이 같았습니다" });
    expect(rows[2]).toMatchObject({ text: "—", sign: 0, speech: "기관, 최근 5일 합계, 값 없음" });
  });
});

// ───────────────────────────── 막대 (설계서 3.6) ─────────────────────────────

const day = (date: string, individual: number | null, foreign: number | null, institution: number | null): FlowDay => ({ date, individual, foreign, institution, otherCorp: null, foreignRatio: null, close: null });

describe("막대 폭·누르기", () => {
  it("폭 280 · 20일: 칸 14, 막대 폭 = 칸 − 사이(2), 60일은 가는 막대 (사이는 칸의 30% 이하)", () => {
    expect(barLayout(280, 20)).toEqual({ slot: 14, bar: 12, gap: 2 });
    const l60 = barLayout(252, 60);
    expect(l60.slot).toBeCloseTo(4.2);
    expect(l60.gap).toBeLessThanOrEqual(l60.slot * 0.3 + 1e-9);
    expect(l60.bar).toBeGreaterThan(2.5);
    // 5일은 막대가 24 를 넘지 않는다 (칸의 나머지는 빈 곳)
    expect(barLayout(280, 5).bar).toBe(24);
  });

  it("누른 x → 가장 가까운 날 (칸 번호, 양 끝 넘으면 끝 칸)", () => {
    expect(pickIndex(0, 280, 20)).toBe(0);
    expect(pickIndex(13.9, 280, 20)).toBe(0);
    expect(pickIndex(14, 280, 20)).toBe(1);
    expect(pickIndex(279, 280, 20)).toBe(19);
    expect(pickIndex(500, 280, 20)).toBe(19);
    expect(pickIndex(-5, 280, 20)).toBe(0);
  });

  it("화면 읽기 요약: 기간·세 줄의 산 쪽/판 쪽 많은 날 수 (0·빈 값은 세지 않음)", () => {
    const days = [day("2026-09-28", 5, -3, 0), day("2026-09-23", -1, -2, null), day("2026-09-22", 2, 4, 1)];
    expect(barsSpeech(days)).toBe("날마다 막대, 9월 22일부터 9월 28일까지 3일. 개인은 산 쪽이 많은 날 2일, 판 쪽이 많은 날 1일. 외국인은 산 쪽이 많은 날 1일, 판 쪽이 많은 날 2일. 기관은 산 쪽이 많은 날 1일, 판 쪽이 많은 날 0일.");
  });
});

describe("보유율 선 좌표", () => {
  it("오래된 점이 왼쪽, 가장 높은 값이 위 (여백 안), 같은 값뿐이면 가운데 한 줄", () => {
    const pts = linePoints([["a", 46.96], ["b", 46.46], ["c", 46.52]], 100, 60, 4);
    expect(pts.map((p) => p.x)).toEqual([4, 50, 96]);
    expect(pts[0]!.y).toBeCloseTo(4);
    expect(pts[1]!.y).toBeCloseTo(56);
    const flat = linePoints([["a", 49], ["b", 49]], 100, 60, 4);
    expect(flat.map((p) => p.y)).toEqual([30, 30]);
    expect(linePoints([["a", 1]], 100, 60, 4)).toEqual([{ x: 50, y: 30 }]);
  });

  it("선분: 두 점 사이 길이·각도·가운데 (View 를 돌려 그린다)", () => {
    const [s] = lineSegments([{ x: 0, y: 0 }, { x: 3, y: 4 }]);
    expect(s).toMatchObject({ len: 5, cx: 1.5, cy: 2 });
    expect(s!.deg).toBeCloseTo((Math.atan2(4, 3) * 180) / Math.PI);
  });
});

describe("넓은 창: 합계를 세 기간 표로", () => {
  it("카드 안쪽 ≥ 520 × 글자 배율이면 표 (펼침 세로 704 안쪽 676: 100·130% 표, 200% 칩)", () => {
    expect(showSumTable(676, 1)).toBe(true);
    expect(showSumTable(676, 1.3)).toBe(true);
    expect(showSumTable(676, 2)).toBe(false);
    expect(showSumTable(332, 1)).toBe(false);
  });
});

// ───────────────────────────── 문구 검사 ─────────────────────────────

const scoreSrc = readFileSync(new URL("../../backend/src/analysis/scoreWording.ts", import.meta.url), "utf8");
const flowSrc = readFileSync(new URL("../../backend/src/services/flowText.ts", import.meta.url), "utf8");
const BANNED = new RegExp(/SCORE_BANNED_RE =\s*\/(.+)\/;/.exec(scoreSrc)![1]!, "g");
const FUTURE = new RegExp(/SCORE_FUTURE_RE = \/(.+)\/;/.exec(scoreSrc)![1]!, "g");
const JUDGE = new RegExp(/FLOW_JUDGE_RE = \/(.+)\/;/.exec(flowSrc)![1]!, "g");
/** 자료 이름(순매수·순매도·공매도)은 검사 전에 지운다 — 서버 검사기와 같은 목록 */
const TERMS = new RegExp(/FLOW_TERMS_RE = \/(.+)\/g;/.exec(flowSrc)![1]!, "g");

/** flowText 의 모든 글 (틀은 예시 값으로 채움) */
function allTexts(): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(text.FLOW_TAB);
  walk(text.FLOW_NAMES);
  walk(text.FLOW_TEXT);
  out.push(
    text.periodLabel(20), text.sumSub1(20), text.shortData(43), text.missingNote(2), text.todayNote("9월 29일 (화)"), text.todayValues("10:05", "+12만 주", "-4만 주"),
    text.pickedLine("9월 28일 (월)", "+742만", "-598만", "-363만", "270,000"), text.ratioDateLine("9월 28일 (월)"), text.agoLine(20, "46.75%", "-0.23%p"), text.agoMissing(60),
    text.highLow("46.96%", "46.46%"), text.pctPointNote("46.75%", "46.52%", "-0.23%p"), text.limitNote("49.0%", "100.0%"), text.sourceToss("9월 28일 (월) 20:15"),
    text.sourceNaver("9월 29일 (화) 02:40"), text.checkLine(20, 20, "9월 29일 (화) 21:05"), text.checkLine(20, 19, "9월 29일 (화) 21:05"), text.staleLine("9월 29일 (화) 10:00"),
    text.sumSpeech("개인", 20, "3,348만 주", -1), text.sumSpeech("기관", 20, "839만 주", 1), text.sumSpeech("외국인", 5, "0주", 0), text.sumSpeech("기관", 5, null, 0),
    text.barsSpeechHead("8월 28일", "9월 28일", 20), text.barsSpeechRow("개인", 9, 11), text.ratioSpeech(60, "6월 30일", "46.96%", "9월 28일", "46.52%", "46.96%", "46.46%"),
    text.tableRowSpeech("9월 28일 월요일", "+742만 주", "-598만 주", "-363만 주"), text.TABLE_HEAD,
  );
  return out;
}

describe("문구: 투자 권유·예측·수급 판단 낱말 0건", () => {
  it("검사할 글이 모두 있다", () => expect(allTexts().length).toBeGreaterThan(50));
  it("flowText 의 모든 글", () => {
    for (const s of allTexts()) {
      const t = s.replace(TERMS, "");
      expect(t.match(BANNED), s).toBeNull();
      expect(t.match(FUTURE), s).toBeNull();
      expect(t.match(JUDGE), s).toBeNull();
    }
  });
  it("검사기가 제대로 읽혔다 (잡아야 할 말은 잡는다)", () => {
    expect("외국인 매집 신호".match(JUDGE)).toEqual(["매집", "신호"]);
    expect("매수 추천".match(BANNED)).toEqual(["매수", "추천"]);
  });
});
