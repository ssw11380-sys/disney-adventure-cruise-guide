import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { NotFoundError } from "../lib/errors.js";
import { seoulDate, seoulIso } from "../lib/time.js";
import type { FilingWatchService, ScheduleFilingItem, FilingStatus } from "../services/filingAlerts.js";
import type { CollectedEvents, CollectInput } from "../services/holdingEvents.js";

/** 화면 일정(배당락일) 캐시 — 보유 목록·실적 플래그가 바뀌면 버린다 (공시 목록은 늘 새로: 알림을 누르고 들어오면 방금 온 공시가 보이게) */
const EVENTS_CACHE_MS = 10 * 60_000;
/** 화면 '최근 공시 (미국)' 기간·최대 줄 수 */
export const SCHEDULE_FILING_DAYS = 30;
export const SCHEDULE_FILING_LIMIT = 60;

const alertsQuery = z.object({
  days: z.coerce.number("days 는 1~3").int("days 는 1~3").min(1, "days 는 1~3").max(3, "days 는 1~3").default(3),
});

export interface ScheduleResponse {
  asOf: string;
  /** 다가오는 일정 (holdingEvents 끔·출처 없음이면 null). 계좌 브리핑의 events 와 같은 모양 (week 는 늘 null) */
  events: (CollectedEvents & { week: null }) | null;
  /** 최근 공시 (미국) — filingAlerts 끔·서비스 없음이면 null */
  filings: (FilingStatus & { items: ScheduleFilingItem[]; more: number }) | null;
  /** 한국 공시: DART 키가 없으면 noDartKey, 있으면 notYet (이번 범위 밖) */
  kr: { filings: "noDartKey" | "notYet" };
}

/**
 * 3-38 새 공시 알림·일정 화면 경로 (둘 다 개인 경로 — 그 사람의 보유 종목으로 거른다. 표·확인 작업은 공용):
 *  - GET /api/filings/alerts?days=1~3 (플래그 filingAlerts 끔 → 404): 알림 대상 새 공시 (기준 잡기 줄 제외 · 서버가 처음 본 때가 days 일 안 · 최신 먼저 30개)
 *  - GET /api/schedule (플래그 holdingSchedule 끔 → 404): 30일 안 배당락일(holdingEvents) + 최근 30일 미국 공시(filingAlerts) + 한국 공시 안내
 */
export const filingRoutes: FastifyPluginAsync<{
  features: { enabled(k: "filingAlerts" | "holdingSchedule" | "holdingEvents" | "holdingEarnings"): Promise<boolean> };
  filings: Pick<FilingWatchService, "alerts" | "list"> | null;
  events: { collect(input: CollectInput): Promise<CollectedEvents> } | null;
  /** 보유 종목 (수량 > 0, 등록 순) */
  holdings: () => Promise<Array<{ code: string; name: string }>>;
  dartKey: boolean;
  now: () => Date;
}> = async (app, deps) => {
  let eventsCache: { key: string; at: number; value: CollectedEvents } | null = null;

  app.get("/filings/alerts", async (req) => {
    if (!(await deps.features.enabled("filingAlerts").catch(() => false))) throw new NotFoundError("공시 알림이 꺼져 있습니다");
    const { days } = alertsQuery.parse(req.query ?? {});
    const now = deps.now();
    return { asOf: seoulIso(now), items: deps.filings ? await deps.filings.alerts({ days, limit: 30 }) : [] };
  });

  app.get("/schedule", async (): Promise<ScheduleResponse> => {
    if (!(await deps.features.enabled("holdingSchedule").catch(() => false))) throw new NotFoundError("일정·공시 화면이 꺼져 있습니다");
    const now = deps.now();
    const [eventsOn, earnings, filingsOn] = await Promise.all([
      deps.features.enabled("holdingEvents").catch(() => false),
      // holdingEarnings 는 읽기만 (사용자 승인 뒤 켬 — 이 화면은 바꾸지 않는다)
      deps.features.enabled("holdingEarnings").catch(() => false),
      deps.features.enabled("filingAlerts").catch(() => false),
    ]);
    const loadEvents = async (): Promise<ScheduleResponse["events"]> => {
      if (!eventsOn || !deps.events) return null;
      const holdings = await deps.holdings();
      const key = `${earnings ? 1 : 0}|${holdings.map((h) => `${h.code}:${h.name}`).join(",")}`;
      const t = now.getTime();
      if (eventsCache && eventsCache.key === key && t - eventsCache.at < EVENTS_CACHE_MS && t >= eventsCache.at) return { ...eventsCache.value, week: null };
      const value = await deps.events.collect({ holdings, today: seoulDate(now), asOf: seoulIso(now), earnings });
      eventsCache = { key, at: t, value };
      return { ...value, week: null };
    };
    const loadFilings = async (): Promise<ScheduleResponse["filings"]> => {
      if (!filingsOn || !deps.filings) return null;
      const r = await deps.filings.list({ days: SCHEDULE_FILING_DAYS, limit: SCHEDULE_FILING_LIMIT });
      return { ...r.status, items: r.items, more: r.total - r.items.length };
    };
    const [events, filings] = await Promise.all([loadEvents(), loadFilings()]);
    return { asOf: seoulIso(now), events, filings, kr: { filings: deps.dartKey ? "notYet" : "noDartKey" } };
  });
};
