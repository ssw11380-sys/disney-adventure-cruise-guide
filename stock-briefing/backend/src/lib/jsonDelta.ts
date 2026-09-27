/**
 * JSON 바뀐 부분만 (플래그 pollSaver, 3-25 성능-16). 앱이 가진 옛 응답(base)과 지금 응답의 차이를 작게 적어 보낸다.
 * 앱 lib/jsonDelta.ts 에 같은 적용 함수가 있다 (공용 픽스처 stock-briefing/shared/fixtures/jsonDelta.json — 한쪽을 고치면 다른 쪽도 같이).
 *
 * 차이(패치) 모양 — 값은 모두 JSON 이라 그대로 주고받는다:
 *  - 숫자·문자·참거짓·null·배열: 그 값으로 바꾼다 (배열은 길이가 같을 때만 칸마다 따지고, 아니면 통째로)
 *  - { "$": 값 }: 그 값으로 통째로 바꾼다 (새 값이 객체인데 옛 값이 객체가 아닐 때 등)
 *  - { "#": { "칸 번호": 패치 } }: 길이가 같은 배열의 칸마다
 *  - { "-": 1 }: 그 키를 지운다 (객체 패치 안에서만)
 *  - 그 밖의 객체 { 키: 패치 }: 객체의 키마다
 * 데이터 객체에 "$"·"#"·"-" 키가 있으면 헷갈리지 않게 그 객체는 통째로 바꾼다.
 */

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type Patch = Json;

const SPECIAL = new Set(["$", "#", "-"]);

function isObj(v: unknown): v is { [k: string]: Json } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 두 JSON 값이 같은지 (키 순서는 보지 않는다) */
export function sameJson(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameJson(a[i]!, b[i]!)) return false;
    return true;
  }
  if (isObj(a)) {
    if (!isObj(b)) return false;
    const ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length) return false;
    for (const k of ka) if (!(k in b) || !sameJson(a[k]!, b[k]!)) return false;
    return true;
  }
  return false;
}

/** 특수 키가 있는 객체는 칸마다 따지지 않는다 */
const plainKeys = (o: { [k: string]: Json }) => Object.keys(o).every((k) => !SPECIAL.has(k));

/** a → b 패치. 같으면 undefined */
export function diffJson(a: Json, b: Json): Patch | undefined {
  if (sameJson(a, b)) return undefined;
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    const out: { [k: string]: Json } = {};
    for (let i = 0; i < b.length; i++) {
      const d = diffJson(a[i]!, b[i]!);
      if (d !== undefined) out[String(i)] = d;
    }
    return { "#": out };
  }
  if (isObj(a) && isObj(b) && plainKeys(a) && plainKeys(b)) {
    const out: { [k: string]: Json } = {};
    for (const k of Object.keys(b)) {
      if (!(k in a)) out[k] = wrap(b[k]!);
      else {
        const d = diffJson(a[k]!, b[k]!);
        if (d !== undefined) out[k] = d;
      }
    }
    for (const k of Object.keys(a)) if (!(k in b)) out[k] = { "-": 1 };
    return out;
  }
  return wrap(b);
}

/** 통째로 바꿀 값: 객체는 { "$": 값 } 으로 싸서 패치(객체)와 헷갈리지 않게 */
function wrap(v: Json): Patch {
  return isObj(v) ? { $: v } : v;
}

/** base 에 patch 를 적용한 새 값 (base 는 건드리지 않는다). 모양이 맞지 않으면 던진다 — 앱은 이때 전체를 다시 받는다 */
export function applyJson(base: Json, patch: Patch): Json {
  if (!isObj(patch)) return patch;
  if ("$" in patch) return patch["$"]!;
  if ("#" in patch) {
    if (!Array.isArray(base)) throw new Error("배열 패치인데 배열이 아님");
    const out = base.slice();
    const items = patch["#"];
    if (!isObj(items)) throw new Error("배열 패치 모양이 틀림");
    for (const [k, p] of Object.entries(items)) {
      const i = Number(k);
      if (!Number.isInteger(i) || i < 0 || i >= out.length) throw new Error("배열 칸 번호가 틀림");
      out[i] = applyJson(out[i]!, p);
    }
    return out;
  }
  if ("-" in patch) throw new Error("지우기 패치는 객체 안에서만");
  if (!isObj(base)) throw new Error("객체 패치인데 객체가 아님");
  const out: { [k: string]: Json } = { ...base };
  for (const [k, p] of Object.entries(patch)) {
    if (isObj(p) && "-" in p) delete out[k];
    else out[k] = k in base ? applyJson(base[k]!, p) : applyJson(null, p);
  }
  return out;
}

/** 키를 정렬한 JSON 문자열 (앱과 서버가 같은 값에 같은 글자를 내게 — 해시 비교용) */
export function canonicalJson(v: Json): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (isObj(v)) {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k]!)}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/** FNV-1a 32비트 (UTF-16 글자 단위) → 16진수 8자리. 앱에서 다시 만든 값이 서버 값과 같은지 확인용 (보안용 아님) */
export function fnv1a32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** 값의 확인용 해시 (키 순서와 무관) */
export function jsonHash(v: Json): string {
  return fnv1a32(canonicalJson(v));
}
