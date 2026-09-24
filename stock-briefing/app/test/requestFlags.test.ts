import { afterEach, describe, expect, it, vi } from "vitest";
import { createApi } from "@/api/client";

/**
 * 새 응답 모양을 안다고 서버에 알리는 요청 플래그 (옛 앱 번들 호환).
 * 서버는 병합하면 바로 배포되지만 옛 앱(OTA 전)은 그대로 쓰이므로, 옛 앱이 모르는 응답은 플래그를 보낸 요청에만 준다.
 *  - 지수 띠 stale=1: 출처가 실패한 지수의 마지막 값(stale). 없으면 서버는 예전처럼 그 지수를 뺀다
 *  - 발견 순위 r=1: 판을 잃은 뒤 쪽의 빈 쪽 + restart. 없으면 서버는 예전처럼 지금 목록의 쪽을 준다
 * 예전 서버는 모르는 플래그를 무시한다.
 */
afterEach(() => vi.unstubAllGlobals());

/** api 호출이 보낸 주소(경로 + 쿼리)를 모은다 */
function capture(body: unknown) {
  const urls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    const u = new URL(url);
    urls.push(`${u.pathname}${u.search}`);
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
  return urls;
}

describe("요청 플래그", () => {
  it("지수 띠는 stale=1 로 요청한다", async () => {
    const urls = capture({ indices: [] });
    await createApi("https://server.test").marketIndices();
    expect(urls).toEqual(["/api/market/indices?stale=1"]);
  });

  it("발견 순위는 모든 쪽을 r=1 로 요청한다 (뒤 쪽은 첫 쪽의 판 v 와 함께)", async () => {
    const urls = capture({ items: [] });
    const api = createApi("https://server.test");
    await api.discoverRank("KR", "volume", 1, 50);
    await api.discoverRank("US", "gainers", 3, 50, 1_758_700_000_000);
    expect(urls).toEqual(["/api/discover/KR/rank/volume?page=1&size=50&r=1", "/api/discover/US/rank/gainers?page=3&size=50&v=1758700000000&r=1"]);
  });
});
