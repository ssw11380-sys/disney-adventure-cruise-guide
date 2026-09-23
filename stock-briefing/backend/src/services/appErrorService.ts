import { createHash } from "node:crypto";
import { z } from "zod";
import type { Db } from "../db/index.js";
import { seoulDate, seoulIso } from "../lib/time.js";

/**
 * 앱 JS 오류 수집 (자체 수집, 외부 서비스 없음).
 *  - 앱이 전역 오류 핸들러·화면 오류 경계에서 잡은 오류를 보낸다
 *  - 저장 전에 토큰·긴 16진 문자열·금액으로 보이는 숫자를 지운다 (계좌 금액이 서버 로그에 남지 않게)
 *  - 분당 보고 수를 제한하고, 오래된 행은 지운다
 */

export const appErrorInput = z.object({
  kind: z.enum(["fatal", "js", "render", "promise", "test"]),
  message: z.string().max(2000),
  stack: z.string().max(20_000).nullable().optional(),
  screen: z.string().max(300).nullable().optional(),
  occurredAt: z.string().max(40).nullable().optional(),
  appVersion: z.string().max(40).nullable().optional(),
  updateId: z.string().max(80).nullable().optional(),
  platform: z.string().max(20).nullable().optional(),
});
export type AppErrorInput = z.infer<typeof appErrorInput>;

/** 한 번에 여러 건 (앱이 켜질 때 못 보낸 것을 모아 보낸다) */
export const appErrorBatch = z.object({ errors: z.array(appErrorInput).min(1).max(20) });

const MAX_PER_MINUTE = 30;
const MAX_ROWS = 5000;
const MESSAGE_MAX = 500;
const STACK_MAX = 4000;

/** 토큰·키·계좌 금액을 지운다. 메시지는 숫자까지, 스택은 토큰·16진만 */
export function scrub(text: string, opts: { numbers: boolean }): string {
  let s = text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [지움]")
    .replace(/([?&;#]|%3F|%26)(token|access_token|api_token|key)(=|%3D)[^&\s#;"']*/gi, "$1$2=[지움]")
    .replace(/\b(sk-ant-[A-Za-z0-9_-]+|ExponentPushToken\[[^\]]*\])/g, "[지움]")
    .replace(/\b[0-9a-f]{24,}\b/gi, "[지움]");
  // 금액·수량으로 보이는 숫자(4자리 이상, 콤마·소수 포함)와 통화 표기
  if (opts.numbers) s = s.replace(/(?:[$₩]\s?)?\d[\d,]{3,}(\.\d+)?(?:\s?(원|달러|USD|KRW))?/g, "#").replace(/[$₩]\s?\d+(\.\d+)?/g, "#");
  return s;
}

/** 같은 오류를 묶는 키: 종류 + 숫자를 지운 메시지 + 첫 스택 줄 */
export function fingerprint(kind: string, message: string, stack: string | null | undefined): string {
  const firstFrame = (stack ?? "").split("\n").find((l) => /\bat\b|@/.test(l)) ?? "";
  const norm = (x: string) => x.replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
  return createHash("sha1").update(`${kind}|${norm(message)}|${norm(firstFrame)}`).digest("hex").slice(0, 12);
}

export interface AppErrorSummary {
  days: number;
  since: string;
  total: number;
  fatal: number;
  byDay: { date: string; count: number }[];
  byKind: Record<string, number>;
  top: { fingerprint: string; kind: string; message: string; screen: string | null; count: number; lastAt: string; updateId: string | null }[];
  recent: { at: string; kind: string; message: string; screen: string | null; appVersion: string | null; updateId: string | null }[];
}

export class AppErrorService {
  private window: { start: number; count: number } = { start: 0, count: 0 };
  private readonly now: () => Date;

  constructor(
    private readonly db: Db,
    now?: () => Date,
  ) {
    this.now = now ?? (() => new Date());
  }

  /** 저장한 건수를 돌려준다 (분당 한도를 넘은 건은 버림) */
  async record(list: AppErrorInput[]): Promise<{ saved: number; dropped: number }> {
    const t = this.now().getTime();
    if (t - this.window.start >= 60_000) this.window = { start: t, count: 0 };
    const room = Math.max(0, MAX_PER_MINUTE - this.window.count);
    const take = list.slice(0, room);
    this.window.count += take.length;
    if (take.length === 0) return { saved: 0, dropped: list.length };
    const at = seoulIso(this.now());
    await this.db
      .insertInto("app_errors")
      .values(
        take.map((e) => {
          const message = scrub(e.message, { numbers: true }).slice(0, MESSAGE_MAX) || "(메시지 없음)";
          const stack = e.stack ? scrub(e.stack, { numbers: false }).slice(0, STACK_MAX) : null;
          return {
            at,
            occurred_at: e.occurredAt ?? null,
            kind: e.kind,
            message,
            stack,
            screen: e.screen ? scrub(e.screen, { numbers: false }).slice(0, 200) : null,
            fingerprint: fingerprint(e.kind, message, stack),
            app_version: e.appVersion ?? null,
            update_id: e.updateId ?? null,
            platform: e.platform ?? null,
          };
        }),
      )
      .execute();
    await this.prune();
    return { saved: take.length, dropped: list.length - take.length };
  }

  private async prune(): Promise<void> {
    const cut = await this.db.selectFrom("app_errors").select("id").orderBy("id", "desc").offset(MAX_ROWS).limit(1).executeTakeFirst();
    if (cut) await this.db.deleteFrom("app_errors").where("id", "<=", cut.id).execute();
  }

  /** 최근 N일 오류 수 (관리 API·설정 화면용) */
  async summary(days = 7): Promise<AppErrorSummary> {
    const sinceDate = new Date(this.now().getTime() - days * 86_400_000);
    const since = seoulIso(sinceDate);
    const rows = await this.db
      .selectFrom("app_errors")
      .select(["at", "kind", "message", "screen", "fingerprint", "app_version", "update_id"])
      .where("at", ">=", since)
      .orderBy("id", "desc")
      .execute();
    const byDay = new Map<string, number>();
    const byKind: Record<string, number> = {};
    const groups = new Map<string, AppErrorSummary["top"][number]>();
    for (const r of rows) {
      const d = r.at.slice(0, 10);
      byDay.set(d, (byDay.get(d) ?? 0) + 1);
      byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
      const g = groups.get(r.fingerprint);
      if (g) g.count += 1;
      else groups.set(r.fingerprint, { fingerprint: r.fingerprint, kind: r.kind, message: r.message, screen: r.screen, count: 1, lastAt: r.at, updateId: r.update_id });
    }
    const dates: { date: string; count: number }[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const date = seoulDate(new Date(this.now().getTime() - i * 86_400_000));
      dates.push({ date, count: byDay.get(date) ?? 0 });
    }
    // 설정 화면의 "오류 수집 시험"으로 만든 건은 합계에서 뺀다 (byKind.test 로만 보인다)
    return {
      days,
      since,
      total: rows.length - (byKind["test"] ?? 0),
      fatal: byKind["fatal"] ?? 0,
      byDay: dates,
      byKind,
      top: [...groups.values()].sort((a, b) => b.count - a.count).slice(0, 10),
      recent: rows.slice(0, 20).map((r) => ({ at: r.at, kind: r.kind, message: r.message, screen: r.screen, appVersion: r.app_version, updateId: r.update_id })),
    };
  }
}
