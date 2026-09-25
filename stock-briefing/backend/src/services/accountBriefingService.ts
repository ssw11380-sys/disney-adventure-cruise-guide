import type { Db } from "../db/index.js";
import { isKrCode } from "../lib/codes.js";
import { NotFoundError } from "../lib/errors.js";
import { seoulIso } from "../lib/time.js";
import { GenerationError, type TextGenerator } from "../llm/generator.js";
import { renderTemplate, type PromptStore } from "../llm/prompts.js";
import type { DigestAccount } from "../notifications/digest.js";
import type { MarketStatus } from "../providers/market/calendar.js";
import type { MarketIndex } from "../providers/market/indices.js";
import type { Disclosure } from "../providers/dart/types.js";
import {
  BASIS,
  buildSchedule,
  checkNarrative,
  cleanNarrative,
  computeAccount,
  factsText,
  krPreviousDay,
  pickIndices,
  sessionKo,
  summaryText,
  templateNarrative,
  usPreviousDay,
  type AccountData,
  type AccountDisclosure,
  type AccountHolding,
  type AccountSession,
} from "./accountNumbers.js";

/** 목록·알림에 쓰는 머리 숫자 (data 에서 뽑는다) */
export interface AccountHeadline {
  totalValue: number;
  dayPnl: number;
  dayRate: number | null;
  holdings: number;
  /** 당일 손익 기여 상위 3 */
  top: Array<{ code: string; name: string; amount: number; changeRate: number | null }>;
  /** 오늘 한국 휴장이라 국내 종목의 등락이 직전 거래일 것 (그럴 때만 true 로 넣는다 — 예전 앱은 모르는 칸) */
  krPreviousDay?: true;
  /** 지난밤 미국 평일 휴장이라 미국 종목의 등락이 직전 거래일 것 (그럴 때만 true) */
  usPreviousDay?: true;
}

export interface AccountBriefing {
  id: number;
  date: string;
  session: AccountSession;
  status: "ok" | "failed";
  summary: string;
  detail: string;
  model: string;
  /** 모델 설명 없이 숫자만으로 만든 기본 문장인지 */
  template: boolean;
  createdAt: string;
  headline: AccountHeadline | null;
}

export interface AccountBriefingWithData extends AccountBriefing {
  data: AccountData | null;
}

export interface AccountBriefingDeps {
  db: Db;
  /** 잔고 + 현재가 (StockService.listWithFreshQuotes — 앱 잔고 화면과 같은 평가) */
  stocks: { listWithFreshQuotes(): Promise<AccountHolding[]> };
  /** 지수 띠와 같은 목록(30초 캐시) — 새로 부르는 출처 없음 */
  indices: { list(opts: { stale?: boolean }): Promise<MarketIndex[]> } | null;
  calendar: { status(): Promise<MarketStatus> } | null;
  generator: TextGenerator;
  prompts: PromptStore;
  features: { enabled(key: "accountBriefing" | "accountBriefingLlm"): Promise<boolean> };
  now?: () => Date;
  log?: { info(obj: Record<string, unknown>, msg: string): void; warn(obj: Record<string, unknown>, msg: string): void };
}

/** 모델 설명을 기다리는 최대 시간. 넘으면 기본 문장으로 (세션 알림이 늦어지지 않게) */
const LLM_WAIT_MS = 90_000;
/** 최근 공시: 오늘 포함 며칠 안에 낸 것만 */
const DISCLOSURE_DAYS = 3;
const DISCLOSURE_MAX = 8;

/**
 * 계좌 한 장 브리핑 (3-31). 세션(오전·오후)마다 종목별 브리핑이 끝난 뒤 계좌 전체 요약 한 건을 만든다.
 *  - 숫자(총 평가·당일 손익·기여도·지수·환율 효과·일정)는 accountNumbers 에서 코드로 계산한다
 *  - 설명은 기본으로 숫자만으로 만든 기본 문장. 플래그 accountBriefingLlm 을 켜면 모델이 그 숫자만 옮겨 쓰게 하고, 입력에 없는 숫자나 매매·전망 표현이 나오면 숫자만으로 만든 기본 문장을 쓴다.
 *    모델이 없거나 실패해도 기본 문장으로 저장한다(실패로 두지 않음)
 *  - 날짜·세션마다 1건. 이미 있으면 force(수동 전체 실행) 때만 다시 만든다
 *  - 플래그 accountBriefing 을 끄면 아무것도 하지 않는다(시세·지수 조회·모델 호출 0)
 */
export class AccountBriefingService {
  private running = false;
  /** 지금 만드는 중인 한 건 (관리용 수동 실행과 종목 실행 뒤 afterRun 이 겹칠 때 기다리려고) */
  private inflight: Promise<AccountBriefing | null> | null = null;
  private readonly now: () => Date;

  constructor(private readonly deps: AccountBriefingDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  get isRunning(): boolean {
    return this.running;
  }

  enabled(): Promise<boolean> {
    return this.deps.features.enabled("accountBriefing");
  }

  /**
   * 종목별 브리핑 실행이 끝났을 때 (BriefingService.onRunDone). 일부 종목 실행(상세의 '이 종목 다시 만들기')은 건너뛴다.
   * 이번에 새로 만든 성공 브리핑만 돌려준다 (세션 알림 앞머리용). 오류는 알림을 막지 않게 삼킨다
   */
  async afterRun(done: { session: AccountSession; date: string; partial: boolean; force: boolean; results?: Array<{ status: string }> }): Promise<AccountBriefing | null> {
    // 부른 순간 만드는 중인 것 (관리용 수동 실행 POST /api/account-briefings/run). 아래에서 끝나길 기다린다
    const pending = this.inflight;
    if (done.partial) return null;
    // 모든 종목이 휴장일이라 건너뛴 실행(두 시장 모두 휴장)은 계좌도 움직이지 않았으므로 만들지 않는다 (알림도 없음)
    if (!done.force && done.results?.length && done.results.every((r) => r.status === "skipped")) return null;
    if (!(await this.enabled().catch(() => false))) return null;
    try {
      // 관리용 수동 실행이 만드는 중이었으면 끝나길 기다린다 — '이미 만드는 중' 오류로 알림 앞머리가 빠지지 않게.
      // 방금 같은 날짜·세션으로 만든 것이면 그것을 앞머리로 쓴다 (force 면 이번 실행 기준으로 다시 만든다)
      if (pending) {
        const prev = await pending;
        if (!done.force && prev?.status === "ok" && prev.date === done.date && prev.session === done.session) return prev;
      }
      const b = await this.generate(done.session, { date: done.date, force: done.force });
      return b?.status === "ok" ? b : null;
    } catch (e) {
      this.deps.log?.warn({ session: done.session, err: (e as Error).message }, "계좌 브리핑 생성 오류");
      return null;
    }
  }

  /**
   * 한 건 만들기. 이미 성공한 건이 있고 force 가 아니면 null(새로 만들지 않음), 보유 종목이 없어도 null.
   * 시세가 하나도 없으면 실패로 저장한다(다음 실행에서 다시 만든다)
   */
  async generate(session: AccountSession, opts: { date: string; force?: boolean }): Promise<AccountBriefing | null> {
    if (this.running) throw new Error("계좌 브리핑을 이미 만드는 중입니다");
    this.running = true;
    const p = this.build(session, opts);
    this.inflight = p.catch(() => null);
    try {
      return await p;
    } finally {
      this.running = false;
      this.inflight = null;
    }
  }

  private async build(session: AccountSession, opts: { date: string; force?: boolean }): Promise<AccountBriefing | null> {
    const { date } = opts;
    if (!opts.force) {
      const existing = await this.find(date, session);
      if (existing?.status === "ok") return null;
    }
    const list = await this.deps.stocks.listWithFreshQuotes();
    const holdings = list.filter((s) => (s.quantity ?? 0) > 0 && s.avgPrice !== null);
    if (!holdings.length) {
      this.deps.log?.info({ session, date }, "보유 종목이 없어 계좌 브리핑 건너뜀");
      return null;
    }
    const now = this.now();
    const [indexList, status, disclosures] = await Promise.all([
      this.deps.indices ? this.deps.indices.list({ stale: true }).catch(() => [] as MarketIndex[]) : Promise.resolve([] as MarketIndex[]),
      this.deps.calendar ? this.deps.calendar.status().catch(() => null) : Promise.resolve(null),
      this.recentDisclosures(holdings.filter((h) => isKrCode(h.code)), date).catch(() => [] as AccountDisclosure[]),
    ]);
    const totals = computeAccount(holdings, { afterCost: true, usdKrw: indexList.find((i) => i.code === "USDKRW") ?? null });
    const { rows, missing } = pickIndices(indexList);
    const data: AccountData = {
      version: 1,
      session,
      date,
      asOf: seoulIso(now),
      basis: BASIS,
      ...totals,
      indices: rows,
      missingIndices: missing,
      schedule: buildSchedule(status, now, disclosures),
      narrative: { source: "template", reason: null },
    };
    data.krPreviousDay = krPreviousDay(data.schedule, totals);
    data.usPreviousDay = usPreviousDay(now, totals);
    if (data.holdings === 0) {
      data.narrative.reason = "시세를 받지 못함";
      return await this.save(date, session, { status: "failed", summary: "시세를 받지 못해 계좌 브리핑을 만들지 못했습니다", detail: "", data, model: "template" });
    }
    const n = await this.narrative(data);
    data.narrative = { source: n.source, reason: n.reason };
    return await this.save(date, session, { status: "ok", summary: summaryText(data), detail: n.text, data, model: n.model });
  }

  /** 모델 설명. 모델이 없거나 실패·시간 초과·검사 불합격이면 기본 문장 */
  private async narrative(data: AccountData): Promise<{ text: string; model: string; source: "llm" | "template"; reason: string | null }> {
    const template = (reason: string) => ({ text: templateNarrative(data), model: "template", source: "template" as const, reason });
    const gen = this.deps.generator;
    // 모델 설명은 플래그 accountBriefingLlm 을 켰을 때만 (기본 꺼짐 — 숫자는 늘 코드가 쓴다)
    if (!(await this.deps.features.enabled("accountBriefingLlm").catch(() => false))) return template("모델 설명 꺼짐");
    if (gen.model === "disabled") return template("브리핑 모델이 설정되지 않음");
    const facts = factsText(data);
    try {
      const p = await this.deps.prompts.load("account_briefing");
      const call = gen.generate({
        system: p.system,
        user: renderTemplate(p.userTemplate, { date: data.date, session_label: `${sessionKo(data.session)} 브리핑`, facts }),
        maxTokens: 1024,
        effort: "low",
        label: "account_briefing",
      });
      const out = await settleWithin(call, LLM_WAIT_MS);
      if (out.kind === "timeout") return template(`모델 응답 시간 초과(${LLM_WAIT_MS / 1000}초)`);
      if (out.kind === "error") throw out.error;
      const r = out.value;
      const text = cleanNarrative(r.text);
      const check = checkNarrative(text, facts);
      if (!check.ok) {
        this.deps.log?.warn({ reason: check.reason }, "계좌 브리핑 설명을 쓰지 않고 기본 문장으로");
        return template(check.reason);
      }
      return { text, model: r.model, source: "llm", reason: null };
    } catch (e) {
      const msg = e instanceof GenerationError ? `${e.kind}: ${e.message}` : (e as Error).message;
      this.deps.log?.warn({ err: msg }, "계좌 브리핑 모델 호출 실패 — 기본 문장으로");
      return template(`모델 호출 실패 (${msg})`);
    }
  }

  /**
   * 보유 국내 종목의 최근 공시 — 종목 브리핑이 이미 받아 저장한 것(briefings.data_snapshot)만 쓴다. DART 를 새로 부르지 않는다
   */
  private async recentDisclosures(kr: AccountHolding[], date: string): Promise<AccountDisclosure[]> {
    if (!kr.length) return [];
    const since = shiftDate(date, -(DISCLOSURE_DAYS - 1));
    const out: AccountDisclosure[] = [];
    for (const h of kr) {
      const row = await this.deps.db
        .selectFrom("briefings")
        .select(["data_snapshot"])
        .where("code", "=", h.code)
        .where("status", "=", "ok")
        .where("briefing_date", ">=", since)
        .orderBy("briefing_date", "desc")
        .orderBy("created_at", "desc")
        .limit(1)
        .executeTakeFirst();
      if (!row) continue;
      let list: Disclosure[] = [];
      try {
        list = (JSON.parse(row.data_snapshot) as { disclosures?: Disclosure[] | null }).disclosures ?? [];
      } catch {
        continue;
      }
      for (const d of list) if (d.filedAt >= since && d.filedAt <= date) out.push({ code: h.code, name: h.name, title: d.title, filedAt: d.filedAt, url: d.url ?? null });
    }
    return out.sort((a, b) => (a.filedAt < b.filedAt ? 1 : a.filedAt > b.filedAt ? -1 : 0)).slice(0, DISCLOSURE_MAX);
  }

  private async save(
    date: string,
    session: AccountSession,
    v: { status: "ok" | "failed"; summary: string; detail: string; data: AccountData; model: string },
  ): Promise<AccountBriefing> {
    const values = { briefing_date: date, session, status: v.status, summary: v.summary, detail: v.detail, data: JSON.stringify(v.data), model: v.model, created_at: seoulIso(this.now()) };
    await this.deps.db
      .insertInto("account_briefings")
      .values(values)
      .onConflict((oc) => oc.columns(["briefing_date", "session"]).doUpdateSet(values))
      .execute();
    const saved = await this.find(date, session);
    this.deps.log?.info({ date, session, status: v.status, model: v.model }, "계좌 브리핑 저장");
    return saved!;
  }

  // ── 조회 ──────────────────────────────────────────────────────

  async find(date: string, session: AccountSession): Promise<AccountBriefing | null> {
    const r = await this.deps.db.selectFrom("account_briefings").selectAll().where("briefing_date", "=", date).where("session", "=", session).executeTakeFirst();
    return r ? toBriefing(r) : null;
  }

  /** 최신 순 (날짜 내림차순, 같은 날은 오후 먼저) */
  async list(limit = 10): Promise<AccountBriefing[]> {
    const rows = await this.deps.db
      .selectFrom("account_briefings")
      .selectAll()
      .orderBy("briefing_date", "desc")
      .orderBy("session", "asc") // 'afternoon' < 'morning'
      .orderBy("id", "desc")
      .limit(limit)
      .execute();
    return rows.map(toBriefing);
  }

  /**
   * 최근 성공한 계좌 브리핑 id (최신 순). 위젯 응답(accountIds)에 넣어 앱 백그라운드 알림이 새 계좌 브리핑을 알아보게 한다 —
   * 종목 브리핑이 모두 실패하고 계좌 브리핑만 생긴 세션도 서버 푸시처럼 1건 알리도록
   */
  async recentOkIds(limit = 4): Promise<number[]> {
    const rows = await this.deps.db
      .selectFrom("account_briefings")
      .select(["id"])
      .where("status", "=", "ok")
      .orderBy("briefing_date", "desc")
      .orderBy("session", "asc")
      .orderBy("id", "desc")
      .limit(limit)
      .execute();
    return rows.map((r) => r.id);
  }

  async get(id: number): Promise<AccountBriefingWithData> {
    const r = await this.deps.db.selectFrom("account_briefings").selectAll().where("id", "=", id).executeTakeFirst();
    if (!r) throw new NotFoundError(`계좌 브리핑 ${id} 이 없습니다`);
    return { ...toBriefing(r), data: parseData(r.data) };
  }
}

/** 세션 알림 앞머리에 쓸 값 (성공한 계좌 브리핑만) */
export function digestAccount(b: AccountBriefing | null | undefined): DigestAccount | null {
  if (!b || b.status !== "ok" || !b.headline) return null;
  return {
    id: b.id,
    dayPnl: b.headline.dayPnl,
    dayRate: b.headline.dayRate,
    top: b.headline.top.map((t) => ({ name: t.name, amount: t.amount })),
    ...(b.headline.krPreviousDay ? { krPreviousDay: true } : {}),
    ...(b.headline.usPreviousDay ? { usPreviousDay: true } : {}),
  };
}

function parseData(s: string): AccountData | null {
  try {
    return JSON.parse(s) as AccountData;
  } catch {
    return null;
  }
}

function toBriefing(r: { id: number; briefing_date: string; session: string; status: string; summary: string; detail: string; data: string; model: string; created_at: string }): AccountBriefing {
  const d = parseData(r.data);
  return {
    id: r.id,
    date: r.briefing_date,
    session: r.session as AccountSession,
    status: r.status === "failed" ? "failed" : "ok",
    summary: r.summary,
    detail: r.detail,
    model: r.model,
    template: d?.narrative?.source !== "llm",
    createdAt: r.created_at,
    headline: d
      ? {
          totalValue: d.totalValue,
          dayPnl: d.dayPnl,
          dayRate: d.dayRate,
          holdings: d.holdings,
          top: d.contributions.slice(0, 3).map((c) => ({ code: c.code, name: c.name, amount: c.amount, changeRate: c.changeRate })),
          ...(d.krPreviousDay ? { krPreviousDay: true as const } : {}),
          ...(d.usPreviousDay ? { usPreviousDay: true as const } : {}),
        }
      : null,
  };
}

/** p 를 ms 까지 기다린다. 늦으면 timeout (p 는 뒤에서 끝나도 무시하고, 나중 실패도 처리된 것으로) */
async function settleWithin<T>(p: Promise<T>, ms: number): Promise<{ kind: "ok"; value: T } | { kind: "error"; error: unknown } | { kind: "timeout" }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<{ kind: "timeout" }>((res) => {
    timer = setTimeout(() => res({ kind: "timeout" }), ms);
  });
  try {
    return await Promise.race([p.then((value) => ({ kind: "ok" as const, value }), (error: unknown) => ({ kind: "error" as const, error })), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** YYYY-MM-DD 에 n일 더하기 */
function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
