import { buildDigest, inQuietHours } from "../notifications/digest.js";
import type { PushMessage, PushSender } from "../notifications/push.js";
import type { NotificationSettingsStore } from "../notifications/settings.js";
import { digestAccount, type AccountBriefing } from "./accountBriefingService.js";
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
}

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
  private pendingReceipts: Array<{ receiptId: string; token: string }> = [];
  private receiptTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly deps: {
      push: PushSender;
      devices: DeviceService;
      settings: NotificationSettingsStore;
      log?: NotificationLog;
      /** 영수증 확인까지 대기 시간 (기본 15분). 테스트에서 0 */
      receiptDelayMs?: number;
      /** 기능 플래그 (없으면 briefingDigest 켜짐으로 본다) */
      features?: { enabled(key: "briefingDigest"): Promise<boolean> };
      now?: () => Date;
    },
  ) {}

  /** BriefingService.onBriefing 에 붙이는 리스너 */
  readonly onBriefing = async (b: Briefing): Promise<void> => {
    if (b.status !== "ok") return;
    if (this.sessionDigest ?? (await this.digestOn())) return; // 세션이 끝날 때 묶어서 (onSession)
    const s = await this.deps.settings.get();
    if (!s.pushEnabled) return;
    const sessionLabel = b.session === "morning" ? "오전" : "오후";
    await this.sendToAll({
      title: `${b.name ?? b.code} ${sessionLabel} 브리핑`,
      body: b.summary,
      data: { type: "briefing", briefingId: b.id, code: b.code, session: b.session, date: b.date },
    });
  };

  /** BriefingService.onSessionDone 에 붙이는 리스너: 세션 알림 1건 */
  readonly onSessionStart = async (): Promise<void> => {
    this.sessionDigest = await this.digestOn();
  };

  /**
   * account: 이번 실행에서 새로 만든 계좌 브리핑(3-31, 플래그 accountBriefing). 있으면 알림 앞머리가 계좌 요약이 되고,
   * 새 종목 브리핑이 알릴 것이 없어도(모델 장애로 모두 실패, 알림을 끈 종목만 성공) 계좌 브리핑으로 1건. 없으면 예전 그대로.
   * 단 이번 실행의 종목(results)을 모두 알림 끔으로 둔 사용자에게는 계좌 요약도 보내지 않는다 — 예전처럼 0건 (앱 로컬 알림과 같은 규칙)
   */
  readonly onSession = async (done: SessionDone & { account?: AccountBriefing | null; results?: ReadonlyArray<{ code: string }> }): Promise<void> => {
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
    const msg = buildDigest(done.session, done.date, items, allMuted ? null : digestAccount(done.account));
    if (!msg) {
      this.deps.log?.info({ session: done.session, muted: done.created.length }, "알림을 끈 종목뿐이라 보내지 않음");
      return;
    }
    await this.sendToAll(msg);
  };

  private async digestOn(): Promise<boolean> {
    return this.deps.features ? this.deps.features.enabled("briefingDigest") : true;
  }

  async sendTest(): Promise<SendSummary> {
    return this.sendToAll({
      title: "주식 브리핑 테스트 알림",
      body: "알림이 정상적으로 도착했습니다.\n브리핑은 설정한 시간에 이렇게 도착합니다.",
      data: { type: "test" },
    });
  }

  async sendToAll(message: PushMessage): Promise<SendSummary> {
    const tokens = await this.deps.devices.enabledTokens();
    const summary: SendSummary = { sent: 0, failed: 0, disabled: [] };
    if (tokens.length === 0) {
      this.deps.log?.info({ title: message.title }, "푸시 대상 기기 없음");
      return summary;
    }
    const { results } = await this.deps.push.send(tokens, message);
    for (const r of results) {
      if (r.ok) {
        summary.sent++;
        if (r.receiptId) this.pendingReceipts.push({ receiptId: r.receiptId, token: r.token });
      } else {
        summary.failed++;
        if (r.error === "DeviceNotRegistered" || r.error === "InvalidToken") {
          await this.deps.devices.disable(r.token, r.error);
          summary.disabled.push(r.token);
        }
        this.deps.log?.warn({ token: mask(r.token), err: r.error }, "푸시 전송 실패");
      }
    }
    this.deps.log?.info({ title: message.title, ...summary, disabled: summary.disabled.length }, "푸시 전송");
    this.scheduleReceiptCheck();
    return summary;
  }

  private scheduleReceiptCheck(): void {
    if (this.receiptTimer || this.pendingReceipts.length === 0) return;
    const delay = this.deps.receiptDelayMs ?? 15 * 60_000;
    this.receiptTimer = setTimeout(() => {
      this.receiptTimer = null;
      void this.checkReceipts();
    }, delay);
    this.receiptTimer.unref?.();
  }

  /** 대기 중인 영수증을 확인한다. 반환: 비활성화한 토큰 수 */
  async checkReceipts(): Promise<{ checked: number; disabled: number }> {
    const pending = this.pendingReceipts;
    this.pendingReceipts = [];
    if (pending.length === 0) return { checked: 0, disabled: 0 };
    let disabled = 0;
    try {
      const receipts = await this.deps.push.checkReceipts(pending.map((p) => p.receiptId));
      const byId = new Map(pending.map((p) => [p.receiptId, p.token]));
      for (const r of receipts) {
        if (r.ok) continue;
        const token = byId.get(r.receiptId);
        this.deps.log?.warn({ token: token ? mask(token) : null, err: r.error }, "푸시 영수증 오류");
        if (token && r.error === "DeviceNotRegistered") {
          await this.deps.devices.disable(token, r.error);
          disabled++;
        }
      }
      // 아직 준비되지 않은 영수증은 다음 확인으로 넘긴다
      const seen = new Set(receipts.map((r) => r.receiptId));
      this.pendingReceipts.push(...pending.filter((p) => !seen.has(p.receiptId)));
      if (this.pendingReceipts.length) this.scheduleReceiptCheck();
    } catch (e) {
      this.deps.log?.warn({ err: (e as Error).message }, "푸시 영수증 확인 실패");
    }
    return { checked: pending.length, disabled };
  }

  stop(): void {
    if (this.receiptTimer) clearTimeout(this.receiptTimer);
    this.receiptTimer = null;
  }
}

function mask(token: string): string {
  return token.length > 12 ? `${token.slice(0, 20)}…` : token;
}
