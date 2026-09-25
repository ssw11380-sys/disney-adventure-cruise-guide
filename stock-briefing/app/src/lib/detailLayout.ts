import type { AnalysisKind } from "@/api/types";
import { estimateTextWidth } from "@/lib/chartLayout";
import { clampScale } from "@/lib/textScale";
import type { FoldLayout } from "@/lib/windowClass";
import { font, fontCap, foldDetail, layout, space, touch } from "@/tokens";

/**
 * 종목 상세의 넓은 창 배치 계산 (3-42 웨이브 C, 기능 플래그 foldLayout). React Native 를 불러오지 않는 순수 모듈 (테스트용).
 * 기준 숫자는 tokens.ts 의 layout(창 등급)·foldDetail. 추정 창 크기(dp)로 본 결과 (글자 100%):
 *  - 폴드8 접힘 475×751 · 울트라 접힘 411×960 → phone (지금 휴대폰 화면 그대로)
 *  - 폴드8 펼침 세로 704×933 → wide (한 단: 차트 전체 폭 → 시세 4칸 → 탭)
 *  - 폴드8 펼침 가로 933×704 · 울트라 펼침 가로 954×859 → split (왼쪽 차트 고정 | 오른쪽 칸만 스크롤)
 *  - 울트라 펼침 세로 859×954 → rows (윗줄 차트 | 시세·보유·AI 분석, 아랫줄 최근 브리핑 · 뉴스 · 공시)
 */

export type DetailMode = "phone" | "wide" | "rows" | "split";

/**
 * 배치 고르기. 플래그가 꺼져 있거나 좁은 창이면 phone(지금 그대로).
 * 2단을 쓸 만큼 넓으면(fold.twoPane — 켜기 840·끄기 816, 큰 글씨면 기준이 올라간다) 가로 창은 좌우, 세로 창은 윗줄+아랫줄.
 * 그보다 좁은 중간 폭(또는 큰 글씨로 2단 기준을 넘지 못한 넓은 창)은 한 단
 */
export function detailMode(fold: FoldLayout, win: { width: number; height: number }): DetailMode {
  if (!fold.on || fold.width === "compact") return "phone";
  if (fold.twoPane) return win.width > win.height ? "split" : "rows";
  return "wide";
}

/** 오른쪽 칸 폭: 100% 는 foldDetail.sideW(340), 큰 글씨는 늘어난 배율(최대 140%)의 절반만큼 넓힌다 (140% → 408) */
export function sideWidth(fontScale: number): number {
  return Math.round(foldDetail.sideW * (1 + (clampScale(fontScale, fontCap.row) - 1) / 2));
}

/**
 * 시세표 한 줄에 놓는 칸(항목명 + 값) 수. inner 는 칸 안쪽 폭(좌우 여백 제외), 칸 사이는 space.lg.
 * 칸 하나는 foldDetail.statMinW × 글자 배율(최대 140%) 이상 → 오른쪽 칸 340 은 100% 에서 2칸, 130% 부터 1칸.
 * 폴드8 펼침 세로(안쪽 676)는 100% 에서 4칸, 130% 에서 3칸
 */
export function statColumns(inner: number, fontScale: number, max = 4): number {
  if (!(inner > 0)) return 1;
  const cell = foldDetail.statMinW * clampScale(fontScale, fontCap.row);
  return Math.max(1, Math.min(max, Math.floor((inner + space.lg) / (cell + space.lg))));
}

/** 목록을 n 칸에 세로로(칸마다 위에서 아래로) 나눈다: 앞 칸부터 하나씩 더 받는다 (14개 3칸 → 5·5·4) */
export function splitColumns<T>(items: readonly T[], n: number): T[][] {
  const cols = Math.max(1, Math.floor(n));
  const base = Math.floor(items.length / cols);
  const extra = items.length % cols;
  const out: T[][] = [];
  let at = 0;
  for (let i = 0; i < cols; i++) {
    const take = base + (i < extra ? 1 : 0);
    out.push(items.slice(at, at + take));
    at += take;
  }
  return out;
}

/** 목록을 한 줄에 n 개씩(가로 먼저) 나눈다 */
export function chunkRows<T>(items: readonly T[], n: number): T[][] {
  const per = Math.max(1, Math.floor(n));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += per) out.push(items.slice(i, i + per));
  return out;
}

/**
 * 폭 중간 한 단 배치(wide)의 차트 그림 높이 상한 = 창 높이 × foldDetail.wideChartHRatio.
 * CandleChart 의 기본(폭 × layout.chartAspect(0.62), 창 높이 × 0.5)보다 낮게 잡아, 차트와 시세·보유 숫자가 첫 화면에 함께 들어온다.
 * 하한은 상세 차트 공통 layout.chartMinH — 단 그 폭의 기본 높이(폭 × chartAspect)보다 높이지는 않는다 (CandleChart 와 같은 규칙)
 */
export function wideChartHeight(chartW: number, winH: number): number {
  const natural = chartW * layout.chartAspect;
  return Math.round(Math.max(Math.min(layout.chartMinH, natural), Math.min(natural, winH * foldDetail.wideChartHRatio)));
}

/**
 * 좌우 배치 왼쪽 칸의 차트 그림 높이: 칸 높이에서 차트 둘레(기간 칩·읽기 줄·이동평균 값·지표 칩·안내)를 뺀 나머지.
 * 둘레 높이는 그려 본 뒤 잰 값(처음에는 어림)이다. 최소 layout.chartMinH(상세 차트 공통 최소 높이) — 더 낮은 창에서는 왼쪽 칸이 스크롤된다
 */
export function fillChartHeight(paneH: number, chromeH: number): number {
  if (!(paneH > 0)) return layout.chartMinH;
  return Math.max(layout.chartMinH, Math.floor(paneH - chromeH));
}

// ── 탭 ──

/** 넓은 창의 탭: 최근 브리핑이 첫 탭이다 (휴대폰 화면은 지금처럼 기업개요 · 가치분석 · 기술분석 · 뉴스·공시, 최근 브리핑은 아래) */
export type DetailTab = AnalysisKind | "news" | "briefing";
const TAB_VALUES: readonly DetailTab[] = ["briefing", "news", "company", "value", "technical"];

/** 주소 검색어의 탭 값 검증 (여러 번 넣었으면 첫 값, 모르는 값이면 null = 배치의 기본 탭) */
export function parseDetailTab(raw: string | string[] | undefined): DetailTab | null {
  const s = Array.isArray(raw) ? raw[0] : raw;
  return TAB_VALUES.find((v) => v === s) ?? null;
}

/** 휴대폰 화면의 탭: 브리핑 탭은 없으므로(최근 브리핑은 늘 아래에 있다) 기업개요로 — 고른 적 없으면 지금처럼 기업개요 */
export function phoneTab(pick: DetailTab | null): AnalysisKind | "news" {
  return pick && pick !== "briefing" ? pick : "company";
}

/** 넓은 창 배치의 탭: 고른 적 없으면 최근 브리핑 */
export function wideTab(pick: DetailTab | null): DetailTab {
  return pick ?? "briefing";
}

/**
 * AI 분석 미리보기 글 (윗줄+아랫줄 배치 오른쪽 칸): 마크다운 제목·구분선·표 줄은 빼고, 목록 기호·강조 기호·링크 주소를 걷어 한 문단으로.
 * 앞 몇 줄만 보이고(foldDetail.previewCompanyLines · previewTechLines) '더 보기'로 원래 마크다운 전체를 보인다
 */
export function markdownPreview(md: string): string {
  return md
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^#{1,6}\s/.test(l) && !/^[-*_]{3,}$/.test(l) && !l.startsWith("|"))
    .map((l) =>
      l
        .replace(/^>\s?/, "")
        .replace(/^[-*+]\s+/, "")
        .replace(/^\d+\.\s+/, "")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/\*\*|__|`/g, ""),
    )
    .join(" ");
}

// ── 합친 머리 ──

export interface DetailHeaderInput {
  /** 머리가 쓰는 폭 (창 폭 − 좌우 화면 여백) */
  width: number;
  /** 시스템 글자 배율. 머리 글자는 fontCap.chrome(150%) 까지만 커진다 */
  fontScale: number;
  name: string;
  /** 코드·시장·업종 줄 */
  sub: string;
  /** 가격·단위·등락 글자 (시세가 없으면 null) */
  price: string | null;
  unit: string | null;
  change: string | null;
  rate: string | null;
  /** 시장 상태 줄들 (실시간·세션 · 기준 시각 · 원화 환산 · 시간외) */
  state: string[];
  /** ‹ n/17 › 묶음이 있는지와 가운데 글자 */
  pager: string | null;
  /** 오른쪽 버튼 글자 (수정 = null 아이콘만, 관심 추가 = "관심 추가", 버튼 없음 = false) */
  action: string | null | false;
}

export interface DetailHeaderLayout {
  /**
   * one: 한 줄에 모두 / stateBelow: 시장 상태만 둘째 줄 / quoteBelow: 가격·등락·시장 상태를 둘째 줄로
   * (이름은 '…'로 줄어들 수 있지만 가격·등락 숫자는 줄이지 않는다)
   */
  tier: "one" | "stateBelow" | "quoteBelow";
}

/** 시세 기준 시각 짧은 표기 "9/23 20:00" (한국 시간) — 합친 머리가 한 줄에 들어가지 않을 때 긴 표기 대신 쓴다 */
export function shortStamp(iso: string | null | undefined): string {
  const ms = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(ms)) return "-";
  const d = new Date(ms + 9 * 3_600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** 머리에서 이름이 줄어들어도 남기는 글자 수 */
const NAME_KEEP = 4;

/** 머리 한 줄의 좌우 여백 (화면 가장자리 ~ 뒤로 버튼, 수정 버튼 ~ 가장자리) */
export const HEAD_PAD = space.xs;

/**
 * 합친 머리 배치 (차트 전체 화면 머리 chartHeaderLayout 과 같은 방식의 어림). 글자 폭을 넉넉히 어림해
 * 한 줄에 들어간다고 본 것은 폰에서도 들어가게 한다. 들어가지 않으면 시장 상태 → 가격·등락 순서로 둘째 줄로 내린다
 */
export function detailHeaderLayout(o: DetailHeaderInput): DetailHeaderLayout {
  const s = clampScale(o.fontScale, fontCap.chrome);
  const w = (text: string | null, size: number) => (text ? estimateTextWidth(text, size * s) : 0);
  const chars = [...o.name];
  // 이름 칸이 지키는 폭: 이름 앞 NAME_KEEP 자, 아래 줄은 종목 코드(6자)까지 — 시장·업종은 '…'로 줄어들 수 있다
  const nameMin = Math.max(w(chars.length <= NAME_KEEP ? o.name : `${chars.slice(0, NAME_KEEP).join("")}…`, font.h2), Math.min(w(o.sub, font.small), w("000000", font.small)));
  // 가격 묶음: 가격(hero) 단위(body) 등락(body) 등락률(body)
  const quote = o.price ? w(o.price, font.hero) + space.xs + w(o.unit, font.body) + space.s + w(o.change, font.body) + space.s + w(o.rate, font.body) : 0;
  const state = o.state.length ? Math.max(...o.state.map((l) => w(l, font.small))) : 0;
  // 오른쪽: ‹ n/17 › (버튼 44 둘 + 가운데 글자) · 수정(44) 또는 관심 추가(별 + 글자)
  const pager = o.pager ? touch.min * 2 + w(o.pager, font.small) + space.xs * 2 : 0;
  const action = o.action === false ? 0 : o.action ? w(o.action, font.small) + font.title + space.xs * 3 : touch.min;
  const fixed = HEAD_PAD * 2 + touch.min + space.sm + nameMin + (pager ? space.sm + pager : 0) + (action ? space.sm + action : 0);
  const gaps = space.md;
  if (fixed + (quote ? gaps + quote : 0) + (state ? gaps + state : 0) <= o.width) return { tier: "one" };
  if (fixed + (quote ? gaps + quote : 0) <= o.width) return { tier: "stateBelow" };
  return { tier: "quoteBelow" };
}
