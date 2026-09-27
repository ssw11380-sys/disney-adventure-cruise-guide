/**
 * 서버가 보낸 "바뀐 부분만"(226, 플래그 pollSaver — 3-25 성능-16)을 받아 둔 옛 응답에 적용한다. 순수 함수 (RN 의존 없음 → 단위 테스트).
 * 서버 backend/src/lib/jsonDelta.ts 와 같은 규칙 (공용 픽스처 stock-briefing/shared/fixtures/jsonDelta.json — 한쪽을 고치면 다른 쪽도 같이).
 *  - 숫자·문자·참거짓·null·배열: 그 값으로 바꾼다
 *  - { "$": 값 }: 통째로 바꾼다 · { "#": { "칸 번호": 패치 } }: 같은 길이 배열의 칸마다 · { "-": 1 }: 객체 안에서 그 키를 지운다
 *  - 그 밖의 객체 { 키: 패치 }: 객체의 키마다
 * 다시 만든 값은 서버가 함께 준 해시(jsonHash)와 비교한다 — 다르면 그 값을 버리고 전체를 다시 받는다 (옛 값이 남지 않게).
 */

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function isObj(v: unknown): v is { [k: string]: Json } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** base 에 patch 를 적용한 새 값 (base 는 건드리지 않는다). 모양이 맞지 않으면 던진다 */
export function applyJson(base: Json, patch: Json): Json {
  if (!isObj(patch)) return patch;
  if ("$" in patch) return patch["$"]!;
  if ("#" in patch) {
    if (!Array.isArray(base)) throw new Error("배열 패치인데 배열이 아님");
    const items = patch["#"];
    if (!isObj(items)) throw new Error("배열 패치 모양이 틀림");
    const out = base.slice();
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

/** 키를 정렬한 JSON 문자열 (서버와 같은 글자 — 해시 비교용) */
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

/** FNV-1a 32비트 (UTF-16 글자 단위) → 16진수 8자리 (서버와 같은 값, 확인용) */
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
