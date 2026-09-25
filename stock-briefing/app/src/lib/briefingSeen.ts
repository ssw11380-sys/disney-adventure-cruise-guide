import AsyncStorage from "@react-native-async-storage/async-storage";
import type { RunResult } from "@/api/types";

/**
 * 백그라운드 확인(로컬 알림)이 이미 알린 — 또는 알리지 않기로 한 — 브리핑 기록. 알림 경로(lib/backgroundBriefings)와
 * 앱에서 직접 만든 브리핑을 적는 수동 실행(api/hooks useStockMutations)이 같이 쓴다. 네이티브 모듈 없이 AsyncStorage 만 쓴다
 */
export const SEEN_KEY = "briefings.notified"; // JSON: number[] (알림 보낸 브리핑 id, 최근 200개. 계좌 브리핑(3-31)은 -id 로 같은 목록에)
/** "1" 이면 알림 기준(그때까지의 브리핑)을 이미 적었다. 브리핑이 0건이라 SEEN 이 비어 있어도 처음으로 보지 않게 (N3) */
export const INIT_KEY = "briefings.notifyInit";

export async function seenIds(): Promise<Set<number>> {
  try {
    const raw = await AsyncStorage.getItem(SEEN_KEY);
    return new Set(raw ? (JSON.parse(raw) as number[]) : []);
  } catch {
    return new Set();
  }
}

export async function saveSeen(ids: Set<number>): Promise<void> {
  try {
    await AsyncStorage.setItem(SEEN_KEY, JSON.stringify([...ids].slice(-200)));
  } catch {
    /* ignore */
  }
}

/** 알림 기준을 적었는지. 표시가 없던 예전 앱에서 올라온 기기는 본 기록이 있으면 적은 것으로 본다 */
export async function initialized(seen: Set<number>): Promise<boolean> {
  if (seen.size > 0) return true;
  return (await AsyncStorage.getItem(INIT_KEY).catch(() => null)) === "1";
}

/**
 * 일부 종목 수동 실행(상세의 "이 종목 다시 만들기" — codes 가 있는 실행)으로 만든 브리핑을 "본 것"으로 적는다 (BH-67).
 * 서버는 이 실행을 알리지 않는다(누른 사람이 화면에서 결과를 본다). 적지 않으면 실패했던 브리핑이 같은 id 로 성공이 되거나 새 id 가 생겨,
 * 백그라운드 확인이 방금 읽은 브리핑을 15분쯤 뒤 다시 알렸다. 전체 수동 생성은 서버처럼 알리므로 적지 않는다.
 * 알림 기준을 아직 적지 않았으면 건드리지 않는다 — 여기서 적으면 기준이 있는 것으로 보여 첫 확인이 옛 브리핑을 알린다
 */
export async function markRunSeen(codes: readonly string[] | undefined, r: Pick<RunResult, "results">): Promise<void> {
  if (!codes?.length) return;
  const ids = r.results.flatMap((x) => (x.status === "ok" && x.briefingId ? [x.briefingId] : []));
  if (!ids.length) return;
  const seen = await seenIds();
  if (!(await initialized(seen))) return;
  // 최근 것으로 뒤에 (saveSeen 은 뒤의 200개만 남긴다)
  for (const id of ids) {
    seen.delete(id);
    seen.add(id);
  }
  await saveSeen(seen);
}
