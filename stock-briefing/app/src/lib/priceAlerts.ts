import type { Currency, PriceAlertKind, PriceAlertRule, Quote, VolumeStatus } from "@/api/types";
import { sentence, speakAmount, speakRate } from "./a11y";
import { formatPct, formatPrice, formatVolume } from "./format";
import { inTradingHours, isKrCode, tradingDate } from "./marketTime";

/**
 * 가격·등락률·거래량 알림 (3-29, 기능 플래그 priceAlerts) — React Native 를 불러오지 않는 순수 모듈 (테스트에서 글자 그대로 확인).
 *  - 조건 글·미리 채우는 값·값 검사(서버 checkValue 와 같은 규칙)
 *  - 울려도 되는 시세인지(이번 거래일·연속 거래 중·세션 경계 전·지연 아님)와 울릴 조건 고르기 (앱이 켜져 있는 동안 체결·시세로)
 *  - 화면 위 알림 카드·알림 목록·화면 읽기 문장
 * 숫자는 모두 캐시의 시세·서버 응답 값을 모양만 바꿔 쓴다 (배율 표기만 내림 소수 한 자리). 이 파일의 글에는 투자 판단을 이끄는 말을 쓰지 않는다
 */

/** 조건 하나를 글·검사에 쓰는 최소 모양 (저장한 조건과 시트의 고른 줄이 같이 쓴다) */
export interface AlertDraft {
  kind: PriceAlertKind;
  value: number;
  /** 가격 조건의 종목 통화 (그 밖에는 null) */
  currency: Currency | null;
}

/** 가격 조건인지 */
export const isPriceKind = (kind: PriceAlertKind) => kind === "priceAbove" || kind === "priceBelow";

/** 종목 코드로 통화 (서버와 같이: 한국 코드면 원, 아니면 달러) */
export const currencyOfCode = (code: string): Currency => (isKrCode(code) ? "KRW" : "USD");

/** 한도 (서버 PRICE_ALERT_LIMITS 와 같음) */
export const ALERT_PER_CODE = 5;
/** 등락률 단계 (미리 채우는 값) */
export const RATE_STEPS = [5, 10, 15, 20, 30] as const;
/** 거래량 조건 배수 칩 */
export const VOLUME_TIMES = [2, 3, 5, 10] as const;

/** 화면에 그대로 보이는 고정 글 (4.2) */
export const ALERT_TEXT = {
  sheetFoot: "앱을 켜 둔 동안 조건에 닿으면 화면 위 알림과 진동으로 알립니다 · 조건마다 하루 한 번 · 매매 권유가 아닙니다",
  noQuote: "시세를 받지 못해 가격·등락률 조건은 고를 수 없습니다",
  newHead: "새 알림 — 하나 고르세요",
  perCodeFull: "한 종목에 알림은 5개까지입니다",
  alreadyMet: "지금 이미 이 조건에 맞아 저장하면 바로 한 번 알립니다",
  save: "알림 저장",
  saving: "저장 중",
  saved: "가격 알림을 저장했습니다",
  saveFailTitle: "알림을 저장하지 못했습니다",
  bannerHead: "가격 알림",
  settingsTitle: "가격 알림",
  settingsAbout: "앱을 켜 둔 동안만 확인합니다. 조건은 종목 화면의 '알림'(종 모양)에서 만듭니다",
  settingsEmpty: "아직 만든 알림이 없습니다",
  /** 조건 목록을 한 번도 받지 못함(404 아닌 오류) — 빈 상태로 보이지 않게 (1분마다 다시 묻는다) */
  loadFailed: "알림 목록을 불러오지 못했습니다 · 잠시 뒤 다시 불러옵니다",
  sheetLoadFailed: "켜진 알림을 불러오지 못했습니다",
  notRegistered: "등록 종목이 아니라 확인하지 않음",
  notYet: "오늘 아직 울리지 않음",
  duplicate: "같은 알림이 이미 있습니다",
  decimals: "소수 둘째 자리까지 넣어 주세요",
  krwRange: "1원 이상 1억 원 이하로 넣어 주세요",
  usdRange: "$0.01 이상 $1,000,000 이하로 넣어 주세요",
  rateRange: "1~30 사이로 넣어 주세요",
  volumeRange: "2·3·5·10배 중 하나로 골라 주세요",
} as const;

/** 소수 둘째 자리까지인 수인지 (센트·등락률). v*100 이 정수인지로 보면 0.29*100 = 28.999999999999996 처럼 부동소수 꼬리 때문에 정상 값을 거절한다 */
export function hasCents(v: number): boolean {
  return Number.isFinite(v) && Math.round(v * 100) / 100 === v;
}

// ── 조건 글 ──

/** 조건 글: 88,600원 이상 · $12.00 이상 · 전일 대비 +5.00% 이상 · 전일 대비 -5.00% 이하 · 거래량 같은 시각 평균 3배 이상 */
export function ruleLabel(r: AlertDraft): string {
  switch (r.kind) {
    case "priceAbove":
      return `${formatPrice(r.value, r.currency ?? "KRW")} 이상`;
    case "priceBelow":
      return `${formatPrice(r.value, r.currency ?? "KRW")} 이하`;
    case "rateUp":
      return `전일 대비 ${formatPct(r.value)} 이상`;
    case "rateDown":
      return `전일 대비 ${formatPct(-r.value)} 이하`;
    default:
      return `거래량 같은 시각 평균 ${r.value}배 이상`;
  }
}

/** 조건만 읽는 문장: 88,600원 이상 · 180.00달러 이하 · 전일 대비 5.00% 이상 상승 · 거래량 같은 시각 평균 3배 이상 */
export function ruleSpeech(r: AlertDraft): string {
  switch (r.kind) {
    case "priceAbove":
      return `${speakAmount(formatPrice(r.value, r.currency ?? "KRW"))} 이상`;
    case "priceBelow":
      return `${speakAmount(formatPrice(r.value, r.currency ?? "KRW"))} 이하`;
    case "rateUp":
      return `전일 대비 ${formatPct(r.value, { sign: false })} 이상 상승`;
    case "rateDown":
      return `전일 대비 ${formatPct(r.value, { sign: false })} 이상 하락`;
    default:
      return `거래량 같은 시각 평균 ${r.value}배 이상`;
  }
}

/** 가격 줄 둘째 글: 지금보다 +5.10% */
export function diffText(v: number, p: number): string {
  return `지금보다 ${formatPct((v / p - 1) * 100)}`;
}

/** 가격 줄 둘째 글을 읽는 말: 지금보다 5.10% 높음 · 낮음 · 지금과 같음 (보이는 글이 0.00% 일 때) */
export function diffSpeech(v: number, p: number): string {
  const pct = (v / p - 1) * 100;
  if (!/[1-9]/.test(formatPct(pct))) return "지금과 같음";
  return `지금보다 ${formatPct(Math.abs(pct), { sign: false })} ${pct > 0 ? "높음" : "낮음"}`;
}

/** 거래량 배율 표기: 내림 소수 한 자리 (3.29 → 3.2배, 3 → 3.0배) — 실제보다 크게 보이지 않게, 부동소수 꼬리 없이 */
export function ratioText(ratio: number): string {
  return `${(Math.floor(Math.round(ratio * 100) / 10) / 10).toFixed(1)}배`;
}

/** 시세 기준 표시 (서버가 준 priceBasis) → 글 끝에 붙이는 조각 */
export function basisSuffix(priceBasis: string | null | undefined): string {
  if (priceBasis === "KRX+NXT 통합") return " · NXT 포함";
  if (priceBasis === "주간거래") return " · 주간거래";
  if (priceBasis === "최근 체결(시간외 포함)") return " · 시간외 포함";
  return "";
}

/** ISO 시각 → 서울 "HH:MM" (못 읽으면 "-") */
export function seoulClock(iso: string | null | undefined): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "-";
  const d = new Date(t + 9 * 3_600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** "10:12" → "10시 12분", "09:00" → "9시" (화면 읽기) */
export function speakClock(hhmm: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return hhmm;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return min === 0 ? `${h}시` : `${h}시 ${min}분`;
}

// ── 시트에 미리 채우는 값 (터치 ② 의 줄들) ──

/** 보기 좋은 단위 (호가 단위를 흉내 내지 않음 — 알림 값일 뿐) */
export function niceStep(p: number, cur: Currency): number {
  if (cur === "USD") return p < 10 ? 0.01 : 0.1;
  if (p < 1_000) return 1;
  if (p < 10_000) return 10;
  if (p < 100_000) return 100;
  if (p < 1_000_000) return 1_000;
  return 10_000;
}

/** 정수 단위: 원은 원, 달러는 만분의 1 달러 (부동소수로 $3.00 × 1.05 를 올림하면 $3.16 이 된다) */
const unitOf = (cur: Currency) => (cur === "USD" ? 10_000 : 1);
const toUnits = (v: number, cur: Currency) => Math.round(v * unitOf(cur));
const fromUnits = (u: number, cur: Currency) => u / unitOf(cur);
/** 저장할 수 있는 가장 작은 값 (정수 단위): 1센트 = 만분의 1 달러 100개, 1원 */
const SAVE_UNITS: Record<Currency, number> = { USD: 100, KRW: 1 };

/** 가격 5% 위·아래를 보기 좋은 단위로 (위는 올림, 아래는 내림) */
export function pricePreset(p: number, cur: Currency): { above: number; below: number } {
  const u = toUnits(p, cur);
  const s = toUnits(niceStep(p, cur), cur);
  return { above: fromUnits(Math.ceil((u * 105) / (100 * s)) * s, cur), below: fromUnits(Math.floor((u * 95) / (100 * s)) * s, cur) };
}

export interface PresetRow {
  /** 줄 열쇠 (priceAbove · priceBelow · rateUp · rateDown · volume) */
  key: PriceAlertKind;
  draft: AlertDraft;
  /** 첫 글 = 조건 글 */
  title: string;
  /** 둘째 글 */
  note: string;
}

/** 거래량 줄 둘째 글 (시트를 열 때 한 번 받은 상태, 받는 중·실패면 undefined) */
export function volumeNote(volume: VolumeStatus | null | undefined): string {
  if (!volume) return "정규장 시간에 30분봉으로 확인합니다";
  if (volume.status === "ok" && volume.ratio !== null) return `지금 ${ratioText(volume.ratio)} · 최근 ${volume.days}거래일 같은 시각 평균과 견줌`;
  if (volume.status === "early") return "개장 뒤 30분이 지나면 확인합니다";
  if (volume.status === "closed") return "정규장 시간에만 확인합니다";
  return "거래량 기준을 만들 수 없어 지금은 확인하지 않습니다";
}

/** 새 알림 줄 (가격 위 · 가격 아래 · 등락률 위 · 등락률 아래 · 거래량). 시세가 없으면 거래량 줄만 */
export function presetDrafts(quote: Quote | null, cur: Currency, volume?: VolumeStatus | null): PresetRow[] {
  const rows: PresetRow[] = [];
  const row = (key: PriceAlertKind, value: number, note: string) => {
    const draft: AlertDraft = { kind: key, value, currency: isPriceKind(key) ? cur : null };
    rows.push({ key, draft, title: ruleLabel(draft), note });
  };
  if (quote && Number.isFinite(quote.price) && quote.price > 0) {
    const p = quote.price;
    const { above, below } = pricePreset(p, cur);
    row("priceAbove", above, diffText(above, p));
    if (below > 0) row("priceBelow", below, diffText(below, p));
    const rate = Number.isFinite(quote.changeRate) ? quote.changeRate : 0;
    const now = `지금 전일 대비 ${formatPct(rate)}`;
    const up = RATE_STEPS.find((s) => s > Math.max(rate, 0));
    const down = RATE_STEPS.find((s) => s > Math.max(-rate, 0));
    if (up !== undefined) row("rateUp", up, now);
    if (down !== undefined) row("rateDown", down, now);
  }
  row("volume", 3, volumeNote(volume));
  return rows;
}

/** 값 조절 한 번의 크기 (정수 단위): 가격은 max(보기 좋은 단위, 지금 가격 1% 를 그 단위로 반올림) — 84,300원 → 800원, $11.34 → $0.10 */
function priceStepUnits(p: number, cur: Currency): number {
  const s = toUnits(niceStep(p, cur), cur);
  return Math.max(s, Math.round(toUnits(p, cur) / (100 * s)) * s);
}

/**
 * [−]·[+] 한 번: 가격은 위 단위만큼(정수로 더하고 뺌), 등락률은 1%p (1~30). 거래량은 칩으로 고르므로 그대로.
 * 입력칸을 비웠거나 읽을 수 없는 글(값 NaN)이면 start(그 줄에 미리 채운 값)에서 시작한다 — 없으면 가격은 지금 시세, 등락률은 1.
 * 그래도 시작할 값이 없으면 그대로 돌려준다 (입력칸에 'NaN' 이 보이지 않게)
 */
export function stepDraft(draft: AlertDraft, dir: 1 | -1, quote: Quote | null, start?: number): AlertDraft {
  if (draft.kind === "volume") return draft;
  const live = quote && Number.isFinite(quote.price) && quote.price > 0 ? quote.price : null;
  const fallback = start !== undefined && Number.isFinite(start) ? start : isPriceKind(draft.kind) ? live : 1;
  const value = Number.isFinite(draft.value) ? draft.value : fallback;
  if (value === null || !Number.isFinite(value)) return draft;
  if (isPriceKind(draft.kind)) {
    const cur = draft.currency ?? "KRW";
    const base = live ?? value;
    const inc = priceStepUnits(base, cur);
    const min = toUnits(niceStep(base, cur), cur);
    // 입력칸에 저장 단위보다 잘게 넣은 값(12.345)에서 시작해도 결과는 저장할 수 있는 단위(1센트 · 1원)로 반올림한다 —
    // 입력칸(센트까지 보임)·줄 제목·값 검사가 같은 값을 보게 (전에는 12.445 가 되어 '12.45' 로 보이는데 소수 오류로 저장이 꺼졌다)
    const next = Math.round((toUnits(value, cur) + dir * inc) / SAVE_UNITS[cur]) * SAVE_UNITS[cur];
    return { ...draft, value: fromUnits(Math.max(min, next), cur) };
  }
  const next = Math.round((value + dir) * 100) / 100;
  return { ...draft, value: Math.min(30, Math.max(1, next)) };
}

/** 값 검사 (서버 checkValue 와 같은 규칙·같은 hasCents). 범위 → 자리 → 같은 조건 → 한 종목 5개. rules = 그 종목의 조건. 통과면 null */
export function validateDraft(draft: AlertDraft, rules: Pick<PriceAlertRule, "kind" | "value">[]): string | null {
  const v = draft.value;
  if (isPriceKind(draft.kind)) {
    if (draft.currency === "USD") {
      if (!(v >= 0.01 && v <= 1_000_000)) return ALERT_TEXT.usdRange;
      if (!hasCents(v)) return ALERT_TEXT.decimals;
    } else if (!(v >= 1 && v <= 100_000_000) || !Number.isInteger(v)) return ALERT_TEXT.krwRange;
  } else if (draft.kind === "volume") {
    if (!(VOLUME_TIMES as readonly number[]).includes(v)) return ALERT_TEXT.volumeRange;
  } else {
    if (!(v >= 1 && v <= 30)) return ALERT_TEXT.rateRange;
    if (!hasCents(v)) return ALERT_TEXT.decimals;
  }
  if (rules.some((r) => r.kind === draft.kind && r.value === v)) return ALERT_TEXT.duplicate;
  if (rules.length >= ALERT_PER_CODE) return ALERT_TEXT.perCodeFull;
  return null;
}

/** 지금 이미 이 조건에 맞는지 (시트의 '이미 맞음' 줄) */
export function metNow(draft: AlertDraft, quote: Quote | null, volume?: VolumeStatus | null): boolean {
  if (draft.kind === "volume") return volume?.status === "ok" && volume.ratio !== null && volume.ratio >= draft.value;
  if (!quote) return false;
  switch (draft.kind) {
    case "priceAbove":
      return quote.price >= draft.value;
    case "priceBelow":
      return quote.price <= draft.value;
    case "rateUp":
      return quote.changeRate >= draft.value;
    default:
      return quote.changeRate <= -draft.value;
  }
}

// ── 언제 울리나 ──

/**
 * 확인할 조건 (쉬는 중 규칙 하나 — 엔진·목록 받기·거래량 받기가 같이 쓴다): 서버가 등록 종목이라고 한 조건 중,
 * 이번 실행에서 받은 잔고 목록의 코드 모음(listCodes)이 있으면 그 안에 있는 종목만. 없으면(null) 서버 registered 만 본다
 */
export function activeRules(rules: PriceAlertRule[], listCodes: Set<string> | null): PriceAlertRule[] {
  return rules.filter((r) => r.registered === true && (listCodes === null || listCodes.has(r.code)));
}

/** 잔고 목록의 코드 모음 (정렬해 이은 글자) — 바뀌면 조건 목록을 다시 받는다 (등록·삭제로 registered 가 바뀜) */
export function codesKey(list: { code: string }[]): string {
  return list
    .map((s) => s.code)
    .sort()
    .join(",");
}

/**
 * 울려도 되는 시세면 그 거래일, 아니면 null: 시세가 있고 지연이 아님 · 지금과 같은 거래일 · 그 종목이 지금 연속 거래 중
 * (세션이 없는 예전 서버면 거래 시간인지) · 받은 세션의 경계(until)가 아직 지나지 않음
 */
export function quoteDate(quote: Quote | null | undefined, code: string, nowMs: number): string | null {
  if (!quote || quote.stale === true) return null;
  const date = tradingDate(quote.asOf, code);
  const nowIso = new Date(nowMs).toISOString();
  if (!date || date !== tradingDate(nowIso, code)) return null;
  const s = quote.session;
  if (s) {
    if (!(s.open === true && s.eligible !== false)) return null;
    if (s.until && Date.parse(s.until) <= nowMs) return null;
  } else if (!inTradingHours(nowIso, code)) return null;
  return date;
}

/**
 * 받은 시세들의 세션 경계(until): 이미 지난 것 중 가장 늦은 것(passed — 그 시세의 세션은 경계 전 값이라 quoteDate 가 null)과
 * 앞으로 올 것 중 가장 이른 것(next). 체결은 가격만 고치고 세션은 그대로 두므로, 경계를 넘으면 목록·상세를 서버에서 다시 받아야 새 세션이 온다.
 * 체결이 이 값을 바꾸지 않으므로 경계 타이머(PriceAlertProvider BoundaryWatch)는 체결 사건에 다시 걸리지 않는다
 */
export function sessionEdges(quotes: readonly (Quote | null | undefined)[], nowMs: number): { passed: number | null; next: number | null } {
  let passed: number | null = null;
  let next: number | null = null;
  for (const q of quotes) {
    const until = q?.session?.until ? Date.parse(q.session.until) : NaN;
    if (!Number.isFinite(until)) continue;
    if (until <= nowMs) passed = passed === null ? until : Math.max(passed, until);
    else next = next === null ? until : Math.min(next, until);
  }
  return { passed, next };
}

/** 서버 기록(firedOn) + 기기 기록 + 이번 실행 메모리를 합친 조회 */
export interface FiredBook {
  has(id: number, date: string): boolean;
}

export function firedBook(rules: Pick<PriceAlertRule, "id" | "firedOn">[], device: Record<string, string>, memory: Set<string>): FiredBook {
  const server = new Map(rules.map((r) => [r.id, r.firedOn]));
  return { has: (id, date) => server.get(id) === date || device[String(id)] === date || memory.has(`${id}|${date}`) };
}

/** 울린 조건 하나 */
export interface Hit {
  rule: PriceAlertRule;
  code: string;
  name: string;
  /** 날짜 열쇠 (가격·등락률 = 시세의 거래일, 거래량 = 서버가 준 날짜) */
  date: string;
  /** 울린 순간 조건을 판정한 값 (가격 · 등락률 · 거래량 배율) — 서버에 그대로 보낸다 */
  firedValue: number;
  quote?: { price: number; changeRate: number; asOf: string; priceBasis: string | null; currency: Currency };
  volume?: { volume: number; ratio: number; days: number; asOf: string };
}

/** 가격·등락률 조건 확인: 활성 조건만, 등록 종목이 아니라고 온 값(발견 탭에서 연 상세)은 건너뛴다 */
export function checkQuoteRules(
  rules: PriceAlertRule[],
  stocks: { code: string; name: string; quote: Quote | null; registered?: boolean }[],
  nowMs: number,
  fired: FiredBook,
  listCodes: Set<string> | null,
): Hit[] {
  const byCode = new Map<string, PriceAlertRule[]>();
  for (const r of activeRules(rules, listCodes)) if (r.kind !== "volume") byCode.set(r.code, [...(byCode.get(r.code) ?? []), r]);
  const hits: Hit[] = [];
  for (const s of stocks) {
    if (s.registered === false) continue;
    const rs = byCode.get(s.code);
    if (!rs) continue;
    const date = quoteDate(s.quote, s.code, nowMs);
    const q = s.quote;
    if (!date || !q) continue;
    for (const r of rs) {
      if (!metNow(r, q) || fired.has(r.id, date) || hits.some((h) => h.rule.id === r.id)) continue;
      hits.push({
        rule: r,
        code: s.code,
        name: s.name,
        date,
        firedValue: isPriceKind(r.kind) ? q.price : q.changeRate,
        quote: { price: q.price, changeRate: q.changeRate, asOf: q.asOf, priceBasis: q.priceBasis ?? null, currency: q.currency ?? r.currency ?? currencyOfCode(s.code) },
      });
    }
  }
  return hits;
}

/** 거래량 조건 확인: 서버가 ok 로 준 배율이 값 이상이고 그 날짜에 아직 안 울렸으면 */
export function checkVolumeRules(rules: PriceAlertRule[], items: VolumeStatus[], names: (code: string) => string, fired: FiredBook, listCodes: Set<string> | null): Hit[] {
  const hits: Hit[] = [];
  const active = activeRules(rules, listCodes).filter((r) => r.kind === "volume");
  for (const it of items) {
    if (it.status !== "ok" || it.ratio === null || it.volume === null || !it.date) continue;
    for (const r of active) {
      if (r.code !== it.code || it.ratio < r.value || fired.has(r.id, it.date) || hits.some((h) => h.rule.id === r.id)) continue;
      hits.push({ rule: r, code: it.code, name: names(it.code), date: it.date, firedValue: it.ratio, volume: { volume: it.volume, ratio: it.ratio, days: it.days, asOf: it.asOf } });
    }
  }
  return hits;
}

// ── 알림 글 ──

/** 카드 제목: 삼성전자 · 88,600원 이상 */
export function hitTitle(hit: Hit): string {
  return `${hit.name} · ${ruleLabel(hit.rule)}`;
}

/** 카드 본문: 지금 88,700원 · 전일 대비 +8.97% · 10:12 기준 (· NXT 포함) / 오늘 거래량 312만주 · 최근 18거래일 같은 시각 평균의 3.2배 · 10:45 기준 */
export function hitBody(hit: Hit): string {
  if (hit.volume) {
    const v = hit.volume;
    return `오늘 거래량 ${formatVolume(v.volume)}주 · 최근 ${v.days}거래일 같은 시각 평균의 ${ratioText(v.ratio)} · ${seoulClock(v.asOf)} 기준`;
  }
  const q = hit.quote!;
  return `지금 ${formatPrice(q.price, q.currency)} · 전일 대비 ${formatPct(q.changeRate)} · ${seoulClock(q.asOf)} 기준${basisSuffix(q.priceBasis)}`;
}

/** 휴대폰 알림 목록에 올리는 글 (누르면 그 종목 상세) */
export interface AlertNotification {
  title: string;
  body: string;
  data: { type: "priceAlert"; code: string; ruleId: number };
}

export function notificationContent(hit: Hit): AlertNotification {
  return { title: `가격 알림 · ${hit.name}`, body: `${ruleLabel(hit.rule)} · ${hitBody(hit)}`, data: { type: "priceAlert", code: hit.code, ruleId: hit.rule.id } };
}

/** 이 조건이 그 종목의 지금 거래일에 울렸는지 */
function firedToday(rule: Pick<PriceAlertRule, "code" | "firedOn">, nowMs: number): boolean {
  return !!rule.firedOn && rule.firedOn === tradingDate(new Date(nowMs).toISOString(), rule.code);
}

/** 켜진 알림 둘째 글: 오늘 09:41 울림 · 오늘 아직 울리지 않음 · 등록 종목이 아니라 확인하지 않음 */
export function firedLine(rule: PriceAlertRule, nowMs: number): string {
  if (!rule.registered) return ALERT_TEXT.notRegistered;
  if (firedToday(rule, nowMs)) return rule.firedAt ? `오늘 ${seoulClock(rule.firedAt)} 울림` : "오늘 울림";
  return ALERT_TEXT.notYet;
}

/** 켜진 알림 둘째 글을 읽는 말: 오늘 9시 41분 울림 */
export function firedSpeech(rule: PriceAlertRule, nowMs: number): string {
  if (!rule.registered) return ALERT_TEXT.notRegistered;
  if (firedToday(rule, nowMs)) return rule.firedAt ? `오늘 ${speakClock(seoulClock(rule.firedAt))} 울림` : "오늘 울림";
  return ALERT_TEXT.notYet;
}

/** 시세 기준 표시를 읽는 말 (" · NXT 포함" → "NXT 포함") */
const basisSpeech = (priceBasis: string | null | undefined) => basisSuffix(priceBasis).replace(/^ · /, "") || null;

/** 시트 '지금 줄'을 읽는 말: 지금 84,300원, 3.56% 상승, 10시 12분 기준(, NXT 포함) */
export function quoteSpeech(quote: Quote): string {
  const cur = quote.currency ?? currencyOfCode(quote.code);
  return sentence([`지금 ${speakAmount(formatPrice(quote.price, cur))}`, speakRate(quote.changeRate), `${speakClock(seoulClock(quote.asOf))} 기준`, basisSpeech(quote.priceBasis)]);
}

/** 시트 '지금 줄' 글: 지금 84,300원 · 전일 대비 +3.56% · 10:12 기준 (· NXT 포함) */
export function quoteLine(quote: Quote): string {
  const cur = quote.currency ?? currencyOfCode(quote.code);
  return `지금 ${formatPrice(quote.price, cur)} · 전일 대비 ${formatPct(quote.changeRate)} · ${seoulClock(quote.asOf)} 기준${basisSuffix(quote.priceBasis)}`;
}

/** 라디오 줄을 읽는 말 (보이는 글의 +·$ 를 그대로 읽지 않음) */
export function rowSpeech(draft: AlertDraft, quote: Quote | null, volume?: VolumeStatus | null): string {
  if (draft.kind === "volume") return `${ruleSpeech(draft)}, ${volumeNote(volume).replace(/ · /g, ", ")}`;
  if (isPriceKind(draft.kind)) return quote ? `${ruleSpeech(draft)}, ${diffSpeech(draft.value, quote.price)}` : ruleSpeech(draft);
  return quote ? `${ruleSpeech(draft)}, 지금 전일 대비 ${speakRate(quote.changeRate) ?? "보합"}` : ruleSpeech(draft);
}

/** 카드 줄을 읽는 말: 가격 알림, 삼성전자, 88,600원 이상에 닿음, 지금 88,700원, 8.97% 상승, 10시 12분 기준 */
export function hitSpeech(hit: Hit): string {
  const head = ["가격 알림", hit.name, `${ruleSpeech(hit.rule)}에 닿음`];
  if (hit.volume) {
    const v = hit.volume;
    return sentence([...head, `오늘 거래량 ${formatVolume(v.volume)}주`, `최근 ${v.days}거래일 같은 시각 평균의 ${ratioText(v.ratio)}`, `${speakClock(seoulClock(v.asOf))} 기준`]);
  }
  const q = hit.quote!;
  return sentence([...head, `지금 ${speakAmount(formatPrice(q.price, q.currency))}`, speakRate(q.changeRate), `${speakClock(seoulClock(q.asOf))} 기준`, basisSpeech(q.priceBasis)]);
}

/** 한 번의 확인에서 울린 것들을 한 번에 읽는 말: 앞 3건을 '. ' 로 잇고 넘치면 '. 외 N건' */
export function announceText(hits: Hit[]): string {
  const head = hits.slice(0, 3).map(hitSpeech).join(". ");
  return hits.length > 3 ? `${head}. 외 ${hits.length - 3}건` : head;
}

/** 지우기 확인 창 글. name 을 주면(여러 종목을 한 목록에 보이는 설정 칸) 조건 앞에 종목 이름: '삼성전자 · 88,600원 이상' 알림을 지울까요? */
export function removeConfirmText(rule: AlertDraft, name?: string): { title: string; message: string; cancel: string; ok: string } {
  const what = name ? `${name} · ${ruleLabel(rule)}` : ruleLabel(rule);
  return { title: "알림 지우기", message: `'${what}' 알림을 지울까요?`, cancel: "취소", ok: "지우기" };
}

/** 지우기 버튼 이름표: 알림 지우기, 88,600원 이상 · 설정 칸은 종목 이름까지 — 알림 지우기, 삼성전자, 88,600원 이상 */
export function removeLabel(rule: AlertDraft, name?: string): string {
  return name ? `알림 지우기, ${name}, ${ruleSpeech(rule)}` : `알림 지우기, ${ruleSpeech(rule)}`;
}

/** 지금 경로(expo-router usePathname)가 그 종목 상세인지 — 화면 위 카드 줄을 눌렀을 때 같은 상세를 스택에 하나 더 쌓지 않게 */
export function isDetailPath(path: string | null | undefined, code: string): boolean {
  if (!path) return false;
  let p = path;
  try {
    p = decodeURIComponent(path);
  } catch {
    /* 읽을 수 없는 경로는 그대로 견준다 */
  }
  return p.replace(/\/+$/, "") === `/stocks/${code}`;
}

/** 알림 버튼 글 · 이름표 (4.1) */
export const alertButtonText = (count: number) => (count ? `알림 ${count}` : "알림");
export const alertButtonA11y = (count: number) => (count ? `가격 알림 설정, 켜진 알림 ${count}개` : "가격 알림 설정");

// ── 휴대폰 알림 목록에 올리기 (주입 — 이 파일은 expo-notifications 를 불러오지 않는다) ──

type Notifier = (content: AlertNotification) => unknown;
let notifier: Notifier | null = null;

/** 앱 시작 때 한 번 (app/_layout): 알림 목록에 올리는 함수. 테스트는 가짜를 넣는다 */
export function installPriceAlertNotifier(fn: Notifier | null): void {
  notifier = fn;
}

/** 올린다 (넣은 함수가 없으면 아무것도 하지 않음, 실패는 조용히) */
export function notifyPriceAlert(content: AlertNotification): void {
  const fn = notifier;
  if (!fn) return;
  try {
    void Promise.resolve(fn(content)).catch(() => undefined);
  } catch {
    /* 알림 목록 줄은 없어도 되는 것 */
  }
}
