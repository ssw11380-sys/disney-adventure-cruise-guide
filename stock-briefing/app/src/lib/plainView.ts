import type { LiveTone } from "./freshness";
import type { MarketSessionView } from "./liveDot";
import { formatPct, formatPrice } from "./format";
import { watchDifference } from "./watchlist";

/**
 * 군더더기 글 줄이기 (2026-11-12, 기능 플래그 plainView — 사용자 요청 '불필요한 글씨가 있으면 가독성이 떨어진다 · AI 냄새가 나면 안 된다').
 * 켜졌을 때 화면에 쓰는 짧은 글을 한곳에 모은다 (순수 함수 · 상수 — test/plainView.test.ts). 꺼져 있으면 아무 화면도 이 파일을 쓰지 않는다.
 *
 * 줄이는 기준:
 *  - 숫자 옆의 단서·출처·수신 시각 설명은 '계산 기준'처럼 눌러서 펴는 곳에만 둔다 (경고는 그대로 둔다 — 지연·끊김·확인 불가)
 *  - 같은 말을 두 번 쓰지 않는다 (구역 머리에 있는 보유·관심 수, 표 머리에 있는 기준)
 *  - 글을 누가 썼는지(모델·AI)를 화면 곳곳에 붙이지 않는다. 틀릴 수 있다는 것과 고지 문구는 남긴다
 */

/** 자동으로 만든 글 위 한 줄 (예전 'AI가 쓴 글 · 틀릴 수 있음') */
export const PLAIN_NOTE = "참고용 요약 · 틀릴 수 있음";
/** 가치분석 글 위 한 줄 (예전 'AI가 쓴 글 · 틀릴 수 있음 · 참고 정보이며 투자 권유가 아닙니다') */
export const PLAIN_VALUE_NOTE = "참고용 요약 · 틀릴 수 있음 · 투자 권유가 아닙니다";

/** 종목 상세의 분석 제목·버튼 (예전 'AI 기업개요' · 'AI 기술분석' · 'AI 가치분석' · 'AI 분석 만들기') */
export const PLAIN_ANALYSIS = {
  company: "기업개요",
  technical: "기술분석",
  value: "가치분석",
  make: "분석 만들기",
  notMade: "관심 종목이 아니라 분석을 미리 만들지 않았습니다.",
  /** 새 분석이 끝났는지 확인하지 못함 (예전: "이전 생성이 중단되어 완료 여부를 확인하지 못했습니다. … 결과 확인은 AI 분석을 새로 만들지 않습니다." + "이전 분석을 보여 주는 중입니다.") */
  unknown: "새 분석이 끝났는지 확인하지 못했습니다.",
  unknownKept: "새 분석을 확인하지 못해 이전 분석을 보여 줍니다.",
} as const;

/**
 * 이미 만들어진 글에서 'AI'·'모델' 표기를 쉬운 말로 바꾼다 — 브리핑을 만들지 못한 까닭(lib/briefingStatus), 분석 대기 안내(lib/analysisRecovery),
 * 계좌 브리핑의 기본 설명 안내(lib/accountBriefing templateNote). 글을 만드는 쪽 함수는 그대로 두고 그리는 곳에서만 바꾼다. 해당 없는 글은 그대로
 */
const PLAIN_REWRITES: readonly (readonly [RegExp, string])[] = [
  [/AI 서비스가 잠시 붐볐습니다/g, "글을 만드는 서비스가 잠시 붐볐습니다"],
  [/AI 서비스에 잠시 문제가 있었습니다/g, "글을 만드는 서비스에 잠시 문제가 있었습니다"],
  [/AI가 글을 끝까지 쓰지 못했습니다/g, "글을 끝까지 만들지 못했습니다"],
  [/AI 서비스가 잠시 붐빔/g, "서비스가 잠시 붐빔"],
  [/AI 서비스에 잠시 문제/g, "서비스에 잠시 문제"],
  [/AI가 글을 끝까지 못 씀/g, "글이 중간에 끊김"],
  [/모델(이 설정되지 않아| 설명이 검사를 통과하지 못해| 설명을 받지 못해) 위 숫자로 만든 기본 설명을 보여 드립니다\./g, "위 숫자로 만든 기본 설명입니다."],
  [/AI 분석/g, "분석"],
];
export function plainText(text: string): string {
  let out = text;
  for (const [from, to] of PLAIN_REWRITES) out = out.replace(from, to);
  return out;
}

const stripMarket = (label: string) => label.replace(/^(한국|미국)\s+/, "");

/**
 * 잔고 상태 줄 (짧게): 열린 세션 이름 + 실시간/지연. 닫힌 시장 이름·실시간 종목 수·시각·보유 수는 쓰지 않는다.
 *  - "미국 정규장 · 실시간" (초록) · "한국 정규장 · 미국 주간거래 · 실시간"
 *  - 열린 시장이 없음: "장 마감" · "휴장" (시장마다 다르면 "미국 휴장 · 한국 장 마감")
 *  - 앱이 값을 제때 못 받거나 서버가 못 받는 중: "미국 정규장 · 지연", 끊김: "… · 연결 끊김"
 *  - 열린 세션에 거래 대상으로 확인된 종목이 없음: 세션 이름만 (회색)
 * 판단은 lib/liveDot sessionStatus 와 같다 (글만 짧다)
 */
export function plainSessionStatus(o: { sessions: readonly MarketSessionView[]; liveCount: number; eligibleCount: number; feedOk: boolean; offline: boolean }): { text: string; tone: LiveTone } {
  const open = o.sessions.filter((s) => s.open).map((s) => s.label);
  const all = o.sessions.map((s) => s.label);
  const short = [...new Set(all.map(stripMarket))];
  const head = open.length ? open.join(" · ") : short.length === 1 ? short[0]! : all.join(" · ");
  const with_ = (x: string) => (head ? `${head} · ${x}` : x);
  if (o.offline) return { text: with_("연결 끊김"), tone: "offline" };
  if (open.length === 0) return { text: head, tone: "closed" };
  if (!o.feedOk) return { text: with_("지연"), tone: "delayed" };
  if (o.liveCount > 0) return { text: with_("실시간"), tone: "live" };
  if (o.eligibleCount > 0) return { text: with_("지연"), tone: "delayed" };
  return { text: head, tone: "closed" };
}

/**
 * 상태 줄 전체 (짧게): 시각은 지연·끊김일 때만 ("… · 01:10:23 기준"), 끝 글(suffix — 시세 지연 종목 수)은 있을 때만.
 * 실시간·장 마감에는 시각을 붙이지 않는다 (실시간이면 지금이고, 장 마감이면 줄마다 값이 그대로다)
 */
export function plainStatusLine(o: { text: string; warn: boolean; clock: string | null; suffix: string }): string {
  return `${o.text}${o.warn && o.clock ? ` · ${o.clock} 기준` : ""}${o.suffix ? ` · ${o.suffix}` : ""}`;
}

/** 계좌 금액을 받은 시각 (짧게): 오늘이면 "01:39 기준", 아니면 "11/11 20:00 기준". 읽을 수 없으면 null */
export function plainSnapshotTime(iso: string, now: number): string | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const kst = (x: number) => new Date(x + 9 * 3_600_000);
  const d = kst(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  const hm = `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
  const sameDay = d.toISOString().slice(0, 10) === kst(now).toISOString().slice(0, 10);
  return `${sameDay ? hm : `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${hm}`} 기준`;
}

/**
 * 관심종목 카드의 '희망가까지' 값 (짧게): "-$115.08 (-31.52%)" — 현재가에서 구매희망 가격까지의 차이와 비율(현재가 대비).
 * 이미 희망가 이하면 "도달 · $5.00 아래", 같으면 "도달". 현재가를 모르면 null (줄을 그리지 않는다)
 */
export function plainWatchGap(current: number | null | undefined, desired: number, currency: "KRW" | "USD"): string | null {
  const diff = watchDifference(current, desired);
  if (!diff) return null;
  if (diff.amount === 0) return "도달";
  if (diff.reached) return `도달 · ${formatPrice(Math.abs(diff.amount), currency)} 아래`;
  return `${formatPrice(diff.amount, currency, { sign: true })} (${formatPct(diff.percent)})`;
}

/** 관심종목 카드의 알림 줄 (예전 '관심 시작 대비 5% 구간 알림 켜짐') */
export const plainWatchAlert = (on: boolean): string => (on ? "5% 알림 켜짐" : "알림 꺼짐");

/**
 * 발견 탭 상태 줄 첫머리 (짧게). 예전: "장중 · 30초마다 갱신" · "시간외 거래 반영 중 · 30초마다 갱신" · "장 시작 전 · 직전 거래일 기준" ·
 * "장외 시간 · 현재가 기준" · "장 마감 · 직전 정규장 기준" · "장 마감 · 마지막 거래 기준"
 */
export function plainDiscoverStatus(session: "regular" | "extended" | "pre" | "closed", live: boolean | undefined, paused: boolean): string {
  const stop = paused ? " · 자동 갱신 멈춤" : "";
  if (session === "regular") return `장중${stop}`;
  if (session === "extended") return `시간외${stop}`;
  if (session === "pre") return "장 시작 전";
  return live ? "장외 시간" : "장 마감";
}
