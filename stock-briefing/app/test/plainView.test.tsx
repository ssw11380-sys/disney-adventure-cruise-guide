import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Quote, ReportVerification } from "@/api/types";
import { cleanupRenders, render } from "./miniRender";

/**
 * 군더더기 글 줄이기 (2026-11-12, 기능 플래그 plainView — 앱 fallback 꺼짐).
 * 꺼져 있을 때 화면이 지금과 같은 것은 기존 테스트들이 본다 (이 플래그를 켜지 않은 채 그대로 통과).
 * 여기서는 켰을 때의 짧은 글과, 켜도 남아야 하는 것(경고·고지)을 본다.
 */
vi.mock("react-native", () => ({ View: "View", Text: "Text", Pressable: "Pressable", StyleSheet: { create: <T,>(v: T) => v, hairlineWidth: 1 }, BackHandler: { addEventListener: () => ({ remove() {} }) } }));
vi.mock("expo-router", () => ({ useFocusEffect: () => undefined, router: { push: () => undefined } }));
vi.mock("@/components/Screen", () => ({ Screen: "Screen" }));
vi.mock("@/components/ui", () => ({ Button: "Button", Card: "Card", Muted: "Muted", SectionTitle: "SectionTitle", Badge: "Badge" }));
vi.mock("@/theme", async () => {
  const t = await import("@/tokens");
  return { ...t, useTheme: () => t.dark };
});

const { PlainViewContext, usePlain } = await import("@/lib/plainFlag");
const { plainDiscoverStatus, plainSessionStatus, plainSnapshotTime, plainStatusLine, plainText, plainWatchAlert, plainWatchGap, PLAIN_ANALYSIS, PLAIN_NOTE, PLAIN_VALUE_NOTE } = await import("@/lib/plainView");
const { sessionStatus } = await import("@/lib/liveDot");
const { DISCLAIMER } = await import("@/lib/disclaimer");
const { ReportVerificationNotice } = await import("@/components/ReportVerification");
const { FundamentalsBasis } = await import("@/components/FundamentalsBasis");
const { SettingsSections } = await import("@/components/SettingsSections");
const { AiTitle } = await import("@/components/scores/AiTitle");
const { TitleNote } = await import("@/components/scores/TitleNote");

afterEach(cleanupRenders);

const on = (el: React.ReactElement) => render(<PlainViewContext.Provider value={true}>{el}</PlainViewContext.Provider>);

describe("짧은 글 (lib/plainView)", () => {
  const us = { market: "US" as const, label: "미국 정규장", open: true };
  const kr = { market: "KR" as const, label: "한국 장 마감", open: false };

  it("잔고 상태 줄: 열린 세션 이름 + 실시간/지연만 (닫힌 시장 이름·실시간 종목 수는 쓰지 않는다)", () => {
    const o = { sessions: [us, kr], liveCount: 18, eligibleCount: 18, feedOk: true, offline: false };
    expect(sessionStatus(o).text).toBe("미국 정규장 · 한국 장 마감 · 실시간 18종목"); // 지금 글
    expect(plainSessionStatus(o)).toEqual({ text: "미국 정규장 · 실시간", tone: "live" });
    // 두 시장이 모두 열림
    expect(plainSessionStatus({ ...o, sessions: [{ market: "KR", label: "한국 정규장", open: true }, { market: "US", label: "미국 주간거래", open: true }] }).text).toBe("한국 정규장 · 미국 주간거래 · 실시간");
  });

  it("잔고 상태 줄: 판단(색)은 지금과 같다 — 지연·끊김·장 마감", () => {
    const o = { sessions: [us, kr], liveCount: 18, eligibleCount: 18, feedOk: true, offline: false };
    const same = (x: typeof o) => expect(plainSessionStatus(x).tone).toBe(sessionStatus(x).tone);
    for (const x of [o, { ...o, feedOk: false }, { ...o, offline: true }, { ...o, liveCount: 0 }, { ...o, liveCount: 0, eligibleCount: 0 }, { ...o, sessions: [kr] }]) same(x);
    expect(plainSessionStatus({ ...o, feedOk: false }).text).toBe("미국 정규장 · 지연");
    expect(plainSessionStatus({ ...o, liveCount: 0 }).text).toBe("미국 정규장 · 지연"); // 서버가 값을 못 받는 중
    expect(plainSessionStatus({ ...o, offline: true }).text).toBe("미국 정규장 · 연결 끊김");
    // 열린 세션에 거래 대상으로 확인된 종목이 없음: 세션 이름만 (회색)
    expect(plainSessionStatus({ ...o, liveCount: 0, eligibleCount: 0 })).toEqual({ text: "미국 정규장", tone: "closed" });
  });

  it("잔고 상태 줄: 열린 시장이 없으면 '장 마감'·'휴장' 한마디 (시장마다 다르면 이름을 붙인다)", () => {
    const base = { liveCount: 0, eligibleCount: 0, feedOk: true, offline: false };
    expect(plainSessionStatus({ ...base, sessions: [kr, { market: "US", label: "미국 장 마감", open: false }] })).toEqual({ text: "장 마감", tone: "closed" });
    expect(plainSessionStatus({ ...base, sessions: [{ market: "KR", label: "한국 휴장", open: false }, { market: "US", label: "미국 휴장", open: false }] }).text).toBe("휴장");
    expect(plainSessionStatus({ ...base, sessions: [{ market: "US", label: "미국 휴장", open: false }, kr] }).text).toBe("미국 휴장 · 한국 장 마감");
    expect(plainSessionStatus({ ...base, offline: true, sessions: [kr] }).text).toBe("장 마감 · 연결 끊김");
  });

  it("상태 줄의 시각은 지연·끊김일 때만 붙고, 지연 종목 수는 있을 때만", () => {
    expect(plainStatusLine({ text: "미국 정규장 · 실시간", warn: false, clock: "01:10:23", suffix: "" })).toBe("미국 정규장 · 실시간");
    expect(plainStatusLine({ text: "미국 정규장 · 지연", warn: true, clock: "01:10:23", suffix: "" })).toBe("미국 정규장 · 지연 · 01:10:23 기준");
    expect(plainStatusLine({ text: "미국 정규장 · 실시간", warn: false, clock: "01:10:23", suffix: "시세 지연 2" })).toBe("미국 정규장 · 실시간 · 시세 지연 2");
    expect(plainStatusLine({ text: "장 마감", warn: false, clock: null, suffix: "" })).toBe("장 마감");
  });

  it("받은 시각: 오늘이면 시:분, 다른 날이면 월/일 시:분 (한국 시각)", () => {
    const now = Date.parse("2026-11-12T01:45:00+09:00");
    expect(plainSnapshotTime("2026-11-12T01:39:40+09:00", now)).toBe("01:39 기준");
    expect(plainSnapshotTime("2026-11-11T20:00:00+09:00", now)).toBe("11/11 20:00 기준");
    expect(plainSnapshotTime("2026-11-11T16:39:40Z", now)).toBe("01:39 기준"); // 표기가 달라도 한국 시각으로
    expect(plainSnapshotTime("모름", now)).toBeNull();
  });

  it("관심 카드: 희망가까지의 차이는 값 한 칸으로, 알림 줄은 짧게", () => {
    expect(plainWatchGap(100, 80, "USD")).toBe("-$20.00 (-20.00%)");
    expect(plainWatchGap(70_000, 75_000, "KRW")).toBe("도달 · 5,000원 아래");
    expect(plainWatchGap(80, 80, "USD")).toBe("도달");
    expect(plainWatchGap(null, 80, "USD")).toBeNull();
    expect(plainWatchGap(0, 80, "USD")).toBeNull();
    expect(plainWatchAlert(true)).toBe("5% 알림 켜짐");
    expect(plainWatchAlert(false)).toBe("알림 꺼짐");
  });

  it("발견 탭 상태: 갱신 주기·기준 설명을 뺀 한마디", () => {
    expect(plainDiscoverStatus("regular", undefined, false)).toBe("장중");
    expect(plainDiscoverStatus("regular", undefined, true)).toBe("장중 · 자동 갱신 멈춤");
    expect(plainDiscoverStatus("extended", undefined, false)).toBe("시간외");
    expect(plainDiscoverStatus("pre", undefined, false)).toBe("장 시작 전");
    expect(plainDiscoverStatus("closed", false, false)).toBe("장 마감");
    expect(plainDiscoverStatus("closed", true, false)).toBe("장외 시간");
  });

  it("화면 글에 'AI'·'모델' 이 남지 않는다 — 틀릴 수 있다는 말과 권유 아님은 남긴다", () => {
    for (const s of [PLAIN_NOTE, PLAIN_VALUE_NOTE, ...Object.values(PLAIN_ANALYSIS)]) expect(s).not.toMatch(/AI|모델|인공지능/);
    expect(PLAIN_NOTE).toContain("틀릴 수 있음");
    expect(PLAIN_VALUE_NOTE).toContain("틀릴 수 있음");
    expect(PLAIN_VALUE_NOTE).toContain("투자 권유가 아닙니다");
    // 이미 만들어진 글 바꾸기 (브리핑 실패 까닭 · 분석 대기 안내 · 계좌 브리핑 기본 설명 안내)
    expect(plainText("만들지 못함 · AI 서비스가 잠시 붐빔")).toBe("만들지 못함 · 서비스가 잠시 붐빔");
    expect(plainText("AI 서비스에 잠시 문제가 있었습니다")).toBe("글을 만드는 서비스에 잠시 문제가 있었습니다");
    expect(plainText("AI가 글을 끝까지 쓰지 못했습니다")).toBe("글을 끝까지 만들지 못했습니다");
    expect(plainText("결과 확인은 AI 분석을 새로 만들지 않습니다.")).toBe("결과 확인은 분석을 새로 만들지 않습니다.");
    expect(plainText("모델 설명을 받지 못해 위 숫자로 만든 기본 설명을 보여 드립니다.")).toBe("위 숫자로 만든 기본 설명입니다.");
    expect(plainText("모델이 설정되지 않아 위 숫자로 만든 기본 설명을 보여 드립니다.")).toBe("위 숫자로 만든 기본 설명입니다.");
    // 해당 없는 글은 그대로
    expect(plainText("서버 설정 문제 (관리자 확인 필요)")).toBe("서버 설정 문제 (관리자 확인 필요)");
    expect(plainText(DISCLAIMER)).toBe(DISCLAIMER);
  });
});

describe("플래그 내려 주기 (lib/plainFlag)", () => {
  function Probe() {
    return React.createElement("Text", {}, usePlain() ? "켜짐" : "꺼짐");
  }
  it("제공자가 없으면 꺼짐 (테스트·예전 화면은 지금 그대로)", () => {
    expect(render(<Probe />).text()).toBe("꺼짐");
    expect(on(<Probe />).text()).toBe("켜짐");
  });
});

describe("분석 글 위의 시세 시각 줄 (ReportVerificationNotice)", () => {
  const base: ReportVerification = { scope: "quote_claims", quoteAsOf: "2026-10-02T09:05:00+09:00", quoteSource: "toss-openapi", checkedClaims: 1, issues: [] };
  it("켜면 시세 시각·출처 줄을 그리지 않는다 (아무것도 그리지 않음)", () => {
    expect(render(<ReportVerificationNotice verification={base} />).text()).toContain("보고서에 사용한 시세 시각");
    const r = on(<ReportVerificationNotice verification={base} />);
    expect(r.text()).toBe("");
    expect(r.all()).toHaveLength(0);
  });
  it("켜도 본문 숫자가 원자료와 다르다는 경고는 그대로 보인다", () => {
    const r = on(<ReportVerificationNotice verification={{ ...base, issues: [{ field: "price", reported: "현재가: 99,000원", expected: "100,000원" }] }} />);
    expect(r.text()).toContain("현재가: 99,000원 · 원자료 100,000원");
    expect(r.text()).not.toContain("보고서에 사용한 시세 시각");
    expect(r.text()).not.toContain("조회 시각을 제공");
    expect(r.all().some((n) => n.props.accessibilityRole === "alert")).toBe(true);
  });
});

describe("재무 자료 기준 줄 (FundamentalsBasis)", () => {
  const basis = { fields: ["per", "pbr"], source: "naver", receivedAt: "2026-11-11T20:00:00+09:00", refreshFailed: false } as unknown as Quote["fundamentalsBasis"];
  it("켜면 평소의 출처·수신 시각 줄은 그리지 않고, 갱신 실패(이전 자료) 경고만 남긴다", () => {
    expect(render(<FundamentalsBasis basis={basis} />).text()).toContain("재무 자료 기준");
    expect(on(<FundamentalsBasis basis={basis} />).text()).toBe("");
    const failed = { ...(basis as object), refreshFailed: true } as Quote["fundamentalsBasis"];
    expect(on(<FundamentalsBasis basis={failed} />).text()).toContain("재무 갱신 실패 · 이전 자료");
  });
});

describe("설정 목록 (SettingsSections)", () => {
  const sections = [{ id: "update", title: "앱 업데이트", detail: "최신 버전", content: <React.Fragment>업데이트 내용</React.Fragment> }];
  it("켜면 목록 위 '설정 / 변경할 항목을 선택하세요.' 카드를 그리지 않는다 (목록·동작은 그대로)", () => {
    const off = render(<SettingsSections sections={sections} openServerRequest={null} refreshing={false} onRefresh={() => undefined} />);
    expect(off.text()).toContain("변경할 항목을 선택하세요.");
    const r = on(<SettingsSections sections={sections} openServerRequest={null} refreshing={false} onRefresh={() => undefined} />);
    expect(r.text()).not.toContain("변경할 항목을 선택하세요.");
    expect(r.all().some((n) => n.type === "Card")).toBe(false);
    r.act(() => (r.all().find((n) => n.props.accessibilityLabel === "앱 업데이트, 최신 버전")!.props.onPress as () => void)());
    expect(r.text()).toContain("업데이트 내용");
  });
});

describe("지표 점수·분석 제목 (AiTitle · TitleNote)", () => {
  it("켜면 'AI ' 와 'AI가 쓴 글' 배지를 뺀 제목만", () => {
    const off = render(<AiTitle title="AI 기업개요" />);
    expect(off.text()).toContain("AI 기업개요");
    expect(off.all().some((n) => n.type === "Badge")).toBe(true);
    const r = on(<AiTitle title="AI 기업개요" />);
    expect(r.text()).toBe("기업개요");
    expect(r.all().some((n) => n.type === "Badge")).toBe(false);
    expect(r.all()[0]!.props.accessibilityLabel).toBe("기업개요");
    expect(on(<AiTitle title="AI 가치분석" />).text()).toBe("가치분석");
  });
  it("켜면 카드 제목 옆 '계산식 결과 · AI 글 아님' 을 그리지 않는다", () => {
    expect(render(<TitleNote text="계산식 결과 · AI 글 아님" />).text()).toBe("계산식 결과 · AI 글 아님");
    expect(on(<TitleNote text="계산식 결과 · AI 글 아님" />).all()).toHaveLength(0);
  });
});
