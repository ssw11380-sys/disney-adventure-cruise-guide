import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { compactKrFacts, krInputs, type KrFacts, type KrMember } from "../../../src/analysis/krValue.js";
import type { ValueReferenceData } from "../../../src/analysis/valueScore.js";
import { parseNaverFinance, parseNaverIntegration } from "../../../src/providers/market/naverFinance.js";
import type { KrValueSources } from "../../../src/services/krValueService.js";

/**
 * 한국 간이 가치 픽스처 (test/fixtures/krValue, 2026-09-28 기록 — 모두 로그인 없는 네이버 증권 모바일 공개 JSON).
 *  - naver-finance.json.gz: 8종목(삼성전자·SK하이닉스·NAVER·카카오·현대차·KB금융·셀트리온·LG에너지솔루션)의 finance/annual · finance/quarter 원본
 *    (기업 소개 글만 뺌 — 추정 열 isConsensus=Y 그대로) · integration 의 숫자 줄(단위 글 '12.13배'·'22,292원'·'1,581조 4,184억')·업종 번호·
 *    증권사 추정 칸(cnsPer·cnsEps·consensusInfo — 파서가 버리는지 시험)
 *  - naver-members.json: 업종 목록 한 쪽(반도체·은행·기타 3개 업종)과 구성 종목 쪽 (앞 몇 줄)
 *  - reference.json.gz: 2026-09-28 실제로 만든 한국 비교 기준(네이버 업종 구성 종목 + 재무 요약 약 2,000종목)에서 시험 종목 업종·금융사 전부와
 *    나머지 1/4 만 남긴 것 (지표 채택 비율은 원래 값)
 */
const here = (name: string) => fileURLToPath(new URL(`./${name}`, import.meta.url));
const gz = (name: string) => JSON.parse(gunzipSync(readFileSync(here(name))).toString("utf8")) as unknown;

export const KR_CODES = ["005930", "000660", "035420", "035720", "005380", "105560", "068270", "373220"] as const;
export type KrCode = (typeof KR_CODES)[number];
export const KR_NAMES: Record<KrCode, string> = {
  "005930": "삼성전자",
  "000660": "SK하이닉스",
  "035420": "NAVER",
  "035720": "카카오",
  "005380": "현대차",
  "105560": "KB금융",
  "068270": "셀트리온",
  "373220": "LG에너지솔루션",
};

type Raw = { annual: unknown; quarter: unknown; integration: unknown };
let fin: { stocks: Record<string, Raw> } | null = null;
export const naverRaw = (code: KrCode): Raw => (fin ??= gz("naver-finance.json.gz") as { stocks: Record<string, Raw> }).stocks[code]!;
export const membersRaw = () => JSON.parse(readFileSync(here("naver-members.json"), "utf8")) as { sectors: unknown; pages: Record<string, unknown> };
export const hasKrReference = () => existsSync(here("reference.json.gz"));
export const krReference = () => gz("reference.json.gz") as ValueReferenceData;

/** 8종목 업종 (네이버 upjong, 2026-09-28) */
export const KR_UPJONG: Record<KrCode, [string, string]> = {
  "005930": ["반도체와반도체장비", "278"],
  "000660": ["반도체와반도체장비", "278"],
  "035420": ["양방향미디어와서비스", "300"],
  "035720": ["양방향미디어와서비스", "300"],
  "005380": ["자동차", "273"],
  "105560": ["은행", "301"],
  "068270": ["제약", "261"],
  "373220": ["전기제품", "283"],
};

/** 파싱해 줄인 재무 (저장 모양) */
export function krFactsOf(code: KrCode): KrFacts {
  const r = naverRaw(code);
  return compactKrFacts(code, parseNaverFinance(r.annual, "annual"), parseNaverFinance(r.quarter, "quarter"), parseNaverIntegration(r.integration))!;
}

/**
 * 합성 비교 회사 세상 (시험용): 8종목 재무를 조금씩 바꿔 종목마다 20곳씩 복제 (EPS·BPS·주당배당금 × 0.6~1.36) + ETF 한 줄.
 * 실제 비교 기준 픽스처(reference.json.gz)가 없을 때도 서버 흐름을 시험할 수 있게
 */
export function krWorld(): { members: KrMember[]; facts: Map<string, KrFacts> } {
  const members: KrMember[] = [];
  const facts = new Map<string, KrFacts>();
  for (const c of KR_CODES) {
    const f = krFactsOf(c);
    for (let k = 0; k < 20; k++) {
      const code = k === 0 ? c : `${900000 + KR_CODES.indexOf(c) * 1000 + k * 10}`;
      const scale = 0.6 + 0.04 * k;
      facts.set(code, { ...f, code, q: f.q.map((r) => [r[0], ...r.slice(1).map((v, j) => (v === null ? null : j === 4 || j === 5 || j === 6 ? v * scale : v))] as typeof r) });
      // 원래 종목은 실제에 가까운 현재가(네이버 PER × EPS)·시가총액(되짚은 주식 수 ÷ 1.1 — 우선주 몫을 뺀 보통주 어림) — 주식 수 확인(잠시 보류)에 걸리지 않게
      const i = f.i!;
      const price = i.per && i.eps && i.per > 0 ? i.per * i.eps : i.pbr! * i.bps!;
      const shares = krInputs(f, "2026-09-28")!.shares!;
      members.push(
        k === 0
          ? { code, name: KR_NAMES[c], market: "KOSPI", endType: "stock", price, marketCap: (price * shares) / 1.1, upjong: KR_UPJONG[c][0], upjongCode: KR_UPJONG[c][1] }
          : { code, name: `${KR_NAMES[c]} 비교${k}`, market: "KOSPI", endType: "stock", price: 100_000, marketCap: 1e12 * (21 - k), upjong: KR_UPJONG[c][0], upjongCode: KR_UPJONG[c][1] },
      );
    }
  }
  members.push({ code: "069500", name: "KODEX 200", market: "KOSPI", endType: "etf", price: 30_000, marketCap: 9e12, upjong: "기타", upjongCode: "25" });
  members.push({ code: "005935", name: "삼성전자우", market: "KOSPI", endType: "stock", price: 220_000, marketCap: 1e14, upjong: "반도체와반도체장비", upjongCode: "278" });
  return { members, facts };
}

/**
 * 가짜 한국 출처: 재무는 픽스처(없는 코드는 null = 네이버에 없음), 구성 종목은 넘긴 목록. 부른 횟수를 센다
 */
export function fakeKrSources(opts: { members?: KrMember[]; failFinance?: Set<string>; alias?: Record<string, KrCode> } = {}) {
  const calls = { finance: [] as string[], summary: [] as boolean[], members: 0 };
  const src: KrValueSources = {
    finance: async (code, o) => {
      calls.finance.push(code);
      calls.summary.push(o?.summary !== false);
      if (opts.failFinance?.has(code)) throw new Error("가짜 네이버 받기 실패");
      const c = (opts.alias?.[code] ?? code) as KrCode;
      if (!(KR_CODES as readonly string[]).includes(c)) return null;
      const r = naverRaw(c);
      return { annual: r.annual, quarter: r.quarter, integration: o?.summary === false ? null : r.integration };
    },
    members: async () => {
      calls.members++;
      return opts.members ?? [];
    },
  };
  return { src, calls };
}
