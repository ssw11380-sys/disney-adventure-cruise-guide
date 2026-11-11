import { afterEach, describe, expect, it } from "vitest";
import { isViewingSender, setViewingSender, viewingCodes, viewStock } from "@/lib/streamView";

/**
 * 보고 있는 종목 목록 (등록하지 않은 종목 상세도 실시간 스트림으로 받게 서버에 알리는 목록 — 2026-11-12 시세 지연 없애기).
 * 서버 쪽은 backend/test/quoteAccuracy.test.ts ({type:"view"})
 */
describe("보고 있는 종목 목록 (lib/streamView)", () => {
  const stops: Array<() => void> = [];
  const view = (code: string) => {
    const stop = viewStock(code);
    stops.push(stop);
    return stop;
  };
  afterEach(() => {
    for (const s of stops.splice(0)) s();
    setViewingSender(null);
  });

  it("화면을 열면 넣고 닫으면 뺀다 · 같은 종목을 두 화면이 보면(상세 + 전체 화면 차트) 둘 다 닫을 때까지 남는다", () => {
    expect(viewingCodes()).toEqual([]);
    const a = view("NVDA");
    const b = view("NVDA");
    view("005930");
    expect(viewingCodes()).toEqual(["NVDA", "005930"]);
    a();
    expect(viewingCodes()).toEqual(["NVDA", "005930"]);
    b();
    expect(viewingCodes()).toEqual(["005930"]);
    b(); // 두 번 불러도 한 번만 뺀다
    expect(viewingCodes()).toEqual(["005930"]);
  });

  it("소켓이 붙으면 바로 한 번 보내고, 목록이 바뀔 때마다 다시 보낸다 · 끊기면 보내지 않는다", () => {
    const sent: string[][] = [];
    const send = () => sent.push(viewingCodes());
    view("AAPL");
    setViewingSender(send); // 붙는 순간 지금 목록을 보낸다
    expect(sent).toEqual([["AAPL"]]);
    const stop = view("TSLA");
    expect(sent.at(-1)).toEqual(["AAPL", "TSLA"]);
    stop();
    expect(sent.at(-1)).toEqual(["AAPL"]);
    expect(isViewingSender(send)).toBe(true);
    setViewingSender(null);
    view("META");
    expect(sent).toHaveLength(3);
    // 볼 종목이 없을 때 붙으면 보낼 것이 없다
    for (const s of stops.splice(0)) s();
    const quiet: string[][] = [];
    setViewingSender(() => quiet.push(viewingCodes()));
    expect(quiet).toEqual([]);
  });
});
