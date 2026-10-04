import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupRenders, render } from "./miniRender";

const h = vi.hoisted(() => ({ openURL: vi.fn(), alert: vi.fn(), check: vi.fn(), refetch: vi.fn(), apply: vi.fn(), showNewApk: true }));
const release = { version: "1.6.0", apkUrl: "https://example.test/app.apk", notes: null, publishedAt: null };
vi.mock("react-native", () => ({ View: "View", Text: "Text", Pressable: "Pressable", Alert: { alert: h.alert }, Linking: { openURL: h.openURL }, Share: { share: vi.fn() } }));
vi.mock("@/theme", async () => { const t = await import("@/tokens"); return { ...t, useTheme: () => t.dark }; });
vi.mock("@/components/ui", () => ({ Badge: "Badge", Button: "Button", Card: "Card", Muted: "Muted", Row: "Row", SectionTitle: "SectionTitle" }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: h.showNewApk ? release : null, refetch: h.refetch }), useQueryClient: () => ({ invalidateQueries: vi.fn(), fetchQuery: vi.fn() }), useMutation: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock("expo-updates", () => ({ useUpdates: () => ({ isChecking: false, isDownloading: false, isRestarting: false, isUpdatePending: false, currentlyRunning: { updateId: "현재" } }) }));
vi.mock("@/lib/appUpdate", () => ({
  applyOtaUpdate: h.apply, checkForAppUpdate: h.check, compareVersions: () => 1, currentVersion: "1.5.0", describeRunningUpdate: () => ({ createdAt: null, updateId: "내장 번들" }),
  fetchRelease: vi.fn(), updateStatus: () => ({ badge: null, message: null, failed: false }),
}));
vi.mock("@/api/hooks", () => ({ useApi: () => ({ importTossHoldings: vi.fn() }), useFeature: () => false, useTossStatus: () => ({ data: { configured: false, outboundIp: null }, refetch: h.refetch, isError: false }) }));
vi.mock("@/lib/settings", () => ({ useSettings: () => ({ apiUrl: "https://example.test" }) }));

const { AppUpdateCard } = await import("@/components/AppUpdateCard");
const { TossOpenApiCard } = await import("@/components/TossOpenApiCard");
type Path = "APK 카드" | "APK 확인창" | "토스 WTS";
const paths: Path[] = ["APK 카드", "APK 확인창", "토스 WTS"];
async function linkPress(path: Path): Promise<() => void> {
  if (path === "토스 WTS") {
    const r = render(<TossOpenApiCard />);
    const link = r.all().find((n) => n.props.accessibilityLabel === "토스증권 WTS 열기")!;
    return link.props.onPress as () => void;
  }
  const r = render(<AppUpdateCard />);
  if (path === "APK 카드") return r.all().find((n) => n.props.title === "새 버전 1.6.0 설치 (APK)")!.props.onPress as () => void;
  (r.all().find((n) => n.props.title === "업데이트 확인")!.props.onPress as () => void)();
  await Promise.resolve(); await Promise.resolve();
  const buttons = h.alert.mock.calls[0]![2] as { text: string; onPress?: () => void }[];
  const press = buttons.find((button) => button.text === "다운로드")!.onPress!;
  h.alert.mockClear();
  return press;
}
beforeEach(() => { h.showNewApk = true; h.openURL.mockReset(); h.alert.mockReset(); h.check.mockReset(); h.refetch.mockReset(); h.apply.mockReset(); h.check.mockResolvedValue({ kind: "apk", release }); });
afterEach(cleanupRenders);

describe("2차 설정 화면 외부 링크 검증", () => {
  it.each(paths)("%s는 정상 링크를 추가 대기 없이 즉시 한 번만 연다", async (path) => {
    h.openURL.mockResolvedValue(undefined);
    const press = await linkPress(path);
    press();
    expect(h.openURL).toHaveBeenCalledExactlyOnceWith(path === "토스 WTS" ? "https://tossinvest.com" : release.apkUrl);
    await Promise.resolve();
    expect(h.alert).not.toHaveBeenCalled();
  });

  it.each(paths)("%s의 기기 거부를 용도에 맞게 안내하고 사용자 재시도는 한 번만 더 연다", async (path) => {
    const failure = Promise.reject(new Error("검증용 브라우저 거부 https://example.test/private?secret=hidden"));
    // 수정 전 미처리 거부는 시험 Promise에서 회수하며 실제 화면의 안내 유무를 검사한다.
    void failure.catch(() => {});
    h.openURL.mockReturnValueOnce(failure).mockResolvedValueOnce(undefined);
    const press = await linkPress(path);
    press();
    await Promise.resolve(); await Promise.resolve();
    expect(h.openURL).toHaveBeenCalledOnce();
    expect(h.alert).toHaveBeenCalledExactlyOnceWith(
      path === "토스 WTS" ? "토스증권 WTS를 열지 못했습니다" : "설치 파일을 열지 못했습니다",
      path === "토스 WTS" ? "브라우저 연결을 확인한 뒤 다시 눌러 주세요." : "브라우저 연결을 확인한 뒤 다운로드를 다시 눌러 주세요.",
    );
    press();
    await Promise.resolve();
    expect(h.openURL).toHaveBeenCalledTimes(2);
    expect(h.alert).toHaveBeenCalledOnce();
  });
});

async function otaPress(path: "OTA 카드" | "OTA 확인창"): Promise<() => void> {
  h.showNewApk = false;
  h.check.mockResolvedValue({ kind: "ota", updateId: "검증용-업데이트" });
  const r = render(<AppUpdateCard />);
  r.act(() => (r.all().find((n) => n.props.title === "업데이트 확인")!.props.onPress as () => void)());
  await Promise.resolve(); await Promise.resolve();
  r.act(() => {});
  const buttons = h.alert.mock.calls[0]![2] as { text: string; onPress?: () => void }[];
  const press = path === "OTA 확인창"
    ? buttons.find((button) => button.text === "지금 다시 시작")!.onPress!
    : r.all().find((n) => n.props.title === "지금 다시 시작해서 적용")!.props.onPress as () => void;
  h.alert.mockClear();
  return press;
}

describe("2차 업데이트 적용 실패 검증", () => {
  it.each(["OTA 카드", "OTA 확인창"] as const)("%s: 정상 재시작을 지연이나 중복 없이 한 번 요청한다", async (path) => {
    h.apply.mockResolvedValue(undefined);
    const press = await otaPress(path);
    press();
    expect(h.apply).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(h.alert).not.toHaveBeenCalled();
  });

  it.each(["OTA 카드", "OTA 확인창"] as const)("%s: 재시작 거부를 안내하고 자동 재시도 없이 사용자 선택을 기다린다", async (path) => {
    const failure = Promise.reject(new Error("검증용 재시작 거부"));
    void failure.catch(() => {});
    h.apply.mockReturnValueOnce(failure).mockResolvedValueOnce(undefined);
    const press = await otaPress(path);
    press();
    await Promise.resolve(); await Promise.resolve();
    expect(h.apply).toHaveBeenCalledOnce();
    expect(h.alert).toHaveBeenCalledExactlyOnceWith("앱을 다시 시작하지 못했습니다", "잠시 뒤 다시 눌러 주세요. 계속 안 되면 앱을 완전히 닫았다가 다시 열어 주세요.");
    expect(h.check).toHaveBeenCalledOnce();
    press();
    await Promise.resolve();
    expect(h.apply).toHaveBeenCalledTimes(2);
    expect(h.alert).toHaveBeenCalledOnce();
    expect(h.check).toHaveBeenCalledOnce();
  });
});
