import type { Selectable } from "kysely";
import type { Db } from "../db/index.js";
import type { PriceAlertTable } from "../db/schema.js";
import type { Candle } from "../domain/types.js";
import { isKrCode, normalizeCode } from "../lib/codes.js";
import { AppError } from "../lib/errors.js";
import { seoulDate, seoulIso } from "../lib/time.js";
import type { FeatureService } from "./featureService.js";
import { VOLUME_REASON, volumeNotOk, volumeStatus, volumeWindow, type VolumeStatus } from "./volumeBaseline.js";

/**
 * 가격·등락률·거래량 알림 조건 (3-29, 플래그 priceAlerts). 조건을 저장하고, 앱이 울린 뒤 알려 준 날짜를 적는다(조건마다 하루 한 번).
 * 확인(울릴지 판단)은 앱이 켜져 있는 동안 앱이 한다 — 가격·등락률은 앱이 받는 실시간 체결·시세로, 거래량 급증만 서버가 30분봉으로 계산해 준다(volume).
 * 조건은 등록 종목(보유·관심)에만 만든다 (앱 실시간 스트림이 등록 종목 체결만 받음). 등록에서 뺀 종목의 조건은 지우지 않고 registered: false 로 준다.
 * 3-30(앱이 꺼져 있어도 알림)이 이 표와 fired_on 을 이어 쓴다
 */

export const PRICE_ALERT_KINDS = ["priceAbove", "priceBelow", "rateUp", "rateDown", "volume"] as const;
export type PriceAlertKind = (typeof PRICE_ALERT_KINDS)[number];

export interface PriceAlertRule {
  id: number;
  code: string;
  kind: PriceAlertKind;
  value: number;
  currency: "KRW" | "USD" | null;
  createdAt: string;
  firedOn: string | null;
  firedAt: string | null;
  firedValue: number | null;
  /** 지금 등록 종목(보유·관심)인지 — 표에 두지 않고 읽을 때 registered_stocks 로 정한다 */
  registered: boolean;
}

/** 한도: 한 종목 5개, 모두 30개, 거래량 조건은 모두 10개 (거래량은 종목마다 30분봉 450개를 30초마다 받으므로 토스 웹 요청을 묶어 두려고) */
export const PRICE_ALERT_LIMITS = { perCode: 5, all: 30, volume: 10 } as const;
/** 거래량 상태를 한 번에 묻는 종목 수 */
export const VOLUME_MAX_CODES = 10;
/** 거래량 조건 배수 */
export const VOLUME_TIMES = [2, 3, 5, 10] as const;
/** 거래량 상태 계산의 시간 예산 기본값(ms): 넘으면 남은 종목의 봉을 받지 않는다 (앱 요청 시간 제한 45초 안에 끝나게) */
const VOLUME_BUDGET_MS = 35_000;
/**
 * 거래량 상태 응답의 마감 기본값(ms): 예산 안에 시작한 받기도 이때까지 끝나지 않으면 기다리지 않고 그 종목은 unavailable.
 * 예산 직전에 시작한 받기는 토스 요청 한도 8초에 봉 캐시의 '받는 중인 요청 뒤 한 번 더'까지 겹쳐 16초쯤 걸릴 수 있다 → 예산만으로는 45초를 넘길 수 있음
 */
const VOLUME_DEADLINE_MS = 40_000;

/** 실제 달력 날짜인지 (YYYY-MM-DD 모양 + 2026-13-45·2026-02-30 같은 없는 날 거절) */
export function isCalendarDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
}

/** 두 날짜(YYYY-MM-DD) 사이 날 수 (b − a) */
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** 소수 둘째 자리까지인 수인지 (센트·등락률). v*100 이 정수인지로 보면 0.29*100 = 28.999999999999996 처럼 부동소수 꼬리 때문에 정상 값을 거절한다 — 앱 lib/priceAlerts 와 같은 식 */
export function hasCents(v: number): boolean {
  return Number.isFinite(v) && Math.round(v * 100) / 100 === v;
}

const isPriceKind = (kind: PriceAlertKind) => kind === "priceAbove" || kind === "priceBelow";

/** kind 별 값 범위·자리 (앱 validateDraft 와 같은 규칙). 어기면 AppError(400, "VALIDATION", "value: …") */
export function checkValue(kind: PriceAlertKind, value: number, currency: "KRW" | "USD" | null): void {
  const bad = (msg: string): never => {
    throw new AppError(400, "VALIDATION", `value: ${msg}`);
  };
  if (isPriceKind(kind)) {
    if (currency === "USD") {
      if (!(value >= 0.01 && value <= 1_000_000)) bad("$0.01 이상 $1,000,000 이하로 넣어 주세요");
      if (!hasCents(value)) bad("소수 둘째 자리까지 넣어 주세요");
      return;
    }
    if (!(value >= 1 && value <= 100_000_000) || !Number.isInteger(value)) bad("1원 이상 1억 원 이하로 넣어 주세요");
    return;
  }
  if (kind === "volume") {
    if (!(VOLUME_TIMES as readonly number[]).includes(value)) bad("2·3·5·10배 중 하나로 골라 주세요");
    return;
  }
  if (!(value >= 1 && value <= 30)) bad("1~30 사이로 넣어 주세요");
  if (!hasCents(value)) bad("소수 둘째 자리까지 넣어 주세요");
}

function toRule(r: Selectable<PriceAlertTable>, registered: boolean): PriceAlertRule {
  return {
    id: Number(r.id),
    code: r.code,
    kind: r.kind as PriceAlertKind,
    value: Number(r.value),
    currency: r.currency === "KRW" || r.currency === "USD" ? r.currency : null,
    createdAt: r.created_at,
    firedOn: r.fired_on,
    firedAt: r.fired_at,
    firedValue: r.fired_value === null ? null : Number(r.fired_value),
    registered,
  };
}

export class PriceAlertService {
  private readonly db: Db;
  private readonly features: Pick<FeatureService, "enabled">;
  private readonly candles: (code: string) => Promise<Candle[]>;
  private readonly now: () => Date;
  private readonly volumeBudgetMs: number;
  private readonly volumeDeadlineMs: number;
  /** 만들기를 한 번에 하나씩 (한도 '세기 → 넣기'가 겹치지 않게). 서버는 한 프로세스라 이 줄로 충분하다 */
  private createQueue: Promise<unknown> = Promise.resolve();

  constructor(deps: {
    db: Db;
    features: Pick<FeatureService, "enabled">;
    candles: (code: string) => Promise<Candle[]>;
    now?: () => Date;
    volumeBudgetMs?: number;
    volumeDeadlineMs?: number;
  }) {
    this.db = deps.db;
    this.features = deps.features;
    this.candles = deps.candles;
    this.now = deps.now ?? (() => new Date());
    this.volumeBudgetMs = deps.volumeBudgetMs ?? VOLUME_BUDGET_MS;
    this.volumeDeadlineMs = deps.volumeDeadlineMs ?? VOLUME_DEADLINE_MS;
  }

  enabled(): Promise<boolean> {
    return this.features.enabled("priceAlerts");
  }

  private async registeredCodes(): Promise<Set<string>> {
    return new Set((await this.db.selectFrom("registered_stocks").select("code").execute()).map((r) => r.code));
  }

  /** 모든 조건 (종목 코드, id 순) */
  async list(): Promise<PriceAlertRule[]> {
    const rows = await this.db.selectFrom("price_alerts").selectAll().orderBy("code").orderBy("id").execute();
    const reg = await this.registeredCodes();
    return rows.map((r) => toRule(r, reg.has(r.code)));
  }

  private async get(id: number): Promise<PriceAlertRule | null> {
    const r = await this.db.selectFrom("price_alerts").selectAll().where("id", "=", id).executeTakeFirst();
    if (!r) return null;
    const reg = await this.db.selectFrom("registered_stocks").select("code").where("code", "=", r.code).executeTakeFirst();
    return toRule(r, !!reg);
  }

  /**
   * 검사 차례: 값 범위 → 등록 종목 → 같은 조건 → 한도(한 종목 5 → 거래량 10 → 모두 30).
   * 한도는 '세고 → 넣기'라 서로 다른 조건이 동시에 오면 둘 다 통과할 수 있으므로 만들기는 줄을 세워 하나씩 한다 (같은 조건은 유일 색인이 한 번 더 막음)
   */
  create(input: { code: string; kind: PriceAlertKind; value: number }): Promise<PriceAlertRule> {
    const run = this.createQueue.then(() => this.createNow(input));
    this.createQueue = run.catch(() => undefined);
    return run;
  }

  private async createNow(input: { code: string; kind: PriceAlertKind; value: number }): Promise<PriceAlertRule> {
    const code = normalizeCode(input.code);
    const { kind, value } = input;
    const currency = isPriceKind(kind) ? (isKrCode(code) ? "KRW" : "USD") : null;
    checkValue(kind, value, currency);
    const reg = await this.db.selectFrom("registered_stocks").select("code").where("code", "=", code).executeTakeFirst();
    if (!reg) throw new AppError(400, "NOT_REGISTERED", "보유·관심 종목에만 알림을 걸 수 있습니다");
    const duplicate = () => new AppError(409, "DUPLICATE", "같은 알림이 이미 있습니다");
    const same = await this.db.selectFrom("price_alerts").select("id").where("code", "=", code).where("kind", "=", kind).where("value", "=", value).executeTakeFirst();
    if (same) throw duplicate();
    // count(*) 는 Postgres 가 글자(bigint)로 준다
    const count = async (where: { code?: string; kind?: string }) => {
      let q = this.db.selectFrom("price_alerts").select((eb) => eb.fn.countAll<number>().as("n"));
      if (where.code) q = q.where("code", "=", where.code);
      if (where.kind) q = q.where("kind", "=", where.kind);
      return Number((await q.executeTakeFirst())?.n ?? 0);
    };
    if ((await count({ code })) >= PRICE_ALERT_LIMITS.perCode) throw new AppError(409, "LIMIT", "한 종목에 알림은 5개까지입니다");
    if (kind === "volume" && (await count({ kind: "volume" })) >= PRICE_ALERT_LIMITS.volume) throw new AppError(409, "LIMIT", "거래량 알림은 모두 10개까지입니다");
    if ((await count({})) >= PRICE_ALERT_LIMITS.all) throw new AppError(409, "LIMIT", "알림은 모두 30개까지입니다");
    // 같은 조건이 동시에 먼저 들어갔으면 유일 색인에 걸려 아무것도 넣지 않는다 (방언과 상관없이) → 409
    const inserted = await this.db
      .insertInto("price_alerts")
      .values({ code, kind, value, currency, created_at: seoulIso(this.now()), fired_on: null, fired_at: null, fired_value: null })
      .onConflict((oc) => oc.columns(["code", "kind", "value"]).doNothing())
      .returning("id")
      .executeTakeFirst();
    if (!inserted) throw duplicate();
    return (await this.get(Number(inserted.id)))!;
  }

  async remove(id: number): Promise<void> {
    const r = await this.db.deleteFrom("price_alerts").where("id", "=", id).executeTakeFirst();
    if (Number(r.numDeletedRows) === 0) throw new AppError(404, "NOT_FOUND", "알림을 찾을 수 없습니다");
  }

  /**
   * 앱이 울린 뒤 알려 준다. 한 문장으로 '그날 처음'만 적는다 (동시에 두 번 와도 한 번만 참).
   * 날짜는 YYYY-MM-DD 글자라 글자 순서 = 날짜 순서 → 더 옛 날짜(늦게 도착한 요청·기기 시계 차이)가 이미 적힌 새 날짜를 덮지 않는다.
   * 그래서 먼 앞날(기기 시계가 틀림)이 한 번 적히면 그날까지 기록이 굳는다 → 실제 날짜이고 서버 오늘(서울) 앞뒤 하루 안만 적는다
   * (미국 종목은 뉴욕 날짜라 서울보다 하루 늦을 수 있음. 3-30 이 fired_on 을 그대로 이어 쓴다)
   */
  async markFired(id: number, date: string, at: string, value: number): Promise<{ first: boolean; rule: PriceAlertRule }> {
    if (!isCalendarDate(date)) throw new AppError(400, "VALIDATION", "date: 날짜는 YYYY-MM-DD 로 넣어 주세요");
    if (Math.abs(daysBetween(seoulDate(this.now()), date)) > 1) throw new AppError(400, "VALIDATION", "date: 오늘 앞뒤 하루 안의 날짜만 적습니다");
    if (!(await this.get(id))) throw new AppError(404, "NOT_FOUND", "알림을 찾을 수 없습니다");
    const r = await this.db
      .updateTable("price_alerts")
      .set({ fired_on: date, fired_at: at, fired_value: value })
      .where("id", "=", id)
      .where((eb) => eb.or([eb("fired_on", "is", null), eb("fired_on", "<", date)]))
      .executeTakeFirst();
    const rule = await this.get(id);
    if (!rule) throw new AppError(404, "NOT_FOUND", "알림을 찾을 수 없습니다");
    return { first: Number(r.numUpdatedRows) === 1, rule };
  }

  /** 봉 받기를 남은 시간(ms)까지만 기다린다. 넘으면 "late" (받기는 뒤에서 끝나 캐시에 남고, 실패해도 조용히) */
  private async candlesWithin(code: string, ms: number): Promise<Candle[] | "late"> {
    const p = this.candles(code);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">((resolve) => {
      timer = setTimeout(() => resolve("late"), Math.max(0, ms));
    });
    try {
      return await Promise.race([p, late]);
    } finally {
      clearTimeout(timer);
      p.catch(() => undefined);
    }
  }

  /**
   * 거래량 급증 상태 (종목마다 순서대로 — 한 번에 몰아 보내지 않음): 정규장이고 개장 뒤 30분이 지났을 때만 30분봉을 받는다.
   * 시간 예산(volumeBudgetMs)이 지나면 남은 종목의 봉은 받지 않고 unavailable. 예산 안에 시작한 받기도 마감(volumeDeadlineMs)까지만 기다린다
   * (그 종목도 unavailable) → 응답이 앱 시간 제한 45초 안에 늘 온다. 시간은 실제 시계로 잰다 (주입된 now 는 테스트에서 고정)
   */
  async volume(codes: string[]): Promise<VolumeStatus[]> {
    const started = Date.now();
    const out: VolumeStatus[] = [];
    for (const raw of codes) {
      const code = normalizeCode(raw);
      const now = this.now();
      if (volumeWindow(code, now).state !== "open") {
        out.push(volumeStatus(code, [], now));
        continue;
      }
      if (Date.now() - started >= this.volumeBudgetMs) {
        out.push(volumeNotOk(code, now, "unavailable", VOLUME_REASON.budget));
        continue;
      }
      let candles: Candle[] | "late";
      try {
        candles = await this.candlesWithin(code, this.volumeDeadlineMs - (Date.now() - started));
      } catch {
        out.push(volumeNotOk(code, now, "unavailable", VOLUME_REASON.unavailable));
        continue;
      }
      if (candles === "late") {
        out.push(volumeNotOk(code, this.now(), "unavailable", VOLUME_REASON.budget));
        continue;
      }
      out.push(volumeStatus(code, candles, this.now()));
    }
    return out;
  }
}
