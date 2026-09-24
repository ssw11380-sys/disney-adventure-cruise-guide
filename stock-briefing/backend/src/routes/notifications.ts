import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { normalizeCode } from "../lib/codes.js";
import { notificationSettingsPatch, timeToCron, type NotificationSettingsStore } from "../notifications/settings.js";
import type { BriefingScheduler } from "../scheduler.js";
import type { DeviceService } from "../services/deviceService.js";
import type { NotificationService } from "../services/notificationService.js";

const registerBody = z.object({
  token: z.string().min(10),
  platform: z.enum(["android", "ios", "web", "unknown"]).default("unknown"),
  deviceName: z.string().max(100).nullable().optional(),
});
const tokenParam = z.object({ token: z.string().min(10) });

export interface NotificationRouteDeps {
  devices: DeviceService;
  notifications: NotificationService;
  settings: NotificationSettingsStore;
  scheduler: BriefingScheduler | null;
  /** 앱이 로컬 알림(백그라운드 확인)도 같은 규칙으로 묶게 briefingDigest 상태를 같이 준다 */
  features?: { enabled(key: "briefingDigest"): Promise<boolean> };
}

export const deviceRoutes: FastifyPluginAsync<NotificationRouteDeps> = async (app, { devices }) => {
  app.get("/", async () => devices.list());
  app.post("/", async (req, reply) => {
    const body = registerBody.parse(req.body);
    const d = await devices.register({ token: body.token, platform: body.platform, deviceName: body.deviceName ?? null });
    return reply.code(201).send(d);
  });
  app.delete("/:token", async (req, reply) => {
    const { token } = tokenParam.parse(req.params);
    await devices.unregister(decodeURIComponent(token));
    return reply.code(204).send();
  });
};

export const notificationRoutes: FastifyPluginAsync<NotificationRouteDeps> = async (app, { notifications, settings, scheduler, devices, features }) => {
  const digest = async () => (features ? features.enabled("briefingDigest") : true);
  /** 알림/브리핑 시간 설정 (+ digest: 세션당 1건으로 묶는지, 3-19) */
  app.get("/settings", async () => ({ ...(await settings.get()), digest: await digest(), schedule: scheduler?.status() ?? null }));

  app.put("/settings", async (req) => {
    const patch = notificationSettingsPatch.parse(req.body ?? {});
    if (patch.mutedCodes) patch.mutedCodes = [...new Set(patch.mutedCodes.map(normalizeCode))];
    const next = await settings.update(Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
    scheduler?.reschedule({
      morningCron: next.morningEnabled ? timeToCron(next.morningTime, next.weekdaysOnly) : null,
      afternoonCron: next.afternoonEnabled ? timeToCron(next.afternoonTime, next.weekdaysOnly) : null,
    });
    return { ...next, digest: await digest(), schedule: scheduler?.status() ?? null };
  });

  /** 테스트 알림 */
  app.post("/test", async (_req, reply) => {
    const count = (await devices.enabledTokens()).length;
    if (count === 0) return reply.code(409).send({ error: "NO_DEVICES", message: "등록된 기기가 없습니다. 앱 설정에서 알림을 켜 주세요." });
    return notifications.sendTest();
  });

  /** 영수증 즉시 확인 (운영/디버그) */
  app.post("/receipts", async () => notifications.checkReceipts());
};
