import { z } from "zod";
import type { Db } from "../db/index.js";

/**
 * 알림/브리핑 시간 설정. 단일 사용자 앱이라 전역 하나만 두고 meta 테이블에 JSON 으로 저장한다.
 * 시간은 한국 시간 HH:MM.
 */
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM 형식");
export const notificationSettingsSchema = z.object({
  morningTime: hhmm,
  afternoonTime: hhmm,
  morningEnabled: z.boolean(),
  afternoonEnabled: z.boolean(),
  weekdaysOnly: z.boolean(),
  pushEnabled: z.boolean(),
  /** 조용한 시간 (3-19): 이 사이에는 브리핑 알림을 보내지 않는다(브리핑은 그대로 만들어 탭에 있음). 한국 시간 */
  quietEnabled: z.boolean(),
  quietStart: hhmm,
  quietEnd: hhmm,
  /** 알림을 끈 종목 코드 (브리핑은 계속 만든다) */
  mutedCodes: z.array(z.string().min(1).max(20)).max(200),
});
export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;
export const notificationSettingsPatch = notificationSettingsSchema.partial();

const KEY = "notification_settings";

/** 3-19 에 더한 항목의 기본값 (예전에 저장한 설정에는 없음) */
export const NOTIFY_DEFAULTS = { quietEnabled: true, quietStart: "22:00", quietEnd: "07:00", mutedCodes: [] as string[] };

/** 환경변수 cron("30 8 * * 1-5")에서 기본 시간을 뽑는다. 파싱이 안 되면 08:30/16:00 */
export function defaultsFromCron(morningCron: string, afternoonCron: string): NotificationSettings {
  const parse = (expr: string, fallback: string): { time: string; weekdays: boolean } => {
    const parts = expr.trim().split(/\s+/);
    if (parts.length !== 5) return { time: fallback, weekdays: true };
    const [m, h, , , dow] = parts;
    if (!/^\d{1,2}$/.test(m!) || !/^\d{1,2}$/.test(h!)) return { time: fallback, weekdays: true };
    return { time: `${h!.padStart(2, "0")}:${m!.padStart(2, "0")}`, weekdays: dow !== "*" };
  };
  const a = parse(morningCron, "08:30");
  const b = parse(afternoonCron, "16:00");
  return {
    morningTime: a.time,
    afternoonTime: b.time,
    morningEnabled: true,
    afternoonEnabled: true,
    weekdaysOnly: a.weekdays && b.weekdays,
    pushEnabled: true,
    ...NOTIFY_DEFAULTS,
  };
}

export function timeToCron(time: string, weekdaysOnly: boolean): string {
  const [h, m] = time.split(":");
  return `${Number(m)} ${Number(h)} * * ${weekdaysOnly ? "1-5" : "*"}`;
}

export class NotificationSettingsStore {
  /** 바꾸기는 한 줄로 (읽고-고쳐-쓰기 사이에 다른 변경이 사라지지 않게) */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly db: Db,
    private readonly defaults: NotificationSettings,
  ) {}

  async get(): Promise<NotificationSettings> {
    const row = await this.db.selectFrom("meta").select("value").where("key", "=", KEY).executeTakeFirst();
    if (!row) return this.defaults;
    try {
      const parsed = notificationSettingsSchema.partial().parse(JSON.parse(row.value));
      return notificationSettingsSchema.parse({ ...this.defaults, ...stripUndefined(parsed) });
    } catch {
      return this.defaults;
    }
  }

  /** mute: 종목 하나만 알림 끄기/켜기 (목록 전체를 보내지 않아 연달아 눌러도 앞의 변경을 잃지 않는다) */
  update(patch: Partial<NotificationSettings>, mute?: { code: string; muted: boolean }): Promise<NotificationSettings> {
    const run = this.queue.then(() => this.apply(patch, mute));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async apply(patch: Partial<NotificationSettings>, mute?: { code: string; muted: boolean }): Promise<NotificationSettings> {
    const merged = { ...(await this.get()), ...stripUndefined(patch) };
    if (mute) merged.mutedCodes = mute.muted ? [...new Set([...merged.mutedCodes, mute.code])] : merged.mutedCodes.filter((c) => c !== mute.code);
    const next = notificationSettingsSchema.parse(merged);
    const value = JSON.stringify(next);
    await this.db
      .insertInto("meta")
      .values({ key: KEY, value })
      .onConflict((oc) => oc.column("key").doUpdateSet({ value }))
      .execute();
    return next;
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
