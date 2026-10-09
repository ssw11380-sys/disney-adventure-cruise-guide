import AsyncStorage from "@react-native-async-storage/async-storage";
import { defaultApiUrl, STORAGE_KEYS } from "@/lib/settings";
import { assertSessionIdentity, backgroundSessionFor, personalBlocked, sessionFor, sessionIdentityVersion } from "@/lib/session";
import type { PnlMode } from "./model";

export interface WidgetPreferences {
  pnlMode: PnlMode;
  sort: "value" | "name";
  pinnedCodes: string[];
  showMarketLine: boolean;
}
export const WIDGET_PREF_PREFIX = "widget.preferences.v1.";
export const defaultWidgetPreferences = (pnlMode: PnlMode = "cumulative"): WidgetPreferences => ({ pnlMode, sort: "value", pinnedCodes: [], showMarketLine: false });
export interface WidgetPreferenceScope { apiUrl: string; owner: number | null; identity: number }
/** 저장장치 오류와 달리 계정·서버 경계 변경은 기본값으로 대체해 이전 그림을 표시하지 않는다. */
export class WidgetPreferenceScopeError extends Error {
  constructor(message = "계정이나 서버가 바뀌었습니다. 화면을 다시 열어 주세요.") {
    super(message);
    this.name = "WidgetPreferenceScopeError";
  }
}

/** 토큰 없이 서버·계정으로 구분한다. 기억하지 않는 로그인과 비주인 계정은 개인 설정을 남기지 않는다. */
export async function widgetPreferenceScope(): Promise<WidgetPreferenceScope> {
  const identity = sessionIdentityVersion();
  const apiUrl = (await AsyncStorage.getItem(STORAGE_KEYS.apiUrl)) || defaultApiUrl();
  const session = await backgroundSessionFor(apiUrl);
  assertSessionIdentity(identity);
  if (session.kind === "memory" || personalBlocked(apiUrl)) throw new Error("로그인 상태를 확인한 뒤 위젯을 설정해 주세요.");
  return { apiUrl, owner: sessionFor(apiUrl)?.user.id ?? null, identity };
}
function keyFor(id: number, scope: WidgetPreferenceScope): string {
  if (!Number.isSafeInteger(id) || id < 0) throw new Error("위젯 번호를 확인할 수 없습니다.");
  return `${WIDGET_PREF_PREFIX}${id}.${encodeURIComponent(scope.apiUrl)}.${scope.owner ?? "legacy"}`;
}
export async function assertWidgetPreferenceScope(scope: WidgetPreferenceScope): Promise<void> {
  assertSessionIdentity(scope.identity);
  const current = await widgetPreferenceScope();
  if (current.apiUrl !== scope.apiUrl || current.owner !== scope.owner) throw new WidgetPreferenceScopeError();
}
export function parseWidgetPreferences(raw: string | null, fallback: PnlMode): WidgetPreferences {
  if (!raw) return defaultWidgetPreferences(fallback);
  const value = JSON.parse(raw) as Partial<WidgetPreferences>;
  if (!value || (value.pnlMode !== "day" && value.pnlMode !== "cumulative") || (value.sort !== "value" && value.sort !== "name") || typeof value.showMarketLine !== "boolean" || !Array.isArray(value.pinnedCodes)) throw new Error("저장된 위젯 설정을 읽지 못했습니다.");
  return { pnlMode: value.pnlMode, sort: value.sort, showMarketLine: value.showMarketLine,
    pinnedCodes: [...new Set(value.pinnedCodes.filter((x): x is string => typeof x === "string" && /^[A-Z0-9][A-Z0-9.\-]{0,19}$/.test(x)))].slice(0, 20) };
}
/** 같은 위젯 저장·삭제는 직렬로 마쳐 늦은 쓰기가 삭제 뒤 되살아나지 않게 한다. */
const writes = new Map<number, Promise<unknown>>();
const deleted = new Set<number>();
function serial<T>(id: number, action: () => Promise<T>): Promise<T> {
  const previous = writes.get(id);
  const result = previous ? previous.then(action, action) : action();
  const tail = result.catch(() => undefined);
  writes.set(id, tail);
  void tail.then(() => { if (writes.get(id) === tail) writes.delete(id); });
  return result;
}
export async function readWidgetPreferences(id: number, fallback: PnlMode, scope?: WidgetPreferenceScope): Promise<WidgetPreferences> {
  const owner = scope ?? await widgetPreferenceScope();
  if (deleted.has(id)) return defaultWidgetPreferences(fallback);
  const raw = await AsyncStorage.getItem(keyFor(id, owner));
  await assertWidgetPreferenceScope(owner);
  return deleted.has(id) ? defaultWidgetPreferences(fallback) : parseWidgetPreferences(raw, fallback);
}
export async function saveWidgetPreferences(id: number, value: WidgetPreferences, scope?: WidgetPreferenceScope): Promise<void> {
  const owner = scope ?? await widgetPreferenceScope();
  const clean = parseWidgetPreferences(JSON.stringify(value), value.pnlMode);
  await serial(id, async () => {
    await assertWidgetPreferenceScope(owner);
    if (deleted.has(id)) throw new Error("삭제된 위젯입니다. 홈 화면의 위젯을 다시 선택해 주세요.");
    await AsyncStorage.setItem(keyFor(id, owner), JSON.stringify(clean));
    await assertWidgetPreferenceScope(owner);
  });
}
/** 손익 클릭처럼 일부만 바꾸는 작업은 최신 설정을 같은 쓰기 큐 안에서 읽는다. 고정 종목·정렬 변경을 되돌리지 않는다. */
export async function updateWidgetPreferences(id: number, change: (current: WidgetPreferences) => WidgetPreferences, fallback: PnlMode, scope?: WidgetPreferenceScope): Promise<WidgetPreferences> {
  const owner = scope ?? await widgetPreferenceScope();
  return serial(id, async () => {
    await assertWidgetPreferenceScope(owner);
    if (deleted.has(id)) throw new Error("삭제된 위젯입니다.");
    const current = parseWidgetPreferences(await AsyncStorage.getItem(keyFor(id, owner)), fallback);
    await assertWidgetPreferenceScope(owner);
    const next = parseWidgetPreferences(JSON.stringify(change(current)), fallback);
    await AsyncStorage.setItem(keyFor(id, owner), JSON.stringify(next));
    await assertWidgetPreferenceScope(owner);
    return next;
  });
}
export async function deleteWidgetPreferences(id: number): Promise<void> {
  deleted.add(id);
  await serial(id, async () => {
    const prefix = `${WIDGET_PREF_PREFIX}${id}.`;
    const keys = (await AsyncStorage.getAllKeys()).filter((key) => key.startsWith(prefix));
    if (keys.length) await AsyncStorage.multiRemove(keys);
  });
}
