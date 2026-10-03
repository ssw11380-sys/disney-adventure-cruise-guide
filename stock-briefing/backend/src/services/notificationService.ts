import { buildDigest, inQuietHours } from "../notifications/digest.js";
import { randomUUID } from "node:crypto";
import type { PushMessage, PushSender } from "../notifications/push.js";
import type { NotificationSettingsStore } from "../notifications/settings.js";
import { RECEIPT_MAX_AGE_MS, type PendingReceipt, type ReceiptStore, type ReceiptClaim } from "../notifications/receiptStore.js";
import type { DeliveryStatus, DispatchClaim } from "../notifications/pushDispatchStore.js";
import { digestAccount, type AccountBriefing } from "./accountBriefingService.js";
import { digestMarket, type MarketSummary } from "./marketSummaryService.js";
import type { Briefing, SessionDone } from "./briefingService.js";
import type { DeviceService } from "./deviceService.js";

export interface NotificationLog {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface SendSummary {
  sent: number;
  failed: number;
  disabled: string[]; // 비활성화된 토큰
  suppressed?: number;
  uncertain?: number;
}

/** Expo 영수증은 24시간 뒤 삭제된다. 그 전에는 기존 예약 간격으로 확인하며 발송은 반복하지 않는다.
 * https://docs.expo.dev/push-notifications/sending-notifications/#check-push-receipts-for-errors
 */

/**
 * 브리핑 알림 푸시.
 *  - briefingDigest 플래그가 켜져 있으면(기본) 실행 한 번(세션)이 끝날 때 1건으로 묶어 보낸다: "오후 브리핑 17종목 · 변동 상위 2개".
 *    조용한 시간(기본 22~07시, 한국 시간)에는 보내지 않고, 알림을 끈 종목은 빼고 센다 (3-19)
 *  - 꺼져 있으면 예전처럼 브리핑이 생성될 때마다 종목별로 1건
 *  - 묶음일 때 상세의 "이 종목 다시 만들기"(일부 종목 수동 실행)는 푸시하지 않는다 — 누른 사람이 화면에서 결과를 본다
 * 영수증(receipt)은 전송 후 일정 시간 뒤에 확인해서 DeviceNotRegistered 기기를 비활성화한다.
 */
export class NotificationService {
  /** 실행 중인 세션이 시작할 때 읽은 briefingDigest 값 (실행 도중 플래그를 바꿔도 알림이 겹치거나 빠지지 않게) */
  private sessionDigest: boolean | null = null;
  private pendingReceipts: PendingReceipt[] = [];
  private receiptTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private restoreNeeded = false;
  private readonly unpersisted = new Map<string, PendingReceipt>();
  private readonly checkingReceiptIds = new Set<string>();
  private durableCheckRunning = false;

  constructor(
    private readonly deps: {
      push: PushSender;
      devices: DeviceService;
      settings: NotificationSettingsStore;
      receipts?: ReceiptStore;
      log?: NotificationLog;
      /** 영수증 확인까지 대기 시간 (기본 15분). 테스트에서 0 */
      receiptDelayMs?: number;
      /** 기능 플래그 (없으면 briefingDigest 켜짐으로 본다) */
      features?: { enabled(key: "briefingDigest"): Promise<boolean> };
      now?: () => Date;
    },
  ) {}

  /** 시작할 때만 복구한다. 읽기 실패는 기존 영수증 확인 간격으로 다시 확인한다. */
  async resumeReceipts(schedule = true): Promise<void> {
    if (this.stopped || !this.deps.receipts) return;
    this.restoreNeeded = true;
    try {
      const now = (this.deps.now?.() ?? new Date()).getTime();
      const acknowledged = await this.deps.receipts.dispatches.recover(now);
      if (acknowledged.length) await this.deps.receipts.save(acknowledged);
      const restored = await this.deps.receipts.load(now);
      if (this.stopped) return;
      const queued = new Set([...this.checkingReceiptIds, ...this.pendingReceipts.map((r) => r.receiptId)]);
      for (const receipt of restored) if (!queued.has(receipt.receiptId)) { this.pendingReceipts.push(receipt); queued.add(receipt.receiptId); }
      this.restoreNeeded = false;
    } catch { this.deps.log?.warn({}, "푸시 영수증 복구 실패"); }
    if (schedule) this.scheduleReceiptCheck();
  }

  private async persistReceipts(): Promise<void> {
    if (this.stopped || !this.deps.receipts || !this.unpersisted.size) return;
    const pending = [...this.unpersisted.values()];
    try {
      await this.deps.receipts.save(pending);
      for (const receipt of pending) this.unpersisted.delete(receipt.receiptId);
    } catch { this.deps.log?.warn({ count: pending.length }, "푸시 영수증 저장 실패"); }
  }

  /** BriefingService.onBriefing 에 붙이는 리스너 */
  readonly onBriefing = async (b: Briefing, eventId?: string): Promise<void> => {
    if (b.status !== "ok") return;
    if (this.sessionDigest ?? (await this.digestOn())) return; // 세션이 끝날 때 묶어서 (onSession)
    const s = await this.deps.settings.get();
    if (!s.pushEnabled) return;
    const sessionLabel = b.session === "morning" ? "오전" : "오후";
    await this.sendToAll({
      title: `${b.name ?? b.code} ${sessionLabel} 브리핑`,
      body: b.summary,
      data: { type: "briefing", briefingId: b.id, code: b.code, session: b.session, date: b.date },
    }, eventId ? `briefing:${eventId}:${b.code}` : `briefing:${b.id}:${b.createdAt}`);
  };

  /** BriefingService.onSessionDone 에 붙이는 리스너: 세션 알림 1건 */
  readonly onSessionStart = async (): Promise<void> => {
    this.sessionDigest = await this.digestOn();
  };

  /**
   * market: 이번 실행에서 만든 시장 전체 요약(플래그 marketSummary). 있으면 본문 첫 줄 (제목·다른 줄은 그대로).
   * account: 이번 실행에서 새로 만든 계좌 브리핑(3-31, 플래그 accountBriefing). 있으면 알림 앞머리가 계좌 요약이 되고,
   * 새 종목 브리핑이 알릴 것이 없어도(모델 장애로 모두 실패, 알림을 끈 종목만 성공) 계좌 브리핑으로 1건. 없으면 예전 그대로.
   * 단 이번 실행의 종목(results)을 모두 알림 끔으로 둔 사용자에게는 계좌 요약도 보내지 않는다 — 예전처럼 0건 (앱 로컬 알림과 같은 규칙)
   */
  readonly onSession = async (done: SessionDone & { eventId?: string; account?: AccountBriefing | null; market?: MarketSummary | null; results?: ReadonlyArray<{ code: string }> }): Promise<void> => {
    const digest = this.sessionDigest ?? (await this.digestOn());
    this.sessionDigest = null;
    if (!digest) return;
    if (done.trigger === "manual" && done.partial) return;
    const s = await this.deps.settings.get();
    if (!s.pushEnabled) return;
    const now = this.deps.now?.() ?? new Date();
    if (inQuietHours(s, now)) {
      this.deps.log?.info({ session: done.session, count: done.created.length, quiet: `${s.quietStart}~${s.quietEnd}` }, "조용한 시간이라 브리핑 알림 보내지 않음");
      return;
    }
    const muted = new Set(s.mutedCodes);
    const items = done.created
      .filter((c) => !muted.has(c.briefing.code))
      .map((c) => ({ briefingId: c.briefing.id, code: c.briefing.code, name: c.briefing.name ?? c.briefing.code, summary: c.briefing.summary, changeRate: c.changeRate }));
    const codes = done.results?.map((r) => r.code) ?? done.created.map((c) => c.briefing.code);
    const allMuted = codes.length > 0 && codes.every((c) => muted.has(c));
    // market(시장 전체 요약): 본문 첫 줄만 더한다 — 요약만으로는 알림을 만들지 않고, 문구는 보내는 순간 기준('밤사이'·'오늘')
    const msg = buildDigest(done.session, done.date, items, allMuted ? null : digestAccount(done.account), digestMarket(done.market, now));
    if (!msg) {
      this.deps.log?.info({ session: done.session, muted: done.created.length }, "알림을 끈 종목뿐이라 보내지 않음");
      return;
    }
    // 같은 저장 결과의 재통지만 합치고, force로 새로 만든 결과의 알림은 유지한다.
    const eventId = done.eventId ?? (done.force ? `force:${randomUUID()}`
      : JSON.stringify([done.date, done.session, done.created.map((c) => [c.briefing.id, c.briefing.createdAt]).sort(), done.account?.id, done.account?.createdAt]));
    await this.sendToAll(msg, eventId);
  };

  private async digestOn(): Promise<boolean> {
    return this.deps.features ? this.deps.features.enabled("briefingDigest") : true;
  }

  async sendTest(): Promise<SendSummary> {
    return this.sendToAll({
      title: "주식 브리핑 테스트 알림",
      body: "알림이 정상적으로 도착했습니다.\n브리핑은 설정한 시간에 이렇게 도착합니다.",
      data: { type: "test" },
    }, `test:${randomUUID()}`);
  }

  async deliveryStatus(): Promise<DeliveryStatus> {
    return this.deps.receipts ? this.deps.receipts.dispatches.status((this.deps.now?.() ?? new Date()).getTime())
      : { sending: 0, uncertain: 0, accepted: 0, failed: 0, lastUncertainAt: null };
  }

  async sendToAll(message: PushMessage, eventId = JSON.stringify(message)): Promise<SendSummary> {
    let tokens = await this.deps.devices.enabledTokens();
    const summary: SendSummary = { sent: 0, failed: 0, disabled: [] };
    if (tokens.length === 0) {
      this.deps.log?.info({ title: message.title }, "푸시 대상 기기 없음");
      return summary;
    }
    let dispatches: DispatchClaim[] = [];
    if (this.deps.receipts) {
      // 이 저장이 실패하면 외부 발송을 시작하지 않는다. 재시작 후 알 수 없는 발송을 만들지 않기 위해서다.
      dispatches = await this.deps.receipts.dispatches.begin(eventId, tokens, (this.deps.now?.() ?? new Date()).getTime());
      if (dispatches.length < tokens.length) summary.suppressed = tokens.length - dispatches.length;
      tokens = dispatches.map((claim) => claim.token);
      if (!tokens.length) return summary;
    }
    let results;
    try { ({ results } = await this.deps.push.send(tokens, message)); }
    catch (error) {
      if (this.deps.receipts && !this.stopped) {
        try { await this.deps.receipts.dispatches.checkpoint(dispatches, [], (this.deps.now?.() ?? new Date()).getTime()); }
        catch { this.deps.log?.warn({}, "푸시 미확인 상태 저장 실패"); }
      }
      throw error;
    }
    const byToken = new Map(dispatches.map((claim) => [claim.token, claim.key]));
    if (this.deps.receipts && !this.stopped) {
      try { await this.deps.receipts.dispatches.checkpoint(dispatches, results, (this.deps.now?.() ?? new Date()).getTime()); }
      catch { this.deps.log?.warn({}, "푸시 응답 기록 실패 — 발송 반복 없이 영수증 저장 재시도"); }
    }
    const returnedTokens = new Set(results.map((result) => result.token));
    const missingResponses = tokens.filter((token) => !returnedTokens.has(token)).length;
    if (missingResponses) summary.uncertain = missingResponses;
    for (const r of results) {
      if (r.ok) {
        summary.sent++;
        if (r.receiptId && !this.stopped) {
          const dispatchKey = byToken.get(r.token);
          const receipt = { receiptId: r.receiptId, token: r.token, receivedAt: (this.deps.now?.() ?? new Date()).getTime(), ...(dispatchKey ? { dispatchKey } : {}) };
          this.pendingReceipts.push(receipt);
          if (this.deps.receipts) this.unpersisted.set(r.receiptId, receipt);
        }
      } else {
        summary.failed++;
        if (!r.error || r.error.startsWith("SendFailed:")) summary.uncertain = (summary.uncertain ?? 0) + 1;
        if (!this.stopped && (r.error === "DeviceNotRegistered" || r.error === "InvalidToken")) {
          try {
            await this.deps.devices.disable(r.token, r.error);
            summary.disabled.push(r.token);
          } catch {
            // 이미 보낸 다른 기기의 결과·영수증은 계속 처리한다. 발송 자체는 다시 하지 않는다.
            this.deps.log?.warn({}, "푸시 기기 비활성화 저장 실패");
          }
        }
        this.deps.log?.warn({ token: mask(r.token), err: r.error }, "푸시 전송 실패");
      }
    }
    this.deps.log?.info({ title: message.title, ...summary, disabled: summary.disabled.length }, "푸시 전송");
    if (this.deps.receipts && this.unpersisted.size) await this.persistReceipts();
    this.scheduleReceiptCheck();
    return summary;
  }

  private scheduleReceiptCheck(): void {
    if (this.stopped || this.receiptTimer || (this.pendingReceipts.length === 0 && !this.restoreNeeded)) return;
    const delay = this.deps.receiptDelayMs ?? 15 * 60_000;
    this.receiptTimer = setTimeout(() => {
      this.receiptTimer = null;
      void this.checkReceipts();
    }, delay);
    this.receiptTimer.unref?.();
  }

  /** 대기 중인 영수증을 확인한다. 반환: 비활성화한 토큰 수 */
  async checkReceipts(): Promise<{ checked: number; disabled: number }> {
    if (this.stopped) return { checked: 0, disabled: 0 };
    if (this.deps.receipts) return this.checkDurableReceipts();
    if (this.restoreNeeded) await this.resumeReceipts(false);
    if (this.deps.receipts && this.unpersisted.size) await this.persistReceipts();
    if (this.stopped) return { checked: 0, disabled: 0 };
    const queuedAtStart = this.pendingReceipts;
    this.pendingReceipts = [];
    const now = (this.deps.now?.() ?? new Date()).getTime();
    const pending = queuedAtStart.filter((receipt) => now - receipt.receivedAt < RECEIPT_MAX_AGE_MS);
    if (pending.length < queuedAtStart.length) this.deps.log?.warn({ count: queuedAtStart.length - pending.length }, "푸시 영수증 확인 기한 초과");
    if (pending.length === 0) { await this.removeReceipts(queuedAtStart); this.scheduleReceiptCheck(); return { checked: 0, disabled: 0 }; }
    let disabled = 0;
    const remaining = new Map(pending.map((p) => [p.receiptId, p]));
    for (const receipt of pending) this.checkingReceiptIds.add(receipt.receiptId);
    try {
      const receipts = await this.deps.push.checkReceipts(pending.map((p) => p.receiptId));
      for (const r of receipts) {
        if (this.stopped) break;
        const receipt = remaining.get(r.receiptId);
        if (!receipt) continue;
        if (!r.ok) {
          this.deps.log?.warn({ token: mask(receipt.token), err: r.error }, "푸시 영수증 오류");
          if (r.error === "DeviceNotRegistered") {
            try {
              await this.deps.devices.disable(receipt.token, r.error);
              disabled++;
            } catch {
              // 이 영수증만 다음 확인으로 남기고 나머지 성공분은 계속 처리한다.
              this.deps.log?.warn({}, "푸시 기기 비활성화 저장 실패");
              continue;
            }
          }
        }
        remaining.delete(r.receiptId);
      }
    } catch {
      this.deps.log?.warn({}, "푸시 영수증 확인 실패");
    } finally {
      // 확인 도중 새로 발송한 영수증은 유지하고 미완료 건만 중복 없이 합친다.
      const queued = new Set(this.pendingReceipts.map((p) => p.receiptId));
      let exhausted = 0;
      const finishedAt = (this.deps.now?.() ?? new Date()).getTime();
      for (const receipt of remaining.values()) {
        if (this.stopped) break;
        if (finishedAt - receipt.receivedAt >= RECEIPT_MAX_AGE_MS) { exhausted++; continue; }
        if (!queued.has(receipt.receiptId)) {
          this.pendingReceipts.push(receipt);
          queued.add(receipt.receiptId);
        }
      }
      if (exhausted) this.deps.log?.warn({ count: exhausted }, "푸시 영수증 확인 기한 초과");
      await this.removeReceipts(queuedAtStart.filter((receipt) => !remaining.has(receipt.receiptId) || finishedAt - receipt.receivedAt >= RECEIPT_MAX_AGE_MS));
      for (const receipt of pending) this.checkingReceiptIds.delete(receipt.receiptId);
      this.scheduleReceiptCheck();
    }
    return { checked: pending.length, disabled };
  }

  private async checkDurableReceipts(): Promise<{ checked: number; disabled: number }> {
    if (this.durableCheckRunning || this.stopped) return { checked: 0, disabled: 0 };
    this.durableCheckRunning = true;
    const store = this.deps.receipts!;
    let claims: ReceiptClaim[] = [];
    const remaining = new Map<string, ReceiptClaim>();
    let checked = 0;
    let disabled = 0;
    try {
      if (this.restoreNeeded) await this.resumeReceipts(false);
      if (this.unpersisted.size) await this.persistReceipts();
      if (this.stopped) return { checked, disabled };
      const queued = this.pendingReceipts;
      this.pendingReceipts = [];
      const now = (this.deps.now?.() ?? new Date()).getTime();
      const pending = queued.filter((r) => now - r.receivedAt < RECEIPT_MAX_AGE_MS);
      await this.removeReceipts(queued.filter((r) => now - r.receivedAt >= RECEIPT_MAX_AGE_MS));
      // 저장 실패분은 메모리에 보존하되, 공유 DB에서 소유권을 얻기 전에는 외부 확인을 시작하지 않는다.
      this.pendingReceipts.push(...pending.filter((r) => this.unpersisted.has(r.receiptId)));
      const eligible = pending.filter((r) => !this.unpersisted.has(r.receiptId));
      try {
        const acquired = await store.claim(eligible, now);
        claims = acquired.claims;
        this.pendingReceipts.push(...acquired.waiting);
      } catch {
        this.pendingReceipts.push(...eligible);
        this.deps.log?.warn({}, "푸시 영수증 처리권 확인 실패");
        return { checked, disabled };
      }
      if (this.stopped || !claims.length) return { checked, disabled };
      for (const claim of claims) {
        remaining.set(claim.receipt.receiptId, claim);
        this.checkingReceiptIds.add(claim.receipt.receiptId);
      }
      checked = claims.length;
      const results = await this.deps.push.checkReceipts(claims.map((claim) => claim.receipt.receiptId));
      for (const result of results) {
        if (this.stopped) break;
        const claim = remaining.get(result.receiptId);
        if (!claim) continue;
        try {
          const reason = !result.ok && result.error === "DeviceNotRegistered" ? result.error : undefined;
          const finished = await store.finish(claim, () => (this.deps.now?.() ?? new Date()).getTime(), reason);
          if (!finished.owned) continue;
          if (reason) disabled++;
          remaining.delete(result.receiptId);
          if (!finished.removed) { this.restoreNeeded = true; this.deps.log?.warn({}, "처리한 푸시 영수증 정리 실패"); }
        } catch { this.deps.log?.warn({}, "푸시 영수증 결과 저장 실패"); }
      }
    } catch { this.deps.log?.warn({}, "푸시 영수증 확인 실패"); }
    finally {
      if (!this.stopped) {
        try { await store.release([...remaining.values()]); }
        catch { this.deps.log?.warn({}, "푸시 영수증 처리권 반환 실패"); }
        const queued = new Set(this.pendingReceipts.map((r) => r.receiptId));
        const now = (this.deps.now?.() ?? new Date()).getTime();
        const expired: PendingReceipt[] = [];
        for (const { receipt } of remaining.values()) {
          if (now - receipt.receivedAt >= RECEIPT_MAX_AGE_MS) expired.push(receipt);
          else if (!queued.has(receipt.receiptId)) { this.pendingReceipts.push(receipt); queued.add(receipt.receiptId); }
        }
        await this.removeReceipts(expired);
      }
      for (const claim of claims) this.checkingReceiptIds.delete(claim.receipt.receiptId);
      this.durableCheckRunning = false;
      this.scheduleReceiptCheck();
    }
    return { checked, disabled };
  }

  private async removeReceipts(receipts: PendingReceipt[]): Promise<void> {
    if (this.stopped || !receipts.length) return;
    for (const receipt of receipts) this.unpersisted.delete(receipt.receiptId);
    try { await this.deps.receipts?.remove(receipts); }
    catch { this.restoreNeeded = true; this.deps.log?.warn({}, "처리한 푸시 영수증 정리 실패"); }
  }

  stop(): void {
    // 종료 전에 시작한 네트워크 응답이 나중에 와도 영수증 예약·DB 작업을 다시 시작하지 않는다.
    this.stopped = true;
    this.pendingReceipts = [];
    this.unpersisted.clear();
    if (this.receiptTimer) clearTimeout(this.receiptTimer);
    this.receiptTimer = null;
  }
}

function mask(token: string): string {
  return token.length > 12 ? `${token.slice(0, 20)}…` : token;
}
