import { describe, expect, it } from "vitest";
import { clockLabel, connection, liveLabel, parseBriefingId, parseStockCode, pollInterval, staleBanner, streamFresh, viewState, type QueryLike } from "@/lib/freshness";

// 2026-09-24 14:03:21 KST
const NOW = Date.parse("2026-09-24T14:03:21+09:00");
const q = (o: Partial<QueryLike> = {}): QueryLike => ({ data: [1], isError: false, fetchStatus: "idle", failureCount: 0, dataUpdatedAt: NOW - 1000, ...o });

describe("viewState: 오류 화면은 처음 불러오기 실패 때만", () => {
  it("값이 있으면 재조회가 실패해도 화면 유지", () => expect(viewState({ data: [1], isError: true })).toBe("ready"));
  it("값이 빈 배열이어도 화면 유지", () => expect(viewState({ data: [], isError: true })).toBe("ready"));
  it("값 없이 실패하면 오류 화면", () => expect(viewState({ data: undefined, isError: true })).toBe("error"));
  it("값 없이 불러오는 중이면 로딩", () => expect(viewState({ data: undefined, isError: false })).toBe("loading"));
});

describe("connection: 끊김·지연 판단", () => {
  it("정상", () => expect(connection(q(), NOW, 15_000)).toEqual({ offline: false, stale: false, asOf: NOW - 1000 }));
  it("재조회 실패(오류 상태) → 끊김", () => expect(connection(q({ isError: true }), NOW, 15_000).offline).toBe(true));
  it("재시도 중(실패 1회) → 끊김", () => expect(connection(q({ failureCount: 1 }), NOW, 15_000).offline).toBe(true));
  it("오프라인이라 요청 보류(웹) → 끊김", () => expect(connection(q({ fetchStatus: "paused" }), NOW, 15_000).offline).toBe(true));
  it("15초 넘게 안 바뀜 → 지연", () => expect(connection(q({ dataUpdatedAt: NOW - 16_000 }), NOW, 15_000).stale).toBe(true));
  it("15초 이내 → 지연 아님", () => expect(connection(q({ dataUpdatedAt: NOW - 14_000 }), NOW, 15_000).stale).toBe(false));
  it("받은 값이 없으면 판단하지 않음", () => expect(connection(q({ data: undefined, dataUpdatedAt: 0, isError: true }), NOW, 15_000)).toEqual({ offline: false, stale: false, asOf: null }));
});

describe("streamFresh: '실시간'은 소켓 연결만이 아니라 최근 체결로", () => {
  it("연결 + 10초 전 체결 → 실시간", () => expect(streamFresh({ connected: true, lastTickAt: NOW - 10_000, connectedAt: NOW - 60_000 }, NOW)).toBe(true));
  it("연결됐지만 체결이 31초 없음 → 아님", () => expect(streamFresh({ connected: true, lastTickAt: NOW - 31_000, connectedAt: NOW - 60_000 }, NOW)).toBe(false));
  it("방금 연결, 체결 아직 없음 → 30초까지는 실시간", () => expect(streamFresh({ connected: true, lastTickAt: null, connectedAt: NOW - 5_000 }, NOW)).toBe(true));
  it("연결 끊김 → 아님", () => expect(streamFresh({ connected: false, lastTickAt: NOW, connectedAt: NOW }, NOW)).toBe(false));
});

describe("liveLabel: 잔고 패널 상태 글자", () => {
  const base = { open: true, closedLabel: "장 마감", streamFresh: false, offline: false, stale: false };
  it("끊김이 가장 우선", () => expect(liveLabel({ ...base, streamFresh: true, offline: true })).toEqual({ text: "연결 끊김", tone: "offline" }));
  it("장 마감", () => expect(liveLabel({ ...base, open: false })).toEqual({ text: "장 마감", tone: "closed" }));
  it("체결 스트림 → 실시간", () => expect(liveLabel({ ...base, streamFresh: true }).text).toBe("실시간"));
  it("폴링이 제때 오면 지연 3초", () => expect(liveLabel(base).text).toBe("지연 3초"));
  it("폴링도 늦으면 지연", () => expect(liveLabel({ ...base, stale: true }).text).toBe("지연"));
});

describe("pollInterval: 한 번 실패로 1분에 묶이지 않는다", () => {
  it("장중 3초", () => expect(pollInterval({ open: true, streamFresh: false, failing: false })).toBe(3_000));
  it("장중 + 스트림 → 보정용 30초", () => expect(pollInterval({ open: true, streamFresh: true, failing: false })).toBe(30_000));
  it("장 마감 1분", () => expect(pollInterval({ open: false, streamFresh: false, failing: false })).toBe(60_000));
  it("장중 실패 중에도 3초 (복구 즉시 반영)", () => expect(pollInterval({ open: true, streamFresh: true, failing: true })).toBe(3_000));
  it("장 마감 중 실패 → 5초마다 재시도", () => expect(pollInterval({ open: false, streamFresh: false, failing: true })).toBe(5_000));
});

describe("기준 시각 표시", () => {
  it("오늘이면 HH:MM:SS (한국 시간)", () => expect(clockLabel(NOW, NOW)).toBe("14:03:21"));
  it("다른 날이면 M/D HH:MM", () => expect(clockLabel(Date.parse("2026-09-23T15:30:00+09:00"), NOW)).toBe("9/23 15:30"));
  it("자정 넘김도 한국 날짜 기준", () => expect(clockLabel(Date.parse("2026-09-24T00:10:00+09:00"), NOW)).toBe("00:10:00"));
  it("끊김 띠", () => expect(staleBanner({ offline: true, stale: false, asOf: NOW - 2000 }, { open: true, now: NOW })).toBe("연결 끊김 · 14:03:19 기준 · 다시 연결 중"));
  it("장중 지연 띠", () => expect(staleBanner({ offline: false, stale: true, asOf: NOW - 20_000 }, { open: true, now: NOW })).toBe("시세 지연 · 14:03:01 기준"));
  it("장 마감 중 오래된 값은 띠 없음", () => expect(staleBanner({ offline: false, stale: true, asOf: NOW - 3_600_000 }, { open: false, now: NOW })).toBeNull());
  it("값이 없으면 띠 없음", () => expect(staleBanner({ offline: true, stale: true, asOf: null }, { open: true, now: NOW })).toBeNull());
});

describe("딥링크 파라미터 검증", () => {
  it("브리핑 id: 양의 정수만", () => {
    expect(parseBriefingId("123")).toBe(123);
    expect(parseBriefingId(["45"])).toBe(45);
    for (const bad of ["abc", "0", "-1", "1.5", "", " ", undefined, "1e3", "9".repeat(20)]) expect(parseBriefingId(bad)).toBeNull();
  });
  it("종목 코드: 국내·미국·신규 코드, 공백·특수문자는 거절", () => {
    for (const ok of ["005930", "0010S0", "AAPL", "BRK.B", "Q500001"]) expect(parseStockCode(ok)).toBe(ok);
    for (const bad of [" ", "", undefined, "../x", "a b", "<script>", "%20"]) expect(parseStockCode(bad)).toBeNull();
  });
});
