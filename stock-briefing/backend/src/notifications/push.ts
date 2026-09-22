import { Expo, type ExpoPushMessage, type ExpoPushTicket } from "expo-server-sdk";

/** 앱으로 보내는 알림 한 건 */
export interface PushMessage {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export interface PushSendResult {
  /** 토큰별 결과. error 가 'DeviceNotRegistered' 면 호출자가 기기를 비활성화한다 */
  results: Array<{ token: string; ok: boolean; error: string | null; receiptId: string | null }>;
}

export interface PushSender {
  readonly name: string;
  isValidToken(token: string): boolean;
  send(tokens: string[], message: PushMessage): Promise<PushSendResult>;
  /** 영수증 확인: 전송 후 몇 분 뒤 FCM 이 실제로 받았는지. 반환값의 error 는 위와 같은 의미 */
  checkReceipts(receiptIds: string[]): Promise<Array<{ receiptId: string; ok: boolean; error: string | null }>>;
}

export const ANDROID_CHANNEL = "briefings";

/** Expo Push Service 를 통해 보낸다 (FCM/APNs 는 Expo 가 처리). 서버 키는 필요 없다. */
export class ExpoPushSender implements PushSender {
  readonly name = "expo";
  private readonly expo: Expo;

  constructor(accessToken?: string) {
    this.expo = new Expo(accessToken ? { accessToken } : {});
  }

  isValidToken(token: string): boolean {
    return Expo.isExpoPushToken(token);
  }

  async send(tokens: string[], message: PushMessage): Promise<PushSendResult> {
    const valid = tokens.filter((t) => Expo.isExpoPushToken(t));
    const messages: ExpoPushMessage[] = valid.map((to) => ({
      to,
      title: message.title,
      body: message.body,
      data: message.data ?? {},
      sound: "default",
      channelId: ANDROID_CHANNEL,
      priority: "high",
    }));
    const results: PushSendResult["results"] = tokens
      .filter((t) => !Expo.isExpoPushToken(t))
      .map((token) => ({ token, ok: false, error: "InvalidToken", receiptId: null }));

    for (const chunk of this.expo.chunkPushNotifications(messages)) {
      let tickets: ExpoPushTicket[];
      try {
        tickets = await this.expo.sendPushNotificationsAsync(chunk);
      } catch (e) {
        for (const m of chunk) results.push({ token: String(m.to), ok: false, error: `SendFailed: ${(e as Error).message}`, receiptId: null });
        continue;
      }
      tickets.forEach((ticket, i) => {
        const token = String(chunk[i]!.to);
        if (ticket.status === "ok") results.push({ token, ok: true, error: null, receiptId: ticket.id });
        else results.push({ token, ok: false, error: ticket.details?.error ?? ticket.message ?? "TicketError", receiptId: null });
      });
    }
    return { results };
  }

  async checkReceipts(receiptIds: string[]): Promise<Array<{ receiptId: string; ok: boolean; error: string | null }>> {
    const out: Array<{ receiptId: string; ok: boolean; error: string | null }> = [];
    for (const chunk of this.expo.chunkPushNotificationReceiptIds(receiptIds)) {
      const receipts = await this.expo.getPushNotificationReceiptsAsync(chunk);
      for (const id of chunk) {
        const r = receipts[id];
        if (!r) continue; // 아직 준비 안 됨
        out.push({ receiptId: id, ok: r.status === "ok", error: r.status === "ok" ? null : (r.details?.error ?? r.message ?? "ReceiptError") });
      }
    }
    return out;
  }
}
