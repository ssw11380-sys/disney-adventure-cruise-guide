import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { CODE_RE, normalizeCode } from "../lib/codes.js";
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
const codeSchema = z.string().transform(normalizeCode).pipe(z.string().regex(CODE_RE, "종목 코드 형식이 아닙니다"));
/** 종목 하나만 알림 끄기/켜기 (3-19) */
const muteBody = z.object({ mute: z.object({ code: codeSchema, muted: z.boolean() }).optional(), mutedCodes: z.array(codeSchema).max(200).optional() });

export interface NotificationRouteDeps {
  devices: DeviceService;
  notifications: NotificationService;
  settings: NotificationSettingsStore;
  scheduler: BriefingScheduler | null;
  /** 앱이 로컬 알림(백그라운드 확인)도 같은 규칙으로 묶게 briefingDigest·accountBriefing 상태를 같이 준다 */
  features?: { enabled(key: "briefingDigest" | "accountBriefing"): Promise<boolean> };
  /** 브리핑 실행 중인지 (앱 백그라운드 알림이 실행 도중엔 알리지 않고 기다리게) */
  isRunning?: () => boolean;
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

export const notificationRoutes: FastifyPluginAsync<NotificationRouteDeps> = async (app, { notifications, settings, scheduler, devices, features, isRunning }) => {
  const extra = async () => ({
    digest: features ? await features.enabled("briefingDigest") : true,
    // 3-31: 앱 백그라운드 알림도 세션 알림 앞머리를 계좌 요약으로 (예전 앱은 모르는 칸이라 무시)
    accountBriefing: features ? await features.enabled("accountBriefing") : false,
    running: isRunning?.() ?? scheduler?.status().running ?? false,
    schedule: scheduler?.status() ?? null,
  });
  /** 알림/브리핑 시간 설정 (+ digest: 세션당 1건으로 묶는지, running: 브리핑·계좌 브리핑 만드는 중, 3-19 · accountBriefing: 3-31) */
  app.get("/settings", async () => ({ ...(await settings.get()), ...(await extra()) }));

  app.put("/settings", async (req) => {
    const patch = notificationSettingsPatch.parse(req.body ?? {});
    const { mute, mutedCodes } = muteBody.parse(req.body ?? {});
    if (mutedCodes) patch.mutedCodes = [...new Set(mutedCodes)];
    const next = await settings.update(Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)), mute);
    scheduler?.reschedule({
      morningCron: next.morningEnabled ? timeToCron(next.morningTime, next.weekdaysOnly) : null,
      afternoonCron: next.afternoonEnabled ? timeToCron(next.afternoonTime, next.weekdaysOnly) : null,
    });
    return { ...next, ...(await extra()) };
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
