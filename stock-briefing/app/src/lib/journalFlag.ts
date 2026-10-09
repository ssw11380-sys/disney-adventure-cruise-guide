import { useFeature } from "@/api/hooks";
import { useAccountView } from "@/lib/account";

/**
 * 매매일지 (3-37) 켜짐: 서버 플래그 tradeJournal 과 그 원자료 tradeRecords 가 모두 켜져 있을 때만 (앱 fallback 은 둘 다 꺼짐 —
 * 서버가 켤 때만 보이고, 예전 서버·플래그를 못 받은 첫 실행은 지금 화면 그대로). 두 훅을 늘 같은 순서로 부른다.
 * 계정 A단계: 주인 아닌 계정(member)은 주인의 체결 기록이라 늘 꺼짐 — 입구·화면·요청 없음 (토스 연동·가격 알림 칸과 같은 규칙)
 */
export function useJournalOn(): boolean {
  const journal = useFeature("tradeJournal", false);
  const records = useFeature("tradeRecords", false);
  const { member } = useAccountView();
  return journal && records && !member;
}

/**
 * 매매일지의 '양도세 추정' 탭 (하위 플래그 journalTax — 서버 기본 끔, 앱 fallback false): 매매일지가 켜져 있고 journalTax 도 켜져 있을 때만.
 * 꺼져 있으면 탭·화면·합계가 없고 양도세 요청도 하지 않는다 (기록·수익률은 그대로). 세 훅을 늘 같은 순서로 부른다
 */
export function useJournalTaxOn(): boolean {
  const on = useJournalOn();
  const tax = useFeature("journalTax", false);
  return on && tax;
}
