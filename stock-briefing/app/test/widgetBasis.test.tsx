import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RegisteredWithQuote } from "@/api/types";
import { holding, quote } from "./helpers";

/**
 * 숫자 기준 (3-32 PR 2, 플래그 numberBasis) — 잔고·자산 위젯 기준 시각 뒤 ' · NXT·주간거래 포함'.
 *  - 배치(planHeader·planTitle·planAsset): basis 가 없거나 null 이면 지금 결과와 깊은 비교로 같다. 첫 후보(칩·가장 긴 기준 시각·긴 제목)가
 *    그대로 들어가고 기준을 붙여도 들어갈 때만 붙인다 — '갱신 중'·'갱신 실패'가 앞이면 붙이지 않는다.
 *    기대값은 폭 숫자로 박지 않고 계산한다 (textWidth 어림값이 바뀌어도 규칙이 맞으면 통과하게). 박는 곳은 넉넉한 폭 780·배율 1 하나뿐
 *  - 그림: 폭마다 있음·없음을 박지 않고 성질로 본다 — 보이면 다른 글은 모두 같고 기준 시각 글만 늘어남 + 화면 읽기 '시세 NXT, 주간거래 포함',
 *    안 보이면 basis 없이 그린 트리와 전체가 같다. 780(잔고 넓은 위젯, 배율 1)은 보인다
 *  - 응답: fromPayload 가 b → quote.priceBasis, widgetFeatures 의 numberBasis → basis. 앱이 넘긴 잔고와 서버 응답으로 그린 머리 글이 같다
 *  - 대상: 잔고 화면과 같은 countedHoldings (환율 없는 달러 종목은 합계 밖이라 세지 않음)
 */

// 위젯 프리미티브·RN·저장소를 가짜로: 렌더 결과(글자·화면 읽기)만 본다 (widgets.test.tsx 와 같은 방식)
vi.mock("react-native-android-widget", () => {
  const mk = (kind: string) => Object.assign((_: unknown) => null, { __widget: kind });
  return { FlexWidget: mk("Flex"), TextWidget: mk("Text"), ListWidget: mk("List") };
});
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: { apiUrl: "https://server.test" } } } }));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined, multiGet: async (keys: string[]) => keys.map((k) => [k, null]) },
}));

const { AssetWidget, HoldingsWidget } = await import("@/widgets/widgets");
const { assetSize, headerRoom, planAsset, planHeader, planTitle, titleWidth } = await import("@/widgets/layout");
const { fromPayload, widgetFeatures } = await import("@/widgets/payload");
const { basisShort, countedHoldings } = await import("@/lib/numberBasis");
type AssetInput = import("@/widgets/layout").AssetInput;
type HeaderInput = import("@/widgets/layout").HeaderInput;
type TitleInput = import("@/widgets/layout").TitleInput;
type WidgetStock = import("@/widgets/payload").WidgetStock;
type WidgetMarket = import("@/widgets/payload").WidgetMarket;

const BASIS = "NXT·주간거래 포함";
const SAID = "시세 NXT, 주간거래 포함";
const NOW = Date.parse("2026-09-28T14:05:00+09:00");

// ── 배치 ──────────────────────────────────────────────────────────────

const HEADER: HeaderInput = { title: "잔고 17", chip: "미국 주간거래", sub: ["14:03 기준", "14:03"], delayed: false };
const TITLE: TitleInput = { titles: ["보유 17 · 관심 1", "보유 17"], chips: ["미국 주간거래 · 한국 장중", "미국 주간거래"], sub: ["9/26 14:03 기준", "9/26 14:03", "14:03"], delayed: false };
const ASSET: AssetInput = { width: 300, height: 200, scale: 1, label: "총 평가", chip: "한국 장중", asOf: ["14:03 기준", "14:03"], total: "123,456,789원", day: { text: "오늘 +1,234,567원", value: "+1,234,567원" }, cum: "총 -12,345,678원", note: [] };
const WIDTHS = [780, 600, 500, 420, 360, 330, 300, 250, 200, 150, 110];
const SCALES = [1, 1.3, 2];

/** 폭을 1dp 씩 줄이며 [폭, 결과] (from → 1) */
function sweep<T>(from: number, f: (w: number) => T): [number, T][] {
  const out: [number, T][] = [];
  for (let w = from; w >= 1; w--) out.push([w, f(w)]);
  return out;
}

describe("배치: basis 없음·null 이면 지금 결과와 같다 (끈 상태)", () => {
  it.each(SCALES)("배율 %s: planHeader·planTitle·planAsset", (scale) => {
    for (const w of WIDTHS) {
      expect(planHeader({ ...HEADER, basis: null }, w, scale), `header ${w}`).toEqual(planHeader(HEADER, w, scale));
      expect(planHeader({ ...HEADER, chip: null, basis: null }, w, scale), `header 칩 없음 ${w}`).toEqual(planHeader({ ...HEADER, chip: null }, w, scale));
      expect(planTitle({ ...TITLE, basis: null }, headerRoom(w), scale), `title ${w}`).toEqual(planTitle(TITLE, headerRoom(w), scale));
      expect(planAsset({ ...ASSET, width: w, scale, basis: null }), `asset ${w}`).toEqual(planAsset({ ...ASSET, width: w, scale }));
    }
  });
});

describe("배치: 넉넉한 폭(780·배율 1)이면 기준 시각 뒤에 붙는다", () => {
  it("잔고 머리 줄·다듬은 제목 줄·자산 윗줄", () => {
    expect(planHeader({ ...HEADER, basis: BASIS }, 780, 1)).toEqual({ chip: true, sub: `14:03 기준 · ${BASIS}`, delayed: false });
    expect(planTitle({ ...TITLE, basis: BASIS }, headerRoom(780), 1)).toEqual({ title: TITLE.titles[0], chip: TITLE.chips[0], sub: `9/26 14:03 기준 · ${BASIS}`, delayed: false });
    expect(planAsset({ ...ASSET, width: 780, basis: BASIS }).top).toEqual({ label: true, chip: true, asOf: `14:03 기준 · ${BASIS}` });
    // 지연이면 '지연 · 14:03 기준 · …'
    expect(planAsset({ ...ASSET, width: 780, asOf: ["지연 · 14:03 기준", "지연 · 14:03", "지연"], basis: BASIS }).top?.asOf).toBe(`지연 · 14:03 기준 · ${BASIS}`);
  });

  it("칩이 없는 위젯에서도 붙는다", () => {
    expect(planHeader({ ...HEADER, chip: null, basis: BASIS }, 780, 1).sub).toBe(`14:03 기준 · ${BASIS}`);
    expect(planTitle({ ...TITLE, chips: [], basis: BASIS }, headerRoom(780), 1).sub).toBe(`9/26 14:03 기준 · ${BASIS}`);
    expect(planAsset({ ...ASSET, width: 780, chip: null, basis: BASIS }).top?.asOf).toBe(`14:03 기준 · ${BASIS}`);
  });

  it("'갱신 중'·'갱신 실패'가 앞이면 붙이지 않는다 (첫 후보가 시각 글일 때만)", () => {
    expect(planHeader({ ...HEADER, sub: ["갱신 중"], basis: BASIS }, 780, 1).sub).toBe("갱신 중");
    expect(planHeader({ ...HEADER, sub: ["갱신 실패", ...HEADER.sub], basis: BASIS }, 780, 1).sub).toBe("갱신 실패");
    expect(planTitle({ ...TITLE, sub: ["갱신 중"], basis: BASIS }, headerRoom(780), 1).sub).toBe("갱신 중");
    expect(planTitle({ ...TITLE, sub: ["갱신 실패", ...TITLE.sub], basis: BASIS }, headerRoom(780), 1).sub).toBe("갱신 실패");
    expect(planAsset({ ...ASSET, width: 780, asOf: ["지연"], basis: BASIS }).top?.asOf).toBe("지연");
  });
});

describe("배치: 다른 칸을 하나도 빼지 않을 때만 (기대값은 계산으로)", () => {
  it.each(SCALES)("배율 %s: 잔고 머리 줄", (scale) => {
    const first = (p: ReturnType<typeof planHeader>) => p.chip === true && p.sub === HEADER.sub[0];
    const rows = sweep(780, (w) => ({ base: planHeader(HEADER, w, scale), got: planHeader({ ...HEADER, basis: BASIS }, w, scale) }));
    // 붙었으면 첫 후보에 붙인 것, 아니면 basis 없는 결과 그대로 (다른 칸은 늘 같다)
    for (const [w, { base, got }] of rows) {
      if (got.sub !== base.sub) {
        expect(first(base), `${w}`).toBe(true);
        expect(got, `${w}`).toEqual({ ...base, sub: `${HEADER.sub[0]} · ${BASIS}` });
      } else expect(got, `${w}`).toEqual(base);
    }
    // '안 붙는 폭': basis 없는 결과가 첫 후보가 아니게 되는 첫 폭 — 칩·기준 시각을 버리고 기준을 넣지 않는다
    const drop = rows.find(([, r]) => !first(r.base));
    expect(drop).toBeDefined();
    expect(drop![1].got).toEqual(drop![1].base);
    // '경계 폭': 첫 후보는 들어가는데 기준을 붙이면 안 들어가는 폭 — 그대로
    const edge = rows.find(([, r]) => first(r.base) && r.got.sub === r.base.sub);
    expect(edge).toBeDefined();
    expect(edge![1].got).toEqual(edge![1].base);
    // 붙는 폭은 경계보다 넓은 쪽에만 (좁아지다 다시 붙지 않음)
    expect(rows.filter(([w, r]) => w < edge![0] && r.got.sub !== r.base.sub)).toEqual([]);
  });

  it.each(SCALES)("배율 %s: 다듬은 제목 줄 (titleWidth 로 직접 계산)", (scale) => {
    const sub0 = TITLE.sub[0]!;
    const first = (p: ReturnType<typeof planTitle>) => p.title === TITLE.titles[0] && p.chip === TITLE.chips[0] && p.sub === sub0;
    const rows = sweep(headerRoom(780), (room) => ({ base: planTitle(TITLE, room, scale), got: planTitle({ ...TITLE, basis: BASIS }, room, scale) }));
    for (const [room, { base, got }] of rows) {
      const withB = { ...base, sub: `${sub0} · ${BASIS}` };
      const want = first(base) && titleWidth(withB, scale) <= room ? withB : base;
      expect(got, `${room}`).toEqual(want);
    }
    const drop = rows.find(([, r]) => !first(r.base));
    expect(drop).toBeDefined();
    expect(drop![1].got).toEqual(drop![1].base);
    const edge = rows.find(([, r]) => first(r.base) && r.got.sub === sub0);
    expect(edge).toBeDefined();
    expect(edge![1].got).toEqual(edge![1].base);
  });

  it.each(SCALES)("배율 %s: 자산 윗줄 (높이 규칙 그대로 — 윗줄 높이는 같음)", (scale) => {
    const first = (p: ReturnType<typeof planAsset>, w: number) => !!p.top && p.top.label && p.top.chip === (assetSize(w) !== "compact") && p.top.asOf === ASSET.asOf[0];
    const rows = sweep(780, (w) => ({ base: planAsset({ ...ASSET, width: w, scale }), got: planAsset({ ...ASSET, width: w, scale, basis: BASIS }) }));
    for (const [w, { base, got }] of rows) {
      if (got.top?.asOf !== base.top?.asOf) {
        expect(first(base, w), `${w}`).toBe(true);
        expect(got, `${w}`).toEqual({ ...base, top: { ...base.top!, asOf: `${ASSET.asOf[0]} · ${BASIS}` } });
      } else expect(got, `${w}`).toEqual(base);
    }
    const drop = rows.find(([w, r]) => !first(r.base, w));
    expect(drop).toBeDefined();
    expect(drop![1].got).toEqual(drop![1].base);
    const edge = rows.find(([w, r]) => first(r.base, w) && r.got.top?.asOf === r.base.top?.asOf);
    expect(edge).toBeDefined();
    expect(edge![1].got).toEqual(edge![1].base);
  });
});

// ── 그림 ──────────────────────────────────────────────────────────────

interface Node {
  kind: string;
  props: Record<string, unknown>;
  children: Node[];
}
/** 함수 컴포넌트를 펼쳐 위젯 트리로 */
function render(el: React.ReactNode): Node[] {
  if (el === null || el === undefined || typeof el === "boolean") return [];
  if (Array.isArray(el)) return el.flatMap(render);
  if (!React.isValidElement(el)) return [];
  const type = el.type as { __widget?: string } & ((p: unknown) => React.ReactNode);
  const props = el.props as Record<string, unknown>;
  if (type.__widget) return [{ kind: type.__widget, props, children: render(props.children as React.ReactNode) }];
  if (typeof type === "function") return render(type(props));
  return render(props.children as React.ReactNode);
}
const all = (nodes: Node[]): Node[] => nodes.flatMap((n) => [n, ...all(n.children)]);
const texts = (nodes: Node[]) => all(nodes).filter((n) => n.kind === "Text").map((n) => String(n.props.text));
const labels = (nodes: Node[]) => all(nodes).map((n) => n.props.accessibilityLabel).filter((x): x is string => typeof x === "string");
/** 비교용 모양 (children 속성은 펼친 트리로 대신) */
const shape = (nodes: Node[]): unknown[] =>
  nodes.map((n) => {
    const { children: _children, ...props } = n.props;
    return { kind: n.kind, props, children: shape(n.children) };
  });

const KR_AT = "2026-09-28T14:03:00+09:00";
const US_AT = "2026-09-28T14:02:00+09:00";
const kr = (code: string, name: string, price: number, basis: string | null = "KRX+NXT 통합") =>
  holding(code, quote(code, price, { change: price * 0.01, changeRate: 1, asOf: KR_AT, ...(basis ? { priceBasis: basis } : {}) }), 10, price * 0.9, undefined, name);
const us = (code: string, name: string, price: number, extra: { fxRate?: number; priceBasis?: string } = { fxRate: 1390, priceBasis: "주간거래" }) =>
  holding(code, quote(code, price, { currency: "USD", change: price * 0.02, changeRate: 2, asOf: US_AT, ...extra }), 5, price * 0.8, undefined, name);
const STOCKS: RegisteredWithQuote[] = [
  kr("005930", "삼성전자", 84_300),
  kr("000660", "SK하이닉스", 318_500),
  kr("035420", "NAVER", 196_000),
  us("AVGO", "브로드컴", 353.95),
  us("SOXL", "SOXL", 151.86),
  // 관심 종목(수량 없음)은 합계 밖 — 기준을 몰라도 글을 막지 않는다 (isHeld 로 거르지 않고 countedHoldings)
  holding("042700", quote("042700", 98_400, { asOf: KR_AT }), null, null, undefined, "한미반도체"),
];
const MARKET: WidgetMarket = { label: "한국 장중", open: true, kr: true, us: false, nextChangeAt: null };

type Kind = "holdings" | "polished" | "asset";
function draw(kind: Kind, stocks: RegisteredWithQuote[], width: number, scale: number, basis: boolean): Node[] {
  const common = { stocks, showKrw: true, fetchedAt: NOW, error: null, now: NOW, market: MARKET, width, fontScale: scale, ...(basis ? { basis: true } : {}) };
  if (kind === "asset") return render(<AssetWidget {...common} height={110} />);
  return render(<HoldingsWidget {...common} height={250} {...(kind === "polished" ? { polish: true } : {})} />);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

describe("그림: 기준 글이 보이면 그 글만 늘고, 안 보이면 트리 전체가 같다", () => {
  it("대상 종목의 기준을 모아 한 번 (국내 NXT + 미국 주간거래)", () => {
    expect(basisShort(countedHoldings(STOCKS).map((s) => s.quote))).toBe(BASIS);
  });

  const cases: [Kind, number, number][] = [];
  for (const kind of ["holdings", "polished", "asset"] as const) for (const w of [780, 360, 330, 250]) for (const s of [1, 1.3]) cases.push([kind, w, s]);
  it.each(cases)("%s %sdp 배율 %s", (kind, width, scale) => {
    const off = draw(kind, STOCKS, width, scale, false);
    const on = draw(kind, STOCKS, width, scale, true);
    const offT = texts(off);
    const onT = texts(on);
    const shown = onT.some((t) => t.endsWith(` · ${BASIS}`));
    if (shown) {
      // (가) 다른 글(칩·제목·'· 관심 N'·날짜)은 모두 같고, 기준 시각 글 하나만 ' · NXT·주간거래 포함' 이 더해짐
      expect(onT).toHaveLength(offT.length);
      const diff = onT.map((t, k) => [t, offT[k]!] as const).filter(([a, b]) => a !== b);
      expect(diff).toHaveLength(1);
      expect(diff[0]![0]).toBe(`${diff[0]![1]} · ${BASIS}`);
      expect(diff[0]![1]).toMatch(/ 기준$/);
      // 화면 읽기: 시각 조각 다음에 '시세 NXT, 주간거래 포함'
      expect(labels(on).some((l) => l.includes(`기준, ${SAID}`))).toBe(true);
      expect(labels(off).some((l) => l.includes(SAID))).toBe(false);
    } else {
      // (나) basis 없이 그린 그림과 트리 전체가 같다
      expect(shape(on)).toEqual(shape(off));
    }
    // 잔고 넓은 위젯(780, 배율 1)은 붙는다
    if (kind !== "asset" && width === 780 && scale === 1) expect(shown).toBe(true);
  });

  it("끄면(basis 없음) 기준 글·화면 읽기 조각이 없다", () => {
    for (const kind of ["holdings", "polished", "asset"] as const) {
      const off = draw(kind, STOCKS, 780, 1, false);
      expect(texts(off).some((t) => t.includes("포함"))).toBe(false);
      expect(labels(off).some((l) => l.includes("시세 "))).toBe(false);
    }
  });

  it("합계에 든 보유 종목 하나라도 기준을 모르면(예전 서버·옛 시세) 붙이지 않는다", () => {
    const unknown = [...STOCKS, kr("005380", "현대차", 251_000, null)];
    expect(unknown.at(-1)!.quote).not.toHaveProperty("priceBasis");
    for (const kind of ["holdings", "polished", "asset"] as const) expect(shape(draw(kind, unknown, 780, 1, true))).toEqual(shape(draw(kind, unknown, 780, 1, false)));
  });

  it("갱신 중이면 붙이지 않는다", () => {
    const on = render(<HoldingsWidget stocks={STOCKS} showKrw fetchedAt={NOW} error={null} now={NOW} market={MARKET} width={780} height={250} refreshing basis />);
    const off = render(<HoldingsWidget stocks={STOCKS} showKrw fetchedAt={NOW} error={null} now={NOW} market={MARKET} width={780} height={250} refreshing />);
    expect(shape(on)).toEqual(shape(off));
  });
});

describe("이전 값으로 채운 시세는 기준을 모르는 것으로 본다 (3-32 다듬기 · 결정 B)", () => {
  // 이번에 시세를 못 받아 마지막 값으로 채운 보유 종목(model.ts fillFromLast → filled)은 그때의 기준이 지금 시세와 다를 수 있다
  const drawFilled = (kind: Kind, stocks: RegisteredWithQuote[], filled: string[], basis: boolean): Node[] => {
    const common = { stocks, showKrw: true, fetchedAt: NOW, error: null, now: NOW, market: MARKET, width: 780, fontScale: 1, filled, ...(basis ? { basis: true } : {}) };
    if (kind === "asset") return render(<AssetWidget {...common} height={110} />);
    return render(<HoldingsWidget {...common} height={250} {...(kind === "polished" ? { polish: true } : {})} />);
  };

  it("합계에 든 보유 종목 하나라도 이전 값이면 ' · NXT·주간거래 포함' 을 붙이지 않는다 — 트리 전체가 끈 것과 같다", () => {
    for (const kind of ["holdings", "polished", "asset"] as const) {
      // 채운 것이 없으면 붙는다 (대조군)
      expect(texts(drawFilled(kind, STOCKS, [], true)).some((t) => t.endsWith(` · ${BASIS}`)), kind).toBe(true);
      for (const code of ["AVGO", "005930"]) {
        const on = drawFilled(kind, STOCKS, [code], true);
        expect(shape(on), `${kind} ${code}`).toEqual(shape(drawFilled(kind, STOCKS, [code], false)));
        expect(texts(on).some((t) => t.includes("포함")), `${kind} ${code}`).toBe(false);
        expect(labels(on).some((l) => l.includes("시세 ")), `${kind} ${code}`).toBe(false);
      }
    }
  });

  it("fillFromLast 가 채운 목록 그대로 넘기면 붙지 않고, 다음에 새 시세를 받으면(채운 것 없음) 다시 붙는다", async () => {
    const { fillFromLast } = await import("@/widgets/model");
    // AVGO 시세를 이번에 못 받음 → 직전 목록(STOCKS)의 값으로 채움
    const now = STOCKS.map((s) => (s.code === "AVGO" ? { ...s, quote: null, evaluation: null } : s));
    const got = fillFromLast(now, STOCKS, NOW);
    expect(got.filled).toEqual(["AVGO"]);
    // 채운 시세에도 예전 기준 글자(priceBasis)가 남아 있다 — 그래도 모르는 것으로 본다
    expect(got.stocks.find((s) => s.code === "AVGO")!.quote!.priceBasis).toBe("주간거래");
    for (const kind of ["holdings", "polished", "asset"] as const) {
      expect(texts(drawFilled(kind, got.stocks, got.filled, true)).some((t) => t.includes("포함")), kind).toBe(false);
      expect(texts(drawFilled(kind, STOCKS, [], true)).some((t) => t.endsWith(` · ${BASIS}`)), kind).toBe(true);
    }
  });

  it("관심 종목(합계 밖) 코드가 filled 에 있어도 막지 않는다 (fillFromLast 는 보유 종목만 채우지만, 합계에 든 종목만 본다)", () => {
    for (const kind of ["holdings", "polished", "asset"] as const) expect(texts(drawFilled(kind, STOCKS, ["042700"], true)).some((t) => t.endsWith(` · ${BASIS}`)), kind).toBe(true);
  });
});

describe("대상: 잔고 화면과 같은 countedHoldings", () => {
  it("환율 없는 달러 종목(주간거래)은 합계 밖이라 세지 않는다 → 'NXT 포함'", () => {
    const noFx = us("RGTX", "RGTX", 10.64, { priceBasis: "주간거래" });
    expect(noFx.quote?.fxRate).toBeUndefined();
    expect(noFx.quote?.priceKrw).toBeUndefined();
    const list = [kr("005930", "삼성전자", 84_300), noFx];
    expect(countedHoldings(list).map((s) => s.code)).toEqual(["005930"]);
    for (const kind of ["holdings", "polished", "asset"] as const) {
      const t = texts(draw(kind, list, 780, 1, true));
      expect(t.some((x) => x.endsWith(" · NXT 포함")), kind).toBe(true);
      expect(t.some((x) => x.includes("주간거래 포함")), kind).toBe(false);
    }
  });
});

// ── 서버 응답 ────────────────────────────────────────────────────────

/** 서버 widgetPayload.ts slim 과 같은 짧은 모양 (b 는 numberBasis 켬 · &ms=1 일 때만) */
function toWire(s: RegisteredWithQuote, withB: boolean): WidgetStock {
  const q = s.quote;
  const e = s.evaluation;
  return {
    c: s.code,
    n: s.name,
    qty: s.quantity,
    avg: s.avgPrice,
    q: q ? [q.price, q.change, q.changeRate, q.currency as "KRW" | "USD", q.asOf, q.fxRate ?? null, q.stale ? 1 : 0] : null,
    e: e ? [e.marketValue, e.costBasis, e.afterCost ? e.afterCost.marketValue : null, e.costBasisKrw ?? null, e.krwCostSource ?? null] : null,
    ...(withB && q?.priceBasis ? { b: q.priceBasis } : {}),
  };
}
const payload = (withB: boolean, features: Record<string, boolean> = {}) => fromPayload({ v: 1, market: MARKET, stocks: STOCKS.map((s) => toWire(s, withB)), briefings: [], features });

describe("응답: b → priceBasis, numberBasis → basis", () => {
  it("fromPayload: b 가 있으면 시세의 priceBasis, 없으면 칸이 없다", () => {
    const got = payload(true).stocks;
    expect(got.find((s) => s.code === "005930")!.quote!.priceBasis).toBe("KRX+NXT 통합");
    expect(got.find((s) => s.code === "AVGO")!.quote!.priceBasis).toBe("주간거래");
    expect(got.find((s) => s.code === "042700")!.quote).not.toHaveProperty("priceBasis");
    expect(payload(false).stocks.some((s) => s.quote && "priceBasis" in s.quote)).toBe(false);
  });

  it("widgetFeatures: numberBasis 가 켜져 있을 때만 basis: true 칸", () => {
    expect(widgetFeatures({ numberBasis: true }).basis).toBe(true);
    expect(widgetFeatures({ numberBasis: false })).not.toHaveProperty("basis");
    expect(widgetFeatures({})).not.toHaveProperty("basis");
    expect(widgetFeatures(null)).not.toHaveProperty("basis");
    expect(payload(true, { numberBasis: true }).features.basis).toBe(true);
  });

  it("앱이 넘긴 잔고와 서버 응답(b)으로 그린 머리 글이 같다 — b 가 빠지면 달라진다", () => {
    const head = (stocks: RegisteredWithQuote[], kind: Kind) => texts(draw(kind, stocks, 780, 1, true)).find((t) => / 기준( · |$)/.test(t));
    for (const kind of ["holdings", "polished", "asset"] as const) {
      const app = head(STOCKS, kind);
      expect(app, kind).toMatch(new RegExp(` · ${BASIS}$`));
      expect(head(payload(true).stocks, kind), kind).toBe(app);
      expect(head(payload(false).stocks, kind), kind).not.toBe(app);
    }
  });
});
