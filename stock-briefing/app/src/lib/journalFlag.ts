import { useFeature } from "@/api/hooks";

/**
 * 매매일지 (3-37) 켜짐: 서버 플래그 tradeJournal 과 그 원자료 tradeRecords 가 모두 켜져 있을 때만 (앱 fallback 은 둘 다 꺼짐 —
 * 서버가 켤 때만 보이고, 예전 서버·플래그를 못 받은 첫 실행은 지금 화면 그대로). 두 훅을 늘 같은 순서로 부른다
 */
export function useJournalOn(): boolean {
  const journal = useFeature("tradeJournal", false);
  const records = useFeature("tradeRecords", false);
  return journal && records;
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
