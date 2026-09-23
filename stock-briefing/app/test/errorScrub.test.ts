import { describe, expect, it } from "vitest";
import { buildReport, createLimiter, enqueue, scrubStack, scrubText, type ErrorReport } from "@/lib/errorScrub";

const META = { screen: "/stocks/005930?token=abc", appVersion: "1.3.0", updateId: "u1", platform: "android" };
const NOW = Date.parse("2026-09-24T10:00:00+09:00");

describe("오류 보고: 토큰·금액은 기기를 떠나기 전에 지운다", () => {
  it("Bearer·?token=·푸시 토큰·Anthropic 키·긴 16진", () => {
    const s = scrubText("Bearer abc.def x?token=f00dcafe99&y=1 ExponentPushToken[qq] sk-ant-api03-XYZ 0123456789abcdef0123456789abcdef", { numbers: false });
    for (const bad of ["abc.def", "f00dcafe99", "qq]", "XYZ", "0123456789abcdef0123"]) expect(s).not.toContain(bad);
  });
  it("메시지 속 금액·수량", () => {
    expect(scrubText("총 75,857,144원 · $52,669.59 · 수량 1234 · 5주", { numbers: true })).toBe("총 # · # · 수량 # · 5주");
  });
  it("스택 첫 줄(메시지 반복)의 금액은 지운다", () => {
    const e = new Error("평가금액 75,857,144원 불일치");
    const r = buildReport("js", e, META, NOW);
    expect(r.stack).not.toContain("75,857,144");
    expect(scrubStack("Error: 합계 1,234,567원\n    at f (b:12345:6)")).toBe("Error: 합계 #\n    at f (b:12345:6)");
  });
  it("JSON 모양 토큰·콤마 구분 유지", () => {
    expect(scrubText('{"apiToken":"abc","avg":12345,"q":3}', { numbers: true })).toBe('{"apiToken":"[지움]","avg":#,"q":3}');
  });
  it("보고마다 서로 다른 id", () => {
    const a = buildReport("js", "a", META, NOW);
    const b = buildReport("js", "a", META, NOW);
    expect(a.id).not.toBe(b.id);
  });
  it("스택의 줄·열 번호는 남긴다", () => expect(scrubText("at f (index.bundle:12345:67)", { numbers: false })).toBe("at f (index.bundle:12345:67)"));
  it("buildReport: Error·문자열·객체 모두 한 건으로", () => {
    const e = new TypeError("Cannot read 'data' of undefined 1,000원");
    const r = buildReport("render", e, META, NOW);
    expect(r.message).toBe("TypeError: Cannot read 'data' of undefined #");
    expect(r.screen).toBe("/stocks/005930?token=[지움]");
    expect(r.occurredAt).toBe("2026-09-24T01:00:00.000Z");
    expect(buildReport("js", "plain", META, NOW).message).toBe("plain");
    expect(buildReport("js", { a: 1 }, META, NOW).message).toBe('{"a":1}');
    expect(buildReport("js", undefined, META, NOW).message).toBe("(메시지 없음)");
  });
  it("길이 제한: 메시지 500자, 스택 4000자", () => {
    const e = new Error("x".repeat(900));
    e.stack = "y".repeat(9000);
    const r = buildReport("js", e, META, NOW);
    expect(r.message.length).toBe(500);
    expect(r.stack!.length).toBe(4000);
  });
});

describe("보고 폭주 막기", () => {
  it("같은 오류는 1분에 1건 (숫자만 다른 것도 같은 오류)", () => {
    const allow = createLimiter(10);
    expect(allow({ kind: "js", message: "row 3 failed" }, NOW)).toBe(true);
    expect(allow({ kind: "js", message: "row 4 failed" }, NOW + 1000)).toBe(false);
    expect(allow({ kind: "js", message: "row 4 failed" }, NOW + 61_000)).toBe(true);
  });
  it("전체 분당 10건", () => {
    const allow = createLimiter(10);
    const ok = Array.from({ length: 15 }, (_, i) => allow({ kind: "js", message: `e-${"abcdefghijklmnop"[i]}` }, NOW)).filter(Boolean).length;
    expect(ok).toBe(10);
  });
  it("기기 대기열은 최근 20건만", () => {
    let q: ErrorReport[] = [];
    for (let i = 0; i < 25; i++) q = enqueue(q, buildReport("js", `m${i}`, META, NOW));
    expect(q).toHaveLength(20);
    expect(q[0]!.message).toBe("m5");
  });
});
