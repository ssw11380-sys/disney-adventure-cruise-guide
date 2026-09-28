import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountEvents, FilingAlertItem, HoldingSchedule, ScheduleFilingItem, ScheduleFilings } from "@/api/types";

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

vi.mock("@/api/hooks", () => ({ useApi: () => ({ baseUrl: "" }) }));

const F = await import("@/lib/filingAlerts");
const H = await import("@/lib/holdingEvents");
const { scheduleStaleMs, SCHEDULE_STALE_MS } = await import("@/lib/scheduleQuery");
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
/** 일정 칸 (받지 못함 글을 바꿔 보는 시험용) */
const EMPTY_EVENTS: AccountEvents = { days: 30, asOf: "2026-07-30T07:03:00+09:00", earnings: false, earningsFailed: false, kr: 0, us: 1, items: [], failed: [], conflicts: [], week: null };
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
      scheduleLinkHint: F.SCHEDULE_LINK_HINT,
      scheduleOff: F.SCHEDULE_OFF,
      alertsTitle: F.ALERTS_TITLE,
      scheduleLoading: F.SCHEDULE_LOADING,
      eventsLoading: F.EVENTS_LOADING,
      filingsLoading: F.FILINGS_LOADING,
      earningsAfterFiling: F.EARNINGS_AFTER_FILING,
      filingsHead: F.FILINGS_HEAD,
      filingsSub: F.filingsSub(30),
      filingsNone: F.filingsNone(30),
      alertsNone: F.alertsNone(3),
      filingsNoUs: F.FILINGS_NO_US,
      filingsNoneCovered: F.FILINGS_NONE_COVERED,
      filingsFailed: F.FILINGS_FAILED,
      scheduleFailed: F.SCHEDULE_FAILED,
      eventsFailedScreen: F.EVENTS_FAILED_SCREEN,
      ...(() => {
        const [retryEarnings, retryDividends, retryStocks] = F.screenRetryView({ ...H.eventsView(EMPTY_EVENTS), notes: [H.EARNINGS_FAILED, H.DIVIDENDS_FAILED, H.failedNote(["테슬라"])] }).notes;
        return { retryEarnings, retryDividends, retryStocks };
      })(),
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
      collapseHint: F.COLLAPSE_HINT,
      itemsHead: F.ITEMS_HEAD,
      openOriginal: F.OPEN_ORIGINAL,
      openOriginalSpeech: F.OPEN_ORIGINAL_SPEECH,
      openFailed: F.OPEN_FAILED,
      krHead: F.KR_HEAD,
      krNoKey: F.KR_NO_KEY,
      krScreenNoKey: F.KR_SCREEN_NO_KEY,
      krNotYet: F.KR_NOT_YET,
      krInAccount: F.KR_IN_ACCOUNT,
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
    // 펼친 첫 줄 묶음: 이으면 같은 글 · 묶음 안은 줄바꿈 없는 공백 · '·'는 앞 묶음 끝 (다음 줄이 '·'로 시작하지 않게)
    expect(l.timeParts.join(" ").replace(/\u00a0/g, " ")).toBe(want.time);
    for (const part of l.timeParts) expect(part).not.toMatch(/ /);
    expect(l.timeParts.slice(1).some((p) => p.startsWith("·"))).toBe(false);
  });

  it("접수 시각을 모르면 제출일만 (미국 날짜라고 밝힘)", () => {
    const l = F.filingLine({ ...MSFT_8K, acceptedAt: null, kst: null, et: null });
    expect(l).toMatchObject({ when: "7/29(수)", head: "7/29(수) · 마이크로소프트", time: "SEC 제출일: 7/29(수) (미국 날짜)", timeParts: ["SEC\u00a0제출일:", "7/29(수)\u00a0(미국\u00a0날짜)"] });
    expect(l.speech).toBe("7월 29일 수요일, 마이크로소프트, 실적 발표, 8-K 2.02");
  });

  it("오전·오후 읽기: 자정 0시 = 오전 12시 · 정오 = 오후 12시 · 분이 0 이면 '시'까지", () => {
    expect(["00:00", "00:30", "05:04", "12:00", "16:04", "23:59", "x"].map(F.speakAmPm)).toEqual(["오전 12시", "오전 12시 30분", "오전 5시 4분", "오후 12시", "오후 4시 4분", "오후 11시 59분", "x"]);
    expect(F.titleSpeech("연간 보고서(20-F, 외국 기업)")).toBe("연간 보고서, 20-F, 외국 기업");
  });

  it("SEC 접수 시간 (미국 동부 평일 06:00~22:59 — 서버 inEdgarHours 와 같은 창, 기기 Intl 없이 서머타임 규칙)", () => {
    const cases: Array<[string, boolean]> = [
      ["2026-07-29T09:59:00Z", false], // 수 05:59 EDT
      ["2026-07-29T10:00:00Z", true], // 수 06:00
      ["2026-07-30T02:59:00Z", true], // 수 22:59
      ["2026-07-30T03:00:00Z", false], // 수 23:00
      ["2026-09-26T00:30:00Z", true], // 금 20:30 EDT = 한국 토 09:30 (미국 애프터마켓·주간거래 모두 닫힘)
      ["2026-08-01T14:00:00Z", false], // 토
      ["2026-08-02T14:00:00Z", false], // 일
      ["2026-04-03T15:00:00Z", true], // 성금요일 11:00 EDT (미국 증시 휴장, SEC 는 받음)
      ["2026-03-06T10:59:00Z", false], // 금 05:59 EST
      ["2026-03-06T11:00:00Z", true], // 금 06:00 EST
      ["2026-03-09T10:00:00Z", true], // 월 06:00 EDT (3/8 서머타임 시작)
      ["2026-11-02T10:30:00Z", false], // 월 05:30 EST (11/1 서머타임 끝)
      ["2026-11-02T11:00:00Z", true],
    ];
    for (const [iso, want] of cases) expect(F.inEdgarHours(Date.parse(iso)), iso).toBe(want);
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
    expect(v).toMatchObject({ title: "최근 공시 (미국)", sub: "보유 미국 종목 · 최근 30일 · SEC", more: 0, empty: null, fresh: 2, notes: [F.TITLE_NOTE], basis: "7/30 07:03 기준 · 출처 SEC EDGAR", basisSpeech: "7월 30일 7시 3분 기준, 출처 SEC EDGAR" });
    // 기준 줄 읽기는 같은 화면 '다가오는 일정' 기준 줄과 같은 24시간 말투 ('16시 15분' — 공시 줄의 접수 시각만 오전·오후)
    expect(F.scheduleFilingsView({ ...base, lastOkAt: "2026-09-25T16:15:00+09:00" }).basisSpeech).toBe("9월 25일 16시 15분 기준, 출처 SEC EDGAR");
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

  it("계좌 상세 링크 끝 '새 공시 N건' ('·'는 링크 글 묶음 끝에 붙인다)", () => {
    expect(F.freshCount(2)).toBe("새 공시 2건");
    expect(F.freshCount(0)).toBeNull();
  });

  it("요청이 실패했을 때 한 줄: 앱이 아는 서버 플래그로 — 둘 다 켜짐·모름이면 '일정·공시', 공시가 꺼졌으면 '일정', 일정이 꺼졌으면 '공시 목록'", () => {
    expect(F.scheduleFailedText(true, true)).toBe(F.SCHEDULE_FAILED);
    expect(F.scheduleFailedText(false, false)).toBe(F.SCHEDULE_FAILED);
    expect(F.scheduleFailedText(true, false)).toBe(F.EVENTS_FAILED_SCREEN);
    expect(F.scheduleFailedText(false, true)).toBe(F.FILINGS_FAILED);
  });

  it("받는 중 한 줄도 같은 규칙 (리뷰 3 — 공시도 함께 받는데 '일정을 받는 중…'이라고만 쓰던 것)", () => {
    expect(F.scheduleLoadingText(true, true)).toBe("일정·공시를 받는 중…");
    expect(F.scheduleLoadingText(false, false)).toBe("일정·공시를 받는 중…");
    expect(F.scheduleLoadingText(true, false)).toBe("일정을 받는 중…");
    expect(F.scheduleLoadingText(false, true)).toBe("공시를 받는 중…");
  });

  it("화면 제목: '일정·공시' 화면이 꺼져 있고 공시 알림만 켜져 있으면 '새 공시'", () => {
    expect(F.scheduleScreenTitle(true, true)).toBe("일정·공시");
    expect(F.scheduleScreenTitle(true, false)).toBe("일정·공시");
    expect(F.scheduleScreenTitle(false, true)).toBe("새 공시");
    expect(F.scheduleScreenTitle(false, false)).toBe("일정·공시");
  });

  it("'새 공시' 화면(알림 목록): 줄은 같은 글, 칩·항목 풀이 없음, 아래 줄 '최근 3일', 없으면 '최근 3일 안에 새 공시가 없습니다.'", () => {
    const f = F.alertsAsFilings(FX.alerts);
    expect(f.items.map((i) => [i.accession, i.detail, i.note, i.isNew])).toEqual(FX.alerts.map((a) => [a.accession, [], null, false]));
    const v = F.scheduleFilingsView(f, new Set(), F.ALERT_DAYS, "alerts");
    expect(v).toMatchObject({ sub: "보유 미국 종목 · 최근 3일 · SEC", empty: null, fresh: 0, notes: [F.TITLE_NOTE], basis: "출처 SEC EDGAR" });
    expect(v.lines.map((l) => l.line.head)).toEqual(FX.alerts.map((a) => FX.app.lines.find((l) => l.accession === a.accession)!.head));
    // 보유 여부를 모르므로 '미국 보유 종목이 없어 …'가 아니라 새 공시가 없다고만
    expect(F.scheduleFilingsView(F.alertsAsFilings([]), new Set(), F.ALERT_DAYS, "alerts")).toMatchObject({ empty: "최근 3일 안에 새 공시가 없습니다.", notes: [] });
  });

  it("'미국 실적은 … 공시로 보입니다'는 공시 칸이 확인하는 미국 종목이 있을 때만 (ETF 뿐이면 없음 — 리뷰 3)", () => {
    expect(F.filingsCoverUs(base)).toBe(true);
    expect(F.filingsCoverUs(null)).toBe(false);
    expect(F.filingsCoverUs({ ...base, items: [], watched: 0, notCovered: [{ code: "QQQ", name: "QQQ", reason: "etf" }] })).toBe(false);
    // 아직 확인 전 · 받지 못함이어도 확인하는 종목이다
    expect(F.filingsCoverUs({ ...base, watched: 0, pending: [{ code: "O", name: "리얼티인컴" }] })).toBe(true);
    expect(F.filingsCoverUs({ ...base, watched: 0, failed: [{ code: "TSLA", name: "테슬라" }] })).toBe(true);
  });

  it("'다가오는 일정'의 받지 못함 글을 이 화면에 맞게 — '다음 브리핑 때' → '화면을 다시 열면' (리뷰 3)", () => {
    const failed = H.eventsView({ ...EMPTY_EVENTS, failed: [{ code: "MSFT", name: "마이크로소프트" }] });
    expect(failed.empty).toBe(H.EVENTS_FAILED);
    const v = F.screenRetryView(failed);
    expect(v.empty).toBe(F.EVENTS_FAILED_SCREEN);
    expect(v.headSpeech).toBe(`다가오는 일정, 보유 종목 30일 안, ${F.EVENTS_FAILED_SCREEN}`);
    const some = F.screenRetryView(H.eventsView({ ...EMPTY_EVENTS, us: 2, failed: [{ code: "TSLA", name: "테슬라" }] }));
    expect(some.notes).toContain("배당 일정을 받지 못한 종목: 테슬라 (화면을 다시 열면 다시 받습니다)");
    expect(JSON.stringify(some)).not.toContain(F.AGAIN_BRIEFING);
    // 받지 못한 것이 없으면 그대로
    const ok = H.eventsView(EMPTY_EVENTS);
    expect(F.screenRetryView(ok)).toEqual(ok);
  });

  it("받지 못한 칸·종목이 있으면 화면을 다시 열 때 곧바로 다시 묻는다 (staleTime 0) — 나머지는 1분 (리뷰 3)", () => {
    const ok: HoldingSchedule = { asOf: "2026-07-30T07:03:00+09:00", events: EMPTY_EVENTS, filings: base, kr: { filings: "noDartKey" } };
    expect(F.scheduleHasFailure(ok)).toBe(false);
    expect(F.scheduleHasFailure(undefined)).toBe(false);
    expect(scheduleStaleMs(ok)).toBe(SCHEDULE_STALE_MS);
    expect(scheduleStaleMs(undefined)).toBe(SCHEDULE_STALE_MS);
    const bads: HoldingSchedule[] = [
      { ...ok, events: null, eventsFailed: true },
      { ...ok, filings: null, filingsFailed: true },
      { ...ok, events: { ...EMPTY_EVENTS, failed: [{ code: "MSFT", name: "마이크로소프트" }] } },
      { ...ok, events: { ...EMPTY_EVENTS, earnings: true, earningsFailed: true } },
    ];
    for (const bad of bads) {
      expect(F.scheduleHasFailure(bad)).toBe(true);
      expect(scheduleStaleMs(bad)).toBe(0);
    }
    // 공시 칸의 '받지 못한 종목'은 서버의 다음 확인 때 다시 받는다 (화면을 다시 열어도 같음) — 곧바로 다시 묻지 않는다
    expect(scheduleStaleMs({ ...ok, filings: { ...base, failed: [{ code: "TSLA", name: "테슬라" }] } })).toBe(SCHEDULE_STALE_MS);
  });

  it("보유 미국 종목 판단 (받아 둔 위젯 응답 — 수량 > 0 인 미국 코드)", () => {
    expect(F.holdsUs([{ c: "MSFT", qty: 3 }])).toBe(true);
    expect(F.holdsUs([{ c: "005930", qty: 10 }, { c: "0126Z0", qty: 1 }])).toBe(false);
    expect(F.holdsUs([{ c: "MSFT", qty: null }, { c: "NVDA", qty: 0 }])).toBe(false);
    expect(F.holdsUs([])).toBe(false);
    expect(F.holdsUs(undefined)).toBe(false);
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
  it("같은 회사를 두 코드로 가짐(GOOGL·GOOG — 서버 codes): 둘 다 껐을 때만 조용히, 하나만 끄면 어느 쪽이든 알림 · 예전 서버(codes 없음)는 대표 코드로 (리뷰 3)", () => {
    const goog = alert({ accession: "0001652044-26-000100", code: "GOOGL", codes: ["GOOGL", "GOOG"], name: "알파벳 A" });
    const one = (mutedCodes: string[]) => plan({ items: [goog], prefs: { ...PREFS, mutedCodes } }).message;
    expect(one([])).not.toBeNull();
    expect(one(["GOOG"])).not.toBeNull();
    expect(one(["GOOGL"])).not.toBeNull();
    expect(one(["GOOGL", "GOOG"])).toBeNull();
    const { codes: _c, ...legacy } = goog;
    expect(plan({ items: [legacy], prefs: { ...PREFS, mutedCodes: ["GOOGL"] } }).message).toBeNull();
    expect(plan({ items: [legacy], prefs: { ...PREFS, mutedCodes: ["GOOG"] } }).message).not.toBeNull();
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

  it("'마지막 공시 알림'은 마지막 묶음의 가장 최신 공시로 잰다 (여러 건을 묶어 알리면 기록이 최신 먼저 붙는다 — 리뷰 3)", async () => {
    await S.setFilingInit();
    // 16:04 실적 8-K · 16:08 10-K 를 07:03 에 한 번에 알림 → 최신(10-K 20:08:01Z)에서 1시간 54분
    expect(await notifyFilings([MSFT_10K, MSFT_8K], { prefs: FULL, now: NOW })).toBe(1);
    const log = await S.readFilingLog();
    expect(log.map((e) => e.accession)).toEqual([MSFT_10K.accession, MSFT_8K.accession]);
    expect(F.lastAlertLine(log)).toBe("마지막 공시 알림 7/30(목) 07:03 · SEC에 올라온 뒤 1시간 54분");
    // 순서가 거꾸로 적혀 있어도(예전 기록) 같은 묶음 안의 가장 최신으로
    expect(F.lastAlertLine([...log].reverse())).toBe("마지막 공시 알림 7/30(목) 07:03 · SEC에 올라온 뒤 1시간 54분");
    // 앞 묶음은 보지 않는다 · 접수 시각을 모르는 줄만 있으면 걸린 시간 없이
    const earlier = { accession: "0001045810-26-000060", acceptedAt: "2026-07-29T22:02:00Z", notifiedAt: "2026-07-29T22:02:30.000Z" };
    expect(F.lastAlertLine([earlier, ...log])).toBe("마지막 공시 알림 7/30(목) 07:03 · SEC에 올라온 뒤 1시간 54분");
    expect(F.lastAlertLine([{ accession: "x", acceptedAt: null, notifiedAt: "2026-07-29T22:03:00.000Z" }])).toBe("마지막 공시 알림 7/30(목) 07:03");
    expect(F.lastAlertLine([])).toBeNull();
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
