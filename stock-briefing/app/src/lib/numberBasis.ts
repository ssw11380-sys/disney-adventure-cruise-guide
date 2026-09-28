import type { ReconcileBadgeBody, RegisteredWithQuote } from "@/api/types";
import { speakClock } from "@/lib/a11y";
import { formatDateKo } from "@/lib/format";
import { reconcileLabel } from "@/lib/freshness";
import { fxOf, isHolding, sharedFx } from "@/lib/portfolio";

/**
 * 숫자 기준·토스 대조 배지 (3-32, 기능 플래그 numberBasis) — 순수 함수 (RN·훅·부품을 부르지 않는다 → 단위 테스트).
 *  - 점 옆 짧은 글(reconcileBadge): 서버의 마지막 토스 대조 기록 그대로 (3번 연속 경고 규칙은 서버 경고에만)
 *  - '숫자 기준' 창의 줄(basisRows): 시세 기준(시장·기준별 종목 수·시각)·시세 지연·합계 제외·평가금액·원화 환산·당일손익·토스 대조
 *  - 기준을 세는 종목 = 바로 옆 합계에 실제로 들어간 종목 (countedHoldings — 잔고 summarize 와 같은 규칙)
 * 앱이 받은 시세로 계산한 숫자이고, 글은 사실만 적는다 (매매 권유 없음)
 */

/** 서버 reconcileService 의 RECONCILE_WARN_PCT 와 같음 */
export const WARN_PCT = 0.1;
/** 토스 대조 배지를 다시 받는 간격 (잔고 탭이 보이는 동안). 실시간 알림이 끊겨도 1분 안에 바뀌게 (3-32) */
export const RECONCILE_POLL_MS = 30_000;
export const RECONCILE_OFF: ReconcileBadgeBody = { on: false, status: null, intraday: null, sync: null };
export type BasisTag = "NXT" | "주간거래" | "시간외" | "정규장";
export const BASIS_WORD: Record<BasisTag, string> = { NXT: "NXT 포함", 주간거래: "주간거래", 시간외: "시간외 포함", 정규장: "정규장" };
export const BASIS_FOOT = "앱이 받은 시세로 계산한 숫자입니다 · 매매 권유가 아닙니다";

/** 시세 priceBasis 원문 → 짧은 기준 (서버 providers/market/toss·tossOpenApi·naver 가 주는 글) */
const TAG_OF = new Map<string, BasisTag>([
  ["KRX+NXT 통합", "NXT"],
  ["KRX 정규장", "정규장"],
  ["정규장", "정규장"],
  ["주간거래", "주간거래"],
  ["최근 체결(시간외 포함)", "시간외"],
]);
/** 기준이 여럿일 때 보이는 차례 (정규장이 아닌 것 먼저, 모르는 기준은 끝) */
const TAG_ORDER: readonly (BasisTag | null)[] = ["NXT", "주간거래", "시간외", "정규장", null];
const UNKNOWN_WORD = "기준 모름";

/** 시세의 priceBasis 원문을 짧은 기준으로. 모르는 값·빈 값·없음(예전 서버)은 null */
export function basisTag(priceBasis: string | null | undefined): BasisTag | null {
  return priceBasis ? (TAG_OF.get(priceBasis) ?? null) : null;
}

/**
 * 종목 시세의 기준을 모아 한 번: 'NXT·주간거래 포함' · '정규장'. 시세가 없는 항목은 건너뛰고,
 * 기준을 모르는 시세가 하나라도 있으면 null ('정규장'이라고 잘못 말하지 않게)
 */
export function basisShort(quotes: readonly ({ priceBasis?: string | null } | null | undefined)[]): string | null {
  const present = quotes.filter((q): q is { priceBasis?: string | null } => q != null);
  if (!present.length) return null;
  const tags = present.map((q) => basisTag(q.priceBasis));
  if (tags.some((tg) => tg === null)) return null;
  const extra = (["NXT", "주간거래", "시간외"] as const).filter((tg) => tags.includes(tg));
  return extra.length ? `${extra.join("·")} 포함` : "정규장";
}

/** 화면 읽기용: 가운뎃점을 쉼표로 ('NXT·주간거래 포함' → 'NXT, 주간거래 포함') */
export function basisSpeech(short: string): string {
  return short.replace(/·/g, ", ");
}

/** 계좌 합계(잔고 summarize·위젯 totals)에 들어간 보유 종목: isHolding 이고 시세·평가가 있고, 달러 종목은 환율(fxOf(s) ?? sharedFx(목록))이 있을 때만 */
export function countedHoldings(stocks: readonly RegisteredWithQuote[]): RegisteredWithQuote[] {
  const shared = sharedFx([...stocks]);
  return stocks.filter((s) => isHolding(s) && !!s.quote && !!s.evaluation && (s.quote.currency !== "USD" || !!(fxOf(s) ?? shared)));
}

const HOUR = 3_600_000;
const kstDate = (ms: number) => new Date(ms + 9 * HOUR).toISOString().slice(0, 10);
const pad2 = (n: number) => String(n).padStart(2, "0");

/** 한국 시간 글: 오늘(한국 날짜)이면 '14:03', 아니면 '9/26 05:00' */
export function hmLabel(ms: number, now: number): string {
  const d = new Date(ms + 9 * HOUR);
  const hm = `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
  return kstDate(ms) === kstDate(now) ? hm : `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${hm}`;
}

export interface MarketBasis {
  market: "KR" | "US";
  count: number;
  tags: { tag: BasisTag | null; count: number }[];
  /** 그 시장 종목 시세 시각(asOf)의 가장 이른·늦은 값 (ms). 읽을 수 있는 것이 없으면 null */
  from: number | null;
  to: number | null;
  /** 시세 지연(quote.stale) 종목 이름 */
  stale: string[];
}

/** 합계에 들어간 종목의 시장별 시세 기준 (한국 → 미국, 종목이 없는 시장은 뺌) */
export function marketBasis(stocks: readonly RegisteredWithQuote[]): MarketBasis[] {
  const counted = countedHoldings(stocks);
  const out: MarketBasis[] = [];
  for (const market of ["KR", "US"] as const) {
    const list = counted.filter((s) => (s.quote!.currency === "USD" ? "US" : "KR") === market);
    if (!list.length) continue;
    const counts = new Map<BasisTag | null, number>();
    for (const s of list) {
      const tag = basisTag(s.quote!.priceBasis);
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    const tags = [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || TAG_ORDER.indexOf(a.tag) - TAG_ORDER.indexOf(b.tag));
    const times = list.map((s) => Date.parse(s.quote!.asOf)).filter((x) => Number.isFinite(x));
    out.push({
      market,
      count: list.length,
      tags,
      from: times.length ? Math.min(...times) : null,
      to: times.length ? Math.max(...times) : null,
      stale: list.filter((s) => s.quote!.stale).map((s) => s.name),
    });
  }
  return out;
}

const wordOf = (tag: BasisTag | null) => (tag ? BASIS_WORD[tag] : UNKNOWN_WORD);

/** 창의 '시세' 한 줄: '국내 3종목 · NXT 포함 · 14:02~14:03', '미국 14종목 · 주간거래 12 · 정규장 2 · 9/26 05:00~14:03' */
export function basisLine(m: MarketBasis, now: number): string {
  const name = m.market === "KR" ? "국내" : "미국";
  const tags = m.tags.length === 1 ? [wordOf(m.tags[0]!.tag)] : m.tags.map((x) => `${wordOf(x.tag)} ${x.count}`);
  let time: string | null = null;
  if (m.from !== null) {
    const a = hmLabel(m.from, now);
    const b = hmLabel(m.to ?? m.from, now);
    time = a === b ? a : `${a}~${b}`;
  }
  return [`${name} ${m.count}종목`, ...tags, ...(time ? [time] : [])].join(" · ");
}

/** 차이 % 글: 소수 둘째 자리, 단 0.1% 를 넘는데 둘째 자리로는 0.10 이하로 보이면 셋째 자리 (0.104 → '0.104') */
export function diffPctText(abs: number): string {
  const s = abs.toFixed(2);
  return Number(s) <= WARN_PCT && abs > WARN_PCT ? abs.toFixed(3) : s;
}

/**
 * 마지막 대조 기록을 '오래됐다'고 볼 분: 지금 동기화 주기(nextRunAt − lastRunAt, 장중 10·장 밖 60) + 10.
 * 주기를 모르면(동기화 정보 없음·다음 실행 없음) 장 밖 주기(idleIntervalMin, 없으면 60) + 10.
 * 동기화가 계속 실패해도 서버는 다음 실행을 앞으로 옮기므로, 부르는 쪽은 마지막 '기록' 시각에서 잰다
 */
export function staleAfterMin(sync: ReconcileBadgeBody["sync"]): number {
  const last = sync?.lastRunAt ? Date.parse(sync.lastRunAt) : NaN;
  const next = sync?.nextRunAt ? Date.parse(sync.nextRunAt) : NaN;
  const gap = Number.isFinite(last) && Number.isFinite(next) && next > last ? (next - last) / 60_000 : (sync?.idleIntervalMin ?? 60);
  return gap + 10;
}

export interface Badge {
  kind: "none" | "wait" | "old" | "qty" | "missing" | "over" | "ok";
  text: string;
  tone: "ok" | "warn" | "muted";
  /** 화면 읽기 (앞말 '숫자 기준 보기, ' 는 부품이 붙인다) */
  speech: string;
}

/** 점 옆 짧은 글: 마지막 토스 대조 기록 그대로 (위에서부터 처음 맞는 줄) */
export function reconcileBadge(body: ReconcileBadgeBody | null | undefined, now: number): Badge {
  const status = body?.on ? body.status : null;
  if (!status) return { kind: "none", text: "숫자 기준", tone: "muted", speech: "토스 대조 없음" };
  const last = status.last;
  if (!last) return { kind: "wait", text: "토스 대조 대기", tone: "muted", speech: "토스 대조 기록 없음" };
  const at = Date.parse(last.at);
  const today = Number.isFinite(at) && kstDate(at) === kstDate(now);
  const hm = Number.isFinite(at) ? hmLabel(at, now) : last.at;
  const when = today ? speakClock(hm) : formatDateKo(last.at, true);
  if (now - at > staleAfterMin(body!.sync) * 60_000) return { kind: "old", text: `토스 대조 ${hm}`, tone: "muted", speech: `${when} 뒤로 새 토스 대조 기록 없음` };
  if (last.qtyMismatch?.length) return { kind: "qty", text: "토스와 수량 다름", tone: "warn", speech: `보유 수량이 토스와 다른 종목 ${last.qtyMismatch.length}개, ${when} 대조` };
  if (last.missing > 0) return { kind: "missing", text: "토스 대조 대기", tone: "muted", speech: `시세 지연 등으로 비교 못 함, ${when} 대조` };
  const compared = last.n && last.n > 0 ? `같은 종목 ${last.n}개 비교, ` : "";
  const abs = Math.abs(last.diffPct);
  if (abs > WARN_PCT) {
    const pct = diffPctText(abs);
    return { kind: "over", text: `토스와 차이 ${pct}%`, tone: "warn", speech: `토스 계좌와 ${pct}% 차이, ${compared}${when} 대조` };
  }
  return { kind: "ok", text: "토스와 0.1% 이내", tone: "ok", speech: `토스 계좌와 0.1% 이내, ${compared}${when} 대조` };
}

export interface BasisRow {
  key: string;
  label: string;
  lines: string[];
  warn?: boolean;
  /** 흐린 글로 그릴 lines 의 번호 */
  muted?: number[];
}

/** '숫자 기준' 창의 줄 (위에서 아래 순서, 조건이 맞을 때만). 부품이 아닌 값만 받는다 */
export function basisRows(o: {
  stocks: readonly RegisteredWithQuote[];
  afterCost: boolean;
  /** AccountBand 의 fxNote(data) */
  fxNote: string | null;
  /** AccountData.excluded */
  excluded: string | null;
  reconcile: ReconcileBadgeBody | null | undefined;
  now: number;
}): BasisRow[] {
  const rows: BasisRow[] = [];
  const markets = marketBasis(o.stocks);
  if (markets.length) rows.push({ key: "quote", label: "시세", lines: markets.map((m) => basisLine(m, o.now)) });
  const stale = markets.flatMap((m) => m.stale);
  if (stale.length) rows.push({ key: "stale", label: "시세 지연", lines: [`${stale.length}종목 · ${stale.slice(0, 3).join(", ")}${stale.length > 3 ? ` 외 ${stale.length - 3}` : ""}`], warn: true });
  if (o.excluded) rows.push({ key: "excluded", label: "합계 제외", lines: [o.excluded], warn: true });
  rows.push({
    key: "value",
    label: "평가금액",
    lines: [o.afterCost ? "수수료·세금 예상액을 뺀 값 (설정 '수수료·세금 차감 평가' 켬)" : "수수료·세금을 빼기 전 값 (설정 '수수료·세금 차감 평가' 꺼짐)"],
  });
  if (o.fxNote) rows.push({ key: "fx", label: "원화 환산", lines: [o.fxNote] });
  rows.push({ key: "day", label: "당일손익", lines: ["종목마다 전일 대비 × 수량 (미국 종목은 적용 환율로 원화 환산 — 환율 변동은 넣지 않음)"] });
  const status = o.reconcile?.on ? o.reconcile.status : null;
  if (status) {
    const lines = [reconcileLabel(status, (iso) => formatDateKo(iso, true), diffPctText)];
    const muted: number[] = [];
    const n = status.last?.n;
    if (n && n > 0) lines.push(`같은 종목 ${n}개의 토스 평가금액(수수료·세금 차감)과 비교`);
    if (status.streakOver >= 1) lines.push(`0.1% 넘는 차이 ${status.streakOver}회 연속`);
    const intra = o.reconcile!.intraday;
    if (intra) {
      // 서버가 소수 첫째 자리로 반올림한 비율을 그대로 글자로 (75 → '75%', 66.7 → '66.7%')
      const head = intra.n > 0 && intra.withinPct !== null ? `최근 7일 장중(정규장) ${intra.n}회 중 ${intra.withinPct}%가 0.1% 이내` : "최근 7일 장중(정규장) 비교 기록 없음";
      lines.push(`${head}${intra.skipped > 0 ? ` · 비교 못 함 ${intra.skipped}회` : ""}`);
    }
    const sync = o.reconcile!.sync;
    if (sync) {
      muted.push(lines.length);
      lines.push(
        sync.enabled && sync.intervalMin > 0
          ? `토스 동기화 때마다 대조합니다 (장중 ${sync.intervalMin}분, 장 밖 ${sync.idleIntervalMin}분마다)`
          : "자동 동기화가 꺼져 있어 설정의 '지금 계좌 동기화' 때만 대조합니다",
      );
    }
    rows.push({ key: "toss", label: "토스 대조", lines, ...(muted.length ? { muted } : {}) });
  }
  return rows;
}
