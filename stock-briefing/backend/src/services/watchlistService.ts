import { randomUUID } from "node:crypto";
import type { PushMessage } from "../notifications/push.js";
import type { Db } from "../db/index.js";
import type { Quote } from "../domain/types.js";
import { isKrCode } from "../lib/codes.js";
import { mapLimit } from "../lib/concurrency.js";
import { AppError } from "../lib/errors.js";
import { tradingDate } from "./marketContext.js";
import type { StockService } from "./stockService.js";
import type { FeatureService } from "./featureService.js";
import type { NotificationService } from "./notificationService.js";
import type { NotificationSettingsStore } from "../notifications/settings.js";

export interface WatchInput { startPrice: number; desiredPrice: number; alerts: boolean }
const SETTINGS_KEY = "movement_alert_settings";
export const MOVEMENT_INTERVAL_MS = 30_000;

/** 경계의 부동소수 오차만 보정한다. 4.99%를 5%로 올리지 않는다. */
export function movementLevel(price: number, basis: number): number {
  if (!(Number.isFinite(price) && price > 0 && Number.isFinite(basis) && basis > 0)) return 0;
  const rate = (price - basis) / basis * 100;
  return Math.sign(rate) * Math.floor((Math.abs(rate) + 1e-9) / 5) * 5;
}

export function movementDate(q: Quote, now: Date): string | null {
  const at = Date.parse(q.asOf), t = now.getTime();
  if (q.stale || !Number.isFinite(at) || at > t + 30_000 || t - at > 180_000) return null;
  if (!q.session?.open || q.session.eligible === false || (q.session.until && Date.parse(q.session.until) <= t)) return null;
  const date = tradingDate(q.asOf, isKrCode(q.code));
  return date === tradingDate(now.toISOString(), isKrCode(q.code)) ? date : null;
}

export class WatchlistService {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;
  constructor(private readonly deps: { db: Db; stocks: StockService; features: FeatureService; notifications: NotificationService; settings: NotificationSettingsStore; now: () => Date; warn: () => void; onChange?: () => Promise<void> }) {}

  async list(quotes = true) {
    const rows = await this.deps.db.selectFrom("watch_items").selectAll().orderBy("created_at", "desc").orderBy("code").execute();
    const current = quotes ? await this.deps.stocks.quotesFor(rows.map(r => r.code)) : new Map<string, Quote>();
    return rows.map(r => ({ code: r.code, name: r.name, market: r.market,
      startPrice: r.start_price, desiredPrice: r.desired_price, alerts: !!r.alerts,
      createdAt: r.created_at, updatedAt: r.updated_at, currency: isKrCode(r.code) ? "KRW" as const : "USD" as const,
      quote: current.get(r.code) ?? null }));
  }

  async save(code: string, input: WatchInput) {
    const db = this.deps.db;
    const prev = await db.selectFrom("watch_items").selectAll().where("code", "=", code).executeTakeFirst();
    const stock = prev ?? await this.deps.stocks.get(code) ?? await this.deps.stocks.preview(code);
    if (!stock) throw new AppError(404, "NOT_FOUND", "종목을 찾을 수 없습니다");
    if (!prev && (await db.selectFrom("watch_items").select("code").execute()).length >= 100) throw new AppError(409, "LIMIT", "관심종목은 최대 100개까지 담을 수 있습니다");
    const now = this.deps.now().toISOString();
    const revision = prev && prev.start_price === input.startPrice ? prev.revision : randomUUID();
    await db.transaction().execute(async trx => {
    await trx.insertInto("watch_items").values({ code, name: stock.name, market: stock.market,
      start_price: input.startPrice, desired_price: input.desiredPrice, alerts: Number(input.alerts), revision, created_at: now, updated_at: now })
      .onConflict(c => c.column("code").doUpdateSet({ start_price: input.startPrice, desired_price: input.desiredPrice, alerts: Number(input.alerts), revision, updated_at: now })).execute();
    if (prev && prev.revision !== revision) await trx.deleteFrom("movement_events").where("event_key", "like", `movement:watch:${code}:${prev.revision}:%`).execute();
    });
    await this.deps.onChange?.();
    return { ok: true };
  }

  async remove(code: string) {
    await this.deps.db.transaction().execute(async trx => {
      await trx.deleteFrom("watch_items").where("code", "=", code).execute();
      await trx.deleteFrom("movement_events").where("code", "=", code).where("scope", "=", "watch").execute();
    });
    await this.deps.onChange?.();
    // 보유 종목·보고서·토스 동기화 제외 목록은 변경하지 않는다.
  }

  async settings() {
    const row = await this.deps.db.selectFrom("meta").select("value").where("key", "=", SETTINGS_KEY).executeTakeFirst();
    if (!row) return { holdings: true };
    const parsed = JSON.parse(row.value) as { holdings?: boolean };
    return { holdings: parsed.holdings !== false };
  }
  async setSettings(holdings: boolean) {
    await this.deps.db.insertInto("meta").values({ key: SETTINGS_KEY, value: JSON.stringify({ holdings }) })
      .onConflict(c => c.column("key").doUpdateSet({ value: JSON.stringify({ holdings }) })).execute();
    return { holdings };
  }

  async events() {
    const [settings, notification, items, holdings] = await Promise.all([this.settings(), this.deps.settings.get(), this.list(false), this.deps.stocks.list()]);
    if (!notification.pushEnabled) return { events: [] };
    const watched = new Set(items.filter(s => s.alerts).map(s => s.code));
    const held = new Set(holdings.filter(s => s.quantity !== null && s.quantity > 0).map(s => s.code));
    const rows = await this.deps.db.selectFrom("movement_events").selectAll()
      .where("created_at", ">=", new Date(this.deps.now().getTime() - 24 * 3_600_000).toISOString()).orderBy("created_at", "asc").limit(1000).execute();
    return { events: rows.filter(r => r.scope === "watch" ? watched.has(r.code) : settings.holdings && held.has(r.code))
      .map(r => ({ id: r.event_key, createdAt: r.created_at, ...JSON.parse(r.payload) as PushMessage })) };
  }

  start() {
    this.stopped = false;
    const next = async () => {
      try { await this.check(); } catch { this.deps.warn(); }
      if (!this.stopped) { this.timer = setTimeout(() => void next(), MOVEMENT_INTERVAL_MS); this.timer.unref(); }
    };
    // HTTP 응답·보고서 생성과 독립해서 실행한다.
    this.timer = setTimeout(() => void next(), MOVEMENT_INTERVAL_MS); this.timer.unref();
  }
  async stop() { this.stopped = true; if (this.timer) clearTimeout(this.timer); await this.running; }
  check(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.checkNow().finally(() => { this.running = null; });
    return this.running;
  }

  private async checkNow() {
    if (!(await this.deps.features.enabled("watchlistSteps"))) return;
    if (!(await this.deps.settings.get()).pushEnabled) return;
    const [settings, watch, held] = await Promise.all([this.settings(), this.deps.db.selectFrom("watch_items").selectAll().where("alerts", "=", 1).execute(), this.deps.stocks.list()]);
    const holdings = settings.holdings ? held.filter(s => s.quantity !== null && s.quantity > 0) : [];
    const codes = [...new Set([...watch.map(s => s.code), ...holdings.map(s => s.code)])];
    const quotes = await this.deps.stocks.quotesFor(codes);
    await mapLimit(codes, 4, async code => {
      try {
        const q = quotes.get(code);
        if (!q) return;
        const date = movementDate(q, this.deps.now());
        if (!date || this.stopped) return;
        const w = watch.find(s => s.code === code);
        if (w) {
          const current = await this.deps.db.selectFrom("watch_items").select(["revision", "alerts"]).where("code", "=", code).executeTakeFirst();
          if (current?.revision === w.revision && current.alerts) await this.notify(q, w.name, w.start_price, `watch:${code}:${w.revision}`, "관심 시작 가격", "watch");
        }
        const h = holdings.find(s => s.code === code);
        if (h && q.prevClose && q.prevClose > 0) await this.notify(q, h.name, q.prevClose, `holding:${code}:${date}`, "전일 종가", "holding");
      } catch { this.deps.warn(); }
    });
    // 거래일별 기록만 정리한다. 관심 시작 가격의 누적 구간 기록은 유지한다.
    await this.deps.db.deleteFrom("movement_marks").where("mark_key", "like", "holding:%")
      .where("created_at", "<", new Date(this.deps.now().getTime() - 35 * 86_400_000).toISOString()).execute();
    await this.deps.db.deleteFrom("movement_events").where("created_at", "<", new Date(this.deps.now().getTime() - 7 * 86_400_000).toISOString()).execute();
  }

  private async notify(q: Quote, name: string, basis: number, key: string, label: string, scope: string) {
    const level = movementLevel(q.price, basis);
    if (!level) return;
    const field = level > 0 ? "up" : "down", value = Math.abs(level), db = this.deps.db;
    await db.insertInto("movement_marks").values({ mark_key: key, up: 0, down: 0, created_at: this.deps.now().toISOString() }).onConflict(c => c.column("mark_key").doNothing()).execute();
    const mark = await db.selectFrom("movement_marks").selectAll().where("mark_key", "=", key).executeTakeFirstOrThrow();
    if (mark[field] >= value) return;
    const format = (n: number) => q.currency === "USD" ? `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : `${n.toLocaleString("ko-KR", { maximumFractionDigits: 0 })}원`;
    // 영속 발송 기록이 같은 구간의 다중 인스턴스·재시작 중복 발송을 차단한다.
    const message: PushMessage = { channelId: "prices",
      title: `${name} ${scope === "watch" ? "관심 기준" : "전일 대비"} ${level > 0 ? "+" : "−"}${value}% 구간 도달`,
      body: `${label} ${format(basis)} 대비 ${level > 0 ? "상승" : "하락"}\n현재 ${format(q.price)} · 실제 ${((q.price - basis) / basis * 100).toFixed(2)}%\n시세 ${q.asOf}`,
      data: { type: "movementAlert", code: q.code, scope, level, basis, asOf: q.asOf } };
    const eventKey = `movement:${key}:${field}:${value}`;
    // 푸시 미지원 설치본도 다음 기기 확인에서 같은 사건을 받을 수 있게 발송 전에 보존한다.
    await db.insertInto("movement_events").values({ event_key: eventKey, code: q.code, scope, payload: JSON.stringify(message), created_at: this.deps.now().toISOString() })
      .onConflict(c => c.column("event_key").doNothing()).execute();
    await this.deps.notifications.sendToAll(message, eventKey);
    await db.updateTable("movement_marks").set({ [field]: value }).where("mark_key", "=", key).where(field, "<", value).execute();
  }
}
