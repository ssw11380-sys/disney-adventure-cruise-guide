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

/** 확인하는 두 갈래: 새 버전 정보(release.json → APK), 화면 업데이트(OTA) */
export type UpdateSource = "apk" | "ota";

export type UpdateCheckResult =
  | { kind: "apk"; release: ReleaseInfo } // 새 APK 를 설치해야 하는 업데이트
  | { kind: "apk-unavailable"; release: ReleaseInfo }
  | { kind: "ota"; updateId: string | null; rollback?: boolean } // 이미 내려받았고 재시작만 하면 되는 업데이트
  | { kind: "none"; warnings: string[] }
  | { kind: "not-applicable"; warnings: string[] } // 이미 적용됐거나 선택 정책상 대상이 아님. 최신이라고 단정하지 않는다.
  | { kind: "unknown"; checked: UpdateSource[]; warnings: string[] }; // 확인에 실패한 갈래가 있어 최신인지 모른다 (checked: 확인된 갈래, 실패 까닭은 warnings 에)

export const currentVersion: string = Constants.expoConfig?.version ?? "0.0.0";

function validVersion(value: unknown): value is string {
  return typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value) && value.split(".").every(n => Number.isSafeInteger(Number(n)));
}

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
    if (!res.ok) throw new Error(res.status === 404 ? "새 버전 정보를 찾지 못했습니다" : `새 버전 정보를 받지 못했습니다 (${res.status})`);
    const j = (await res.json()) as Partial<ReleaseInfo> | null;
    if (!j || !validVersion(j.version)) throw new Error("새 버전 정보가 올바르지 않습니다");
    let apkUrl: string | null = null;
    if (typeof j.apkUrl === "string") {
      try { const url = new URL(j.apkUrl); if (url.protocol === "https:" && !url.username && !url.password) apkUrl = url.href; } catch { /* 잘못된 주소로 설치를 안내하지 않는다. */ }
    }
    return { version: j.version, apkUrl, notes: typeof j.notes === "string" ? j.notes : null,
      publishedAt: typeof j.publishedAt === "string" && Number.isFinite(Date.parse(j.publishedAt)) ? j.publishedAt : null };
  } finally {
    clearTimeout(timer);
  }
}

export type UpdateCheckPhase = "checking" | "downloading";
type CheckOptions = { loadRelease?: () => Promise<ReleaseInfo>; onPhase?: (phase: UpdateCheckPhase) => void };
let checking: Promise<UpdateCheckResult> | null = null;
let phase: UpdateCheckPhase = "checking";
const phaseListeners = new Set<(phase: UpdateCheckPhase) => void>();
function emitPhase(next: UpdateCheckPhase): void {
  phase = next;
  for (const listener of phaseListeners) listener(next);
}

/** 설치 파일·화면 업데이트를 병렬 확인하고, 같은 실행 중 요청은 공유한다. 새 설치 파일 안내가 다운로드보다 우선이다. */
export function checkForAppUpdate(options: CheckOptions = {}): Promise<UpdateCheckResult> {
  if (options.onPhase) { phaseListeners.add(options.onPhase); options.onPhase(checking ? phase : "checking"); }
  if (!checking) {
    phase = "checking";
    checking = performCheck(options.loadRelease ?? fetchRelease).finally(() => { checking = null; phaseListeners.clear(); });
  }
  return checking;
}

async function performCheck(loadRelease: () => Promise<ReleaseInfo>): Promise<UpdateCheckResult> {
  const warnings: string[] = [];
  const checked: UpdateSource[] = [];
  // 거부 처리도 즉시 연결한다. 새 APK가 있으면 느린 OTA 확인을 기다리지 않고 안내한다.
  const apkPending = Promise.allSettled([loadRelease()]);
  const otaPending = Promise.allSettled([Updates.isEnabled ? Updates.checkForUpdateAsync()
    : Promise.reject(new Error("화면 업데이트 기능을 사용할 수 없습니다. 앱을 완전히 닫았다가 다시 확인해 주세요."))]);
  const [apk] = await apkPending;
  if (apk.status === "fulfilled") {
    const release = apk.value;
    if (compareVersions(release.version, currentVersion) > 0) return { kind: release.apkUrl ? "apk" : "apk-unavailable", release };
    checked.push("apk");
  } else warnings.push(`새 버전 정보 확인 실패: ${errorMessage(apk.reason)}`);
  try {
    const [ota] = await otaPending;
    if (ota.status === "rejected") throw ota.reason;
    const check = ota.value;
    if (check.isAvailable || check.isRollBackToEmbedded) {
      emitPhase("downloading");
      const fetched = await Updates.fetchUpdateAsync();
      if (fetched.isRollBackToEmbedded) return { kind: "ota", updateId: null, rollback: true };
      if (fetched.isNew && fetched.manifest && "id" in fetched.manifest && typeof fetched.manifest.id === "string" && fetched.manifest.id) {
        return { kind: "ota", updateId: fetched.manifest.id };
      }
      throw new Error("적용할 새 파일을 확보하지 못했습니다. 다시 확인해 주세요.");
    }
    // 같은 버전도 이 사유로 반환된다. 원문이 없는 경우 최신 여부까지 확대 판정하지 않는다.
    if (check.reason === "updateRejectedBySelectionPolicy") {
      return checked.includes("apk") ? { kind: "not-applicable", warnings } : { kind: "unknown", checked, warnings: [...warnings, "현재 기기에 적용할 새 화면 업데이트가 없습니다."] };
    }
    if (check.reason !== "noUpdateAvailableOnServer") {
      const reason = check.reason === "updatePreviouslyFailed" ? "새 업데이트가 이 기기에서 실행에 실패해 적용되지 않았습니다. 수정된 업데이트가 필요합니다."
        : check.reason === "rollbackNoEmbeddedConfiguration" || check.reason === "rollbackRejectedBySelectionPolicy" ? "복구 업데이트를 적용할 수 없습니다. 설치 버전과 배포 상태 확인이 필요합니다."
          : "화면 업데이트의 적용 가능 여부를 확인하지 못했습니다. 다시 확인해 주세요.";
      throw new Error(reason);
    }
    checked.push("ota");
  } catch (e) {
    warnings.push(`OTA 확인 실패: ${errorMessage(e)}`);
  }
  return checked.length === 2 ? { kind: "none", warnings } : { kind: "unknown", checked, warnings };
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "인터넷 연결과 배포 상태를 확인해 주세요."; }

export interface UpdateStatus {
  /** 제목 옆 배지. 녹색 "최신"은 확인할 갈래를 모두 확인했을 때만 */
  badge: { text: string; tone: "good" | "neutral" | "bad" } | null;
  /** 확인 버튼 아래 한 줄 */
  message: string | null;
  /** 아무것도 확인하지 못함 → 오류 색 */
  failed: boolean;
}

/** 업데이트 확인 결과를 화면 글자로. 새 APK·OTA 는 카드가 따로 그린다 */
export function updateStatus(r: UpdateCheckResult | null): UpdateStatus {
  if (!r || r.kind === "apk" || r.kind === "ota") return { badge: null, message: null, failed: false };
  if (r.kind === "apk-unavailable") return { badge: { text: "설치 확인 필요", tone: "neutral" }, message: `새 설치 버전 ${r.release.version}이 있지만 다운로드 주소를 확인하지 못했습니다. 잠시 뒤 다시 확인해 주세요.`, failed: false };
  if (r.kind === "not-applicable") return { badge: { text: "확인 완료", tone: "neutral" }, message: "현재 기기에 추가로 적용할 업데이트가 없습니다.", failed: false };
  const why = r.warnings.length ? ` (${r.warnings.join(" / ")})` : "";
  if (r.kind === "none") return { badge: { text: "최신", tone: "good" }, message: `최신 버전입니다.${why}`, failed: false };
  if (r.checked.includes("apk")) return { badge: { text: "일부 확인", tone: "neutral" }, message: `새 설치 파일은 없습니다. 화면 업데이트는 확인하지 못했습니다.${why}`, failed: false };
  if (r.checked.includes("ota")) return { badge: { text: "일부 확인", tone: "neutral" }, message: `화면 업데이트는 없습니다. 새 설치 파일은 확인하지 못했습니다.${why}`, failed: false };
  return { badge: { text: "확인 실패", tone: "bad" }, message: `업데이트를 확인하지 못했습니다. 인터넷 연결을 확인한 뒤 다시 눌러 주세요.${why}`, failed: true };
}

export function describeRunningUpdate(): { channel: string; updateId: string; createdAt: string | null } {
  return {
    channel: Updates.channel ?? (Updates.isEnabled ? "기본" : "업데이트 기능 비활성"),
    updateId: Updates.isEmbeddedLaunch || !Updates.updateId ? "내장 번들" : Updates.updateId.slice(0, 8),
    createdAt: Updates.createdAt ? Updates.createdAt.toISOString() : null,
  };
}

let restarting: Promise<void> | null = null;
export function applyOtaUpdate(): Promise<void> {
  restarting ??= Updates.reloadAsync().finally(() => { restarting = null; });
  return restarting;
}
