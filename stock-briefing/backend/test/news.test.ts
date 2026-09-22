import { describe, expect, it } from "vitest";
import { ProviderError } from "../src/lib/errors.js";
import type { FetchFn } from "../src/providers/market/types.js";
import { NewsProviderChain } from "../src/providers/news/chain.js";
import { GoogleNewsRssProvider, parseGoogleRss } from "../src/providers/news/googleRss.js";
import { NaverNewsProvider } from "../src/providers/news/naver.js";
import { stripHtml } from "../src/providers/news/types.js";

const RSS = `<?xml version="1.0"?><rss><channel><title>x</title>
<item><title>삼성전자·SK하이닉스, PS6 D램 공급 정조준 - 더구루</title><link>https://news.google.com/a1</link><pubDate>Mon, 21 Sep 2026 23:22:18 GMT</pubDate><description>&lt;a href="x"&gt;desc&lt;/a&gt;</description></item>
<item><title><![CDATA[SK하이닉스 신입 4명 해고 - v.daum.net]]></title><link>https://news.google.com/a2</link><pubDate>Mon, 21 Sep 2026 02:07:29 GMT</pubDate><source url="https://v.daum.net">다음</source></item>
<item><title></title><link>https://x</link></item>
</channel></rss>`;

function fakeFetch(status: number, body: string, capture?: { url?: string; headers?: HeadersInit }): FetchFn {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    if (capture) {
      capture.url = String(input);
      capture.headers = init?.headers ?? {};
    }
    return new Response(body, { status });
  }) as FetchFn;
}

describe("Google News RSS", () => {
  it("제목에서 언론사를 분리하고 최신순으로 정렬한다", () => {
    const items = parseGoogleRss(RSS);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ title: "삼성전자·SK하이닉스, PS6 D램 공급 정조준", source: "더구루", url: "https://news.google.com/a1" });
    expect(items[0]!.publishedAt).toBe("2026-09-21T23:22:18.000Z");
    expect(items[1]).toMatchObject({ title: "SK하이닉스 신입 4명 해고", source: "다음" });
  });

  it("HTTP 오류는 ProviderError", async () => {
    const p = new GoogleNewsRssProvider(fakeFetch(503, ""));
    await expect(p.search("x", 5)).rejects.toThrow(ProviderError);
  });
});

describe("Naver news", () => {
  it("헤더에 키를 넣고, 태그를 벗기고, originallink 를 우선 쓴다", async () => {
    const cap: { url?: string; headers?: HeadersInit } = {};
    const body = JSON.stringify({
      items: [
        { title: "<b>SK하이닉스</b> 실적 &quot;호조&quot;", originallink: "https://www.example.com/1", link: "https://n.news.naver.com/1", description: "요약<br>", pubDate: "Tue, 22 Sep 2026 09:00:00 +0900" },
        { title: "두번째", link: "https://n.news.naver.com/2", description: "", pubDate: "Tue, 22 Sep 2026 08:00:00 +0900" },
      ],
    });
    const p = new NaverNewsProvider("id", "secret", fakeFetch(200, body, cap));
    const items = await p.search("SK하이닉스", 1);
    expect(cap.url).toContain("query=SK%ED%95%98%EC%9D%B4%EB%8B%89%EC%8A%A4");
    expect((cap.headers as Record<string, string>)["X-Naver-Client-Id"]).toBe("id");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ title: 'SK하이닉스 실적 "호조"', url: "https://www.example.com/1", source: "example.com", summary: "요약" });
    expect(items[0]!.publishedAt).toBe("2026-09-22T00:00:00.000Z");
  });

  it("stripHtml 은 태그와 엔티티를 정리한다", () => {
    expect(stripHtml("a &amp; <b>b</b>&nbsp;&lt;c&gt;")).toBe("a & b <c>");
  });
});

describe("NewsProviderChain", () => {
  it("첫 소스 실패 시 다음 소스로 넘어간다", async () => {
    const naver = new NaverNewsProvider("id", "s", fakeFetch(401, "{}"));
    const google = new GoogleNewsRssProvider(fakeFetch(200, RSS));
    const warnings: string[] = [];
    const chain = new NewsProviderChain([naver, google], { warn: (_o, m) => warnings.push(m) });
    const items = await chain.search("SK하이닉스", 5);
    expect(items).toHaveLength(2);
    expect(warnings).toHaveLength(1);
  });
});
