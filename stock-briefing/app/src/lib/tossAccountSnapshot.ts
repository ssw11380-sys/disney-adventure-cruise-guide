import type { TossAccountSnapshotBody } from "@/api/types";

export const TOSS_SNAPSHOT_OFF: TossAccountSnapshotBody = { on: false, snapshot: null, sync: null };
export const TOSS_SNAPSHOT_POLL_MS = 30_000;
const GRACE_MS = 5 * 60_000;

/** 장기 보존 기록도 연도를 생략하지 않는다. 사용자 기기 시간대와 무관하게 한국 시각이다. */
export function tossSnapshotTime(iso: string): string {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return "시각 확인 불가";
  return new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(at);
}
export function tossSnapshotRange(from: string, to: string): string {
  const start = tossSnapshotTime(from), end = tossSnapshotTime(to);
  return start === end ? end : `${start} ~ ${end}`;
}

/** 수신 구간 끝은 시세 기준 시각이 아니다. 정상 장외 동기화(60분)를 지연으로 오인하지 않는다. */
export function tossSnapshotNotice(body: TossAccountSnapshotBody | undefined, failed: boolean, now: number): string | null {
  if (failed) return body?.snapshot ? "새로고침 실패 · 마지막 수신 금액입니다." : "토스 계좌 금액을 확인하지 못했습니다. 아래 실시간 평가를 확인해 주세요.";
  if (!body) return "토스 계좌 금액 확인 중 · 아래는 실시간 평가입니다.";
  if (!body.on) return "토스 계좌 기준을 사용할 수 없어 실시간 평가를 표시합니다.";
  if (!body.snapshot) return body.sync?.lastError ? "토스 계좌 동기화에 실패했습니다. 마지막으로 확보한 실시간 평가를 표시합니다." : "수신한 토스 계좌 금액이 없습니다. 설정에서 계좌 연동 상태를 확인해 주세요.";
  if (body.sync?.lastError) return "계좌 동기화 실패 · 마지막 수신 금액입니다.";
  if (body.sync?.enabled === false) return "자동 동기화 꺼짐 · 마지막 수신 금액입니다.";
  const at = Date.parse(body.snapshot.receivedAt);
  const next = body.sync?.nextRunAt ? Date.parse(body.sync.nextRunAt) : NaN;
  const interval = Math.max(body.sync?.intervalMin ?? 10, body.sync?.idleIntervalMin ?? 60) * 60_000;
  const due = Number.isFinite(next) ? Math.min(next, at + interval) : at + interval;
  if (!Number.isFinite(at) || at > now + GRACE_MS || now > due + GRACE_MS) {
    return "계좌 금액 갱신 대기 · 수신 시각을 확인해 주세요.";
  }
  return null;
}
