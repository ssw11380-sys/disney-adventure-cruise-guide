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

  /**
   * 등록(같은 토큰이면 새로 적음). sessionId: 이 기기를 등록한 로그인 세션 (계정 A단계 — 그 세션을 끊으면 이 등록도 지운다).
   * 플래그가 꺼져 있거나 세션 없이(API 토큰만) 등록하면 null
   */
  async register(input: { token: string; platform: string; deviceName?: string | null; sessionId?: number | null }): Promise<Device> {
    if (!this.push.isValidToken(input.token)) {
      throw new AppError(400, "INVALID_TOKEN", "Expo 푸시 토큰 형식이 아닙니다 (ExponentPushToken[...])");
    }
    const ts = seoulIso(this.now());
    const sessionId = input.sessionId ?? null;
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
        session_id: sessionId,
      })
      .onConflict((oc) =>
        oc.column("token").doUpdateSet({ platform: input.platform, device_name: input.deviceName ?? null, enabled: 1, disabled_reason: null, last_seen_at: ts, session_id: sessionId }),
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

  /**
   * 알림을 보낼 기기. 로그인 세션으로 등록한 기기는 그 세션이 살아 있을 때만 (끊김·기한 지남·지워짐이면 빼고 — 계정 A단계:
   * 로그아웃하거나 '모든 기기에서 로그아웃'으로 끊긴 폰, 자동 로그인을 끈 채 12시간 넘게 안 쓴 폰으로 주인 계좌 알림이 가지 않게).
   * 세션 없이(계정 전·플래그 꺼짐) 등록한 기기는 예전처럼 보낸다
   */
  async enabledTokens(): Promise<string[]> {
    const nowIso = seoulIso(this.now());
    const rows = await this.db
      .selectFrom("devices as d")
      .leftJoin("sessions as s", "s.id", "d.session_id")
      .select("d.token")
      .where("d.enabled", "=", 1)
      .where((eb) => eb.or([eb("d.session_id", "is", null), eb.and([eb("s.id", "is not", null), eb("s.revoked_at", "is", null), eb("s.expires_at", ">", nowIso)])]))
      .execute();
    return rows.map((r) => r.token);
  }
}

function toDevice(r: {
  token: string; platform: string; device_name: string | null; enabled: number; disabled_reason: string | null; created_at: string; last_seen_at: string; session_id?: number | null;
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
