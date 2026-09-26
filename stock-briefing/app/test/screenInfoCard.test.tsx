import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "./miniRender";

/**
 * 설정 > 화면 정보 카드. 접힌 채로 시작하고, 펴면 지금 창·화면 값을 보여 주며, 폰을 접거나 펴면(크기 변경) 바로 바뀐다.
 * '공유'는 같은 값을 글로 넘긴다
 */
const h = vi.hoisted(() => ({
  win: { width: 411, height: 914, scale: 2.625, fontScale: 1 },
  screen: { width: 411, height: 914, scale: 2.625, fontScale: 1 },
  insets: { top: 32, bottom: 48, left: 0, right: 0 },
  listeners: [] as ((e: { window: unknown; screen: { width: number; height: number } }) => void)[],
  removed: 0,
  share: vi.fn(async (_c: { message: string; title?: string }) => ({ action: "sharedAction" })),
  alert: vi.fn(),
  /** 홈 화면 위젯 진단 줄 (widgets/diagnose.ts — 위젯 2차). null 이면 읽다 실패 */
  widgetLines: [] as string[] | null,
  /** 진단을 읽은 횟수 */
  widgetReads: 0,
  /** 서버 기능 플래그 (useFeature — 없으면 fallback) */
  flags: {} as Record<string, boolean>,
}));

vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 },
  Alert: { alert: h.alert },
  Share: { share: h.share },
  PixelRatio: { get: () => 2.625 },
  Dimensions: {
    get: () => h.screen,
    addEventListener: (_ev: string, cb: (typeof h.listeners)[number]) => {
      h.listeners.push(cb);
      return { remove: () => void h.removed++ };
    },
  },
  useWindowDimensions: () => h.win,
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => h.insets }));
vi.mock("@expo/vector-icons", () => ({ Ionicons: "Ionicons" }));
vi.mock("expo-device", () => ({ manufacturer: "samsung", modelName: "SM-F966N", osVersion: "16", platformApiLevel: 36 }));
vi.mock("@/lib/appUpdate", () => ({ currentVersion: "1.4.0", describeRunningUpdate: () => ({ channel: "기본", updateId: "내장 번들", createdAt: null }) }));
vi.mock("@/theme", async () => {
  const tokens = await import("@/tokens");
  return { ...tokens, useTheme: () => tokens.light };
});
vi.mock("@/components/ui", () => ({ Button: "Button", Card: "Card", Muted: "Muted", Row: "Row", SectionTitle: "SectionTitle" }));
vi.mock("@/api/hooks", () => ({ useFeature: (key: string, fallback = false) => h.flags[key] ?? fallback }));
vi.mock("@/widgets/diagnose", () => ({
  widgetReport: async () => {
    h.widgetReads++;
    if (h.widgetLines === null) throw new Error("위젯 모듈 없음");
    return h.widgetLines;
  },
}));

const { ScreenInfoCard } = await import("@/components/ScreenInfoCard");

type R = ReturnType<typeof render>;
/** 보이는 줄: 이름 → 값 */
const rows = (r: R) =>
  Object.fromEntries(
    r
      .all()
      .filter((n) => n.type === "Row")
      .map((n) => [n.props.label as string, (n.props.value as React.ReactElement<{ children: string }>).props.children]),
  );
const open = () => {
  const r = render(<ScreenInfoCard />);
  r.act(() => (r.byLabel("화면 정보").props.onPress as () => void)());
  return r;
};

beforeEach(() => {
  h.win = { width: 411, height: 914, scale: 2.625, fontScale: 1 };
  h.screen = { width: 411, height: 914, scale: 2.625, fontScale: 1 };
  h.insets = { top: 32, bottom: 48, left: 0, right: 0 };
  h.listeners.length = 0;
  h.removed = 0;
  h.share.mockClear();
  h.alert.mockClear();
  h.widgetLines = [];
  h.widgetReads = 0;
  h.flags = { widgetFoldFit: true };
});

describe("화면 정보 카드", () => {
  it("처음에는 접혀 있고 크기 변경도 듣지 않는다", () => {
    const r = render(<ScreenInfoCard />);
    expect(r.byLabel("화면 정보").props.accessibilityState).toEqual({ expanded: false });
    expect(Object.keys(rows(r))).toEqual([]);
    expect(h.listeners).toHaveLength(0);
  });

  it("펴면 모델·창 크기·밀도·글자 배율·방향·접힘 짐작·폭 등급·여백이 보인다", () => {
    const r = open();
    expect(r.byLabel("화면 정보").props.accessibilityState).toEqual({ expanded: true });
    const v = rows(r);
    expect(v["모델명"]).toBe("samsung SM-F966N");
    expect(v["앱 창 크기"]).toBe("411×914 dp");
    expect(v["화면 밀도"]).toBe("2.625 (약 420dpi)");
    expect(v["글자 배율"]).toBe("100%");
    expect(v["가로/세로"]).toBe("세로");
    expect(v["접힘/펼침"]).toMatch(/^접힘\(바깥 화면\)으로 추정/);
    expect(v["폭 등급"]).toBe("좁음 (600dp 미만)");
    expect(v["화면 여백"]).toBe("위 32 · 아래 48 · 왼쪽 0 · 오른쪽 0 dp");
    expect(r.text()).toMatch(/화면 폭으로 짐작합니다/);
  });

  it("폰을 펴면(창·화면 크기 변경) 숫자가 바로 바뀐다", () => {
    const r = open();
    expect(h.listeners).toHaveLength(1);
    // 펼침: 창 변경(useWindowDimensions) + 화면 변경(Dimensions change) 이 함께 온다
    h.win = { width: 832, height: 750, scale: 2.625, fontScale: 1.3 };
    h.insets = { top: 24, bottom: 0, left: 0, right: 48 };
    r.act(() => h.listeners[0]({ window: h.win, screen: { width: 832, height: 750 } }));
    const v = rows(r);
    expect(v["앱 창 크기"]).toBe("832×750 dp");
    expect(v["화면 전체 크기"]).toBe("832×750 dp · 2184×1969 픽셀");
    expect(v["가로/세로"]).toBe("가로");
    expect(v["접힘/펼침"]).toBe("펼침(안쪽 화면)으로 추정 · 짧은 변 750dp");
    expect(v["글자 배율"]).toBe("130%");
    expect(v["화면 여백"]).toBe("위 24 · 아래 0 · 왼쪽 0 · 오른쪽 48 dp");
  });

  it("다시 접으면(카드 닫기) 크기 변경 구독을 푼다", () => {
    const r = open();
    r.act(() => (r.byLabel("화면 정보").props.onPress as () => void)());
    expect(h.removed).toBe(1);
    expect(Object.keys(rows(r))).toEqual([]);
  });

  it("공유: 지금 값을 글로 넘긴다", async () => {
    const r = open();
    const btn = r.all().find((n) => n.type === "Button");
    expect(btn!.props.accessibilityLabel).toBe("화면 정보 공유");
    r.act(() => (btn!.props.onPress as () => void)());
    await vi.waitFor(() => expect(h.share).toHaveBeenCalledTimes(1));
    const { message, title } = h.share.mock.calls[0][0];
    expect(title).toBe("화면 정보");
    expect(message).toMatch(/^\[화면 정보\] \d{4}-\d{2}-\d{2} \d{2}:\d{2} 한국 시각 · 앱 1\.4\.0 \(내장 번들\)\n/);
    expect(message).toContain("\n모델명: samsung SM-F966N\n");
    expect(message).toContain("\n앱 창 크기: 411×914 dp\n");
    expect(message).toContain("\n안드로이드 버전: 16 (API 36)\n");
  });

  it("공유: 글 끝에 홈 화면 위젯 진단(위젯 번호·지금 크기·최근 받은 크기)을 붙이고, 못 읽으면 화면 값만 (위젯 2차)", async () => {
    h.widgetLines = ["[위젯] 잔고 1개 · 자산 0개 · 브리핑 0개 · 지수·환율 1개", "[위젯] 잔고 #12: 지금 476×611dp"];
    const r = open();
    r.act(() => (r.all().find((n) => n.type === "Button")!.props.onPress as () => void)());
    await vi.waitFor(() => expect(h.share).toHaveBeenCalledTimes(1));
    const message = h.share.mock.calls[0][0].message;
    expect(message.endsWith("짐작한 값입니다.\n[위젯] 잔고 1개 · 자산 0개 · 브리핑 0개 · 지수·환율 1개\n[위젯] 잔고 #12: 지금 476×611dp")).toBe(true);
    h.widgetLines = null;
    h.share.mockClear();
    r.act(() => (r.all().find((n) => n.type === "Button")!.props.onPress as () => void)());
    await vi.waitFor(() => expect(h.share).toHaveBeenCalledTimes(1));
    expect(h.share.mock.calls[0][0].message).toMatch(/짐작한 값입니다\.$/);
  });

  it("검증 지적: 플래그 widgetFoldFit 이 꺼져 있거나 모르면 위젯 진단을 읽지도 붙이지도 않는다 — 공유 글이 예전과 같다", async () => {
    h.widgetLines = ["[위젯] 잔고 1개 · 자산 0개 · 브리핑 0개 · 지수·환율 1개", "[위젯] 잔고 #12: 지금 476×611dp"];
    const { screenInfoText } = await import("@/lib/screenInfo");
    for (const flags of [{ widgetFoldFit: false }, {}] as Record<string, boolean>[]) {
      h.flags = flags;
      h.share.mockClear();
      const r = open();
      r.act(() => (r.all().find((n) => n.type === "Button")!.props.onPress as () => void)());
      await vi.waitFor(() => expect(h.share).toHaveBeenCalledTimes(1));
      const message = h.share.mock.calls[0][0].message;
      expect(message).not.toContain("[위젯]");
      expect(message).toMatch(/짐작한 값입니다\.$/);
      // 예전(위젯 진단 전)과 같은 글: 화면 값만 (시각 줄은 분 단위라 같은 시각에 만든 글과 견준다)
      const before = screenInfoText({
        window: { width: 411, height: 914 },
        screen: { width: 411, height: 914 },
        density: 2.625,
        fontScale: 1,
        insets: h.insets,
        manufacturer: "samsung",
        modelName: "SM-F966N",
        osVersion: "16",
        apiLevel: 36,
        appVersion: "1.4.0",
        build: "내장 번들",
      });
      expect(message.split("\n").slice(1)).toEqual(before.split("\n").slice(1));
    }
    expect(h.widgetReads).toBe(0);
  });

  it("공유 창을 못 열면 글을 알림으로 보여 준다", async () => {
    h.share.mockRejectedValueOnce(new Error("no activity"));
    const r = open();
    r.act(() => (r.all().find((n) => n.type === "Button")!.props.onPress as () => void)());
    await vi.waitFor(() => expect(h.alert).toHaveBeenCalledTimes(1));
    expect(h.alert.mock.calls[0][0]).toBe("화면 정보");
    expect(h.alert.mock.calls[0][1]).toMatch(/^\[화면 정보\]/);
  });
});
