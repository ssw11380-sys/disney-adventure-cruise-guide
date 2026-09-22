import { z } from "zod";
import type { Db } from "../db/index.js";

/**
 * 알림/브리핑 시간 설정. 단일 사용자 앱이라 전역 하나만 두고 meta 테이블에 JSON 으로 저장한다.
 * 시간은 한국 시간 HH:MM.
 */
export const notificationSettingsSchema = z.object({
  morningTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM 형식"),
  afternoonTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM 형식"),
  morningEnabled: z.boolean(),
  afternoonEnabled: z.boolean(),
  weekdaysOnly: z.boolean(),
  pushEnabled: z.boolean(),
});
export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;
export const notificationSettingsPatch = notificationSettingsSchema.partial();

const KEY = "notification_settings";

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
  };
}

export function timeToCron(time: string, weekdaysOnly: boolean): string {
  const [h, m] = time.split(":");
  return `${Number(m)} ${Number(h)} * * ${weekdaysOnly ? "1-5" : "*"}`;
}

export class NotificationSettingsStore {
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

  async update(patch: Partial<NotificationSettings>): Promise<NotificationSettings> {
    const next = notificationSettingsSchema.parse({ ...(await this.get()), ...stripUndefined(patch) });
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
