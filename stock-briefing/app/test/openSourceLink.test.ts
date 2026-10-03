import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ openURL: vi.fn(), alert: vi.fn() }));
vi.mock("react-native", () => ({ Linking: { openURL: h.openURL }, Alert: { alert: h.alert } }));
const { openSourceLink } = await import("@/lib/openSourceLink");

beforeEach(() => { h.openURL.mockReset(); h.alert.mockReset(); });

describe("근거 원문 열기", () => {
  it.each(["http://example.test/a", "https://example.test/a"])("정상 주소 %s는 추가 확인이나 자동 재시도 없이 즉시 한 번 연다", async (url) => {
    h.openURL.mockResolvedValue(undefined);
    const opening = openSourceLink(url);
    expect(h.openURL).toHaveBeenCalledExactlyOnceWith(url);
    await opening;
    expect(h.alert).not.toHaveBeenCalled();
  });

  it.each(["거부", "동기 오류"])("기기 %s도 처리하고 오류의 주소·상세를 노출하지 않는다", async (mode) => {
    const error = new Error("내부 오류 https://example.test/private?secret=test");
    if (mode === "거부") h.openURL.mockRejectedValue(error);
    else h.openURL.mockImplementation(() => { throw error; });
    await expect(openSourceLink("https://example.test/news")).resolves.toBeUndefined();
    expect(h.openURL).toHaveBeenCalledOnce();
    expect(h.alert).toHaveBeenCalledExactlyOnceWith("원문을 열지 못했습니다", "브라우저 연결을 확인한 뒤 다시 눌러 주세요.");
  });

  it.each(["javascript:alert(1)", "intent://example", "", "https://bad url"])("원문 웹 주소가 아닌 %s는 기기로 전달하지 않는다", async (url) => {
    await openSourceLink(url);
    expect(h.openURL).not.toHaveBeenCalled();
    expect(h.alert).toHaveBeenCalledOnce();
  });

  it("실패 뒤 사용자가 다시 누르면 새로 한 번 시도할 수 있다", async () => {
    h.openURL.mockRejectedValueOnce(new Error("시험 오류")).mockResolvedValueOnce(undefined);
    await openSourceLink("https://example.test/news");
    expect(h.openURL).toHaveBeenCalledTimes(1);
    await openSourceLink("https://example.test/news");
    expect(h.openURL).toHaveBeenCalledTimes(2);
    expect(h.alert).toHaveBeenCalledOnce();
  });
});
