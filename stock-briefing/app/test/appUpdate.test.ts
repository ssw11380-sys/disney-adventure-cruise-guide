import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 설정 > 앱 업데이트 확인 (2026-09-24 점검 U1).
 * 새 버전 정보(release.json, APK)와 화면 업데이트(OTA) 중 확인하지 못한 것이 있으면 "최신"이라고 하지 않는다.
 */
const ota = vi.hoisted(() => ({
  enabled: true,
  check: async (): Promise<{ isAvailable: boolean }> => ({ isAvailable: false }),
  fetch: async (): Promise<{ manifest: { id: string } | null }> => ({ manifest: { id: "ota-1" } }),
}));
vi.mock("expo-updates", () => ({
  get isEnabled() {
    return ota.enabled;
  },
  checkForUpdateAsync: () => ota.check(),
  fetchUpdateAsync: () => ota.fetch(),
}));
vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "1.3.0" } } }));

const { checkForAppUpdate, updateStatus } = await import("@/lib/appUpdate");

const release = (version: string) => async () =>
  new Response(JSON.stringify({ version, apkUrl: `https://example.test/app-${version}.apk`, notes: null, publishedAt: null }), { status: 200 });
const offline = async () => {
  throw new TypeError("Network request failed");
};
const otaFails = async () => {
  throw new Error("offline");
};

beforeEach(() => {
  ota.enabled = true;
  ota.check = async () => ({ isAvailable: false });
  ota.fetch = async () => ({ manifest: { id: "ota-1" } });
  vi.stubGlobal("fetch", release("1.3.0"));
});

describe("업데이트 확인 결과 (U1)", () => {
  it("APK·OTA 모두 확인 + 새 것 없음 → 최신 (녹색)", async () => {
    const r = await checkForAppUpdate();
    expect(r).toEqual({ kind: "none", warnings: [] });
    expect(updateStatus(r)).toEqual({ badge: { text: "최신", tone: "good" }, message: "최신 버전입니다.", failed: false });
  });

  it("둘 다 실패(인터넷 없음) → 확인 실패, 녹색 최신이 아니다", async () => {
    vi.stubGlobal("fetch", offline);
    ota.check = otaFails;
    const r = await checkForAppUpdate();
    expect(r.kind).toBe("unknown");
    expect(r).toMatchObject({ checked: [] });
    const s = updateStatus(r);
    expect(s.badge).toEqual({ text: "확인 실패", tone: "bad" });
    expect(s.failed).toBe(true);
    expect(s.message).toContain("업데이트를 확인하지 못했습니다");
    expect(s.message).not.toContain("최신");
    // 실패 까닭은 그대로 붙인다
    expect(s.message).toContain("새 버전 정보 확인 실패");
    expect(s.message).toContain("OTA 확인 실패: offline");
  });

  it("APK 확인만 성공, OTA 실패 → 일부 확인 (녹색 아님)", async () => {
    ota.check = otaFails;
    const r = await checkForAppUpdate();
    expect(r).toMatchObject({ kind: "unknown", checked: ["apk"] });
    const s = updateStatus(r);
    expect(s.badge).toEqual({ text: "일부 확인", tone: "neutral" });
    expect(s.failed).toBe(false);
    expect(s.message).toContain("새 설치 파일은 없습니다");
    expect(s.message).toContain("화면 업데이트는 확인하지 못했습니다");
  });

  it("OTA 확인만 성공, APK(새 버전 정보) 실패 → 일부 확인 (녹색 아님)", async () => {
    vi.stubGlobal("fetch", async () => new Response("", { status: 503 }));
    const r = await checkForAppUpdate();
    expect(r).toMatchObject({ kind: "unknown", checked: ["ota"] });
    const s = updateStatus(r);
    expect(s.badge).toEqual({ text: "일부 확인", tone: "neutral" });
    expect(s.message).toContain("화면 업데이트는 없습니다");
    expect(s.message).toContain("새 설치 파일은 확인하지 못했습니다");
    expect(s.message).toContain("(503)");
  });

  it("OTA 를 받는 중 실패해도 확인 못 한 것으로 본다", async () => {
    ota.check = async () => ({ isAvailable: true });
    ota.fetch = otaFails;
    const r = await checkForAppUpdate();
    expect(r).toMatchObject({ kind: "unknown", checked: ["apk"] });
  });

  it("개발 빌드(OTA 없음): APK 확인이 되면 최신, 안 되면 확인 실패", async () => {
    ota.enabled = false;
    const ok = await checkForAppUpdate();
    expect(ok).toEqual({ kind: "none", warnings: ["개발 빌드라 OTA 업데이트는 확인하지 않습니다."] });
    expect(updateStatus(ok).badge?.tone).toBe("good");

    vi.stubGlobal("fetch", offline);
    const bad = await checkForAppUpdate();
    expect(bad).toMatchObject({ kind: "unknown", checked: [] });
    expect(updateStatus(bad).badge).toEqual({ text: "확인 실패", tone: "bad" });
  });

  it("새 APK·OTA 가 있으면 그대로 알린다 (최신·실패 배지 없음)", async () => {
    vi.stubGlobal("fetch", release("1.4.0"));
    const apk = await checkForAppUpdate();
    expect(apk).toMatchObject({ kind: "apk", release: { version: "1.4.0" } });
    expect(updateStatus(apk)).toEqual({ badge: null, message: null, failed: false });

    vi.stubGlobal("fetch", offline);
    ota.check = async () => ({ isAvailable: true });
    ota.fetch = async () => ({ manifest: { id: "ota-2" } });
    const next = await checkForAppUpdate();
    expect(next).toEqual({ kind: "ota", updateId: "ota-2" });
    expect(updateStatus(next).badge).toBeNull();
  });

  it("확인 전에는 아무것도 표시하지 않는다", () => expect(updateStatus(null)).toEqual({ badge: null, message: null, failed: false }));
});
