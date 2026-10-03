import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupRenders, render } from "./miniRender";
import type { TossImportResult } from "@/api/types";

const h = vi.hoisted(() => ({
  alert: vi.fn(), import: vi.fn(), register: vi.fn(), invalidate: vi.fn(), identity: 1, ready: true,
  credentials: { apiUrl: "https://test.invalid", apiToken: "test-only" },
  qc: {} as { invalidateQueries: ReturnType<typeof vi.fn> },
}));
vi.mock("react-native", () => ({ View: "View", Text: "Text", Pressable: "Pressable", Alert: { alert: h.alert }, Linking: { openURL: vi.fn() }, Share: { share: vi.fn() } }));
vi.mock("@/theme", async () => { const t = await import("@/tokens"); return { ...t, useTheme: () => t.dark }; });
vi.mock("@/components/ui", () => ({ Badge: "Badge", Button: "Button", Card: "Card", Muted: "Muted", Row: "Row", SectionTitle: "SectionTitle" }));
vi.mock("@/lib/haptics", () => ({ haptic: vi.fn() }));
vi.mock("@/lib/session", () => ({ sessionIdentityVersion: () => h.identity, sessionVersion: () => h.identity, subscribeSession: () => () => {} }));
vi.mock("@/lib/settings", () => ({ useSettings: () => ({ ...h.credentials, ready: h.ready }), currentCredentials: () => ({ ...h.credentials }) }));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => h.qc,
  useMutation: (options: { onSuccess: (r: unknown) => void }) => ({ mutate: () => h.import().then(options.onSuccess), isPending: false }),
}));
vi.mock("@/api/hooks", () => ({
  useApi: () => ({ importTossHoldings: h.import, registerStock: h.register }),
  useFeature: () => false,
  useTossStatus: () => ({ data: { configured: true }, refetch: vi.fn(), isError: false }),
  useTossImport: () => ({ mutate: (_: unknown, options: { onSuccess: (r: unknown) => void }) => h.import().then(options.onSuccess), isPending: false }),
}));
const { TossOpenApiCard } = await import("@/components/TossOpenApiCard");
const { TossImportButton } = await import("@/components/TossImportButton");
const { createTossImportFlow, tossImportSummary } = await import("@/lib/tossImport");
const { ApiRequestError } = await import("@/api/client");
const stock = (code: string, name: string) => ({ code, name, quantity: 1, avgPrice: 10, lastPrice: 11, currency: "USD" as const, market: "US" });
const result = () => ({ accounts: 1, added: ["MSFT"], updated: [], unchanged: [], excluded: ["APH"], holdings: [stock("MSFT", "마이크로소프트"), stock("APH", "암페놀")] });
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
beforeEach(() => {
  h.alert.mockReset(); h.import.mockReset().mockResolvedValue(result()); h.register.mockReset().mockResolvedValue({}); h.invalidate.mockReset();
  h.qc = { invalidateQueries: h.invalidate }; h.identity = 1; h.ready = true; h.credentials = { apiUrl: "https://test.invalid", apiToken: "test-only" };
});

const press = (r: ReturnType<typeof render>, title: string) => r.act(() => (r.all().find((n) => n.props.title === title)!.props.onPress as () => void)());
const dialogPress = (text: string) => {
  const buttons = h.alert.mock.calls.at(-1)![2] as { text: string; onPress?: () => void }[];
  const button = buttons.find((b) => b.text === text);
  expect(button).toBeDefined(); button!.onPress!();
};
const deferred = <T,>() => { let resolve!: (v: T) => void; let reject!: (v: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const fixtureFlow = () => createTossImportFlow({ api: { importTossHoldings: h.import, registerStock: h.register }, isCurrent: () => h.identity === 1, invalidate: h.invalidate });
const restored = (): TossImportResult => ({ ...result(), added: [], updated: ["APH"], unchanged: ["MSFT"], excluded: [] });
const openRestore = async (flow: ReturnType<typeof createTossImportFlow>) => { await flow.run(); dialogPress("제외 종목 확인"); dialogPress("다시 연동"); await tick(); };

describe("가져오기 결과의 범위와 보류", () => {
  it("전체 제외는 보유 없음이 아니며 제외 이름을 정상 종목 상세보다 먼저 보여준다", () => {
    const all = tossImportSummary({ ...result(), added: [], excluded: ["MSFT", "APH"] });
    expect(all.message).toContain("보유 2종목 · 앱 연동 대상 0종목 · 동기화 제외 2종목");
    expect(all.message).not.toContain("보유 중인 주식이 없습니다");
    const partial = tossImportSummary(result()).message;
    expect(partial.indexOf("동기화 제외 1종목: 암페놀")).toBeLessThan(partial.indexOf("마이크로소프트 · 토스 조회"));
  });
  it("빈 계좌와 구버전 필드 누락을 구분하고 알 수 없는 반영을 성공으로 채우지 않는다", () => {
    expect(tossImportSummary({ accounts: 1, added: [], updated: [], unchanged: [], holdings: [] }).message).toContain("보유 중인 주식이 없습니다");
    const old = tossImportSummary({ ...result(), excluded: undefined });
    expect(old.message).toContain("앱 연동 대상 1종목");
    expect(old.message).toContain("반영 여부 확인 필요 1종목: 암페놀 (APH)");
  });
  it("부분 계좌 응답의 수량은 반영된 것으로 보이지 않고 유지 종목도 조회 수량을 단정하지 않는다", () => {
    const guarded = tossImportSummary({ ...restored(), updated: [], unchanged: ["MSFT", "APH"], deferred: ["APH"] });
    expect(guarded.summary).toContain("앱 연동 대상 1종목");
    expect(guarded.message).toContain("반영 보류 1종목: 암페놀 (APH)");
    expect(guarded.message).not.toContain("암페놀 · 토스 조회");
    expect(guarded.message).not.toContain("1주");
    expect(guarded.message).toContain("기존 등록 유지");
  });
  it("응답에서 이전 종목이 통째로 빠져도 보류가 있으면 빈 계좌로 단정하지 않는다", async () => {
    h.import.mockResolvedValueOnce({ accounts: 1, added: [], updated: [], unchanged: [], excluded: [], deferred: ["APH"], holdings: [] });
    await fixtureFlow().run();
    const [title, message, buttons] = h.alert.mock.calls.at(-1)!;
    expect(title).toBe("계좌 동기화 · 일부 반영 보류");
    expect(message).toContain("이번 조회 0종목"); expect(message).toContain("반영 보류 1종목: APH");
    expect(message).toContain("이전 등록·제외 상태를 유지"); expect(message).not.toContain("보유 중인 주식이 없습니다");
    expect(buttons).toEqual(expect.arrayContaining([expect.objectContaining({ text: "동기화 재시도" })]));
  });
});

describe("개별 복원과 일부 실패", () => {
  it("선택한 종목만 등록하고 동기화하며 다른 제외 종목은 유지한다", async () => {
    h.import.mockResolvedValueOnce({ ...result(), excluded: ["APH", "MSFT"], added: [] }).mockResolvedValueOnce({ ...restored(), unchanged: [], excluded: ["MSFT"] });
    await openRestore(fixtureFlow());
    expect(h.register).toHaveBeenCalledExactlyOnceWith({ code: "APH" });
    expect(h.import).toHaveBeenCalledTimes(2);
    expect(h.alert.mock.calls.at(-1)![1]).toContain("동기화 제외 1종목: 마이크로소프트 (MSFT)");
  });
  it("여러 제외 종목은 다음으로 선택하며 한 알림의 버튼은 세 개 이하이다", async () => {
    h.import.mockResolvedValueOnce({ ...result(), excluded: ["APH", "MSFT"], added: [] });
    const flow = fixtureFlow(); await flow.run(); dialogPress("제외 종목 확인"); dialogPress("다음 종목");
    expect(h.alert.mock.calls.at(-1)![1]).toContain("마이크로소프트 (MSFT)");
    for (const call of h.alert.mock.calls) expect(call[2]?.length ?? 0).toBeLessThanOrEqual(3);
    expect(h.register).not.toHaveBeenCalled();
  });
  it("등록 성공·동기화 실패를 분리하고 재시도에서 등록을 반복하지 않는다", async () => {
    h.import.mockResolvedValueOnce(result()).mockRejectedValueOnce(new Error("모의 연결 실패")).mockResolvedValueOnce(restored());
    await openRestore(fixtureFlow());
    expect(h.alert.mock.calls.at(-1)![0]).toBe("제외 해제 완료 · 계좌 동기화 실패");
    expect(h.import).toHaveBeenCalledTimes(2);
    dialogPress("동기화 재시도"); await tick();
    expect(h.register).toHaveBeenCalledTimes(1); expect(h.import).toHaveBeenCalledTimes(3);
  });
  it("등록 실패는 자동 재시도나 동기화 없이 정확히 실패 안내한다", async () => {
    h.register.mockRejectedValueOnce(new Error("등록 저장 실패"));
    await openRestore(fixtureFlow());
    expect(h.import).toHaveBeenCalledOnce(); expect(h.alert.mock.calls.at(-1)![0]).toBe("종목 복원 실패");
  });
  it("이미 등록된 정확한 충돌만 동기화로 확인하고 여전히 제외되면 복원 완료로 말하지 않는다", async () => {
    h.register.mockRejectedValueOnce(new ApiRequestError(409, "CONFLICT", "이미 등록된 종목입니다: APH"));
    await openRestore(fixtureFlow());
    expect(h.import).toHaveBeenCalledTimes(2);
    expect(h.alert.mock.calls.at(-1)![0]).toBe("종목 복원 확인 필요");
    expect(h.alert.mock.calls.at(-1)![1]).toContain("아직 동기화 제외 상태");
  });
  it.each([new ApiRequestError(409, "BUSY", "처리 중"), new ApiRequestError(403, "FORBIDDEN", "권한 없음")])("다른 오류를 이미 등록된 성공으로 취급하지 않는다: %s", async (error) => {
    h.register.mockRejectedValueOnce(error); await openRestore(fixtureFlow());
    expect(h.import).toHaveBeenCalledOnce(); expect(h.alert.mock.calls.at(-1)![0]).toBe("종목 복원 실패");
  });
  it("복원 응답에서 수량 반영 보류면 재동기화만 제공하고 보류 수량은 표시하지 않는다", async () => {
    h.import.mockResolvedValueOnce(result()).mockResolvedValueOnce({ ...restored(), updated: [], unchanged: ["MSFT", "APH"], deferred: ["APH"] }).mockResolvedValueOnce(restored());
    await openRestore(fixtureFlow());
    expect(h.alert.mock.calls.at(-1)![0]).toBe("종목 복원 확인 필요");
    expect(h.alert.mock.calls.at(-1)![1]).toContain("수량·평단 반영이 보류");
    expect(h.alert.mock.calls.at(-1)![1]).not.toContain("암페놀 · 토스 조회");
    dialogPress("동기화 재시도"); await tick();
    expect(h.register).toHaveBeenCalledOnce(); expect(h.import).toHaveBeenCalledTimes(3);
  });
  it("복원한 종목이 응답에서 사라지면 성공으로 단정하지 않는다", async () => {
    h.import.mockResolvedValueOnce(result()).mockResolvedValueOnce({ ...restored(), updated: [], holdings: [stock("MSFT", "마이크로소프트")] });
    await openRestore(fixtureFlow());
    expect(h.alert.mock.calls.at(-1)![0]).toBe("종목 복원 확인 필요");
    expect(h.alert.mock.calls.at(-1)![1]).toContain("복원을 확인하지 못했습니다");
  });
});

describe("중복 요청과 계정·서버 경계", () => {
  it("두 진입점의 연속 클릭은 요청 한 번이며 완료 알림은 빈 잔고가 사라져도 복원한다", async () => {
    const wait = deferred<TossImportResult>(); h.import.mockReturnValueOnce(wait.promise).mockResolvedValueOnce(restored());
    const r = render(<><TossOpenApiCard /><TossImportButton /></>);
    press(r, "토스 계좌 불러오기"); press(r, "지금 계좌 동기화"); press(r, "토스 계좌 불러오기");
    expect(h.import).toHaveBeenCalledOnce();
    r.unmount(); wait.resolve(result()); await tick();
    dialogPress("제외 종목 확인"); dialogPress("다시 연동"); dialogPress("다시 연동"); await tick();
    expect(h.register).toHaveBeenCalledExactlyOnceWith({ code: "APH" }); expect(h.import).toHaveBeenCalledTimes(2);
  });
  it("설정을 읽기 전에는 요청하지 않고 같은 인증으로 준비되면 바로 한 번 요청한다", async () => {
    h.ready = false; const r = render(<TossImportButton />); press(r, "토스 계좌 불러오기"); await tick(); expect(h.import).not.toHaveBeenCalled();
    h.ready = true; r.rerender(); press(r, "토스 계좌 불러오기"); await tick(); expect(h.import).toHaveBeenCalledOnce();
  });
  it.each(["계정", "서버", "토큰"])("%s가 바뀐 뒤 이전 완료 알림의 복원 행동은 새 요청을 보내지 않는다", async (kind) => {
    const r = render(<TossImportButton />); press(r, "토스 계좌 불러오기"); await tick(); dialogPress("제외 종목 확인");
    if (kind === "계정") h.identity++; else if (kind === "서버") h.credentials.apiUrl = "https://other.invalid"; else h.credentials.apiToken = "other-test";
    dialogPress("다시 연동"); await tick();
    expect(h.register).not.toHaveBeenCalled(); expect(h.import).toHaveBeenCalledOnce();
    expect(h.alert.mock.calls.at(-1)![0]).toBe("다시 확인해 주세요");
  });
  it("가져오기 대기 중 계정 전환 시 이전 결과·캐시 갱신을 적용하지 않는다", async () => {
    const wait = deferred<TossImportResult>(); h.import.mockReturnValueOnce(wait.promise);
    const r = render(<TossOpenApiCard />); press(r, "지금 계좌 동기화"); h.identity++; r.rerender();
    wait.resolve(result()); await tick(); r.rerender();
    expect(h.alert).not.toHaveBeenCalled(); expect(h.invalidate).not.toHaveBeenCalled(); expect(r.text()).not.toContain("앱 연동 대상");
  });
  it("등록 대기 중 계정이 바뀌면 후속 계좌 동기화를 보내지 않는다", async () => {
    const wait = deferred<unknown>(); h.register.mockReturnValueOnce(wait.promise);
    const flow = fixtureFlow(); await flow.run(); dialogPress("제외 종목 확인"); dialogPress("다시 연동"); h.identity++;
    wait.resolve({}); await tick(); expect(h.import).toHaveBeenCalledOnce();
  });
  it("등록 직후의 미세 작업 경계에서 계정이 바뀌어도 새 계정 동기화는 없다", async () => {
    h.register.mockImplementationOnce(() => { queueMicrotask(() => { h.identity++; }); return Promise.resolve({}); });
    await openRestore(fixtureFlow()); expect(h.import).toHaveBeenCalledOnce();
  });
  it("새 가져오기 뒤 이전 알림에서 복원을 눌러도 오래된 제외 목록을 적용하지 않는다", async () => {
    const flow = fixtureFlow(); await flow.run(); dialogPress("제외 종목 확인");
    const old = (h.alert.mock.calls.at(-1)![2] as { text: string; onPress?: () => void }[]).find((b) => b.text === "다시 연동")!.onPress!;
    await flow.run(); old(); await tick(); expect(h.register).not.toHaveBeenCalled();
  });
});
afterEach(cleanupRenders);

describe("토스 가져오기 두 진입점", () => {
  it.each(["설정", "빈 잔고"])("%s 완료 안내는 전체 보유를 전부 연동했다고 말하지 않고 제외 종목 복원을 제공한다", async (path) => {
    const r = render(path === "설정" ? <TossOpenApiCard /> : <TossImportButton />);
    const title = path === "설정" ? "지금 계좌 동기화" : "토스 계좌 불러오기";
    r.act(() => (r.all().find((n) => n.props.title === title)!.props.onPress as () => void)());
    await tick();
    expect(h.import).toHaveBeenCalledOnce(); expect(h.register).not.toHaveBeenCalled();
    const [, message, buttons] = h.alert.mock.calls.at(-1)!;
    expect(message).toContain("앱 연동 대상 1종목");
    expect(message).toContain("동기화 제외 1종목: 암페놀 (APH)");
    expect(buttons).toEqual(expect.arrayContaining([expect.objectContaining({ text: "제외 종목 확인" })]));
  });
});
