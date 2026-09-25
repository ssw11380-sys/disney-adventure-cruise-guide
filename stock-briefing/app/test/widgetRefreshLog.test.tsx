import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "./miniRender";

/**
 * 위젯 리뷰 2번(OTA 부분): 앱을 닫아 두면 위젯이 실제로 몇 분마다 바뀌는지 알 수 없었다 (설정 문구 '장중 약 15분'은 잰 값이 아님).
 * 자동 갱신마다 시각·출처·결과를 기기에 짧게 적고(lib/widgetRefreshLog), 설정 화면에 '마지막 자동 갱신 10:47 · 오늘 평균 간격 18분'과
 * 장중 1시간 넘게 자동 갱신이 없을 때 경고, 배터리 설정 열기 버튼을 보여 준다 (플래그 widgetRefreshLog).
 */

const h = vi.hoisted(() => ({
  sendIntent: vi.fn(async (_a: string) => undefined as void),
  openSettings: vi.fn(async () => undefined as void),
  os: "android",
}));
vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Platform: {
    get OS() {
      return h.os;
    },
  },
  Linking: { sendIntent: h.sendIntent, openSettings: h.openSettings },
}));
vi.mock("@/theme", async () => {
  const tokens = await import("@/tokens");
  return { ...tokens, useTheme: () => tokens.light };
});
vi.mock("@/components/ui", () => ({ Button: "Button", Muted: "Muted" }));
vi.mock("@/api/hooks", () => ({ useMarketStatus: () => ({ data: undefined }) }));
const store = new Map<string, string>();
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: string) => void store.set(k, v),
    removeItem: async (k: string) => void store.delete(k),
  },
}));

const { appendRefresh, logWidgetRefresh, readWidgetRefreshLog, refreshSummaryText, summarizeRefreshLog, REFRESH_LOG_MAX, STALE_AUTO_MS } = await import("@/lib/widgetRefreshLog");
const { WidgetRefreshView, openBatterySettings } = await import("@/components/WidgetRefreshStatus");
type Entry = Parameters<typeof appendRefresh>[1];

/** 2026-09-24(목) KST */
const T = (hm: string, day = "24") => Date.parse(`2026-09-${day}T${hm}:00+09:00`);

beforeEach(() => {
  store.clear();
  h.os = "android";
  h.sendIntent.mockReset();
  h.sendIntent.mockImplementation(async () => undefined);
  h.openSettings.mockReset();
  h.openSettings.mockImplementation(async () => undefined);
});

describe("기록 (기기 안, 최근 것만)", () => {
  it("적은 순서대로 읽고, 1분 안에 같은 출처·결과가 몰리면(위젯 4개 주기 갱신) 한 줄로 합친다", async () => {
    await logWidgetRefresh("periodic", "ok", { at: T("10:00") });
    await logWidgetRefresh("periodic", "ok", { at: T("10:00") + 20_000 });
    await logWidgetRefresh("background", "ok", { at: T("10:01") });
    await logWidgetRefresh("background", "failed", { at: T("10:16"), error: "갱신 실패 · 연결 안 됨" });
    const log = await readWidgetRefreshLog();
    expect(log).toEqual([
      { t: T("10:00") + 20_000, s: "periodic", r: "ok", n: 2 },
      { t: T("10:01"), s: "background", r: "ok" },
      { t: T("10:16"), s: "background", r: "failed", e: "갱신 실패 · 연결 안 됨" },
    ]);
  });

  it(`최대 ${150}줄, 3일 넘은 줄은 버린다 (저장소가 커지지 않게)`, () => {
    expect(REFRESH_LOG_MAX).toBe(150);
    let list: Entry[] = [];
    for (let i = 0; i < 400; i++) list = appendRefresh(list, { t: T("00:00") + i * 16 * 60_000, s: "background", r: "ok" });
    expect(list).toHaveLength(REFRESH_LOG_MAX);
    expect(list.at(-1)!.t).toBe(T("00:00") + 399 * 16 * 60_000);
    const old = appendRefresh([{ t: T("10:00", "20"), s: "background", r: "ok" }], { t: T("10:00"), s: "background", r: "ok" });
    expect(old).toEqual([{ t: T("10:00"), s: "background", r: "ok" }]);
  });

  it("깨진 기록은 버리고 빈 목록으로 (설정 화면이 멈추지 않게)", async () => {
    store.set("widget.refreshLog", "{not json");
    expect(await readWidgetRefreshLog()).toEqual([]);
    store.set("widget.refreshLog", JSON.stringify([{ t: "x", s: "background", r: "ok" }, { t: T("10:00"), s: "nope", r: "ok" }, { t: T("10:05"), s: "background", r: "ok" }]));
    expect(await readWidgetRefreshLog()).toEqual([{ t: T("10:05"), s: "background", r: "ok" }]);
  });
});

describe("요약: '마지막 자동 갱신 10:47 · 오늘 평균 간격 18분'", () => {
  const bg = (hm: string, r: Entry["r"] = "ok", day = "24"): Entry => ({ t: T(hm, day), s: "background", r });

  it("오늘(한국 날짜) 자동 갱신(백그라운드 성공·건너뜀, 위젯 주기 갱신 성공) 사이 평균 간격, 실패 수", () => {
    const list: Entry[] = [bg("23:50", "ok", "23"), bg("10:11"), bg("10:29", "skipped"), { t: T("10:40"), s: "app", r: "ok" }, bg("10:47"), bg("10:55", "failed"), { t: T("10:30"), s: "button", r: "ok" }];
    const s = summarizeRefreshLog(list, T("11:00"), true);
    expect(s).toMatchObject({ last: T("10:47"), avgGapMin: 18, todayCount: 3, failedToday: 1, stale: false });
    expect(refreshSummaryText(s, T("11:00"))).toBe("마지막 자동 갱신 10:47 · 오늘 평균 간격 18분 · 실패 1회");
  });

  it("장중에 자동 갱신이 1시간 넘게 없으면 경고 (휴장이면 경고하지 않는다)", () => {
    const list: Entry[] = [bg("09:30")];
    expect(STALE_AUTO_MS).toBe(60 * 60_000);
    expect(summarizeRefreshLog(list, T("10:29"), true).stale).toBe(false);
    expect(summarizeRefreshLog(list, T("10:31"), true).stale).toBe(true);
    expect(summarizeRefreshLog(list, T("10:31"), false).stale).toBe(false);
    // 자동 갱신이 한 번도 없어도, 기록이 시작된 지(앱 즉시 갱신 등) 1시간이 지났으면 경고 (작업이 아예 막힌 경우)
    expect(summarizeRefreshLog([{ t: T("09:00"), s: "app", r: "ok" }], T("10:31"), true).stale).toBe(true);
    // 실패만 있으면 자동 갱신으로 세지 않는다
    expect(summarizeRefreshLog([bg("10:00", "failed"), bg("10:15", "failed")], T("11:01"), true)).toMatchObject({ last: null, stale: true, failedToday: 2 });
  });

  it("기록이 없거나 오늘 한 번뿐이면 평균 간격 없이, 오늘이 아니면 날짜까지", () => {
    expect(refreshSummaryText(summarizeRefreshLog([], T("11:00"), true), T("11:00"))).toBe("아직 자동 갱신 기록이 없습니다");
    expect(summarizeRefreshLog([], T("11:00"), true).stale).toBe(false);
    expect(refreshSummaryText(summarizeRefreshLog([bg("10:47")], T("11:00"), false), T("11:00"))).toBe("마지막 자동 갱신 10:47");
    expect(refreshSummaryText(summarizeRefreshLog([bg("23:50", "ok", "23")], T("11:00"), false), T("11:00"))).toBe("마지막 자동 갱신 9/23 23:50");
  });
});

describe("설정 화면 위젯 칸: 자동 갱신 기록과 배터리 설정", () => {
  const summary = (over: Partial<ReturnType<typeof summarizeRefreshLog>> = {}) => ({ last: T("10:47"), avgGapMin: 18, todayCount: 3, failedToday: 0, stale: false, ...over });

  it("요약 한 줄과 쉬운 말 안내, '배터리 설정 열기' 버튼 (이름표 있음)", () => {
    const onOpen = vi.fn();
    const r = render(<WidgetRefreshView summary={summary()} now={T("11:00")} onOpenBattery={onOpen} />);
    expect(r.text()).toContain("마지막 자동 갱신 10:47 · 오늘 평균 간격 18분");
    expect(r.text()).toContain("배터리 사용량 → 제한 없음");
    expect(r.text()).not.toContain("1시간 넘게");
    const btn = r.byLabel("배터리 설정 열기");
    (btn.props.onPress as () => void)();
    expect(onOpen).toHaveBeenCalledTimes(1);
    // 읽는 문장: 요약을 한 번에 읽는다
    expect(r.has("위젯 자동 갱신: 마지막 자동 갱신 10:47 · 오늘 평균 간격 18분")).toBe(true);
  });

  it("장중 1시간 넘게 자동 갱신이 없으면 경고 글 (경고색)", () => {
    const r = render(<WidgetRefreshView summary={summary({ stale: true })} now={T("11:00")} onOpenBattery={() => undefined} />);
    expect(r.text()).toContain("장중인데 1시간 넘게 자동 갱신이 없었습니다");
  });

  it("기록을 아직 읽지 못했으면 '확인 중', 안드로이드가 아니면 배터리 버튼 없음", () => {
    expect(render(<WidgetRefreshView summary={null} now={T("11:00")} onOpenBattery={() => undefined} />).text()).toContain("확인 중");
    h.os = "ios";
    expect(render(<WidgetRefreshView summary={summary()} now={T("11:00")} onOpenBattery={() => undefined} />).has("배터리 설정 열기")).toBe(false);
  });

  it("버튼: 배터리 최적화 설정 화면 → 안 열리면 이 앱 설정 화면", async () => {
    await openBatterySettings();
    expect(h.sendIntent).toHaveBeenCalledWith("android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS");
    expect(h.openSettings).not.toHaveBeenCalled();
    h.sendIntent.mockImplementation(async () => {
      throw new Error("No Activity found");
    });
    await openBatterySettings();
    expect(h.openSettings).toHaveBeenCalledTimes(1);
  });
});
