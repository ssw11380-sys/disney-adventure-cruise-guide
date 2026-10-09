import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BriefingActiveRun, BriefingStatus } from "@/api/types";
import { cleanupRenders, render } from "./miniRender";

const h = vi.hoisted(() => ({
  flag: undefined as boolean | undefined,
  status: undefined as BriefingStatus | null | undefined,
  error: false,
  useFeature: vi.fn(),
  useBriefingStatus: vi.fn(),
}));
vi.mock("react-native", () => ({ View: "View", Text: "Text", Pressable: "Pressable", StyleSheet: { create: <T,>(styles: T) => styles } }));
vi.mock("@expo/vector-icons/Ionicons", () => ({ default: "Ionicons" }));
vi.mock("@/components/ui", () => ({ Card: "Card" }));
vi.mock("@/theme", async () => {
  const tokens = await import("@/tokens");
  return { ...tokens, useTheme: () => tokens.dark };
});
vi.mock("@/lib/useNow", () => ({ useNow: () => Date.parse("2026-12-28T08:20:00+09:00") }));
vi.mock("@/api/hooks", () => ({ useFeature: h.useFeature, useBriefingStatus: h.useBriefingStatus }));

const { BriefingStatusSlot, BriefingStatusBanner } = await import("@/components/BriefingStatusBanner");
const { progressView, statusView } = await import("@/lib/briefingStatus");
const NOW = Date.parse("2026-12-28T08:20:00+09:00");
const RUN: BriefingActiveRun = { session: "afternoon", date: "2026-12-28", trigger: "manual", partial: true, startedAt: "2026-12-28T08:20:00+09:00", total: 3, done: 1 };
const STATUS: BriefingStatus = {
  session: null, date: "2026-12-28", scheduledAt: null, state: "none", late: false, startedAt: null, finishedAt: null,
  total: 0, done: 0, problems: [], reasonKind: null, nextRunAt: "2026-12-28T08:30:00+09:00", retryAt: null, manualRun: true,
};
const slot = () => render(<BriefingStatusSlot fallback={"예전 안내"} onOpen={vi.fn()} role="link" />);

beforeEach(() => {
  cleanupRenders();
  h.flag = undefined;
  h.status = { ...STATUS, activeRun: { ...RUN } };
  h.error = false;
  h.useFeature.mockReset().mockImplementation((_key: string, fallback: boolean) => h.flag ?? fallback);
  h.useBriefingStatus.mockReset().mockImplementation(() => ({ data: h.status, isError: h.error, dataUpdatedAt: NOW, refetch: vi.fn() }));
});

describe("실행 중 브리핑 안내", () => {
  it("예약 전 수동·일부 종목 실행은 상위 판정이 none이어도 자기 회차·시작 시각으로 보인다", () => {
    h.flag = true;
    const rendered = slot();
    expect(rendered.text()).toContain("오후 브리핑을 만드는 중입니다");
    expect(rendered.text()).toContain("3종목 중 1종목 처리");
    for (const part of ["2026-12-28", "수동 실행", "일부 종목", "시작 08:20"]) expect(rendered.text()).toContain(part);
    expect(h.useFeature).toHaveBeenCalledWith("briefingLiveProgress", false);
    expect(h.useBriefingStatus).toHaveBeenCalledWith(true, true);
    const speech = rendered.all().find((n) => n.props.accessible === true)?.props.accessibilityLabel;
    expect(speech).toContain("8시 20분 시작");
    expect(speech).toContain("실패하거나 건너뛴 종목도 포함");
    expect(rendered.all().filter((n) => n.type === "Text").every((n) => n.props.numberOfLines === undefined)).toBe(true);
  });

  it("대상 0은 준비 중, 처리 수가 전체와 같아도 실행이 남아 있으면 마무리 중이다", () => {
    h.flag = true;
    h.status = { ...STATUS, activeRun: { ...RUN, total: 0, done: 0 } };
    const rendered = slot();
    expect(rendered.text()).toContain("오후 브리핑을 준비하는 중입니다");
    expect(rendered.text()).not.toContain("0종목 중");
    h.status = { ...STATUS, activeRun: { ...RUN, done: 3 } };
    rendered.rerender();
    expect(rendered.text()).toContain("오후 브리핑을 마무리하는 중입니다");
    expect(rendered.text()).toContain("3종목 중 3종목 처리");
    expect(rendered.text()).not.toMatch(/생성 완료|생성 성공|100%/);
    h.status = { ...STATUS, activeRun: null };
    rendered.rerender();
    expect(rendered.text()).toBe("");
  });

  it("예약 실행의 전체 대상 문구와 활성 실행 없음·구서버를 구별한다", () => {
    const view = progressView({ ...RUN, session: "morning", trigger: "schedule", partial: false }, NOW);
    expect(view?.title).toBe("오전 브리핑을 만드는 중입니다");
    expect(view?.small?.parts).toContain("예약 실행");
    expect(view?.small?.parts).toContain("전체 종목");
    expect(progressView(null, NOW)).toBeNull();
    expect(progressView(undefined, NOW)).toBeNull();
  });

  it.each([false, true])("20분 넘게 걸리는 실행은 경고를 유지한다 (일부 종목 %s)", (partial) => {
    const normal = progressView({ ...RUN, partial }, NOW + 20 * 60_000)!;
    expect(normal.tone).toBe("progress");
    const slow = progressView({ ...RUN, partial }, NOW + 20 * 60_000 + 1)!;
    expect(slow.title).toBe("오후 브리핑을 아직 만드는 중입니다");
    expect(slow.tone).toBe("warn");
    expect(slow.small?.note).toContain("평소보다 오래 걸리고 있습니다");
  });

  it("서버의 같은 회차 slow도 경고하고, 캐시가 남은 조회 실패는 마지막 확인으로 표시한다", () => {
    h.flag = true;
    h.status = { ...STATUS, state: "slow", session: RUN.session, date: RUN.date, activeRun: RUN };
    expect(slot().text()).toContain("오후 브리핑을 아직 만드는 중입니다");
    h.error = true;
    const rendered = slot();
    expect(rendered.text()).toContain("브리핑 진행 상태를 확인하지 못했습니다");
    expect(rendered.text()).toContain("마지막 확인 상태: 3종목 중 1종목 처리");
    expect(rendered.text()).toContain("마지막 확인 08:20");
    expect(rendered.text()).not.toContain("만드는 중입니다");
  });

  it.each([undefined, false])("플래그 %s: 응답에 activeRun이 있어도 예전 안내 트리와 동일하다", (flag) => {
    h.flag = flag;
    h.status = { ...STATUS, state: "slow", session: "morning", total: 17, done: 9, activeRun: RUN };
    const actual = slot();
    const legacy = render(<BriefingStatusBanner view={statusView(h.status, NOW)!} onOpen={vi.fn()} role="link" />);
    expect(actual.tree).toEqual(legacy.tree);
    expect(actual.text()).not.toContain("오후 브리핑");
    expect(h.useBriefingStatus).toHaveBeenCalledWith(true, false);
  });

  it("켜졌어도 activeRun 없는 구서버는 기존 상태를, 404나 최초 연결 실패는 예전 안내를 쓴다", () => {
    h.flag = true;
    h.status = { ...STATUS, state: "llmOff" };
    expect(slot().text()).toContain("브리핑 모델이 설정되지 않았습니다");
    h.status = null;
    expect(slot().text()).toBe("예전 안내");
    h.status = undefined;
    h.error = true;
    expect(slot().text()).toBe("예전 안내");
  });
});
