import { readFileSync } from "node:fs";
import { MutationObserver, QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApi } from "@/api/client";
import type { Analysis, AnalysisKind } from "@/api/types";
import { analysisView } from "@/lib/freshness";

/**
 * 종목 상세 AI 분석 탭 갱신 실패 (2026-09-24 점검 AI-01).
 * 이미 분석이 보이는 상태에서 "갱신" 요청(?refresh=1)만 실패하면, 이전 분석은 그대로 두되
 * 갱신 실패·이전 분석 표시 중임을 알리고 다시 시도할 수 있어야 한다. (예전: 실패 안내 없이 이전 분석으로 돌아감)
 * 실제 API 클라이언트 + react-query 조회·뮤테이션 상태를 화면 판단 함수에 그대로 넣는다.
 */
const API = "https://server.test";
const CODE = "005930";
const OLD_AT = "2026-09-23T09:00:00+09:00";
const NEW_AT = "2026-09-24T18:00:00+09:00";
const analysis = (kind: AnalysisKind, createdAt: string, content: string): Analysis => ({ id: 1, code: CODE, kind, content, missing: [], model: "test", createdAt, cached: false });

type Fail = (url: string) => Promise<Response>;
const FAILS: Record<string, { fail: Fail; says: string }> = {
  "503": { fail: async () => new Response("", { status: 503 }), says: "서버 오류 (503)" },
  시간초과: {
    fail: async () => {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    },
    says: "서버 응답이 없습니다 (시간 초과)",
  },
  연결실패: {
    fail: async () => {
      throw new TypeError("Network request failed");
    },
    says: `서버에 연결할 수 없습니다: ${API}`,
  },
};

/** 분석 탭 하나: 조회(QueryObserver) + 갱신(MutationObserver), hooks.ts 의 useAnalysis·refreshAnalysis 와 같은 키·동작 */
function tab(kind: AnalysisKind, requested = true) {
  const api = createApi(API);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 }, mutations: { retry: 0 } } });
  const query = new QueryObserver(qc, { queryKey: [API, "analysis", CODE, kind], queryFn: () => api.getAnalysis(CODE, kind), enabled: requested, retry: 0 });
  const unsubscribe = query.subscribe(() => undefined);
  const refresh = new MutationObserver(qc, {
    mutationFn: ({ code, kind: k }: { code: string; kind: AnalysisKind }) => api.getAnalysis(code, k, true),
    onSuccess: (data: Analysis) => qc.setQueryData([API, "analysis", data.code, data.kind], data),
  });
  const view = () => analysisView({ requested, query: query.getCurrentResult(), refresh: refresh.getCurrentResult(), code: CODE, kind });
  const data = () => query.getCurrentResult().data;
  return { query, refresh, view, data, unsubscribe, press: () => refresh.mutate({ code: CODE, kind }).catch(() => undefined) };
}

/** 첫 조회는 정상, 갱신(?refresh=1)만 fail 로 */
function serve(kind: AnalysisKind, refresh: Fail | "ok") {
  vi.stubGlobal("fetch", async (url: string) => {
    if (!url.includes("refresh=1")) return new Response(JSON.stringify(analysis(kind, OLD_AT, "이전 분석")), { status: 200 });
    return refresh === "ok" ? new Response(JSON.stringify(analysis(kind, NEW_AT, "새 분석")), { status: 200 }) : refresh(url);
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("분석 갱신 실패 안내 (AI-01)", () => {
  for (const kind of ["company", "value", "technical"] as const) {
    for (const [name, { fail, says }] of Object.entries(FAILS)) {
      it(`${kind}: 갱신 ${name} → 이전 분석·생성 시각은 그대로, 실패 안내가 함께 보인다`, async () => {
        serve(kind, fail);
        const t = tab(kind);
        await vi.waitFor(() => expect(t.data()).toBeDefined());
        expect(t.view()).toEqual({ state: "ready", refreshError: null });

        const pending = t.press();
        expect(t.view().state).toBe("loading");
        await pending;

        const v = t.view();
        expect(v.state).toBe("ready");
        expect(t.data()).toMatchObject({ content: "이전 분석", createdAt: OLD_AT });
        expect(v.refreshError).toContain("갱신하지 못했습니다");
        expect(v.refreshError).toContain("이전 분석");
        expect(v.refreshError).toContain(says);
        t.unsubscribe();
      });
    }
  }

  it("실패 후 다시 시도가 성공하면 안내가 사라지고 새 분석·새 생성 시각으로 바뀐다", async () => {
    serve("company", FAILS["503"]!.fail);
    const t = tab("company");
    await vi.waitFor(() => expect(t.data()).toBeDefined());
    await t.press();
    expect(t.view().refreshError).not.toBeNull();

    serve("company", "ok");
    await t.press();
    expect(t.view()).toEqual({ state: "ready", refreshError: null });
    expect(t.data()).toMatchObject({ content: "새 분석", createdAt: NEW_AT });
    t.unsubscribe();
  });

  it("다른 분석 종류의 갱신 실패는 이 탭에 띄우지 않는다", () => {
    const refresh = { isPending: false, isError: true, error: new Error("서버 오류 (503)"), variables: { code: CODE, kind: "value" } };
    const query = { data: analysis("company", OLD_AT, "이전 분석"), isLoading: false, isError: false };
    expect(analysisView({ requested: true, query, refresh, code: CODE, kind: "company" }).refreshError).toBeNull();
    expect(analysisView({ requested: true, query, refresh, code: "000660", kind: "value" }).refreshError).toBeNull();
  });

  it("기존 분석이 없을 때: 첫 조회 실패는 오류 화면(다시 시도), 만들기 전(관심 종목 아님)은 만들기 버튼", async () => {
    vi.stubGlobal("fetch", async () => new Response("", { status: 503 }));
    const t = tab("company");
    await vi.waitFor(() => expect(t.query.getCurrentResult().isError).toBe(true));
    expect(t.view()).toEqual({ state: "error", refreshError: null });
    t.unsubscribe();

    const idle = tab("value", false);
    expect(idle.view()).toEqual({ state: "ask", refreshError: null });
    idle.unsubscribe();
  });

  it("종목 상세 화면의 분석 탭이 갱신(뮤테이션) 상태를 넘기고 실패 안내를 그린다", () => {
    const src = readFileSync(new URL("../src/app/stocks/[code]/index.tsx", import.meta.url), "utf8");
    const body = src.slice(src.indexOf("function AnalysisTab("), src.indexOf("function NewsTab("));
    expect(body).toMatch(/analysisView\(\{[^}]*refresh: refreshAnalysis/);
    expect(body).toMatch(/refreshError \?/);
  });
});
