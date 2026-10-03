import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDb } from "../src/db/index.js";

const OriginalPool = pg.Pool;
/** 통신만 생략한다. 풀의 acquire/release 및 Client의 query 오류 처리는 설치된 pg 실제 구현이다. */
class NoNetworkClient extends pg.Client {
  override connect(callback?: (err: Error | undefined) => void): any { callback?.(undefined); }
  override end(callback?: () => void): any { this.emit("end"); callback?.(); }
  disconnect(error: Error) {
    (this as unknown as { _handleErrorEvent(error: Error): void })._handleErrorEvent(error);
  }
}
const pools: pg.Pool[] = [];
afterEach(async () => { await Promise.all(pools.splice(0).map((pool) => pool.end())); vi.restoreAllMocks(); });
function setup() {
  vi.spyOn(pg, "Pool").mockImplementation(function (config) {
    const pool = new OriginalPool({ ...config, Client: NoNetworkClient }); pools.push(pool); return pool;
  });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  createDb("postgresql://test:fake@localhost/connection_error_test");
  return { pool: pools.at(-1)!, warn };
}

describe("실제 pg Pool/Client의 오류 경계, 연결 통신은 모의", () => {
  it("빌린 연결의 연속 오류는 프로세스 예외 대신 원래 쿼리 거절을 유지한다", async () => {
    const { pool, warn } = setup();
    const client = await pool.connect() as pg.PoolClient & NoNetworkClient;
    const error = new Error("연결 종료: 출력하면 안 되는 모의 접속 정보");
    const pending = client.query("select 1");
    const rejected = expect(pending).rejects.toBe(error);
    try {
      expect(() => client.disconnect(error)).not.toThrow();
      await rejected;
      expect(() => client.disconnect(new Error("두 번째 소켓 종료 오류"))).not.toThrow();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls.flat().join(" ")).not.toContain(error.message);
      await expect(client.query("rollback")).rejects.toThrow("not queryable");
    } finally { await rejected; client.release(); }
    expect(pool.totalCount).toBe(0);
    const next = await pool.connect();
    expect(next).not.toBe(client); next.release();
  });

  it("같은 연결의 반복 대여는 리스너를 늘리지 않고 유휴 오류와 후속 오류도 한 번만 기록한다", async () => {
    const { pool, warn } = setup();
    let last: pg.PoolClient | undefined;
    for (let i = 0; i < 5; i++) {
      const client = await pool.connect();
      try {
        expect(client.listenerCount("error")).toBe(1);
        if (last) expect(client).toBe(last);
        last = client;
      } finally { client.release(); }
    }
    const client = last! as pg.PoolClient & NoNetworkClient;
    expect(() => client.disconnect(new Error("유휴 연결 종료"))).not.toThrow();
    expect(() => client.disconnect(new Error("후속 연결 종료"))).not.toThrow();
    expect(pool.totalCount).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
