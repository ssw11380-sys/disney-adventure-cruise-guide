import { useEffect, useState } from "react";

/** everyMs 마다 다시 그리게 하는 현재 시각. "30초 넘게 체결 없음" 같은 시간 기준 표시를 제때 바꾸는 데 쓴다 */
export function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}
