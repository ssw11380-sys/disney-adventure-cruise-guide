import { PostgresAdapter, sql, type Kysely, type RawBuilder } from "kysely";
import type { Database } from "./schema.js";

/**
 * 등록순(registered_stocks 를 created_at 으로 늘어놓을 때)에서 등록 시각이 같은 행끼리의 차례 — orderBy("created_at") 뒤에 붙인다.
 * 토스 동기화는 한 번에 들어온 종목에 같은 시각을 넣어, 이 차례를 정하지 않으면 DB 가 정한다.
 *  - SQLite(운영): 넣은 차례 = 행 번호 rowid (표에 이름 없이 있는 칸, 행을 고쳐도 바뀌지 않음). 이 줄을 붙이기 전에도 SQLite 는 이 차례로 돌려주었다 → 잔고 순서 그대로
 *  - Postgres: 행 번호가 없어(ctid 는 행을 고칠 때마다 바뀐다) 코드 순
 * 잔고 목록(stockService.list — 플래그를 끈 잔고 순서)과 관심 그룹 순서(watchGroupService — 자리가 같으면 등록 시각, 그다음 이 차례)가 같은 차례를 쓴다 (3-34)
 */
export function sameTimeOrder(db: Kysely<Database>): RawBuilder<unknown> {
  return db.getExecutor().adapter instanceof PostgresAdapter ? sql`code` : sql`rowid`;
}
