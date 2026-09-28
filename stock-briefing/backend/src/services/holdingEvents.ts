import { isKrCode } from "../lib/codes.js";
import type { TossCalendarEarning, TossDividend } from "../providers/market/toss.js";
import type { AccountEventItem, AccountEvents } from "./accountNumbers.js";

/**
 * 브리핑 3차 5 — 다가오는 일정 (플래그 holdingEvents, 실적 발표일은 holdingEarnings — 기본 꺼짐).
 * 계좌 브리핑을 만들 때 보유 종목의 앞날 일정을 모아 data.events 로 저장한다 (그때 기준 그대로).
 *  - 배당락일: 토스 웹 배당 요약(회사가 발표한 앞날 배당락일 포함 — 시세와 같은 호스트, 로그인 없음). 미국 종목은 네이버 basic 의 exDividendAt 과 맞춰
 *    **네이버의 다가오는 날짜가 토스 목록에 없으면 그 종목 배당락일을 빼고 로그**(틀린 날짜를 보이지 않게). 토스를 받지 못하면 미국은 네이버 날짜만(금액 없이).
 *    한국 종목은 배당이 보통 기준일 뒤에 정해져 앞날 날짜가 거의 없다 — 토스에 있을 때만
 *  - 실적 발표(holdingEarnings 켬일 때만): 토스증권 공개 캘린더(큰 종목만)에서 보유 종목의 토스 상품 코드와 맞는 것. 시각은 토스가 준 한국 시각·글 그대로
 *  - 브리핑 날짜(한국)부터 EVENTS_DAYS 일 안. 계좌 브리핑·세션 알림을 늦추지 않게 모두 합쳐 최대 EVENTS_BUDGET_MS 만 기다리고,
 *    못 받으면 24시간 안의 캐시, 그것도 없으면 failed(배당)·earningsFailed(실적)로 밝힌다 — 다음 브리핑 때 다시 받는다
 * 순수 함수(날짜 고르기·맞추기·이번 주)는 따로 내보내 녹화한 응답으로 테스트한다
 */

/** 브리핑 날짜부터 며칠 안의 일정을 보이는지 */
export const EVENTS_DAYS = 30;
/** 모든 출처를 합쳐 기다리는 최대 시간 (계좌 브리핑이 시장 요약(20초)과 함께 기다리므로 알림이 더 늦어지지 않게) */
export const EVENTS_BUDGET_MS = 20_000;
/** 배당 요약 캐시 (종목마다) — 하루 최대 두 번쯤 부른다 */
const DIVIDEND_TTL_MS = 12 * 3_600_000;
/** 캘린더 캐시 (달마다) */
const CALENDAR_TTL_MS = 6 * 3_600_000;
/** 새로 받지 못했을 때 쓰는 옛 캐시의 한도 */
const STALE_MS = 24 * 3_600_000;
/** 배당 요약을 동시에 부르는 수 */
const DIVIDEND_CONCURRENCY = 2;
/** 네이버를 동시에 부르는 수 */
const NAVER_CONCURRENCY = 2;

/** 다가오는 일정의 출처 (app.ts 가 토스 웹·네이버로 만든다 — 테스트는 녹화한 응답) */
export interface HoldingEventSources {
  /** 토스 배당 요약 (받지 못하면 던짐) */
  dividends(code: string): Promise<TossDividend[]>;
  /** 토스 캘린더 한 달의 실적 발표 (받지 못하거나 모양이 바뀌면 던짐) */
  calendar(ym: string): Promise<TossCalendarEarning[]>;
  /** 미국 종목의 토스 상품 코드 (시세를 받으며 이미 캐시에 있음) */
  productCode(code: string): Promise<string>;
  /** 네이버 가장 최근 발표 배당락일 (미국만): 날짜 · null(칸 없음) · undefined(받지 못함). 없으면 맞춰 보지 않는다 */
  naverExDividend?: ((code: string) => Promise<string | null | undefined>) | null;
}

export interface EventHolding {
  code: string;
  name: string;
}

export interface CollectInput {
  /** 보유 종목 (수량 > 0, 등록 순) */
  holdings: readonly EventHolding[];
  /** 브리핑 날짜 (한국 YYYY-MM-DD) */
  today: string;
  /** 계산 시각 (한국 시간 ISO — 계좌 브리핑 asOf) */
  asOf: string;
  /** 실적 발표일도 넣을지 (플래그 holdingEarnings) */
  earnings: boolean;
  /** 기다리는 최대 시간 (기본 EVENTS_BUDGET_MS — 테스트는 짧게) */
  budgetMs?: number;
}

/** 계좌 브리핑이 저장하는 값 중 이번 주(week — DB 를 봐야 앎)를 뺀 것 */
export type CollectedEvents = Omit<AccountEvents, "week">;

// ── 순수 함수 ──────────────────────────────────────────────────────

/** YYYY-MM-DD 에 n일 더하기 */
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 그 날짜가 든 주(월~일)의 월요일 */
export function mondayOf(date: string): string {
  const wd = new Date(`${date}T12:00:00Z`).getUTCDay(); // 0 = 일
  return addDays(date, wd === 0 ? -6 : 1 - wd);
}

/** 그 날짜가 든 주(월~일)의 일요일 */
export function sundayOf(date: string): string {
  return addDays(mondayOf(date), 6);
}

/** from ~ to 가 걸친 달 목록 'YYYY-MM' (보통 두 달) */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const end = to.slice(0, 7);
  for (let i = 0; i < 12; i++) {
    const ym = `${y}-${String(m).padStart(2, "0")}`;
    out.push(ym);
    if (ym >= end) break;
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

/** 이번 주 일정: 브리핑 날짜 ~ 그 주 일요일 (items 는 이미 날짜 순) */
export function weekItems(items: readonly AccountEventItem[], date: string): AccountEventItem[] {
  const end = sundayOf(date);
  return items.filter((i) => i.date >= date && i.date <= end);
}

/**
 * 종목 하나의 배당락일 줄 (from ~ to, 날짜 순). toss = 토스 배당 요약(받지 못했으면 null), naver = 네이버 가장 최근 발표 배당락일(미국만 —
 * 날짜 · null 칸 없음 · undefined 모름).
 *  - 토스를 받음: 오늘 이후 토스 날짜 중 창 안의 것. 미국이고 네이버의 다가오는(오늘 이후) 날짜가 토스 목록에 없으면 두 출처가 다른 것 → 줄을 빼고 conflict
 *    (네이버 날짜가 지난 날이거나 모르면 토스만). 두 출처가 같은 날짜는 source 'toss+naver'
 *  - 토스를 받지 못함: 한국은 failed. 미국은 네이버 날짜가 창 안이면 그 날짜만(금액 없이), 네이버도 모르면 failed
 */
export function dividendItems(
  h: EventHolding,
  toss: readonly TossDividend[] | null,
  naver: string | null | undefined,
  from: string,
  to: string,
): { items: AccountEventItem[]; failed: boolean; conflict: boolean } {
  const us = !isKrCode(h.code);
  const base = { code: h.code, name: h.name, kind: "exDividend" as const, usDate: us };
  if (toss === null) {
    if (!us || naver === undefined) return { items: [], failed: true, conflict: false };
    return { items: naver !== null && naver >= from && naver <= to ? [{ ...base, date: naver, source: "naver" }] : [], failed: false, conflict: false };
  }
  // 같은 날짜가 두 줄이면(정정 등) 먼저 온 한 줄만
  const seen = new Set<string>();
  const upcoming = [...toss].filter((r) => r.exDate >= from && !seen.has(r.exDate) && !!seen.add(r.exDate)).sort((a, b) => (a.exDate < b.exDate ? -1 : a.exDate > b.exDate ? 1 : 0));
  const inWindow = upcoming.filter((r) => r.exDate <= to);
  const naverNext = us && typeof naver === "string" && naver >= from ? naver : null;
  if (inWindow.length && naverNext !== null && !upcoming.some((r) => r.exDate === naverNext)) return { items: [], failed: false, conflict: true };
  return {
    items: inWindow.map((r) => ({
      ...base,
      date: r.exDate,
      ...(r.cash !== null ? { amount: r.cash } : {}),
      ...(r.cash !== null && r.currency ? { currency: r.currency } : {}),
      source: naverNext !== null && r.exDate === naverNext ? "toss+naver" : "toss",
    })),
    failed: false,
    conflict: false,
  };
}

/**
 * 캘린더 실적 발표 → 보유 종목 줄 (from ~ to). productCode = 보유 종목의 토스 상품 코드(한국 'A'+코드, 모르면 null — 맞추지 않음).
 * 미국은 토스가 준 한국 시각('05:00')·글('오전 5시 이후')을 그대로, 한국은 날짜만(시각을 주지 않음). 이미 발표 시각이 지난 것(오늘 05:00 < 08:38)은 뺀다
 */
export function earningsItems(
  holdings: ReadonlyArray<EventHolding & { productCode: string | null }>,
  calendar: readonly TossCalendarEarning[],
  from: string,
  to: string,
  asOf: string,
): AccountEventItem[] {
  const byProduct = new Map<string, EventHolding>();
  for (const h of holdings) if (h.productCode && !byProduct.has(h.productCode)) byProduct.set(h.productCode, h);
  const nowKst = kstMinute(asOf);
  const out: AccountEventItem[] = [];
  const seen = new Set<string>();
  for (const e of calendar) {
    const h = byProduct.get(e.productCode);
    if (!h || e.date < from || e.date > to) continue;
    const key = `${h.code}|${e.date}`;
    if (seen.has(key)) continue;
    const us = !isKrCode(h.code);
    const at = us && e.announceAt ? e.announceAt.slice(0, 16) : null;
    if (at && nowKst && at <= nowKst) continue; // 이미 발표 시각이 지남
    seen.add(key);
    out.push({
      code: h.code,
      name: h.name,
      kind: "earnings",
      date: e.date,
      ...(at ? { kstTime: at.slice(11, 16) } : {}),
      ...(us && e.timeText ? { timeText: e.timeText } : {}),
      usDate: false,
      source: "toss",
    });
  }
  return out;
}

/** 날짜 순 (같은 날은 시각 → 배당락일 → 실적 → 등록 순) */
export function sortEvents(items: readonly AccountEventItem[], holdings: readonly EventHolding[]): AccountEventItem[] {
  const order = new Map(holdings.map((h, i) => [h.code, i]));
  const kind = (k: AccountEventItem["kind"]) => (k === "exDividend" ? 0 : 1);
  return [...items].sort(
    (a, b) =>
      cmp(a.date, b.date) || cmp(a.kstTime ?? "", b.kstTime ?? "") || kind(a.kind) - kind(b.kind) || (order.get(a.code) ?? 0) - (order.get(b.code) ?? 0),
  );
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** 한국 시간 ISO → 'YYYY-MM-DDTHH:MM' (한국 벽시계). 읽지 못하면 null */
function kstMinute(iso: string): string | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Date(t + 9 * 3_600_000).toISOString().slice(0, 16);
}

// ── 모으기 (캐시·시간 제한) ──────────────────────────────────────────

interface Cached<T> {
  at: number;
  value: T;
}

export interface HoldingEventsDeps {
  sources: HoldingEventSources;
  now?: () => Date;
  log?: { info(obj: Record<string, unknown>, msg: string): void; warn(obj: Record<string, unknown>, msg: string): void };
}

/**
 * 출처를 부르고 캐시를 지니는 쪽 (계좌 브리핑이 하나를 같이 쓴다). 캐시 시각은 주입한 시계(now), 기다리는 시간은 실제 시계로 잰다.
 * 시간이 다 되면 새로 부르기를 멈추고, 나가 있는 요청은 뒤에서 끝나면 캐시에만 남긴다(다음 브리핑이 씀)
 */
export class HoldingEventsService {
  private readonly dividends = new Map<string, Cached<TossDividend[]>>();
  private readonly calendars = new Map<string, Cached<TossCalendarEarning[]>>();
  private readonly dividendInflight = new Map<string, Promise<void>>();
  private readonly calendarInflight = new Map<string, Promise<void>>();
  private readonly now: () => Date;
  private lastOk: string | null = null;
  private warning: string | null = null;
  /** 마지막으로 받지 못한 이유 (모양이 바뀜 등 — /health 경고에 붙임) */
  private lastError: { dividend: string | null; calendar: string | null } = { dividend: null, calendar: null };

  constructor(private readonly deps: HoldingEventsDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** /health 에 보일 값 (플래그가 켜져 있을 때만 app.ts 가 넣는다): 마지막으로 모두 받은 시각과 경고 */
  health(): { lastOk: string | null; warning: string | null } {
    return { lastOk: this.lastOk, warning: this.warning };
  }

  async collect(input: CollectInput): Promise<CollectedEvents> {
    const deadline = Date.now() + (input.budgetMs ?? EVENTS_BUDGET_MS);
    const from = input.today;
    const to = addDays(from, EVENTS_DAYS);
    const seen = new Set<string>();
    const holdings = input.holdings.filter((h) => !seen.has(h.code) && !!seen.add(h.code));
    const us = holdings.filter((h) => !isKrCode(h.code));
    const [, earnings] = await Promise.all([this.loadDividends(holdings.map((h) => h.code), deadline), input.earnings ? this.loadEarnings(holdings, from, to, input.asOf, deadline) : Promise.resolve(null)]);
    // 미국: 토스 창 안에 날짜가 있거나 토스를 받지 못한 종목만 네이버와 맞춰 본다 (토스에 앞날 날짜가 없으면 보일 줄도 없다)
    const toss = new Map(holdings.map((h) => [h.code, this.cachedDividends(h.code)]));
    const naver = await this.loadNaver(
      us.filter((h) => {
        const rows = toss.get(h.code);
        return rows === null || rows!.some((r) => r.exDate >= from && r.exDate <= to);
      }),
      deadline,
    );
    const items: AccountEventItem[] = [];
    const failed: Array<{ code: string; name: string }> = [];
    const conflicts: Array<{ code: string; name: string }> = [];
    for (const h of holdings) {
      const r = dividendItems(h, toss.get(h.code) ?? null, naver.get(h.code), from, to);
      items.push(...r.items);
      if (r.failed) failed.push({ code: h.code, name: h.name });
      if (r.conflict) {
        conflicts.push({ code: h.code, name: h.name });
        this.deps.log?.warn({ code: h.code, toss: toss.get(h.code)?.filter((x) => x.exDate >= from).map((x) => x.exDate), naver: naver.get(h.code) }, "토스·네이버 배당락일이 달라 이 종목 배당락일을 빼고 저장");
      }
    }
    if (earnings?.items) items.push(...earnings.items);
    const earningsFailed = input.earnings && earnings?.items === null;
    this.note(input.asOf, failed.length, earningsFailed, conflicts.length);
    return {
      asOf: input.asOf,
      days: EVENTS_DAYS,
      items: sortEvents(items, holdings),
      earnings: input.earnings,
      failed,
      earningsFailed,
      conflicts,
      kr: holdings.length - us.length,
      us: us.length,
    };
  }

  /** 캐시에 있는 배당 요약 (24시간 안이면 옛 값도). 없으면 null = 받지 못함 */
  private cachedDividends(code: string): TossDividend[] | null {
    const c = this.dividends.get(code);
    return c && this.now().getTime() - c.at < STALE_MS ? c.value : null;
  }

  /** 12시간 안에 받은 값이 없는 종목만 부른다 (동시에 DIVIDEND_CONCURRENCY 개, 시간이 다 되면 새로 부르지 않음) */
  private async loadDividends(codes: string[], deadline: number): Promise<void> {
    const t = this.now().getTime();
    const queue = codes.filter((c) => {
      const hit = this.dividends.get(c);
      return !hit || t - hit.at >= DIVIDEND_TTL_MS;
    });
    const one = (code: string): Promise<void> => {
      let p = this.dividendInflight.get(code);
      if (!p) {
        p = Promise.resolve()
          .then(() => this.deps.sources.dividends(code))
          .then(
            (rows) => {
              this.dividends.set(code, { at: this.now().getTime(), value: rows });
            },
            (e: unknown) => {
              this.lastError.dividend = (e as Error)?.message ?? String(e);
            },
          )
          .finally(() => this.dividendInflight.delete(code));
        this.dividendInflight.set(code, p);
      }
      return p;
    };
    const work = Promise.all(
      Array.from({ length: Math.min(DIVIDEND_CONCURRENCY, queue.length) }, async () => {
        for (let c = queue.shift(); c; c = queue.shift()) {
          if (Date.now() >= deadline) return;
          // 시간이 다 돼 돌아왔으면(타이머가 시계보다 1ms 일찍 울릴 수 있음) 다음 종목을 새로 부르지 않는다
          if ((await within(one(c), deadline)).kind === "timeout") return;
        }
      }),
    );
    await within(work, deadline);
  }

  /**
   * 실적 발표 (holdingEarnings): 창이 걸친 달의 캘린더(6시간 캐시, 못 받으면 24시간 안 옛 값)와 보유 종목의 토스 상품 코드.
   * 한 달이라도 받지 못하면 items null (일부 달만 보이면 목록이 다 있는 것처럼 읽히므로 실적 줄을 모두 뺀다)
   */
  private async loadEarnings(holdings: readonly EventHolding[], from: string, to: string, asOf: string, deadline: number): Promise<{ items: AccountEventItem[] | null }> {
    const months = monthsBetween(from, to);
    const t = this.now().getTime();
    const oneMonth = (ym: string): Promise<void> => {
      const hit = this.calendars.get(ym);
      if (hit && t - hit.at < CALENDAR_TTL_MS) return Promise.resolve();
      let p = this.calendarInflight.get(ym);
      if (!p) {
        p = Promise.resolve()
          .then(() => this.deps.sources.calendar(ym))
          .then(
            (rows) => {
              this.calendars.set(ym, { at: this.now().getTime(), value: rows });
            },
            (e: unknown) => {
              this.lastError.calendar = (e as Error)?.message ?? String(e);
            },
          )
          .finally(() => this.calendarInflight.delete(ym));
        this.calendarInflight.set(ym, p);
      }
      return p;
    };
    const codes = holdings.map((h) =>
      isKrCode(h.code)
        ? Promise.resolve<string | null>(`A${h.code}`)
        : Promise.resolve()
            .then(() => this.deps.sources.productCode(h.code))
            .catch(() => null),
    );
    const [, pcs] = await Promise.all([within(Promise.all(months.map(oneMonth)), deadline), Promise.all(codes.map((p) => within(p, deadline).then((r) => (r.kind === "ok" ? r.value : null))))]);
    const rows: TossCalendarEarning[] = [];
    const now = this.now().getTime();
    for (const ym of months) {
      const c = this.calendars.get(ym);
      if (!c || now - c.at >= STALE_MS) return { items: null };
      rows.push(...c.value);
    }
    return { items: earningsItems(holdings.map((h, i) => ({ ...h, productCode: pcs[i] ?? null })), rows, from, to, asOf) };
  }

  /** 네이버 배당락일 (미국, 동시에 NAVER_CONCURRENCY 개). 시간이 다 되거나 받지 못하면 그 종목은 undefined(모름) */
  private async loadNaver(list: readonly EventHolding[], deadline: number): Promise<Map<string, string | null | undefined>> {
    const out = new Map<string, string | null | undefined>();
    const src = this.deps.sources.naverExDividend;
    if (!src || !list.length) return out;
    const queue = [...list];
    await within(
      Promise.all(
        Array.from({ length: Math.min(NAVER_CONCURRENCY, queue.length) }, async () => {
          for (let h = queue.shift(); h; h = queue.shift()) {
            if (Date.now() >= deadline) return;
            const r = await within(
              Promise.resolve()
                .then(() => src(h.code))
                .catch(() => undefined),
              deadline,
            );
            out.set(h.code, r.kind === "ok" ? r.value : undefined);
            // 시간이 다 됐으면 다음 종목을 새로 부르지 않는다 (타이머가 시계보다 1ms 일찍 울릴 수 있음)
            if (r.kind === "timeout") return;
          }
        }),
      ),
      deadline,
    );
    return out;
  }

  /** /health 경고와 마지막으로 모두 받은 시각 */
  private note(asOf: string, failed: number, earningsFailed: boolean, conflicts: number): void {
    const parts = [
      failed ? `배당 일정을 받지 못한 종목 ${failed}개${this.lastError.dividend ? ` (${this.lastError.dividend})` : ""}` : null,
      earningsFailed ? `실적 발표일(토스 캘린더)을 받지 못함${this.lastError.calendar ? ` (${this.lastError.calendar})` : ""}` : null,
      conflicts ? `토스·네이버 배당락일이 달라 뺀 종목 ${conflicts}개` : null,
    ].filter((x): x is string => x !== null);
    this.warning = parts.length ? parts.join(" · ") : null;
    if (!failed && !earningsFailed) this.lastOk = asOf;
    if (!failed) this.lastError.dividend = null;
    if (!earningsFailed) this.lastError.calendar = null;
  }
}

/** p 를 deadline(실제 시계)까지 기다린다. 늦거나 실패하면 timeout (p 는 뒤에서 끝나도 무시 — 나중 실패도 처리된 것으로) */
async function within<T>(p: Promise<T>, deadline: number): Promise<{ kind: "ok"; value: T } | { kind: "timeout" }> {
  const settled = p.then(
    (value) => ({ kind: "ok" as const, value }),
    () => ({ kind: "timeout" as const }),
  );
  const ms = deadline - Date.now();
  if (ms <= 0) return { kind: "timeout" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<{ kind: "timeout" }>((res) => {
    timer = setTimeout(() => res({ kind: "timeout" }), ms);
  });
  try {
    return await Promise.race([settled, late]);
  } finally {
    clearTimeout(timer);
  }
}
