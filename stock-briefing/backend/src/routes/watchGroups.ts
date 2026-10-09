import type { FastifyPluginAsync } from "fastify";
import { AppError } from "../lib/errors.js";
import { WATCH_OFF, type WatchGroupService } from "../services/watchGroupService.js";

const disabled = () => new AppError(409, "DISABLED", "관심 그룹 기능이 꺼져 있습니다");
const GROUP_MSG = "그룹 번호가 올바르지 않습니다";
const INDEX_MSG = "자리 번호가 올바르지 않습니다";
const bad = (msg: string) => new AppError(400, "VALIDATION", msg);

/** 양의 정수 그룹 번호 (주소 칸은 글자로 온다) */
function groupIdOf(v: unknown): number {
  const n = typeof v === "string" && /^\d{1,15}$/.test(v) ? Number(v) : v;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n <= 0) throw bad(GROUP_MSG);
  return n;
}

const bodyOf = (b: unknown): Record<string, unknown> => (b !== null && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {});

/** 이름은 글자여야 한다 (빈 글자·빈칸만은 서비스가 '이름을 넣어 주세요'). 아주 긴 글자는 정리 전에 거른다 */
function nameOf(b: unknown): string {
  const name = bodyOf(b).name;
  if (typeof name !== "string") throw bad("이름을 넣어 주세요");
  if (name.length > 200) throw bad("이름은 10자까지입니다");
  return name;
}

/**
 * 관심 종목 그룹·순서 (3-34, 플래그 watchGroups). 새 경로라 예전 앱은 부르지 않고, 새 앱은 예전 서버의 404 를 '꺼짐'으로 본다.
 * 모든 응답은 배치 전체(WatchLayout — 그룹 순서대로 + 그룹·자리가 정해진 종목) → 앱은 받은 값으로 캐시를 통째로 바꾼다.
 * 플래그를 끄면 GET 은 DB 를 읽지 않고 { on: false, groups: [], items: [] }, 쓰기는 모두 409 DISABLED (모양 검사보다 먼저). 저장된 그룹·순서는 지우지 않는다.
 *  - GET    /api/watch-groups               배치
 *  - POST   /api/watch-groups               { name } → 201 배치 + created { id, name } (새 그룹을 맨 끝에)
 *  - PATCH  /api/watch-groups/:id           { name } → 이름 바꾸기
 *  - DELETE /api/watch-groups/:id           그룹 지우기 (종목은 관심으로 남고 그룹 없음 맨 끝으로)
 *  - PUT    /api/watch-groups/order         { ids } 그룹 순서 (지금 그룹과 정확히 같은 번호들 — 아니면 409 STALE)
 *  - POST   /api/watch-groups/move          { code, groupId: 번호 | null, index } 종목 하나를 그 그룹의 index 자리로 (범위 밖은 맨 앞/맨 끝으로)
 */
export const watchGroupRoutes: FastifyPluginAsync<{ service: WatchGroupService }> = async (app, { service }) => {
  const guard = async () => {
    if (!(await service.enabled())) throw disabled();
  };

  app.get("/", async () => {
    if (!(await service.enabled())) return WATCH_OFF;
    return service.layout();
  });

  app.post("/", async (req, reply) => {
    await guard();
    return reply.code(201).send(await service.create(nameOf(req.body)));
  });

  app.put("/order", async (req) => {
    await guard();
    const ids = bodyOf(req.body).ids;
    if (!Array.isArray(ids) || ids.length > 100) throw bad(GROUP_MSG);
    return service.order(ids.map(groupIdOf));
  });

  app.post("/move", async (req) => {
    await guard();
    const b = bodyOf(req.body);
    if (typeof b.code !== "string" || !b.code.trim()) throw bad("종목 코드를 넣어 주세요");
    const groupId = b.groupId === null ? null : groupIdOf(b.groupId);
    if (typeof b.index !== "number" || !Number.isSafeInteger(b.index) || b.index < 0) throw bad(INDEX_MSG);
    return service.move(b.code, groupId, b.index);
  });

  app.patch("/:id", async (req) => {
    await guard();
    const id = groupIdOf((req.params as { id?: unknown }).id);
    return service.rename(id, nameOf(req.body));
  });

  app.delete("/:id", async (req) => {
    await guard();
    return service.remove(groupIdOf((req.params as { id?: unknown }).id));
  });
};
