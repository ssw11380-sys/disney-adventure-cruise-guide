import React from "react";
import { describe, expect, it, vi } from "vitest";
import { holding, quote } from "./helpers";
import type { LatestBriefing } from "@/api/types";
import type { WidgetSummary } from "@/widgets/payload";

vi.mock("react-native-android-widget", async () => {
  const load = (p: string) => import(/* @vite-ignore */ p);
  const base = "react-native-android-widget/lib/commonjs/widgets/";
  const [flex, text, list] = await Promise.all([load(`${base}FlexWidget.js`), load(`${base}TextWidget.js`), load(`${base}ListWidget.js`)]);
  return { FlexWidget: flex.FlexWidget, TextWidget: text.TextWidget, ListWidget: list.ListWidget };
});
const lib = (p: string) => import(/* @vite-ignore */ p);
const { buildWidgetTree } = await lib("react-native-android-widget/lib/commonjs/api/build-widget-tree.js");
const { HoldingsWidget, AssetWidget, BriefingWidget } = await import("@/widgets/widgets");
const { MarketWidget } = await import("@/widgets/marketWidget");
const { planClarityAsset, lineHeight } = await import("@/widgets/layout");
const NOW = Date.parse("2026-10-04T12:00:00+09:00");
const STOCKS = [holding("005930", quote("005930", 70000, { asOf: "2026-10-02T15:30:00+09:00", change: 1000, changeRate: 1.4 }), 10, 60000, undefined, "삼성전자")];
const props = { stocks: STOCKS, showKrw: false, afterCost: false, fetchedAt: NOW, now: NOW, error: null, market: { label: "휴장", open: false, nextChangeAt: null }, width: 330, height: 200 };
interface Tree { type: string; props: Record<string, unknown>; children?: Tree[] }
const build = (x: React.JSX.Element): Tree => buildWidgetTree(x);
const nodes = (x: Tree): Tree[] => [x, ...(x.children ?? []).flatMap(nodes)];
const words = (x: Tree) => nodes(x).filter((n) => n.type === "TextWidget").map((n) => String(n.props.text)).join(" ");
const clarity = { clarity: true, widgetId: 7 };

describe("위젯 정보 기준과 작은 화면", () => {
  it("간소 보기에서 누적 종목 손익은 덜고 현재가·전일 대비·지연 경고와 상세 연결은 보존한다", () => {
    const lean=build(<HoldingsWidget {...props} {...clarity} leanLive width={508} height={223} />);
    const normal=build(<HoldingsWidget {...props} {...clarity} width={508} height={223} />);
    expect(words(normal)).toContain("수익 "); expect(words(lean)).not.toContain("수익 ");
    expect(words(lean)).toContain("70,000원"); expect(words(lean)).toContain("+1.40%");
    expect(words(lean)).toContain("전일 대비");
    expect(nodes(lean).some(n=>(n.props.clickActionData as {uri?:string})?.uri?.endsWith("stocks/005930"))).toBe(true);
    const stale=build(<HoldingsWidget {...props} {...clarity} leanLive width={508} height={223} filled={["005930"]} />);
    expect(words(stale)).toContain("시세 지연");
    expect(build(<HoldingsWidget {...props} {...clarity} leanLive={false} />)).toEqual(build(<HoldingsWidget {...props} {...clarity} />));
  });
  it("간소 시장 위젯은 변동률을 남기고 포인트 반복을 덜며 큰 글씨에서도 숫자를 자르지 않는다", () => {
    const board=[{code:"KOSPI",name:"코스피",value:7000,change:63,changeRate:0.91,open:true}];
    for(const scale of [1.15,1.3,2]) {
      const t=build(<MarketWidget {...clarity} leanLive board={board} boardAt={NOW} enabled error={null} now={NOW} width={508} height={350} fontScale={scale}/>);
      expect(words(t)).toContain("+0.91%"); expect(words(t)).not.toContain("▲63");
      expect(words(t)).toContain("7,000.00");
    }
  });
  it("기능이 꺼져 있으면 기존 트리와 정확히 같다", () => {
    expect(build(<HoldingsWidget {...props} {...{ clarity: false }} />)).toEqual(build(<HoldingsWidget {...props} />));
    expect(build(<AssetWidget {...props} {...{ clarity: false }} />)).toEqual(build(<AssetWidget {...props} />));
  });
  it("시세 합계의 이름과 앱 열기 기준이 일치한다", () => {
    const t = build(<HoldingsWidget {...props} {...clarity} />);
    expect(words(t)).toContain("앱 시세 평가");
    expect(nodes(t).some((n) => (n.props.clickActionData as { uri?: string })?.uri === "stockbriefing://?valuation=live")).toBe(true);
    expect(nodes(t).some((n) => (n.props.clickActionData as { uri?: string })?.uri === "stockbriefing://widget-settings?id=7")).toBe(true);
  });
  it("작은 자산 위젯은 실패·부분 합계 경고를 금액보다 먼저 지킨다", () => {
    const stocks = [...STOCKS, holding("AAPL", null, 2, 100, undefined, "애플")];
    const t = build(<AssetWidget {...props} {...clarity} stocks={stocks} width={150} height={70} error="network" />);
    expect(words(t)).toMatch(/갱신 실패|금액 주의/);
    expect(String(t.props.accessibilityLabel)).toContain("부분 평가");
    expect(String(t.props.accessibilityLabel)).toContain("갱신 실패");
  });
  it("휴장 종가를 오늘 손익이라고 표시하지 않는다", () => {
    const t = build(<HoldingsWidget {...props} {...clarity} pnlToggle pnlMode="day" height={280} />);
    expect(words(t)).toContain("전일 대비");
    expect(words(t)).not.toContain("오늘");
  });
  it("아주 작은 110×56 · 큰 글씨 200%에서도 경고 한 줄은 남고 숫자를 1sp로 줄이지 않는다", () => {
    for (const width of [110, 150, 200, 330]) for (const height of [56, 70, 90, 120]) for (const scale of [1, 1.3, 2]) {
      const lines = planClarityAsset({ width, height, scale, total: "999,999,999,999원", warning: "갱신 실패 · 부분 평가 · 시세 지연", time: "시세 10/2 15:30", pnl: "전일 대비 +999,999원" });
      expect(lines.length).toBeGreaterThan(0);
      expect(lines[0]?.kind).toBe("warning");
      expect(lines.reduce((n, x) => n + x.height, 0)).toBeLessThanOrEqual(height - 16);
      expect(lines.every((x) => x.font >= 11)).toBe(true);
    }
  });
  it("부분 평가·시세 지연·시세/조회 시각·비용·번호 기준을 접근성 설명에도 보존", () => {
    const stocks = [...STOCKS.map((s) => ({ ...s, quote: { ...s.quote!, stale: true, priceBasis: "KRX+NXT 통합" } })), holding("AAPL", null, 1, 100)];
    const t = build(<AssetWidget {...props} {...clarity} stocks={stocks} basis error="network" />);
    const label = String(t.props.accessibilityLabel);
    expect(label).toContain("부분 평가"); expect(label).toContain("시세 지연");
    expect(label).toContain("시세 10/2 15:30"); expect(label).toContain("조회 12:00");
    expect(label).toContain("수수료·세금 차감 전");
  });
  it("보유 목록을 고정 순서로 바꿔도 합계는 전체이며 목록 넘기기 안내를 제공", () => {
    const stocks = [...STOCKS, holding("035420", quote("035420", 10000), 1, 5000, undefined, "네이버")];
    const t = build(<HoldingsWidget {...props} {...clarity} stocks={stocks} height={350} order={{ sort: "name", pinnedCodes: ["035420"] }} />);
    expect(words(t)).toContain("710,000원"); expect(words(t)).toContain("아래로");
    const rowLinks = nodes(t).filter((n) => String((n.props.clickActionData as { uri?: string })?.uri).includes("stocks/"));
    expect((rowLinks[0]?.props.clickActionData as { uri: string }).uri).toContain("035420");
    expect(rowLinks.every((n) => Number(n.props.height) >= 48)).toBe(true);
  });
  it("실제 커버 위젯 크기 508×223·115%에서 목록을 없애지 않는다", () => {
    const t = build(<HoldingsWidget {...props} {...clarity} width={508} height={223} fontScale={1.15} pnlToggle />);
    expect(nodes(t).some((n) => n.type === "ListWidget")).toBe(true);
    expect(words(t)).toContain("+100,000원 (+16.67%)");
    expect(nodes(t).some((n) => n.type === "TextWidget" && String(n.props.text).startsWith("시세 ") && String(n.props.text).includes("종목 전일 대비"))).toBe(true);
    const list = nodes(t).find((n) => n.type === "ListWidget")!;
    const row = list.children?.[0];
    expect(Number(row?.props.height)).toBeGreaterThanOrEqual(48);
    // 새 머리 48 + 시각/안내 19 + 아래 8 = 75. 남은 148dp에 50dp 종목 약 3개가 들어간다.
    expect((223 - 48 - lineHeight(11, 1.15) - 8) / Number(row?.props.height)).toBeGreaterThanOrEqual(2.9);
  });
  it("브리핑은 작은 화면에도 작성 회차를 남기며 정상 크기 보고서 터치는 48dp 이상", () => {
    const latest = { id: 8, code: "005930", session: "afternoon", date: "2026-10-02", summary: "첫 문장\n다음 문장", status: "ok", createdAt: "2026-10-02T16:00:00+09:00" };
    const briefings = [{ code: "005930", name: "삼성전자", latest }] as LatestBriefing[];
    const p = { briefings, fetchedAt: NOW, error: null, now: NOW, ...clarity };
    const small = build(<BriefingWidget {...p} width={250} height={110} />);
    expect(words(small)).toContain("10/02 오후");
    expect((small.props.clickActionData as { uri: string }).uri).toBe("stockbriefing://briefings/8");
    const normal = build(<BriefingWidget {...p} width={330} height={200} />);
    const reports = nodes(normal).filter((n) => (n.props.clickActionData as { uri?: string })?.uri === "stockbriefing://briefings/8");
    expect(reports.length).toBeGreaterThan(0);
    expect(reports.every((n) => Number(n.props.height) >= 48)).toBe(true);
    expect(words(normal)).toContain("조회 12:00");
  });
  it("지수는 모든 항목을 유지한 스크롤 목록이며 작은 글자 대신 앱 확인을 제시", () => {
    const board = [{ code: "KOSPI", name: "코스피", value: 99999999.99, change: 1, changeRate: 0.1, open: false }];
    const t = build(<MarketWidget {...clarity} board={board} boardAt={NOW} enabled error={null} now={NOW} width={250} height={300} fontScale={2} />);
    expect(nodes(t).some((n) => n.type === "ListWidget")).toBe(true);
    const tiles = nodes(t).filter((n) => String((n.props.clickActionData as { uri?: string })?.uri).includes("market/"));
    expect(tiles).toHaveLength(9);
    expect(tiles.slice(0, 3).map((n) => (n.props.clickActionData as { uri: string }).uri)).toEqual(["stockbriefing://market/KOSPI", "stockbriefing://market/NASDAQ", "stockbriefing://market/USDKRW"]);
    expect(words(t)).toContain("시장 환율");
    expect(tiles.every((n) => Number(n.props.height) >= 48)).toBe(true);
    const textNodes = nodes(t).filter((n) => n.type === "TextWidget" && n.props.fontSize !== undefined);
    expect(textNodes.every((n) => Number(n.props.fontSize) >= 10)).toBe(true);
    expect(lineHeight(12, 2)).toBeGreaterThan(0);
  });
  it("508×223·115% 시장 위젯은 글자 크기를 유지하면서 6개 전체와 추가 3개 스크롤을 보존", () => {
    const board = ["KOSPI", "NASDAQ", "USDKRW", "KOSDAQ", "SPX", "JPYKRW", "DJI", "SOX", "CNYKRW"].map((code) => ({ code, name: code, value: 27190.86, change: 319.27, changeRate: 1.19, open: false }));
    const t = build(<MarketWidget {...clarity} board={board} boardAt={NOW} enabled error={null} now={NOW} width={508} height={223} fontScale={1.15} />);
    const all = nodes(t), list = all.find((n) => n.type === "ListWidget")!;
    expect(list.children).toHaveLength(3);
    expect(list.children?.every((row) => row.children?.length === 3)).toBe(true);
    const metadata = all.slice(0, all.indexOf(list)).filter((n) => n.type === "TextWidget" && /조회|아래로/.test(String(n.props.text)));
    expect(metadata).toHaveLength(1);
    expect(String(metadata[0]?.props.text)).toMatch(/조회.*아래로/);
    const metaH = metadata.reduce((sum, n) => sum + lineHeight(Number(n.props.fontSize), 1.15), 0);
    expect(48 + metaH + Number(list.children?.[0]?.props.height) * 2 + 8 + 2).toBeLessThanOrEqual(223);
    const firstTile = list.children?.[0]?.children?.[0];
    expect(firstTile?.children?.map((n) => n.props.fontSize)).toEqual([12, 18, 12]);
  });
  it("큰 자산 카드의 누적손익과 전일 대비를 보존하고 좁을 때도 낭독에 둘 다 포함", () => {
    const big = build(<AssetWidget {...props} {...clarity} width={500} height={180} />);
    expect(words(big)).toContain("누적 +100,000원"); expect(words(big)).toContain("전일 대비 +10,000원");
    const small = build(<AssetWidget {...props} {...clarity} width={110} height={56} fontScale={2} />);
    expect(String(small.props.accessibilityLabel)).toContain("누적 +100,000원"); expect(String(small.props.accessibilityLabel)).toContain("전일 대비 +10,000원");
  });
  it("시장 요약과 해당 상세 링크를 충분한 브리핑 크기에서 유지", () => {
    const summary: WidgetSummary = { id: 10, date: "2026-10-04", session: "morning", market: "US", marketDate: "2026-10-02", basisDate: "2026-10-02", holiday: null, phase: "final", asOf: "2026-10-04T08:00:00+09:00", indices: [{ code: "NASDAQ", name: "나스닥", date: "2026-10-02", changeRate: 1.2 }], holdings: null };
    const t = build(<BriefingWidget {...clarity} width={500} height={300} briefings={[]} fetchedAt={NOW} now={NOW} error={null} summary={summary} />);
    const link = nodes(t).find((n) => (n.props.clickActionData as { uri?: string })?.uri === "stockbriefing://briefings/market/10");
    expect(link).toBeTruthy(); expect(Number(link?.props.height)).toBeGreaterThanOrEqual(48);
    expect(words(t)).toContain("나스닥 +1.20%");
  });
  it("선택해서 켠 잔고 시장줄의 지연 표시를 버리지 않는다", () => {
    const indices = [{ code: "NASDAQ", name: "나스닥", value: 25000, change: 1, changeRate: 0.1, open: false, stale: true }];
    const t = build(<HoldingsWidget {...props} {...clarity} width={600} height={350} indexLine indices={indices} />);
    expect(words(t)).toContain("지연");
    expect(nodes(t).some((n) => String(n.props.accessibilityLabel).includes("나스닥") && String(n.props.accessibilityLabel).includes("지연"))).toBe(true);
  });
  it("시장줄을 켠 508×223·115%에서는 여러 지수가 한 줄에 안 들어가도 일부와 종목 목록을 표시", () => {
    const indices = ["KOSPI", "KOSDAQ", "NASDAQ", "SPX", "USDKRW"].map((code) => ({ code, name: code, value: 27190.86, change: 319.27, changeRate: 1.19, open: false, stale: true }));
    const t = build(<HoldingsWidget {...props} {...clarity} width={508} height={223} fontScale={1.15} indexLine indices={indices} />);
    expect(nodes(t).some((n) => n.type === "ListWidget")).toBe(true);
    const line = nodes(t).find((n) => n.type === "TextWidget" && /코스피|나스닥/.test(String(n.props.text)));
    expect(line).toBeTruthy();
    expect(String(line?.props.text)).toContain("+1.19%");
    expect(String(line?.props.text)).toContain("지연");
  });
});
