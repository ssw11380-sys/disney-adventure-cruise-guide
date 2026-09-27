/**
 * 잔고 줄의 수정·지우기 (3-24, 기능 플래그 oneHand): 스와이프 버튼 · 길게 누르기 메뉴 · 화면 읽기 동작 · 종목 상세 아래 막대가 같은 말을 쓴다.
 * 지우기는 늘 확인 창을 한 번 거친다 (되돌릴 수 없는 일).
 *  - 토스 연동 종목: '동기화 제외' — 지우면 토스 동기화에서도 빠져 다시 나타나지 않는다 (수정 화면의 '동기화 제외하고 삭제'와 같은 뜻).
 *    서버의 inTossSnapshot(지우면 동기화에서 빠지는 종목 — 동기화가 3시간 넘게 멈췄거나 자동 동기화 0분이라 잠금이 풀린 때도 참)을 따른다.
 *    예전 서버(값 없음)는 tossSynced 로 대신한다
 *  - 보유 종목(수량 있음): '삭제'
 *  - 관심 종목(수량 없음): '관심 해제'
 */
export interface RemovableStock {
  name: string;
  quantity: number | null;
  tossSynced?: boolean;
  inTossSnapshot?: boolean;
}

export type RemoveKind = "sync" | "delete" | "unwatch";

export function removeKind(s: RemovableStock): RemoveKind {
  if (s.inTossSnapshot ?? s.tossSynced) return "sync";
  return s.quantity ? "delete" : "unwatch";
}

/** 버튼·메뉴에 쓰는 짧은 이름 */
export function removeLabel(s: RemovableStock): string {
  const k = removeKind(s);
  return k === "sync" ? "동기화 제외" : k === "delete" ? "삭제" : "관심 해제";
}

/** 확인 창: 제목 · 본문 · 확인 버튼 이름 (확인 버튼은 줄 버튼과 같은 이름) */
export function removeConfirm(s: RemovableStock): { title: string; message: string; confirm: string } {
  const k = removeKind(s);
  if (k === "sync")
    return {
      title: "동기화 제외하고 삭제",
      message: `${s.name} 은(는) 토스 계좌에서 가져온 종목입니다. 동기화에서 제외하면 목록에서 사라지고 다음 동기화 때도 다시 나타나지 않습니다 (다시 등록하면 다시 맞춤). 지난 브리핑은 남습니다.`,
      confirm: "동기화 제외",
    };
  if (k === "delete") return { title: "종목 삭제", message: `${s.name} 을(를) 목록에서 삭제할까요? 수량·평단도 함께 지워집니다. 지난 브리핑은 남습니다.`, confirm: "삭제" };
  return { title: "관심 해제", message: `${s.name} 을(를) 관심 종목에서 뺄까요? 지난 브리핑은 남습니다.`, confirm: "관심 해제" };
}

/** 화면 읽기 동작 (TalkBack '동작' 메뉴): 수정 · 지우기 · 길게 누르기(메뉴) */
export function rowA11yActions(s: RemovableStock): { name: string; label: string }[] {
  return [
    { name: "edit", label: "수정" },
    { name: "remove", label: removeLabel(s) },
    { name: "longpress", label: "메뉴 열기" },
  ];
}
