import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 설정 > 앱 업데이트 확인 (2026-09-24 점검 U1).
 * 새 버전 정보(release.json, APK)와 화면 업데이트(OTA) 중 확인하지 못한 것이 있으면 "최신"이라고 하지 않는다.
 */
const ota = vi.hoisted(() => ({
  enabled: true,
  check: async (): Promise<{ isAvailable: boolean; isRollBackToEmbedded?: boolean; reason?: string }> => ({ isAvailable: false, reason: "noUpdateAvailableOnServer" }),
  fetch: async (): Promise<{ isNew: boolean; isRollBackToEmbedded?: boolean; manifest?: { id: string } | null }> => ({ isNew: true, manifest: { id: "ota-1" } }),
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
  ota.check = async () => ({ isAvailable: false, reason: "noUpdateAvailableOnServer" });
  ota.fetch = async () => ({ isNew: true, manifest: { id: "ota-1" } });
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

  it("업데이트 비활성은 개발 빌드로 단정하거나 최신으로 표시하지 않는다", async () => {
    ota.enabled = false;
    const ok = await checkForAppUpdate();
    expect(ok).toMatchObject({ kind: "unknown", checked: ["apk"] });
    expect(updateStatus(ok).badge?.tone).not.toBe("good");
    expect(updateStatus(ok).message).not.toContain("개발 빌드");

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
    ota.fetch = async () => ({ isNew: true, manifest: { id: "ota-2" } });
    const next = await checkForAppUpdate();
    expect(next).toEqual({ kind: "ota", updateId: "ota-2" });
    expect(updateStatus(next).badge).toBeNull();
  });

  it("확인 전에는 아무것도 표시하지 않는다", () => expect(updateStatus(null)).toEqual({ badge: null, message: null, failed: false }));
});

describe("업데이트 예외 판정 재현", () => {
  it("더 높은 설치 버전인데 주소가 없으면 최신이 아니다", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ version: "1.4.0", apkUrl: null })));
    const r = await checkForAppUpdate();
    expect(r.kind).not.toBe("none");
    expect(updateStatus(r).badge?.tone).not.toBe("good");
  });
  it.each(["not-a-version", "1.4.0oops", "", "1..4", "999999999999999999999.0.0"])("잘못된 설치 버전 %s는 확인 실패", async version => {
    vi.stubGlobal("fetch", release(version));
    const r = await checkForAppUpdate();
    expect(r).toMatchObject({ kind: "unknown", checked: ["ota"] });
  });
  it("내장 버전 복구 지시를 내려받아 재시작 대기로 구분한다", async () => {
    ota.check = async () => ({ isAvailable: false, isRollBackToEmbedded: true });
    const fetch = vi.fn(async () => ({ isNew: false, isRollBackToEmbedded: true }));
    ota.fetch = fetch;
    const r = await checkForAppUpdate();
    expect(fetch).toHaveBeenCalledOnce();
    expect(r).toMatchObject({ kind: "ota", rollback: true });
  });
  it.each(["updatePreviouslyFailed", "rollbackNoEmbeddedConfiguration", "rollbackRejectedBySelectionPolicy", "futureUnknownReason"])("적용 실패·복구 불가·미지원 사유 %s는 최신이 아니다", async reason => {
    ota.check = async () => ({ isAvailable: false, reason });
    const r = await checkForAppUpdate();
    expect(r).toMatchObject({ kind: "unknown", checked: ["apk"] });
  });
  it("다운로드가 새 파일을 받지 못하면 준비 완료로 표시하지 않는다", async () => {
    ota.check = async () => ({ isAvailable: true });
    ota.fetch = async () => ({ isNew: false, isRollBackToEmbedded: false });
    const r = await checkForAppUpdate();
    expect(r).toMatchObject({ kind: "unknown", checked: ["apk"] });
  });
  it("새 파일 표시가 있어도 식별할 본문이 없으면 준비 완료가 아니다", async () => {
    ota.check = async () => ({ isAvailable: true });
    ota.fetch = async () => ({ isNew: true, manifest: null });
    expect(await checkForAppUpdate()).toMatchObject({ kind: "unknown", checked: ["apk"] });
  });
});

describe("확인 속도와 중복 보호", () => {
  it("설치 정보가 늦어도 OTA 확인을 바로 시작하며 같은 요청을 공유한다", async () => {
    let resolve!: (r: Response) => void;
    const request = vi.fn(() => new Promise<Response>(r => { resolve = r; }));
    const check = vi.fn(async () => ({ isAvailable: false, reason: "noUpdateAvailableOnServer" }));
    vi.stubGlobal("fetch", request); ota.check = check;
    const first = checkForAppUpdate(), second = checkForAppUpdate();
    expect(check).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledOnce();
    resolve(new Response(JSON.stringify({ version: "1.3.0" })));
    expect(await first).toMatchObject({ kind: "none" });
    expect(await second).toMatchObject({ kind: "none" });
    await checkForAppUpdate({ loadRelease: async () => ({ version: "1.3.0", apkUrl: null, notes: null, publishedAt: null }) });
    expect(check).toHaveBeenCalledTimes(2);
  });
  it("새 APK 안내는 느린 OTA 확인을 기다리지 않고 해당 OTA를 다운로드하지 않는다", async () => {
    let done!: (x: {isAvailable: boolean}) => void;
    ota.check = () => new Promise(r => { done = r; });
    const fetch = vi.fn(async () => ({ isNew: true, manifest: { id: "old-runtime" } })); ota.fetch = fetch;
    vi.stubGlobal("fetch", release("1.4.0"));
    expect(await checkForAppUpdate()).toMatchObject({ kind: "apk" });
    expect(fetch).not.toHaveBeenCalled();
    done({isAvailable: true});
  });
  it("선택 정책상 같은 버전 또는 대상 아님을 실패나 최신으로 단정하지 않는다", async () => {
    ota.check = async () => ({ isAvailable: false, reason: "updateRejectedBySelectionPolicy" });
    const r = await checkForAppUpdate();
    expect(r).toMatchObject({ kind: "not-applicable" });
    expect(updateStatus(r).message).toContain("추가로 적용할 업데이트가 없습니다");
    expect(updateStatus(r).badge?.text).not.toBe("최신");
  });
  it("다운로드 단계를 알리고 실패 뒤 다음 확인을 막지 않는다", async () => {
    ota.check = async () => ({ isAvailable: true }); ota.fetch = otaFails;
    const onPhase = vi.fn();
    expect(await checkForAppUpdate({ onPhase })).toMatchObject({ kind: "unknown" });
    expect(onPhase.mock.calls.map(x => x[0])).toEqual(["checking", "downloading"]);
    ota.fetch = async () => ({ isNew: true, manifest: { id: "recovered" } });
    expect(await checkForAppUpdate()).toEqual({ kind: "ota", updateId: "recovered" });
  });
});
