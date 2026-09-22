import type { PushMessage, PushSender } from "../notifications/push.js";
import type { NotificationSettingsStore } from "../notifications/settings.js";
import type { Briefing } from "./briefingService.js";
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
 * 브리핑이 생성되면 등록된 모든 기기에 요약을 푸시한다.
 * 영수증(receipt)은 전송 후 일정 시간 뒤에 확인해서 DeviceNotRegistered 기기를 비활성화한다.
 */
export class NotificationService {
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
    },
  ) {}

  /** BriefingService.onBriefing 에 붙이는 리스너 */
  readonly onBriefing = async (b: Briefing): Promise<void> => {
    if (b.status !== "ok") return;
    const s = await this.deps.settings.get();
    if (!s.pushEnabled) return;
    const sessionLabel = b.session === "morning" ? "오전" : "오후";
    await this.sendToAll({
      title: `${b.name ?? b.code} ${sessionLabel} 브리핑`,
      body: b.summary,
      data: { type: "briefing", briefingId: b.id, code: b.code, session: b.session, date: b.date },
    });
  };

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
