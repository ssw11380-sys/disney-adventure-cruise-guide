import Constants from "expo-constants";
import * as Updates from "expo-updates";

/**
 * 앱 업데이트는 두 갈래다.
 *  1) OTA (EAS Update): JS/화면만 바뀐 경우. expo-updates 가 받아서 재시작하면 끝. 앱 재설치 불필요.
 *  2) 새 APK: 네이티브 모듈이 바뀌거나 버전이 올라간 경우. 저장소의 release.json 에 새 버전과 APK 주소를 적어 두면
 *     앱이 그 파일을 읽어 "새 버전 설치" 버튼을 보여준다. 스토어 없이 배포하는 앱이라 이 방식이 가장 단순하다.
 */

export const RELEASE_URL = "https://raw.githubusercontent.com/ssw11380-sys/disney-adventure-cruise-guide/main/stock-briefing/release.json";

export interface ReleaseInfo {
  version: string; // 예: 1.2.0 (app.json 의 version 과 같은 체계)
  apkUrl: string | null;
  notes: string | null;
  publishedAt: string | null;
}

export type UpdateCheckResult =
  | { kind: "apk"; release: ReleaseInfo } // 새 APK 를 설치해야 하는 업데이트
  | { kind: "ota"; updateId: string | null } // 이미 내려받았고 재시작만 하면 되는 업데이트
  | { kind: "none"; warnings: string[] }; // 최신 (확인 못 한 항목은 warnings 에)

export const currentVersion: string = Constants.expoConfig?.version ?? "0.0.0";

/** "1.2.0" 과 "1.10.1" 을 숫자로 비교. a > b 면 양수 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((x) => parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export async function fetchRelease(timeoutMs = 8000): Promise<ReleaseInfo> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // GitHub raw 는 CDN 캐시가 있어 쿼리를 붙여 최신을 받는다
    const res = await fetch(`${RELEASE_URL}?t=${Date.now()}`, { signal: ctrl.signal, headers: { "cache-control": "no-cache" } });
    if (!res.ok) throw new Error(`release.json HTTP ${res.status}`);
    const j = (await res.json()) as Partial<ReleaseInfo>;
    if (typeof j.version !== "string") throw new Error("release.json 에 version 이 없습니다");
    return { version: j.version, apkUrl: typeof j.apkUrl === "string" && j.apkUrl ? j.apkUrl : null, notes: j.notes ?? null, publishedAt: j.publishedAt ?? null };
  } finally {
    clearTimeout(timer);
  }
}

/** APK(새 버전) → OTA 순으로 확인한다. 어느 한쪽이 실패해도 다른 쪽은 확인한다. */
export async function checkForAppUpdate(): Promise<UpdateCheckResult> {
  const warnings: string[] = [];
  try {
    const release = await fetchRelease();
    if (compareVersions(release.version, currentVersion) > 0 && release.apkUrl) return { kind: "apk", release };
  } catch (e) {
    warnings.push(`새 버전 정보 확인 실패: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!Updates.isEnabled) {
    warnings.push("개발 빌드라 OTA 업데이트는 확인하지 않습니다.");
    return { kind: "none", warnings };
  }
  try {
    const check = await Updates.checkForUpdateAsync();
    if (check.isAvailable) {
      const fetched = await Updates.fetchUpdateAsync();
      return { kind: "ota", updateId: fetched.manifest && "id" in fetched.manifest ? String(fetched.manifest.id) : null };
    }
  } catch (e) {
    warnings.push(`OTA 확인 실패: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { kind: "none", warnings };
}

export function describeRunningUpdate(): { channel: string; updateId: string; createdAt: string | null } {
  return {
    channel: Updates.channel ?? (Updates.isEnabled ? "기본" : "없음 (개발 빌드)"),
    updateId: Updates.isEmbeddedLaunch || !Updates.updateId ? "내장 번들" : Updates.updateId.slice(0, 8),
    createdAt: Updates.createdAt ? Updates.createdAt.toISOString() : null,
  };
}

export async function applyOtaUpdate(): Promise<void> {
  await Updates.reloadAsync();
}
