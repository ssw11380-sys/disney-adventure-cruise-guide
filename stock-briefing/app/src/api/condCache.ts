import { applyJson, jsonHash, type Json } from "../lib/jsonDelta";

/**
 * 끊겼을 때 데이터 절약 (플래그 pollSaver, 3-25 성능-16) — 자주 묻는 GET 의 마지막 응답을 주소별로 기억한다 (메모리만, 앱을 다시 켜면 비어 있음).
 *  - 보낼 때: 기억한 ETag 를 If-None-Match 로, "바뀐 부분만 받을 수 있음"(A-IM: json-delta)을 함께
 *  - 304(변화 없음): 기억한 본문을 새로 풀어 준다 → 화면 값은 그대로, react-query 는 "방금 받음"(dataUpdatedAt)으로 적는다
 *  - 226(바뀐 부분만): 기억한 본문에 적용하고, 서버가 준 해시와 같을 때만 쓴다. 다르거나 적용할 수 없으면 버리고 전체를 다시 받는다
 *  - 200: 전체 본문과 ETag 를 기억한다 (ETag 가 없으면 — 예전 서버·플래그 꺼짐 — 기억하지 않아 다음에도 예전처럼 묻는다)
 * 기억한 본문은 글자(JSON)로 두고 쓸 때마다 새로 푼다 — 화면·캐시가 받은 객체를 고쳐도 기억한 본문이 바뀌지 않게.
 */

export const DELTA_IM = "json-delta";
/** 기억해 둘 주소 수 (잔고 1 + 종목 상세 여러 개 + 지수·플래그·상태) */
const MAX_ENTRIES = 40;
/** 설정 화면 비율에 쓰는 최근 응답 수 */
const RECENT = 200;

export type CondOutcome = "full" | "same" | "delta" | "resync";

interface Entry {
  etag: string;
  text: string;
}

const store = new Map<string, Entry>();
const recent: CondOutcome[] = [];
const totals: Record<CondOutcome, number> = { full: 0, same: 0, delta: 0, resync: 0 };

export function condKey(baseUrl: string, path: string): string {
  return `${baseUrl}\n${path}`;
}

/** 지금 기억한 것 (보낼 때 한 번 집어 두고, 응답은 그것과 맞춘다 — 그사이 다른 응답이 바꿔 적어도 섞이지 않게) */
export function condGet(key: string): Entry | null {
  const e = store.get(key);
  if (!e) return null;
  store.delete(key);
  store.set(key, e); // 최근에 쓴 것을 뒤로 (오래 안 쓴 것부터 버림)
  return e;
}

export function condPut(key: string, etag: string, text: string): void {
  store.delete(key);
  store.set(key, { etag, text });
  while (store.size > MAX_ENTRIES) store.delete(store.keys().next().value!);
}

export function condDrop(key: string): void {
  store.delete(key);
}

export function condNote(o: CondOutcome): void {
  totals[o]++;
  recent.push(o);
  if (recent.length > RECENT) recent.shift();
}

/** 보낼 조건 헤더 (기억한 것이 없으면 없음) */
export function condHeaders(held: Entry | null): Record<string, string> {
  return held ? { "if-none-match": held.etag, "a-im": DELTA_IM } : {};
}

/** 226 본문 모양 */
interface DeltaEnvelope {
  $im: string;
  base: string;
  etag: string;
  h: string;
  p: Json;
}

export function isDelta(v: unknown): v is DeltaEnvelope {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const d = v as Partial<DeltaEnvelope>;
  return d.$im === DELTA_IM && typeof d.base === "string" && typeof d.etag === "string" && typeof d.h === "string" && "p" in d;
}

/** 기억한 본문에 차이를 적용해 다시 만든 값. 기준이 다르거나·적용할 수 없거나·해시가 다르면 null (전체를 다시 받는다) */
export function rebuild(held: Entry | null, d: DeltaEnvelope): Json | null {
  if (!held || held.etag !== d.base) return null;
  try {
    const out = applyJson(JSON.parse(held.text) as Json, d.p);
    return jsonHash(out) === d.h ? out : null;
  } catch {
    return null;
  }
}

/** 설정 화면용: 최근 응답 중 변화 없음·바뀐 부분만·전체 (다시 받기는 전체에 넣는다) */
export function condStats(): { recent: number; same: number; delta: number; full: number; totals: Record<CondOutcome, number> } {
  let same = 0;
  let delta = 0;
  let full = 0;
  for (const o of recent) {
    if (o === "same") same++;
    else if (o === "delta") delta++;
    else full++;
  }
  return { recent: recent.length, same, delta, full, totals: { ...totals } };
}

/** 테스트용: 모두 비운다 */
export function condReset(): void {
  store.clear();
  recent.length = 0;
  for (const k of Object.keys(totals) as CondOutcome[]) totals[k] = 0;
}
