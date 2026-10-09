import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { normalizePassword } from "./rules.js";

/**
 * 비밀번호 해시·세션 토큰 (계정 A단계). node:crypto 만 쓴다 (새 패키지 없음).
 *  - 해시: scrypt(N=16384, r=8, p=1), 키 64바이트, 소금 16바이트 → "scrypt$N$r$p$<소금 b64>$<키 b64>" (매개변수를 함께 적어 나중에 바꿔도 옛 해시를 읽는다)
 *  - 비교는 timingSafeEqual. 비밀번호는 NFC 로만 맞추고 다듬지 않는다
 *  - 세션 토큰: "gzs1_" + 32바이트 난수(base64url). DB 에는 sha256 hex 만 적는다 — 토큰은 로그인·가입 응답에 한 번만 나간다
 */
export const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;
const SALT_LEN = 16;
/** N=16384·r=8 은 약 16MB 를 쓴다. 기본 한도(32MB)보다 여유 있게 */
const MAX_MEM = 64 * 1024 * 1024;

function derive(password: string, salt: Buffer, n: number, r: number, p: number, len: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(normalizePassword(password), salt, len, { N: n, r, p, maxmem: MAX_MEM }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** 비밀번호 → 저장할 해시 글. n 은 테스트에서만 낮춘다 (빠르게) */
export async function hashPassword(password: string, n: number = SCRYPT_N): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const key = await derive(password, salt, n, SCRYPT_R, SCRYPT_P, KEY_LEN);
  return `scrypt$${n}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

/** 저장된 해시와 맞는지. 모양이 틀린 해시는 false (오류를 던지지 않는다) */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [n, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (![n, r, p].every((v) => Number.isInteger(v) && v > 0)) return false;
  const salt = Buffer.from(parts[4]!, "base64");
  const expected = Buffer.from(parts[5]!, "base64");
  if (!salt.length || !expected.length) return false;
  const key = await derive(password, salt, n, r, p, expected.length);
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** 해시의 N (다시 저장할지 판단) */
export function hashCost(stored: string): number | null {
  const n = Number(stored.split("$")[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export const SESSION_TOKEN_PREFIX = "gzs1_";

export function newSessionToken(): string {
  return SESSION_TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

/** 세션 토큰 → DB 에 적는 값 */
export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** 토큰 모양이 맞는지 (DB 를 보기 전에 거른다 — 긴 헤더로 해시·조회를 시키지 않게) */
export function looksLikeToken(token: string): boolean {
  return token.length > SESSION_TOKEN_PREFIX.length && token.length <= 128 && token.startsWith(SESSION_TOKEN_PREFIX) && /^[A-Za-z0-9_-]+$/.test(token.slice(SESSION_TOKEN_PREFIX.length));
}
