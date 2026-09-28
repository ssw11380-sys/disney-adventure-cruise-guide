import { createApi } from "@/api/client";
import type { Health } from "@/api/types";

/**
 * 서버 설정을 저장한 직후의 연결 확인 (계정 A단계 — 로그인 전 '서버 설정' 화면). **저장한 값으로 직접** 묻는다:
 * 화면의 useHealth().refetch() 는 아직 옛 토큰의 요청 함수를 들고 있어, 맞는 토큰으로 고쳐 저장해도 '토큰 필요'가 최대 60초 남고
 * 로그인 화면으로 돌아가지 않았다 (검증 지적). 받은 결과는 put 으로 새 주소의 캐시에 넣는다 (배지가 바로 바뀌게).
 * 토큰까지 맞으면(limited 아님) true. 연결 오류는 false — 화면의 확인(새 주소로 다시 받음)이 오류를 보여 준다
 */
export async function checkSaved(url: string, token: string, put: (url: string, data: Health) => void, api: (url: string, token: string) => Pick<ReturnType<typeof createApi>, "health"> = createApi): Promise<boolean> {
  const u = url.trim().replace(/\/+$/, "");
  try {
    const data = await api(u, token.trim()).health();
    put(u, data);
    return !data.limited;
  } catch {
    return false;
  }
}
