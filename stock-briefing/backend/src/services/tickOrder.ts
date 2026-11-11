import type { LiveTick } from "../providers/market/tossRealtime.js";

/**
 * 웹소켓 체결(ws)과 공식 API 현재가(polled — 1초 확인) 중 어느 쪽이 새로운지.
 * 둘 다 체결 시각이 실제 체결 시각이라 시각으로 견주는데, 공식 현재가의 시각은 초 단위다 ("…T19:59:59.000+09:00").
 * 그래서 같은 초 안에서는 밀리초까지 있는 웹소켓 체결보다 늘 이르게 보인다 — 웹소켓이 그 초의 나중 체결을 놓치면(유실이 있다)
 * 시각만으로는 영영 메우지 못한다 (세션 마지막 초 19:59:59 에 놓치면 밤새 한 틱 틀린 가격이 남는다).
 *
 * 규칙:
 *  - 현재가의 체결 시각이 더 뒤 → 현재가
 *  - 같은 초(현재가 시각에 밀리초가 없음)이고 가격이 다르며, 웹소켓 체결을 받은 뒤 SAME_SECOND_SETTLE_MS 넘게 지나 받은 현재가 → 현재가.
 *    그때 받은 현재가는 그 시각의 '마지막 체결'이므로 웹소켓 체결보다 나중 체결이다. 체결 시각은 웹소켓 체결 바로 뒤(+1ms)로 적는다
 *    (실제 체결도 그 초 안, 웹소켓 체결 뒤다 — 앱·스트림이 시각으로 순서를 따져도 뒤집히지 않게)
 *  - 그 밖에는 웹소켓 체결 (null)
 * 시각을 읽을 수 없으면 현재가를 쓴다 (예전 스트림 폴링과 같은 판단)
 */
const SAME_SECOND_SETTLE_MS = 1_500;

export function polledOverWs(ws: LiveTick, polled: LiveTick): LiveTick | null {
  const a = Date.parse(polled.timestamp);
  const b = Date.parse(ws.timestamp);
  if (Number.isNaN(a) || Number.isNaN(b)) return polled;
  if (a > b) return polled;
  const sameSecond = a % 1000 === 0 && Math.floor(a / 1000) === Math.floor(b / 1000);
  if (sameSecond && polled.price !== ws.price && polled.receivedAt - ws.receivedAt >= SAME_SECOND_SETTLE_MS) return { ...polled, timestamp: new Date(b + 1).toISOString() };
  return null;
}

/** 시각 a 가 b 보다 뒤인지. 읽을 수 없으면 글자 순서로 (같은 형식의 ISO 는 글자 순서가 시간 순서) */
export function laterThan(a: string, b: string): boolean {
  const x = Date.parse(a);
  const y = Date.parse(b);
  return Number.isNaN(x) || Number.isNaN(y) ? a > b : x > y;
}
