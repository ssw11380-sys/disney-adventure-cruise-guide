import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FilingAlertItem, ScheduleFilingItem, ScheduleFilings } from "@/api/types";

/**
 * 3-38 새 공시 알림 (플래그 filingAlerts) — 앱 순수 함수·기기 기록·알림 보내기.
 * 공용 픽스처(shared/fixtures/filingAlerts.json)의 줄로 글·화면 읽기를, 고정 시계(목 7/30 07:03 KST)로 알림 규칙을 본다
 */
const scheduled: Array<{ content: { title: string; body: string; data: Record<string, unknown> }; trigger: unknown }> = [];
const perm = { status: "granted" };
const channels: string[] = [];
const gate: { hold: Promise<void> | null } = { hold: null };
vi.mock("expo-notifications", () => ({
  setNotificationHandler: () => undefined,
  getPermissionsAsync: async () => ({ ...perm }),
  scheduleNotificationAsync: async (x: (typeof scheduled)[number]) => {
    if (gate.hold) await gate.hold;
    scheduled.push(x);
  },
  setNotificationChannelAsync: async (id: string) => void channels.push(id),
  AndroidImportance: { DEFAULT: 3, HIGH: 4 },
}));
vi.mock("expo-device", () => ({ isDevice: true, modelName: "test" }));
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: {} } } }));
const store = new Map<string, string>();
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: string) => void store.set(k, v),
    removeItem: async (k: string) => void store.delete(k),
  },
}));

const F = await import("@/lib/filingAlerts");
const S = await import("@/lib/filingSeen");
const { notifyFilings, checkFilingIds, filingRules } = await import("@/lib/filingNotify");
const { routeForNotification, notificationNav } = await import("@/lib/notifications");

type Fixture = {
  items: ScheduleFilingItem[];
  alerts: FilingAlertItem[];
  app: { lines: Array<{ accession: string; when: string; head: string; speech: string; time: string; timeSpeech: string }>; notifications: Record<"one" | "two", { title: string; body: string }> };
  texts: Record<string, string>;
};
const FX = JSON.parse(readFileSync(new URL("../../shared/fixtures/filingAlerts.json", import.meta.url), "utf8")) as Fixture;
const byAcc = (acc: string) => FX.items.find((i) => i.accession === acc)!;
/** 목 7/30 07:03 KST = 7/29 22:03Z */
const NOW = new Date("2026-07-29T22:03:00Z");
const PREFS = { quietEnabled: true, quietStart: "22:00", quietEnd: "07:00", mutedCodes: [] as string[] };
const FULL = { digest: true, accountBriefing: false, ...PREFS };
const MSFT_8K = FX.alerts.find((a) => a.form === "8-K")!;
const MSFT_10K = FX.alerts.find((a) => a.form === "10-K")!;
/** 알림 하나 만들기 (접수 시각을 바꿔 쓰는 시험용) */
const alert = (over: Partial<FilingAlertItem>): FilingAlertItem => ({ ...MSFT_8K, ...over });

beforeEach(() => {
  store.clear();
  scheduled.length = 0;
  channels.length = 0;
  perm.status = "granted";
  gate.hold = null;
});

describe("문구 (공용 픽스처 texts 와 같음 — 서버가 같은 글을 BRIEFING_BANNED 로 검사)", () => {
  it("화면·설정·알림 문구가 픽스처와 같다", () => {
    const T = FX.texts;
    expect({
      scheduleTitle: F.SCHEDULE_TITLE,
      scheduleLink: F.SCHEDULE_LINK,
      scheduleLinkSpeech: F.SCHEDULE_LINK_SPEECH,
      scheduleOff: F.SCHEDULE_OFF,
      eventsLoading: F.EVENTS_LOADING,
      earningsAfterFiling: F.EARNINGS_AFTER_FILING,
      filingsHead: F.FILINGS_HEAD,
      filingsSub: F.filingsSub(30),
      filingsNone: F.filingsNone(30),
      filingsNoUs: F.FILINGS_NO_US,
      filingsNoneCovered: F.FILINGS_NONE_COVERED,
      filingsFailed: F.FILINGS_FAILED,
      titleNote: F.TITLE_NOTE,
      notCovered: F.notCoveredNote([
        { code: "QQQ", name: "QQQ", reason: "etf" },
        { code: "SOXL", name: "SOXL", reason: "etf" },
        { code: "ABCD", name: "ABCD", reason: "notFound" },
      ]),
      stale: F.staleNote("2026-09-29T07:55:00+09:00"),
      staleNever: F.STALE_NEVER,
      failed: F.failedNote([{ name: "테슬라" }]),
      pending: F.pendingNote([{ name: "테슬라" }]),
      basis: F.scheduleFilingsView({ items: [], more: 0, watched: 1, notCovered: [], failed: [], pending: [], lastOkAt: "2026-09-29T08:40:00+09:00", warning: null }).basis,
      newChip: F.NEW_CHIP,
      expandHint: F.EXPAND_HINT,
      itemsHead: F.ITEMS_HEAD,
      openOriginal: F.OPEN_ORIGINAL,
      openOriginalSpeech: F.OPEN_ORIGINAL_SPEECH,
      openFailed: F.OPEN_FAILED,
      krHead: F.KR_HEAD,
      krNoKey: F.KR_NO_KEY,
      krNotYet: F.KR_NOT_YET,
      settingTitle: F.SETTING_TITLE,
      settingAbout: F.SETTING_ABOUT,
      settingQuiet: F.settingQuiet("22:00", "07:00"),
      settingMuted: F.SETTING_MUTED,
      settingDeviceOff: F.SETTING_DEVICE_OFF,
      settingLast: F.lastAlertLine([{ accession: MSFT_8K.accession, acceptedAt: "2026-07-29T20:04:53Z", notifiedAt: "2026-07-29T22:03:00Z" }]),
      notifyOne: F.filingMessage([MSFT_8K])!.title,
      notifyMany: F.filingMessage([MSFT_8K, MSFT_10K, MSFT_8K, MSFT_10K, MSFT_8K])!.title,
      notifyMore: F.filingMessage([MSFT_8K, MSFT_10K, MSFT_8K, MSFT_10K, MSFT_8K])!.body.split("\n").at(-1),
      channelName: F.CHANNEL_NAME,
      channelAbout: F.CHANNEL_ABOUT,
    }).toEqual(T);
  });
});

describe("공시 줄 글·화면 읽기 (공용 픽스처)", () => {
  it.each(FX.app.lines.map((l) => [l.accession, l] as const))("%s", (acc, want) => {
    const item = byAcc(acc);
    const l = F.filingLine(item, item.isNew);
    expect({ when: l.when, head: l.head, speech: l.speech, time: l.time, timeSpeech: l.timeSpeech }).toEqual({ when: want.when, head: want.head, speech: want.speech, time: want.time, timeSpeech: want.timeSpeech });
    expect(l.title).toBe(item.title);
  });

  it("접수 시각을 모르면 제출일만 (미국 날짜라고 밝힘)", () => {
    const l = F.filingLine({ ...MSFT_8K, acceptedAt: null, kst: null, et: null });
    expect(l).toMatchObject({ when: "7/29(수)", head: "7/29(수) · 마이크로소프트", time: "SEC 제출일: 7/29(수) (미국 날짜)" });
    expect(l.speech).toBe("7월 29일 수요일, 마이크로소프트, 실적 발표, 8-K 2.02");
  });

  it("오전·오후 읽기: 자정 0시 = 오전 12시 · 정오 = 오후 12시 · 분이 0 이면 '시'까지", () => {
    expect(["00:00", "00:30", "05:04", "12:00", "16:04", "23:59", "x"].map(F.speakAmPm)).toEqual(["오전 12시", "오전 12시 30분", "오전 5시 4분", "오후 12시", "오후 4시 4분", "오후 11시 59분", "x"]);
    expect(F.titleSpeech("연간 보고서(20-F, 외국 기업)")).toBe("연간 보고서, 20-F, 외국 기업");
  });

  it("접수 번호 모양만 받는다", () => {
    expect(F.parseAccession("0001193125-26-323632")).toBe("0001193125-26-323632");
    for (const bad of ["../x", "0001193125-26-32363", "", 5, null, undefined, "0001193125-26-323632?x=1"]) expect(F.parseAccession(bad)).toBeNull();
  });
});

describe("'최근 공시 (미국)' 칸", () => {
  const base: ScheduleFilings = { items: FX.items, more: 0, watched: 5, notCovered: [], failed: [], pending: [], lastOkAt: "2026-07-30T07:03:00+09:00", warning: null };

  it("줄 · 새 공시(서버 isNew 이고 이 기기에서 펼쳐 보지 않음) · 제목 뜻 · 기준", () => {
    const v = F.scheduleFilingsView(base);
    expect(v.lines.map((l) => [l.line.head, l.isNew])).toEqual(FX.items.map((i) => [expect.stringContaining(i.name), i.isNew]));
    expect(v).toMatchObject({ title: "최근 공시 (미국)", sub: "보유 미국 종목 · 최근 30일 · SEC", more: 0, empty: null, fresh: 2, notes: [F.TITLE_NOTE], basis: "7/30 07:03 기준 · 출처 SEC EDGAR", basisSpeech: "7월 30일 오전 7시 3분 기준, 출처 SEC EDGAR" });
    const seen = F.scheduleFilingsView(base, new Set([MSFT_8K.accession]));
    expect(seen.fresh).toBe(1);
    expect(seen.lines.find((l) => l.item.accession === MSFT_8K.accession)!.line.speech).not.toMatch(/새 공시/);
  });

  it("30줄까지, 넘으면 '외 N건' (서버가 주지 않은 줄 포함)", () => {
    const many = Array.from({ length: 34 }, (_, i) => ({ ...FX.items[2]!, accession: `0001046179-26-0${String(100 + i).padStart(5, "0")}` }));
    const v = F.scheduleFilingsView({ ...base, items: many, more: 3 });
    expect(v.lines).toHaveLength(30);
    expect(v.more).toBe(7);
  });

  it("없음 · 미국 보유 없음 · ETF 만 · 멈춤 · 일부 실패 · 아직 확인 전 · 대상 아님", () => {
    const empty = { ...base, items: [] };
    expect(F.scheduleFilingsView(empty)).toMatchObject({ empty: "최근 30일 안에 올라온 공시가 없습니다.", notes: [] });
    expect(F.scheduleFilingsView({ ...empty, watched: 0 }).empty).toBe(F.FILINGS_NO_US);
    expect(F.scheduleFilingsView({ ...empty, watched: 0, notCovered: [{ code: "QQQ", name: "QQQ", reason: "etf" }] })).toMatchObject({
      empty: F.FILINGS_NONE_COVERED,
      notes: ["공시를 확인하지 않는 종목: QQQ (ETF·ETN)"],
    });
    expect(F.scheduleFilingsView({ ...base, warning: "stale", lastOkAt: "2026-09-29T07:55:00+09:00" }).notes).toContain("SEC 공시 확인이 9/29 07:55 이후 되지 않았습니다. 서버가 다시 확인하면 채워집니다.");
    expect(F.scheduleFilingsView({ ...base, warning: "shape", lastOkAt: null }).notes).toContain(F.STALE_NEVER);
    const partial = F.scheduleFilingsView({ ...base, warning: "partial", failed: [{ code: "TSLA", name: "테슬라" }], pending: [{ code: "O", name: "리얼티인컴" }] });
    expect(partial.notes).toEqual([F.TITLE_NOTE, "공시를 받지 못한 종목: 테슬라 (다음 확인 때 다시 받습니다)", "아직 공시를 확인하지 않은 종목: 리얼티인컴 (서버가 확인하는 중입니다)"]);
    const seven = Array.from({ length: 7 }, (_, i) => ({ code: `E${i}`, name: `E${i}`, reason: "etf" as const }));
    expect(F.notCoveredNote(seven)).toBe("공시를 확인하지 않는 종목: E0, E1, E2, E3, E4 외 2종목 (ETF·ETN)");
    expect(F.notCoveredNote([])).toBeNull();
    // 모두 받은 시각을 모르면 출처만
    expect(F.scheduleFilingsView({ ...base, lastOkAt: null }).basis).toBe("출처 SEC EDGAR");
  });

  it("계좌 상세 링크 끝 '· 새 공시 N건'", () => {
    expect(F.freshSuffix(2)).toBe("· 새 공시 2건");
    expect(F.freshSuffix(0)).toBeNull();
  });
});

describe("알림 문구 (설계 2.4)", () => {
  it("1건 · 여러 건(3건까지) · 4건 이상 '외 N건' · data", () => {
    expect(F.filingMessage([MSFT_10K])).toEqual({ ...FX.app.notifications.one, data: { type: "filing", accessions: [MSFT_10K.accession], focus: MSFT_10K.accession } });
    expect(F.filingMessage([MSFT_10K, MSFT_8K])).toMatchObject(FX.app.notifications.two);
    const five = [MSFT_10K, MSFT_8K, alert({ accession: "0001045810-26-000060", name: "엔비디아", title: "임원·이사 변경(8-K 5.02)" }), alert({ accession: "0001045810-26-000061" }), alert({ accession: "0001045810-26-000062" })];
    expect(F.filingMessage(five)).toMatchObject({
      title: "보유 종목 새 공시 5건",
      body: "마이크로소프트 · 연간 보고서(10-K)\n마이크로소프트 · 실적 발표(8-K 2.02)\n엔비디아 · 임원·이사 변경(8-K 5.02)\n외 2건",
      data: { focus: MSFT_10K.accession },
    });
    expect(F.filingMessage([])).toBeNull();
    // 접수 시각을 모르면 SEC 제출일(미국 날짜)이라고 밝힌다
    expect(F.filingMessage([{ ...MSFT_8K, acceptedAt: null, kst: null, et: null }])!.body).toBe("실적 발표(8-K 2.02) · SEC 제출일 7/29(수) (미국 날짜)");
  });
});

describe("알림 규칙 planFilingNotification (표)", () => {
  const plan = (over: Partial<Parameters<typeof F.planFilingNotification>[0]> = {}) =>
    F.planFilingNotification({ items: FX.alerts, seen: new Set(), init: true, prefs: PREFS, enabled: true, now: NOW, ...over });

  it("기준을 아직 안 잡음 → 접수 30분이 지난 것은 모두 '본 것'(알림 0), 30분 안의 것은 알림 — 첫 확인이 곧 첫 새 공시인 기기에서 사라지지 않게", () => {
    expect(plan({ init: false })).toEqual({ message: null, markSeen: FX.alerts.map((a) => a.accession), notified: [], init: true, deferred: false });
    const just = alert({ accession: "0001193125-26-400000", acceptedAt: "2026-07-29T21:40:00Z" }); // 23분 전
    const p = plan({ init: false, items: [just, ...FX.alerts] });
    expect(p).toMatchObject({ init: true, deferred: false, notified: [just], message: { title: "마이크로소프트 새 공시" } });
    expect(p.markSeen).toEqual([...FX.alerts.map((a) => a.accession), just.accession]);
    // 첫 확인이 조용한 시간이면 30분 지난 것만 적고 새 것은 미룸 (기준은 잡음)
    const quiet = plan({ init: false, items: [just, ...FX.alerts], now: new Date("2026-07-29T21:55:00Z") });
    expect(quiet).toEqual({ message: null, markSeen: FX.alerts.map((a) => a.accession), notified: [], init: true, deferred: true });
  });
  it("새 공시 2건 → 알림 1건(묶음), 모두 '본 것'", () => {
    const p = plan();
    expect(p.message).toMatchObject(FX.app.notifications.two);
    expect(p.markSeen).toEqual(FX.alerts.map((a) => a.accession));
    expect(p.notified).toEqual(FX.alerts);
  });
  it("이미 본 접수 번호는 건너뜀 (같은 번호가 두 번 와도 한 번)", () => {
    const p = plan({ items: [...FX.alerts, MSFT_8K], seen: new Set([MSFT_10K.accession]) });
    expect(p.message).toMatchObject({ title: "마이크로소프트 새 공시", body: "실적 발표(8-K 2.02) · SEC에 7/30(목) 05:04 올라옴" });
    expect(p.markSeen).toEqual([MSFT_8K.accession]);
    expect(plan({ seen: new Set(FX.alerts.map((a) => a.accession)) })).toEqual({ message: null, markSeen: [], notified: [], init: false, deferred: false });
  });
  it("접수 24시간이 넘은 것 · 끈 종목 · 이 기기 '공시 알림' 끔 → 조용히 '본 것'", () => {
    const old = alert({ accession: "0001045810-26-000060", code: "NVDA", acceptedAt: "2026-07-28T22:02:00Z" });
    expect(plan({ items: [old] })).toEqual({ message: null, markSeen: [old.accession], notified: [], init: false, deferred: false });
    // 접수 시각이 없으면 서버가 처음 본 시각으로
    expect(plan({ items: [alert({ acceptedAt: null, firstSeenAt: "2026-07-29T22:00:00Z" })] }).message).not.toBeNull();
    expect(plan({ prefs: { ...PREFS, mutedCodes: ["MSFT"] } })).toMatchObject({ message: null, markSeen: FX.alerts.map((a) => a.accession) });
    expect(plan({ enabled: false })).toMatchObject({ message: null, markSeen: FX.alerts.map((a) => a.accession) });
  });
  it("조용한 시간(22:00~07:00)은 미룸(아무것도 적지 않음 — 24시간 넘은 것만 적음), 07:00 이 되면 보냄 · 시작=끝이면 조용한 시간 없음 · 조용한 시간을 끈 사용자는 바로", () => {
    const old = alert({ accession: "0001045810-26-000060", acceptedAt: "2026-07-27T00:00:00Z" });
    const at0659 = new Date("2026-07-29T21:59:00Z");
    expect(plan({ items: [...FX.alerts, old], now: at0659 })).toEqual({ message: null, markSeen: [old.accession], notified: [], init: false, deferred: true });
    expect(plan({ now: new Date("2026-07-29T22:00:00Z") }).message).not.toBeNull();
    expect(plan({ now: at0659, prefs: { ...PREFS, quietStart: "07:00", quietEnd: "07:00" } }).message).not.toBeNull();
    expect(plan({ now: at0659, prefs: { ...PREFS, quietEnabled: false } }).message).not.toBeNull();
  });
});

describe("기기 기록 · 보내기", () => {
  it("첫 확인은 기준만(알림 0) → 새 공시 1건 → 같은 목록을 다시 받아도 0 · 채널 '공시 알림' · 기록", async () => {
    expect(await notifyFilings([MSFT_10K], { prefs: FULL, now: NOW })).toBe(0);
    expect(await S.filingInit()).toBe(true);
    expect(await notifyFilings([MSFT_10K, MSFT_8K], { prefs: FULL, now: NOW })).toBe(1);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toMatchObject({ content: { title: "마이크로소프트 새 공시", body: "실적 발표(8-K 2.02) · SEC에 7/30(목) 05:04 올라옴", data: { type: "filing", focus: MSFT_8K.accession } }, trigger: { channelId: "filings" } });
    expect(channels).toEqual(["filings"]);
    expect(await notifyFilings([MSFT_10K, MSFT_8K], { prefs: FULL, now: NOW })).toBe(0);
    expect(await S.readFilingLog()).toEqual([{ accession: MSFT_8K.accession, acceptedAt: MSFT_8K.acceptedAt, notifiedAt: "2026-07-29T22:03:00.000Z" }]);
    expect(F.lastAlertLine(await S.readFilingLog())).toBe("마지막 공시 알림 7/30(목) 07:03 · SEC에 올라온 뒤 1시간 58분");
  });

  it("알림 권한이 없으면 아무것도 적지 않는다 (권한을 다시 주면 24시간 안의 것만)", async () => {
    await S.setFilingInit();
    perm.status = "denied";
    expect(await notifyFilings(FX.alerts, { prefs: FULL, now: NOW })).toBe(0);
    expect(await S.readFilingSeen()).toEqual([]);
    perm.status = "granted";
    expect(await notifyFilings(FX.alerts, { prefs: FULL, now: new Date("2026-07-31T00:00:00Z") })).toBe(0);
    expect(await S.readFilingSeen()).toEqual(FX.alerts.map((a) => a.accession));
  });

  it("두 확인이 겹쳐도 알림은 1건 (withFilingSeen)", async () => {
    await S.setFilingInit();
    let release!: () => void;
    gate.hold = new Promise<void>((r) => (release = r));
    const a = notifyFilings(FX.alerts, { prefs: FULL, now: NOW });
    const b = notifyFilings(FX.alerts, { prefs: FULL, now: NOW });
    await new Promise((r) => setTimeout(r, 0));
    release();
    expect((await a) + (await b)).toBe(1);
    expect(scheduled).toHaveLength(1);
  });

  it("'본 것'은 300개까지 — 넘으면 오래된 것부터", async () => {
    await S.addFilingSeen(Array.from({ length: 310 }, (_, i) => `0000000000-26-${String(i).padStart(6, "0")}`));
    const seen = await S.readFilingSeen();
    expect(seen).toHaveLength(300);
    expect(seen[0]).toBe("0000000000-26-000010");
    await S.addFilingSeen(["0000000000-26-000010"]);
    expect((await S.readFilingSeen()).at(-1)).toBe("0000000000-26-000010");
  });

  it("알림 묶음(briefingDigest)이 꺼진 서버: 조용한 시간을 쓰지 않는다 (설정 화면도 그때 조용한 시간을 보이지 않음)", async () => {
    await S.setFilingInit();
    const night = new Date("2026-07-29T15:00:00Z"); // 00:00 KST
    const late = alert({ accession: "0001193125-26-400002", acceptedAt: "2026-07-29T14:50:00Z" });
    expect(filingRules({ ...FULL, digest: false }).quietEnabled).toBe(false);
    expect(filingRules(FULL)).toBe(FULL);
    expect(await notifyFilings([late], { prefs: FULL, now: night })).toBe(0);
    expect(await notifyFilings([late], { prefs: { ...FULL, digest: false }, now: night })).toBe(1);
  });

  it("'공시 알림' 스위치는 기기에 (기본 켬)", async () => {
    expect(await S.filingAlertsEnabled()).toBe(true);
    await S.setFilingAlertsEnabled(false);
    expect(await S.filingAlertsEnabled()).toBe(false);
  });

  it("checkFilingIds: 모르는 번호가 없으면 요청 0, 있으면 규칙·목록 두 요청, 조용한 시간이면 목록을 받지 않음", async () => {
    const calls = { prefs: 0, alerts: 0 };
    const load = { prefs: async () => (calls.prefs++, FULL), alerts: async () => (calls.alerts++, [...FX.alerts]) };
    // 첫 확인(기준 없음): 두 요청으로 기준을 잡는다
    expect(await checkFilingIds(FX.alerts.map((a) => a.accession), load, NOW)).toBe(0);
    expect(calls).toEqual({ prefs: 1, alerts: 1 });
    expect(await checkFilingIds(FX.alerts.map((a) => a.accession), load, NOW)).toBe(0);
    expect(calls).toEqual({ prefs: 1, alerts: 1 });
    expect(await checkFilingIds(undefined, load, NOW)).toBe(0);
    const next = alert({ accession: "0001193125-26-400000", acceptedAt: "2026-07-29T21:50:00Z" });
    load.alerts = async () => (calls.alerts++, [next, ...FX.alerts]);
    expect(await checkFilingIds([next.accession, ...FX.alerts.map((a) => a.accession)], load, new Date("2026-07-29T21:55:00Z"))).toBe(0); // 06:55 조용한 시간
    expect(calls).toEqual({ prefs: 2, alerts: 1 });
    expect(await checkFilingIds([next.accession], load, NOW)).toBe(1);
    expect(calls).toEqual({ prefs: 3, alerts: 2 });
    // 규칙을 못 받으면 이번엔 넘긴다
    const next2 = alert({ accession: "0001193125-26-400001" });
    expect(await checkFilingIds([next2.accession], { prefs: async () => null, alerts: load.alerts }, NOW)).toBe(0);
    expect(calls.alerts).toBe(2);
  });
});

describe("알림 누름 (routeForNotification · notificationNav)", () => {
  it("type 'filing' → /schedule?focus=<접수 번호>, 틀린 번호 → /schedule, 브리핑이 아니라 쌓기만(legacy)", () => {
    expect(routeForNotification({ type: "filing", focus: MSFT_8K.accession, accessions: [MSFT_8K.accession] })).toBe(`/schedule?focus=${MSFT_8K.accession}`);
    expect(routeForNotification({ type: "filing", focus: "../../x" })).toBe("/schedule");
    expect(routeForNotification({ type: "filing" })).toBe("/schedule");
    expect(notificationNav({ type: "filing", focus: MSFT_8K.accession }, { back: true, twoPane: true, path: "/" })).toEqual({ kind: "legacy", path: `/schedule?focus=${MSFT_8K.accession}` });
  });
});
