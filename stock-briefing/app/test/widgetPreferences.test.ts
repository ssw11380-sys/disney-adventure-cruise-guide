import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ storage: new Map<string, string>(), failWrite: false, failRemove: false, holdRead: null as null | (() => Promise<void>), holdWrite: null as null | (() => Promise<void>) }));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: {
  getItem: async (key: string) => { if (key.startsWith("widget.preferences") && h.holdRead) await h.holdRead(); return h.storage.get(key) ?? null; },
  setItem: async (key: string, value: string) => { if (h.failWrite) throw new Error("disk"); if (h.holdWrite) await h.holdWrite(); h.storage.set(key, value); },
  removeItem: async (key: string) => { h.storage.delete(key); },
  getAllKeys: async () => [...h.storage.keys()],
  multiRemove: async (keys: string[]) => { if (h.failRemove) throw new Error("disk"); keys.forEach((key) => h.storage.delete(key)); },
} }));
vi.mock("@/lib/settings", () => ({ defaultApiUrl: () => "https://a.test", STORAGE_KEYS: { apiUrl: "settings.apiUrl" } }));
const { defaultWidgetPreferences, deleteWidgetPreferences, readWidgetPreferences, saveWidgetPreferences, updateWidgetPreferences, widgetPreferenceScope } = await import("@/widgets/preferences");
const { resetSessionForTests, saveSession, installSessionStorage } = await import("@/lib/session");
const storage = { getItem: async (key: string) => h.storage.get(key) ?? null, setItem: async (key: string, value: string) => { h.storage.set(key, value); }, removeItem: async (key: string) => { h.storage.delete(key); } };
const user = (id: number, isOwner = true) => ({ id, loginId: `user${id}`, email: null, isOwner, usingInitialPassword: false });
const login = (id: number, remember = true, isOwner = true) => saveSession({ apiUrl: "https://a.test", token: `session-test-${id}`, remember, user: user(id, isOwner) });
beforeEach(() => { h.storage.clear(); h.failWrite = false; h.failRemove = false; h.holdRead = null; h.holdWrite = null; resetSessionForTests(); installSessionStorage(storage); });

describe("위젯별 개인 설정", () => {
  it("처음에는 이전 공통 손익 기준을 사용하고 변경은 다른 위젯에 번지지 않는다", async () => {
    const scope = await widgetPreferenceScope();
    expect(await readWidgetPreferences(101, "day", scope)).toEqual(defaultWidgetPreferences("day"));
    await saveWidgetPreferences(101, { ...defaultWidgetPreferences(), sort: "name", pinnedCodes: ["AAPL"], showMarketLine: true }, scope);
    expect(await readWidgetPreferences(101, "day", scope)).toMatchObject({ pnlMode: "cumulative", pinnedCodes: ["AAPL"], sort: "name" });
    expect(await readWidgetPreferences(102, "day", scope)).toEqual(defaultWidgetPreferences("day"));
  });
  it("서버와 사용자별 고정 종목을 구분하고 자동 로그인 끔·회원은 읽지 않는다", async () => {
    await login(1);
    await saveWidgetPreferences(201, { ...defaultWidgetPreferences(), pinnedCodes: ["AAPL"] });
    await login(2);
    expect((await readWidgetPreferences(201, "day")).pinnedCodes).toEqual([]);
    await login(1);
    expect((await readWidgetPreferences(201, "day")).pinnedCodes).toEqual(["AAPL"]);
    h.storage.set("settings.apiUrl", "https://b.test");
    expect((await readWidgetPreferences(201, "day")).pinnedCodes).toEqual([]);
    h.storage.set("settings.apiUrl", "https://a.test");
    await login(1, false);
    await expect(readWidgetPreferences(201, "day")).rejects.toThrow();
    await login(3, true, false);
    await expect(readWidgetPreferences(201, "day")).rejects.toThrow();
  });
  it("읽기 도중 계정이 바뀌면 이전 고정 종목을 반환하지 않는다", async () => {
    await login(1);
    await saveWidgetPreferences(301, { ...defaultWidgetPreferences(), pinnedCodes: ["AAPL"] });
    let release!: () => void;
    let reached!: () => void;
    const entered = new Promise<void>((resolve) => { reached = resolve; });
    h.holdRead = () => { reached(); return new Promise<void>((resolve) => { release = resolve; }); };
    const read = readWidgetPreferences(301, "day");
    const checked = expect(read).rejects.toThrow();
    await entered;
    await login(2);
    release();
    await checked;
  });
  it("오래 열린 설정의 저장은 새 계정이나 서버에 적용하지 않는다", async () => {
    await login(1);
    const scope = await widgetPreferenceScope();
    await login(2);
    await expect(saveWidgetPreferences(401, defaultWidgetPreferences(), scope)).rejects.toThrow();
    expect([...h.storage.keys()].filter((key) => key.startsWith("widget.preferences"))).toEqual([]);
  });
  it("쓰기 실패를 성공으로 처리하지 않고 이전 설정을 유지한다", async () => {
    await saveWidgetPreferences(501, defaultWidgetPreferences("day"));
    h.failWrite = true;
    await expect(saveWidgetPreferences(501, { ...defaultWidgetPreferences(), pinnedCodes: ["AAPL"] })).rejects.toThrow("disk");
    expect(await readWidgetPreferences(501, "cumulative")).toEqual(defaultWidgetPreferences("day"));
  });
  it("설정 화면 저장과 손익 전환이 겹쳐도 새 고정 종목·정렬·시장줄을 보존한다", async () => {
    await saveWidgetPreferences(550, { ...defaultWidgetPreferences(), pinnedCodes: ["AAPL"] });
    let release!: () => void;
    let entered!: () => void;
    const writing = new Promise<void>((resolve) => { entered = resolve; });
    h.holdWrite = () => { entered(); return new Promise<void>((resolve) => { release = resolve; }); };
    const settings = saveWidgetPreferences(550, { ...defaultWidgetPreferences(), pinnedCodes: ["MSFT"], sort: "name", showMarketLine: true });
    await writing;
    const toggle = updateWidgetPreferences(550, (value) => ({ ...value, pnlMode: "day" }), "cumulative");
    h.holdWrite = null; release();
    await Promise.all([settings, toggle]);
    expect(await readWidgetPreferences(550, "cumulative")).toEqual({ pnlMode: "day", pinnedCodes: ["MSFT"], sort: "name", showMarketLine: true });
  });
  it("삭제는 해당 위젯의 모든 서버 설정만 지우고 다른 위젯을 보존한다", async () => {
    await saveWidgetPreferences(601, defaultWidgetPreferences("day"));
    await saveWidgetPreferences(602, defaultWidgetPreferences("day"));
    h.storage.set("settings.apiUrl", "https://b.test");
    await saveWidgetPreferences(601, { ...defaultWidgetPreferences(), pinnedCodes: ["AAPL"] });
    await deleteWidgetPreferences(601);
    expect([...h.storage.keys()].some((key) => key.startsWith("widget.preferences.v1.601."))).toBe(false);
    expect([...h.storage.keys()].some((key) => key.startsWith("widget.preferences.v1.602."))).toBe(true);
  });
  it("삭제 실패 후 같은 실행에서 이전 설정을 다시 사용하지 않는다", async () => {
    await saveWidgetPreferences(701, { ...defaultWidgetPreferences(), pinnedCodes: ["AAPL"] });
    h.failRemove = true;
    await expect(deleteWidgetPreferences(701)).rejects.toThrow("disk");
    expect(await readWidgetPreferences(701, "day")).toEqual(defaultWidgetPreferences("day"));
  });
});
