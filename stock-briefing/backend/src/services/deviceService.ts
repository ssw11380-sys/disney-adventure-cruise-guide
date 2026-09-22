import type { Db } from "../db/index.js";
import { AppError, NotFoundError } from "../lib/errors.js";
import { seoulIso } from "../lib/time.js";
import type { PushSender } from "../notifications/push.js";

export interface Device {
  token: string;
  platform: string;
  deviceName: string | null;
  enabled: boolean;
  disabledReason: string | null;
  createdAt: string;
  lastSeenAt: string;
}

/** 푸시 토큰(기기) 등록 관리. 토큰이 곧 기기 식별자다. */
export class DeviceService {
  private readonly now: () => Date;

  constructor(
    private readonly db: Db,
    private readonly push: PushSender,
    now?: () => Date,
  ) {
    this.now = now ?? (() => new Date());
  }

  async register(input: { token: string; platform: string; deviceName?: string | null }): Promise<Device> {
    if (!this.push.isValidToken(input.token)) {
      throw new AppError(400, "INVALID_TOKEN", "Expo 푸시 토큰 형식이 아닙니다 (ExponentPushToken[...])");
    }
    const ts = seoulIso(this.now());
    await this.db
      .insertInto("devices")
      .values({
        token: input.token,
        platform: input.platform,
        device_name: input.deviceName ?? null,
        enabled: 1,
        disabled_reason: null,
        created_at: ts,
        last_seen_at: ts,
      })
      .onConflict((oc) =>
        oc.column("token").doUpdateSet({ platform: input.platform, device_name: input.deviceName ?? null, enabled: 1, disabled_reason: null, last_seen_at: ts }),
      )
      .execute();
    return (await this.get(input.token))!;
  }

  async unregister(token: string): Promise<void> {
    const r = await this.db.deleteFrom("devices").where("token", "=", token).executeTakeFirst();
    if (Number(r.numDeletedRows) === 0) throw new NotFoundError("등록되지 않은 기기입니다");
  }

  async disable(token: string, reason: string): Promise<void> {
    await this.db.updateTable("devices").set({ enabled: 0, disabled_reason: reason }).where("token", "=", token).execute();
  }

  async get(token: string): Promise<Device | null> {
    const r = await this.db.selectFrom("devices").selectAll().where("token", "=", token).executeTakeFirst();
    return r ? toDevice(r) : null;
  }

  async list(): Promise<Device[]> {
    return (await this.db.selectFrom("devices").selectAll().orderBy("created_at").execute()).map(toDevice);
  }

  async enabledTokens(): Promise<string[]> {
    return (await this.db.selectFrom("devices").select("token").where("enabled", "=", 1).execute()).map((r) => r.token);
  }
}

function toDevice(r: {
  token: string; platform: string; device_name: string | null; enabled: number; disabled_reason: string | null; created_at: string; last_seen_at: string;
}): Device {
  return {
    token: r.token,
    platform: r.platform,
    deviceName: r.device_name,
    enabled: r.enabled === 1,
    disabledReason: r.disabled_reason,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
  };
}
