import { readFileSync } from "node:fs";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LatestBriefing, MarketSummaryData } from "@/api/types";

/**
 * 시장 전체 요약 2단계 — 브리핑 위젯 첫 줄 (플래그 marketSummary, 확정 설계 '화면·알림 설계' 5번).
 *  - 머리 줄 아래 '밤사이 미국'·'오늘 한국' 칩과 지수 등락률(색). 좁으면 숫자를 자르지 않고 뒤 지수부터 뺀다(필라반도체 → 다우)
 *  - 큰 4x2(460×290)처럼 높이가 남으면 둘째 줄 '내 미국 12종목 · 지수보다 높음 2 · 낮음 3 · 비슷 7'. 그 아래 종목 브리핑 줄은 그대로, 작은 4x2 는 한 줄 모양
 *  - 누르면 그 요약의 상세 (/briefings/market/<id>)
 *  - 칩은 보는 날짜로: 월요일·휴장 다음 날은 '9/25 미국', 자정 뒤·주말에 보면 '9/23 한국' (사양 보정 — 저장한 문구가 아님)
 *  - 서버는 새 앱이 /api/widget …&ms=1 로 물을 때만 넣는다. 예전 서버·끔·요약 없음이면 지금 그림과 한 글자도 같다
 *  - 폭(지수 개수)과 높이(둘째 줄·종목 칸)로만 정한다 — 넓은 모습이 없어 폴드 위젯 폭 규칙(560dp, widgetFoldFit)과 상관없이 같은 그림
 * 요약 숫자는 공용 픽스처(shared/fixtures/marketSummary.json — 서버 테스트와 같은 데이터)에서 서버 widgetSummary 와 같은 모양으로 만든다. 시각은 모두 고정 시계
 */

vi.mock("react-native-android-widget", async () => {
  const load = (p: string) => import(/* @vite-ignore */ p);
  const base = "react-native-android-widget/lib/commonjs/widgets/";
  const [flex, text, list] = await Promise.all([load(`${base}FlexWidget.js`), load(`${base}TextWidget.js`), load(`${base}ListWidget.js`)]);
  return { FlexWidget: flex.FlexWidget, TextWidget: text.TextWidget, ListWidget: list.ListWidget };
});
vi.mock("react-native", () => ({ Platform: { OS: "android" }, PixelRatio: { getFontScale: () => 1 } }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: { apiUrl: "https://server.test" } } } }));
const store = new Map<string, string>();
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: string) => void store.set(k, v),
    removeItem: async (k: string) => void store.delete(k),
    multiGet: async (keys: string[]) => keys.map((k) => [k, store.get(k) ?? null]),
  },
}));

const lib = (p: string) => import(/* @vite-ignore */ p);
const { buildWidgetTree } = await lib("react-native-android-widget/lib/commonjs/api/build-widget-tree.js");
const { BriefingWidget, WIDGET_NAMES } = await import("@/widgets/widgets");
const { renderOne } = await import("@/widgets/render");
const { WIDGET_PALETTES, WIDGET_FONT: F, WIDGET_TOUCH } = await import("@/widgets/palette");
const { cleanSummary, fromPayload, widgetFeatures, NO_FEATURES } = await import("@/widgets/payload");
const { summaryChips, summaryInput, summaryItems, summarySecond, summarySpeech, summaryUri } = await import("@/widgets/summary");
const L = await import("@/widgets/layout");
const { loadCachedWidgetData, loadWidgetData, pushWidgetData } = await import("@/widgets/data");
type WidgetSummary = import("@/widgets/payload").WidgetSummary;
type WidgetData = import("@/widgets/data").WidgetData;

const API = "https://server.test";

// ── 요약 (공용 픽스처 → 서버 widgetSummary 와 같은 모양) ──
const shared = JSON.parse(readFileSync(new URL("../../shared/fixtures/marketSummary.json", import.meta.url), "utf8")) as { cases: { name: string; data: MarketSummaryData }[] };
function toWidget(d: MarketSummaryData, id: number): WidgetSummary {
  const h = d.holdings;
  return {
    id,
    date: d.date,
    session: d.session,
    market: d.market,
    marketDate: d.marketDate,
    basisDate: d.basisDate,
    holiday: d.holiday,
    phase: d.phase,
    asOf: d.asOf,
    indices: d.indices.map((i) => ({ code: i.code, name: i.name, changeRate: i.changeRate, date: i.date })),
    holdings: h && h.compared > 0 ? { compared: h.compared, high: h.high.length, low: h.low.length, similar: h.similar.length } : null,
  };
}
const MONDAY = toWidget(shared.cases[0]!.data, 41); // 9/28(월) 08:30 — 금요일(9/25) 미국 장
const KR_DAY = toWidget(shared.cases[1]!.data, 42); // 9/23(수) 16:00 — 오늘 한국 장
const KR_HOLIDAY = toWidget(shared.cases[2]!.data, 43); // 9/25(금) 16:00 추석 — 직전 거래일 9/23
const US_HOLIDAY = toWidget(shared.cases[3]!.data, 44); // 11/27(금) 08:30 — 추수감사절 다음 날, 11/25 값
const SUNEUNG = toWidget(shared.cases[4]!.data, 45); // 11/19(목) 16:00 수능일 — 장중
/** 화~금 아침: 9/29(화) 08:30 에 만든 9/28(월) 미국 장 (숫자는 월요일 요약과 같게) */
const TUESDAY: WidgetSummary = { ...MONDAY, id: 46, date: "2026-09-29", marketDate: "2026-09-28", basisDate: "2026-09-28", indices: MONDAY.indices.map((i) => ({ ...i, date: "2026-09-28" })) };
const at = (iso: string) => Date.parse(iso);
const NOW = at("2026-09-28T08:31:00+09:00");

// ── 브리핑 3종목 (목업과 같은 예시 문장) ──
const brief = (id: number, code: string, name: string, summary: string): LatestBriefing => ({
  code,
  name,
  latest: { id, code, name, session: "morning", date: "2026-09-28", status: "ok", summary, detail: "", missing: [], model: "", error: null, createdAt: "2026-09-28T08:35:00+09:00" },
});
const BRIEFS = [brief(11, "NVDA", "엔비디아", "9/25 정규장 0.22% 상승 마감."), brief(12, "MSFT", "마이크로소프트", "9/25 정규장 3.66% 상승 마감."), brief(13, "005930", "삼성전자", "직전 거래일(9/23) 3.62% 상승 마감.")];

interface Tree {
  type: string;
  props: Record<string, unknown> & { text?: string };
  children?: Tree[];
}
const nodes = (t: Tree): Tree[] => [t, ...(t.children ?? []).flatMap(nodes)];
const texts = (t: Tree) => nodes(t).filter((n) => n.type === "TextWidget").map((n) => String(n.props.text));
const uri = (n: Tree) => String((n.props.clickActionData as { uri?: string } | undefined)?.uri ?? "");
const build = (el: React.JSX.Element): Tree => buildWidgetTree(el) as Tree;
/** 첫 줄 칸 (요약 상세를 여는 칸) */
const block = (t: Tree) => nodes(t).find((n) => uri(n).includes("/briefings/market/"));

type Size = { width: number; height: number };
/** 사양·폴드8 캡처 크기 (dp) */
const COVER: Size = { width: 507, height: 222 }; // 폴드8 바깥 4x2
const INNER: Size = { width: 476, height: 611 }; // 폴드8 안쪽 (세로로 긴 위젯)
const INNER_WIDE: Size = { width: 780, height: 350 }; // 폴드8 안쪽에 넓게 늘린 위젯
const PHONE: Size = { width: 360, height: 180 }; // 흔한 폰 4x2
const BIG: Size = { width: 460, height: 290 }; // 사양 목업 '큰 4x2'
const SMALL: Size = { width: 430, height: 180 }; // 사양 목업 '작은 4x2'

const widget = (s: WidgetSummary | null, size: Size, o: { now?: number; scale?: number; briefings?: LatestBriefing[]; scheme?: "light" | "dark" } = {}) =>
  build(
    <BriefingWidget
      briefings={o.briefings ?? BRIEFS}
      fetchedAt={(o.now ?? NOW) - 60_000}
      error={null}
      now={o.now ?? NOW}
      market={null}
      polish
      {...(s ? { summary: s } : {})}
      width={size.width}
      height={size.height}
      fontScale={o.scale ?? 1}
      palette={WIDGET_PALETTES[o.scheme ?? "dark"]}
    />,
  );

beforeEach(() => {
  store.clear();
  vi.unstubAllGlobals();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("칩: 보는 날짜로 ('밤사이'는 숫자의 거래일이 보는 날의 전날일 때만 — 사양 보정)", () => {
  it("월요일 아침은 금요일 장이라 '9/25 미국', 화~금 아침은 '밤사이 미국', 다음 날·주말에 보면 날짜로", () => {
    expect(summaryChips(MONDAY, NOW)).toEqual(["9/25 미국"]);
    expect(summaryChips(MONDAY, at("2026-09-28T23:59:00+09:00"))).toEqual(["9/25 미국"]);
    expect(summaryChips(TUESDAY, at("2026-09-29T08:31:00+09:00"))).toEqual(["밤사이 미국"]);
    // 같은 날 저녁에 봐도 숫자는 전날 밤 장 (카드 제목과 같은 규칙)
    expect(summaryChips(TUESDAY, at("2026-09-29T21:00:00+09:00"))).toEqual(["밤사이 미국"]);
    // 다음 날 자정 뒤·다음 날 아침 전에 보면 날짜로
    expect(summaryChips(TUESDAY, at("2026-09-30T00:10:00+09:00"))).toEqual(["9/28 미국"]);
  });

  it("오후는 오늘이면 '오늘 한국', 자정 뒤·주말에 보면 '9/23 한국' (금요일 오후 요약이 토·일 내내 '오늘'로 남지 않게)", () => {
    expect(summaryChips(KR_DAY, at("2026-09-23T16:01:00+09:00"))).toEqual(["오늘 한국"]);
    expect(summaryChips(KR_DAY, at("2026-09-23T23:59:00+09:00"))).toEqual(["오늘 한국"]);
    expect(summaryChips(KR_DAY, at("2026-09-24T00:00:00+09:00"))).toEqual(["9/23 한국"]);
  });

  it("휴장: 한국 추석 오후는 '오늘 한국 휴장(추석)'(좁으면 이름 없이), 다음 날 보면 '9/25 한국 휴장(추석)'. 미국 휴장 다음 날은 숫자의 날 '11/25 미국'", () => {
    expect(summaryChips(KR_HOLIDAY, at("2026-09-25T16:01:00+09:00"))).toEqual(["오늘 한국 휴장(추석)", "오늘 한국 휴장"]);
    expect(summaryChips(KR_HOLIDAY, at("2026-09-26T09:00:00+09:00"))).toEqual(["9/25 한국 휴장(추석)", "9/25 한국 휴장"]);
    expect(summaryChips({ ...KR_HOLIDAY, holiday: { date: "2026-09-25", name: null } }, at("2026-09-25T16:01:00+09:00"))).toEqual(["오늘 한국 휴장"]);
    expect(summaryChips(US_HOLIDAY, at("2026-11-27T08:31:00+09:00"))).toEqual(["11/25 미국"]);
  });

  it("장중 값(수능일 16:00 — 16:30 마감)·미국 최종값 전은 칩에 그 사실을 붙인다 (알림 첫 줄과 같은 말)", () => {
    expect(summaryChips(SUNEUNG, at("2026-11-19T16:01:00+09:00"))).toEqual(["오늘 한국 장중(16:00)"]);
    expect(summaryChips({ ...TUESDAY, phase: "prelim" }, at("2026-09-29T07:01:00+09:00"))).toEqual(["밤사이 미국(최종값 전)"]);
  });
});

describe("지수·둘째 줄 글 (숫자는 서버 요약 그대로, 권유·평가 말 없음)", () => {
  it("아침 네 지수 이름·등락률, 한국 휴장이면 칸마다 직전 거래일(흐림), 받지 못한 지수는 뺀다, '0.00%' 는 부호 없음(기본 글자색)", () => {
    expect(summaryItems(MONDAY).map((i) => `${i.label} ${i.rate}${i.tag ? ` ${i.tag}` : ""}`)).toEqual(["나스닥 +0.48%", "S&P500 +0.51%", "다우 +0.93%", "필라반도체 +1.41%"]);
    expect(summaryItems(KR_HOLIDAY).map((i) => `${i.label} ${i.rate} ${i.tag}`)).toEqual(["코스피 +0.90% 9/23", "코스닥 +1.21% 9/23"]);
    const miss = { ...MONDAY, indices: MONDAY.indices.map((i, k) => (k === 1 ? { ...i, changeRate: null } : k === 2 ? { ...i, changeRate: 0 } : i)) };
    expect(summaryItems(miss).map((i) => [i.label, i.rate, i.sign])).toEqual([
      ["나스닥", "+0.48%", 1],
      ["다우", "0.00%", 0],
      ["필라반도체", "+1.41%", 1],
    ]);
    expect(summaryInput({ ...MONDAY, indices: MONDAY.indices.map((i) => ({ ...i, changeRate: null })) }, NOW)).toBeNull();
  });

  it("둘째 줄: 개수만 ('내 미국 12종목 · 지수보다 높음 2 · 낮음 3 · 비슷 7'), 모두 비슷·휴장·보유 없음", () => {
    expect(summarySecond(MONDAY)).toBe("내 미국 12종목 · 지수보다 높음 2 · 낮음 3 · 비슷 7");
    expect(summarySecond(KR_DAY)).toBe("내 국내 5종목 · 지수보다 높음 1 · 낮음 2 · 비슷 2");
    expect(summarySecond(KR_HOLIDAY)).toBe("9/23 기준 · 내 국내 5종목 · 지수보다 높음 1 · 낮음 2 · 비슷 2");
    expect(summarySecond(US_HOLIDAY)).toBe("11/25 기준 · 내 미국 2종목 모두 지수와 ±1%p 안");
    expect(summarySecond(SUNEUNG)).toBeNull();
  });

  it("평가·권유·원인 말을 쓰지 않는다 (칩·지수·둘째 줄·화면 읽기 모두)", () => {
    const all = [MONDAY, KR_DAY, KR_HOLIDAY, US_HOLIDAY, SUNEUNG, TUESDAY].flatMap((s) => {
      const i = summaryInput(s, NOW)!;
      return [...i.chips, ...i.items.map((x) => `${x.label} ${x.rate}`), i.second ?? "", summarySpeech(i.chips[0]!, i.items, i.second)];
    });
    for (const t of all) expect(t).not.toMatch(/선방|부진|아쉬|기회|주의|과매도|때문|매수|매도|추천|전망|유망|사세요|파세요|목표/);
  });

  it("화면 읽기: 보이는 것만 한 문장 — 날짜는 'M월 D일', 기호는 말로", () => {
    const i = summaryInput(KR_HOLIDAY, at("2026-09-25T16:01:00+09:00"))!;
    expect(summarySpeech(i.chips[0]!, i.items, i.second)).toBe(
      "시장 요약, 오늘 한국 휴장(추석), 코스피 0.90% 상승 9월 23일 값, 코스닥 1.21% 상승 9월 23일 값, 9월 23일 기준, 내 국내 5종목, 지수보다 높음 1, 낮음 2, 비슷 2, 자세히 보기",
    );
    const m = summaryInput(MONDAY, NOW)!;
    expect(summarySpeech(m.chips[0]!, m.items.slice(0, 2), null)).toBe("시장 요약, 9월 25일 미국, 나스닥 0.48% 상승, S&P500 0.51% 상승, 자세히 보기");
  });
});

describe("위젯 그림: 사양 크기·폴드8 크기 (숫자는 자르지 않고 뒤 지수부터 뺀다)", () => {
  /** 첫 줄에 보인 지수 이름 */
  const shownIndices = (t: Tree) => {
    const b = block(t);
    return b ? texts(b).filter((x) => ["나스닥", "S&P500", "다우", "필라반도체", "코스피", "코스닥"].includes(x)) : [];
  };
  const second = (t: Tree) => (block(t) ? texts(block(t)!).find((x) => x.includes("종목")) ?? null : null);
  const briefNames = (t: Tree) => texts(t).filter((x) => ["엔비디아", "마이크로소프트", "삼성전자"].includes(x));

  it("큰 4x2(460×290): 칩 · 지수 넷 · 둘째 줄 내 종목, 그 아래 브리핑 3종목 (사양 목업)", () => {
    const t = widget(MONDAY, BIG);
    expect(texts(block(t)!)).toContain("9/25 미국");
    expect(shownIndices(t)).toEqual(["나스닥", "S&P500", "다우", "필라반도체"]);
    expect(second(t)).toBe("내 미국 12종목 · 지수보다 높음 2 · 낮음 3 · 비슷 7");
    expect(briefNames(t)).toEqual(["엔비디아", "마이크로소프트", "삼성전자"]);
    // 첫 줄은 머리 줄 바로 아래, 브리핑 줄보다 위
    const all = texts(t);
    expect(all.indexOf("9/25 미국")).toBeLessThan(all.indexOf("엔비디아"));
    expect(all.indexOf("브리핑")).toBeLessThan(all.indexOf("9/25 미국"));
  });

  it("작은 4x2(430×180)·흔한 폰(360×180): 첫 줄만(둘째 줄 없음), 필라반도체를 빼고(사양 목업 430×180 과 같다), 브리핑은 한 줄 모양으로", () => {
    const small = widget(TUESDAY, SMALL, { now: at("2026-09-29T08:31:00+09:00") });
    expect(texts(block(small)!)[0]).toBe("밤사이 미국");
    expect(shownIndices(small)).toEqual(["나스닥", "S&P500", "다우"]);
    expect(second(small)).toBeNull();
    expect(briefNames(small)).toHaveLength(3);
    const phone = widget(TUESDAY, PHONE, { now: at("2026-09-29T08:31:00+09:00") });
    expect(shownIndices(phone)).toEqual(["나스닥", "S&P500", "다우"]);
    expect(second(phone)).toBeNull();
    expect(briefNames(phone).length).toBeGreaterThanOrEqual(2);
    // 한 줄 모양: 날짜 줄(' · 09/28 오전')이 없다
    expect(texts(phone).some((x) => x.includes("09/28 오전"))).toBe(false);
  });

  it("폴드8 바깥 4x2(507×222): 지수 넷, 브리핑 3종목을 지키느라 둘째 줄은 없다 · 안쪽(476×611)·넓게 늘린 안쪽(780×350)은 둘째 줄까지", () => {
    const cover = widget(MONDAY, COVER);
    expect(shownIndices(cover)).toEqual(["나스닥", "S&P500", "다우", "필라반도체"]);
    expect(second(cover)).toBeNull();
    expect(briefNames(cover)).toHaveLength(3);
    for (const size of [INNER, INNER_WIDE]) {
      const t = widget(MONDAY, size);
      expect(shownIndices(t), `${size.width}×${size.height}`).toEqual(["나스닥", "S&P500", "다우", "필라반도체"]);
      expect(second(t), `${size.width}×${size.height}`).toBe("내 미국 12종목 · 지수보다 높음 2 · 낮음 3 · 비슷 7");
      expect(briefNames(t)).toHaveLength(3);
    }
    // 브리핑이 둘뿐이면 바깥 4x2 도 높이가 남아 둘째 줄이 들어간다 (높이로만 정한다)
    expect(second(widget(MONDAY, COVER, { briefings: BRIEFS.slice(0, 2) }))).toBe("내 미국 12종목 · 지수보다 높음 2 · 낮음 3 · 비슷 7");
  });

  it("오후·휴장: '오늘 한국' 코스피·코스닥, 추석이면 '오늘 한국 휴장(추석)'과 칸마다 9/23 (폰에서도 두 지수)", () => {
    const day = widget(KR_DAY, BIG, { now: at("2026-09-23T16:01:00+09:00") });
    expect(texts(block(day)!).slice(0, 5)).toEqual(["오늘 한국", "코스피", "+0.90%", "·", "코스닥"]);
    const hol = widget(KR_HOLIDAY, PHONE, { now: at("2026-09-25T16:01:00+09:00") });
    expect(texts(block(hol)!).slice(0, 8)).toEqual(["오늘 한국 휴장(추석)", "코스피", "+0.90%", "9/23", "·", "코스닥", "+1.21%", "9/23"]);
  });

  it("누르면 그 요약의 상세, 화면 읽기는 보이는 것과 같은 문장", () => {
    const t = widget(MONDAY, BIG);
    const b = block(t)!;
    expect(uri(b)).toBe("stockbriefing://briefings/market/41");
    expect(summaryUri(41)).toBe("stockbriefing://briefings/market/41");
    expect(b.props.clickAction).toBe("OPEN_URI");
    expect(String(b.props.accessibilityLabel)).toBe(
      "시장 요약, 9월 25일 미국, 나스닥 0.48% 상승, S&P500 0.51% 상승, 다우 0.93% 상승, 필라반도체 1.41% 상승, 내 미국 12종목, 지수보다 높음 2, 낮음 3, 비슷 7, 자세히 보기",
    );
    // 브리핑 줄·제목의 누르는 곳은 그대로 (종목 브리핑 상세·브리핑 탭)
    expect(nodes(t).filter((n) => uri(n).match(/briefings\/\d+$/)).map(uri)).toEqual(["stockbriefing://briefings/11", "stockbriefing://briefings/12", "stockbriefing://briefings/13"]);
  });

  it("아주 낮은 위젯(4x1, 110dp)은 첫 줄을 넣으면 브리핑이 하나도 안 남아 첫 줄 없이 지금 그림 그대로", () => {
    const low = { width: 360, height: 110 };
    expect(block(widget(MONDAY, low))).toBeUndefined();
    expect(JSON.stringify(widget(MONDAY, low))).toBe(JSON.stringify(widget(null, low)));
  });

  it("브리핑이 없으면 첫 줄 아래 안내 문구 (첫 줄이 누르는 칸, 안내 칸은 브리핑 탭)", () => {
    const t = widget(MONDAY, PHONE, { briefings: [] });
    expect(block(t)).toBeDefined();
    expect(texts(t).some((x) => x.startsWith("아직 브리핑이 없습니다"))).toBe(true);
  });
});

describe("크기 격자: 넘침·잘림 없음, 폭·높이로만 정함 (폴드 폭 규칙과 부딪히지 않음)", () => {
  const WIDTHS = [250, 300, 320, 360, 380, 411, 430, 460, 476, 504, 507, 516, 536, 552, 559, 560, 600, 644, 700, 780, 900];
  const HEIGHTS = [110, 130, 150, 180, 200, 222, 250, 290, 350, 611];
  const SUMMARIES = [MONDAY, KR_DAY, KR_HOLIDAY, US_HOLIDAY, SUNEUNG];

  it("모든 크기 × 글자 100·130% × 요약 5가지: 첫 줄이 있으면 폭 안(칩 전체·등락률 온전), 머리 줄 + 첫 줄 + 브리핑 + 고지가 높이 안", () => {
    for (const s of SUMMARIES)
      for (const width of WIDTHS)
        for (const height of HEIGHTS)
          for (const scale of [1, 1.3]) {
            const input = summaryInput(s, NOW)!;
            const plan = L.planBriefing({ width, height, scale, header: { title: "브리핑", chip: null, sub: ["08:30 기준"], delayed: false }, count: 3, summary: input });
            const tag = `${s.id} ${width}×${height} ×${scale}`;
            if (!plan.summary) continue;
            const content = width - L.PAD * 2;
            expect(L.summaryRowWidth(plan.summary.chip, plan.summary.items, plan.summary.font, scale), tag).toBeLessThanOrEqual(content);
            expect(input.chips, tag).toContain(plan.summary.chip);
            // 지수는 앞에서부터 이어서 (뒤에서부터 뺀다), 등락률 글자는 그대로
            expect(plan.summary.items, tag).toEqual(input.items.slice(0, plan.summary.items.length));
            if (plan.summary.second) expect(L.textWidth(plan.summary.second.text, plan.summary.second.font, scale), tag).toBeLessThanOrEqual(content);
            const itemsH = plan.items * L.briefingItemHeight(plan.item, plan.summaryLines, scale);
            expect(WIDGET_TOUCH + plan.summary.height + itemsH + L.disclaimerHeight(scale) + L.PAD, tag).toBeLessThanOrEqual(height);
            expect(plan.items, tag).toBeGreaterThan(0);
          }
  });

  it("사양 크기에서는 첫 줄이 늘 들어간다 (폰 360×180 글자 130% 까지)", () => {
    for (const size of [COVER, INNER, INNER_WIDE, PHONE, BIG, SMALL])
      for (const scale of [1, 1.3])
        for (const s of [MONDAY, KR_DAY, KR_HOLIDAY]) expect(block(widget(s, size, { scale })), `${s.id} ${size.width}×${size.height} ×${scale}`).toBeDefined();
  });

  it("폴드 폭 규칙(widgetFoldFit)을 켜도 끄도 브리핑 위젯 그림은 같다 — 폭 504~559dp(폴드8 바깥)·560dp 이상 모두", () => {
    const data = (foldFit: boolean): WidgetData => ({
      stocks: [],
      briefings: BRIEFS,
      showKrw: false,
      afterCost: true,
      brief: null,
      fetchedAt: NOW - 60_000,
      error: null,
      filled: [],
      market: null,
      indices: null,
      board: null,
      features: widgetFeatures({ widgetPolish: true, marketSummary: true, ...(foldFit ? { widgetFoldFit: true } : {}) }),
      summary: MONDAY,
    });
    for (const width of [476, 504, 507, 516, 536, 559, 560, 644, 780])
      for (const height of [222, 350, 611]) {
        const draw = (f: boolean) => JSON.stringify(build(renderOne(WIDGET_NAMES.briefing, data(f), { width, height, fontScale: 1, now: NOW, pnlMode: "cumulative" }, WIDGET_PALETTES.dark)));
        expect(draw(true), `${width}×${height}`).toBe(draw(false));
        expect(draw(true)).toContain("/briefings/market/41");
      }
  });
});

describe("플래그를 끄면(또는 예전 서버·요약 없음) 지금 그림과 한 글자도 같다", () => {
  const base = (features: Record<string, boolean>, summary?: WidgetSummary): WidgetData => ({
    stocks: [],
    briefings: BRIEFS,
    showKrw: false,
    afterCost: true,
    brief: { morning: "08:30", afternoon: "16:00", weekdaysOnly: true, failed: 0 },
    fetchedAt: NOW - 60_000,
    error: null,
    filled: [],
    market: { label: "한국 장중", open: true, kr: true, us: false, nextChangeAt: "2026-09-28T11:00:00.000Z" },
    indices: null,
    board: null,
    features: widgetFeatures(features),
    ...(summary ? { summary } : {}),
  });
  const SIZES: Size[] = [COVER, INNER, INNER_WIDE, PHONE, BIG, SMALL, { width: 250, height: 110 }, { width: 900, height: 200 }];

  it("marketSummary 꺼짐(키 없음)이면 받아 둔 요약이 있어도 첫 줄 없이 — 요약을 받은 적 없는 그림과 바이트까지 같다 (다듬은 모습 켬·끔, 라이트·다크, 글자 100·130%)", () => {
    for (const polish of [true, false])
      for (const size of SIZES)
        for (const scale of [1, 1.3])
          for (const scheme of ["light", "dark"] as const) {
            const opts = { width: size.width, height: size.height, fontScale: scale, now: NOW, pnlMode: "cumulative" as const };
            const flags: Record<string, boolean> = polish ? { widgetPolish: true } : {};
            const off = JSON.stringify(build(renderOne(WIDGET_NAMES.briefing, base(flags, MONDAY), opts, WIDGET_PALETTES[scheme])));
            const never = JSON.stringify(build(renderOne(WIDGET_NAMES.briefing, base(flags), opts, WIDGET_PALETTES[scheme])));
            const tag = `${polish} ${size.width}×${size.height} ×${scale} ${scheme}`;
            expect(off, tag).toBe(never);
            expect(off, tag).not.toContain("/briefings/market/");
            // 켜면 첫 줄이 생긴다 (낮은 250×110 은 브리핑이 안 남아 첫 줄 없음)
            const on = JSON.stringify(build(renderOne(WIDGET_NAMES.briefing, base({ ...flags, marketSummary: true }, MONDAY), opts, WIDGET_PALETTES[scheme])));
            if (size.height >= 180) expect(on, tag).toContain("/briefings/market/41");
          }
  });

  it("플래그는 켜져 있어도 요약이 없으면(끔·요약 없음·예전 서버) 지금 그림 그대로", () => {
    for (const size of SIZES) {
      const opts = { width: size.width, height: size.height, fontScale: 1, now: NOW, pnlMode: "cumulative" as const };
      const draw = (d: WidgetData) => JSON.stringify(build(renderOne(WIDGET_NAMES.briefing, d, opts, WIDGET_PALETTES.dark)));
      expect(draw(base({ widgetPolish: true, marketSummary: true }))).toBe(draw(base({ widgetPolish: true })));
    }
  });

  it("layout: summary 를 주지 않으면 planBriefing 결과에 summary 칸도 없다 (예전 배치 그대로)", () => {
    const i = { width: 360, height: 180, scale: 1, header: { title: "브리핑", chip: null, sub: ["08:30 기준"], delayed: false }, count: 3 };
    expect(L.planBriefing(i)).toEqual({ size: "regular", header: { chip: false, sub: "08:30 기준", delayed: false }, items: 2, item: "full", summaryLines: 1, messageLines: 3, messageGap: 6 });
    expect(L.planBriefing({ ...i, summary: null })).toEqual(L.planBriefing(i));
  });
});

describe("받기·저장 (/api/widget …&ms=1 — 예전 서버·모양이 다른 값은 첫 줄 없음)", () => {
  const body = (o: { ms?: unknown; features?: Record<string, boolean> } = {}) => ({
    v: 1,
    market: null,
    stocks: [],
    briefings: [{ id: 11, code: "NVDA", name: "엔비디아", session: "morning", date: "2026-09-28", summary: "9/25 정규장 0.22% 상승 마감.", createdAt: "2026-09-28T08:35:00+09:00" }],
    latestIds: [11],
    features: o.features ?? { widgetPnlToggle: true, widgetIndexLine: true, widgetMarket: true, widgetPolish: true, marketSummary: true },
    ...(o.ms !== undefined ? { ms: o.ms } : {}),
  });

  it("cleanSummary: 서버 모양만 받고, 이상한 값은 버린다 (내 종목 개수가 안 맞으면 둘째 줄만 뺀다)", () => {
    expect(cleanSummary(MONDAY)).toEqual(MONDAY);
    expect(cleanSummary(KR_HOLIDAY)).toEqual(KR_HOLIDAY);
    for (const bad of [null, 1, "x", {}, { ...MONDAY, id: 0 }, { ...MONDAY, market: "JP" }, { ...MONDAY, basisDate: "9/25" }, { ...MONDAY, phase: "x" }, { ...MONDAY, indices: [] }, { ...MONDAY, holiday: { date: "x" } }])
      expect(cleanSummary(bad)).toBeNull();
    expect(cleanSummary({ ...MONDAY, holdings: { compared: 12, high: 2, low: 3, similar: 1 } })?.holdings).toBeNull();
    expect(cleanSummary({ ...MONDAY, indices: [...MONDAY.indices, { code: "X", name: "", changeRate: 1 }, { code: "Y", name: "와이", changeRate: "1" }] })?.indices.map((i) => [i.name, i.changeRate])).toEqual([
      ["나스닥", 0.48],
      ["S&P500", 0.51],
      ["다우", 0.93],
      ["필라반도체", 1.41],
      ["와이", null],
    ]);
  });

  it("fromPayload·widgetFeatures: 예전 서버(ms·marketSummary 없음)면 칸이 없다 (예전 기록과 같은 모양)", () => {
    const old = fromPayload(body({ features: { widgetPnlToggle: true, widgetIndexLine: true, widgetMarket: true, widgetPolish: true } }) as never);
    expect(old).not.toHaveProperty("summary");
    expect(old.features).not.toHaveProperty("marketSummary");
    expect(widgetFeatures({ marketSummary: false })).toEqual(widgetFeatures({}));
    expect(widgetFeatures({ marketSummary: true }).marketSummary).toBe(true);
    const on = fromPayload(body({ ms: MONDAY }) as never);
    expect(on.summary).toEqual(MONDAY);
    expect(on.features.marketSummary).toBe(true);
    expect(fromPayload(body({ ms: { id: "x" } }) as never)).not.toHaveProperty("summary");
    expect(NO_FEATURES).not.toHaveProperty("marketSummary");
  });

  it("위젯이 받은 응답(&ms=1)의 첫 줄을 적어 두고 다시 그릴 때(손익 전환·↻ 직후·앱 즉시 갱신)도 쓴다 — 받아 둔 응답에 없으면(끔) 없다", async () => {
    const urls: string[] = [];
    let current: unknown = body({ ms: MONDAY });
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify(current), { status: 200, headers: { etag: `"${urls.length}"` } });
    });
    const d = await loadWidgetData({ stocks: false, briefings: true });
    expect(urls).toEqual([`${API}/api/widget?indices=1&sessions=1&ui=2&ms=1`]);
    expect(d.summary).toEqual(MONDAY);
    expect(block(build(renderOne(WIDGET_NAMES.briefing, d, { width: 460, height: 290, fontScale: 1, now: NOW, pnlMode: "cumulative" }, WIDGET_PALETTES.dark)))).toBeDefined();
    expect((await loadCachedWidgetData()).summary).toEqual(MONDAY);
    // 앱 즉시 갱신: 앱은 요약을 따로 넘기지 않는다 — 받아 둔 응답의 것
    const pushed = await pushWidgetData({ stocks: [], filled: [], showKrw: false, afterCost: true, fetchedAt: NOW, market: null });
    expect(pushed.summary).toEqual(MONDAY);
    // 서버에서 끄면 다음 응답에 없다 → 첫 줄도 없다 (적어 둔 것도 지운다)
    current = body({ features: { widgetPolish: true, marketSummary: false } });
    const off = await loadWidgetData({ stocks: false, briefings: true });
    expect(off).not.toHaveProperty("summary");
    expect(await loadCachedWidgetData()).not.toHaveProperty("summary");
    expect((await pushWidgetData({ stocks: [], filled: [], showKrw: false, afterCost: true, fetchedAt: NOW, market: null })).summary).toBeUndefined();
  });

  it("앱이 받은 플래그가 더 새것이고 꺼져 있으면, 받아 둔 첫 줄이 있어도 그리지 않는다 (render.tsx 가 거른다)", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(body({ ms: MONDAY })), { status: 200, headers: { etag: '"a"' } }));
    await loadWidgetData({ stocks: false, briefings: true });
    const pushed = await pushWidgetData({ stocks: [], filled: [], showKrw: false, afterCost: true, fetchedAt: NOW, market: null, features: { at: NOW + 60_000, flags: widgetFeatures({ widgetPolish: true }) } });
    expect(pushed.summary).toEqual(MONDAY);
    expect(pushed.features.marketSummary).toBeUndefined();
    expect(block(build(renderOne(WIDGET_NAMES.briefing, pushed, { width: 460, height: 290, fontScale: 1, now: NOW, pnlMode: "cumulative" }, WIDGET_PALETTES.dark)))).toBeUndefined();
  });

  it("조회에 실패하면 마지막으로 받은 첫 줄을 그대로 둔다 (갱신 실패로 첫 줄이 사라지지 않게)", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(body({ ms: KR_DAY })), { status: 200, headers: { etag: '"a"' } }));
    await loadWidgetData({ stocks: false, briefings: true });
    vi.stubGlobal("fetch", async () => {
      throw new Error("Network request failed");
    });
    const failed = await loadWidgetData({ stocks: false, briefings: true });
    expect(failed.error).toBeTruthy();
    expect(failed.summary).toEqual(KR_DAY);
  });

  it("예전 서버(ms 를 모름): 첫 줄 없이 지금 그림", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(body({ features: { widgetPolish: true } })), { status: 200 }));
    const d = await loadWidgetData({ stocks: false, briefings: true });
    expect(d).not.toHaveProperty("summary");
    expect(d.features).not.toHaveProperty("marketSummary");
  });

  it("글자 크기: 첫 줄 지수는 md(11) → sm(10), 둘째 줄은 sm(10) → xs(9)", () => {
    expect(L.SUMMARY_FONTS).toEqual([F.md, F.sm]);
    expect(L.SUMMARY_SECOND_FONTS).toEqual([F.sm, F.xs]);
  });
});
