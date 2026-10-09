import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Notifications from "expo-notifications";
import { sessionFor } from "./session";
import { defaultApiUrl, STORAGE_KEYS } from "./settings";

/** 본 기록 키만 실패했을 때 보관하는 OS 접수 기록. 알림을 보내기 전에 완료 기록을 적지 않는다. */
const RECEIPTS_KEY = "briefings.deliveryReceipts.v1";
const MAX_AGE = 24 * 3_600_000;
type Receipt = { identifier: string; at: number };
const acceptedInMemory = new Map<string, number>();

export class LocalDeliveryRecordError extends Error {
  constructor(persisted: boolean) {
    super(persisted
      ? "알림을 보냈지만 발송 목록을 저장하지 못했습니다. 별도 접수 기록으로 중복을 막고 다음 확인에서 복구합니다."
      : "알림을 보냈지만 기기에 전달 기록을 남기지 못했습니다. OS 알림 목록으로 다음 확인에서 복구하며, 알림을 지우고 앱을 종료하면 전달 여부를 확인할 수 없습니다.");
    this.name = "LocalDeliveryRecordError";
  }
}

/** 서버·계정·실제 전달 대상이 모두 같을 때만 같은 OS 식별자. 토큰·보유 금액·본문은 넣지 않는다. */
export function localDeliveryIdentifier(scope: string, ids: readonly number[]): string {
  return `briefing-local:v1:${encodeURIComponent(scope)}:${[...new Set(ids)].sort((a, b) => a - b).join(".")}`;
}

/** 새 알림이 있을 때만 목록을 병렬로 읽는다. 조회 실패를 빈 OS 목록으로 간주하지 않는다. */
export async function inspectLocalDeliveries(now: number) {
  const [storedUrl, raw, presented, scheduled] = await Promise.all([
    AsyncStorage.getItem(STORAGE_KEYS.apiUrl), AsyncStorage.getItem(RECEIPTS_KEY),
    Notifications.getPresentedNotificationsAsync(), Notifications.getAllScheduledNotificationsAsync(),
  ]);
  const apiUrl = (storedUrl || defaultApiUrl()).trim().replace(/\/+$/, "");
  const scope = JSON.stringify([apiUrl, sessionFor(apiUrl)?.user.id ?? null]);
  let rows: Receipt[] = [];
  if (raw !== null) {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.some((r) => !r || typeof r.identifier !== "string" || typeof r.at !== "number" || !Number.isFinite(r.at))) {
      throw new Error("알림 접수 기록을 읽지 못했습니다. 다음 확인에서 다시 시도합니다.");
    }
    rows = (parsed as Receipt[]).filter((r) => now - r.at < MAX_AGE).slice(-200);
  }
  const receipts = new Map(rows.map((r) => [r.identifier, r.at]));
  for (const [id, at] of acceptedInMemory) if (now - at >= MAX_AGE) acceptedInMemory.delete(id);
  const known = new Set([...presented.map((n) => n.request.identifier), ...scheduled.map((n) => n.identifier), ...receipts.keys(), ...acceptedInMemory.keys()]);
  const write = () => AsyncStorage.setItem(RECEIPTS_KEY, JSON.stringify([...receipts].slice(-200).map(([identifier, at]) => ({ identifier, at }))));
  return {
    identifier: (ids: readonly number[], date: unknown, session: unknown) => localDeliveryIdentifier(JSON.stringify([scope, date, session]), ids),
    known,
    accepted(identifier: string) { acceptedInMemory.set(identifier, now); known.add(identifier); },
    async recordFailure(identifier: string): Promise<never> {
      acceptedInMemory.set(identifier, now);
      receipts.set(identifier, now);
      let persisted = true;
      try { await write(); } catch { persisted = false; }
      throw new LocalDeliveryRecordError(persisted);
    },
    async completed(identifier: string): Promise<void> {
      acceptedInMemory.delete(identifier);
      if (receipts.delete(identifier)) await write().catch(() => undefined);
    },
  };
}
