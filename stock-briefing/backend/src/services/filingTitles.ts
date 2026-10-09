/**
 * 3-38 공시 제목 번역 (플래그 filingAlerts): SEC 서식과 8-K 항목 번호를 우리말 제목·한 줄 설명으로 옮긴다. 순수 함수만.
 * 내용 요약이 아니라 '회사가 어떤 서식·항목으로 냈는지'를 옮긴 것이다 (원문은 영어 — 화면 작은 글이 밝힌다).
 * 사실만 적는다: 판단·권유·전망하는 말 없음 (test/filingTitles.test.ts 가 BRIEFING_BANNED 로 모든 글을 검사)
 */

export interface ItemInfo {
  /** 제목 '실적 발표' */
  title: string;
  /** 한 줄 설명 '분기·연간 실적 같은 영업 결과를 알림' */
  about: string;
  /** 제목으로 먼저 보일 차례 (작을수록 먼저). 화면·알림에 중요도로 쓰지 않는다 */
  order: number;
}

/** 8-K 항목 번호 → 제목·설명·차례 (SEC Form 8-K 항목 목록) */
export const ITEMS_8K: Readonly<Record<string, ItemInfo>> = {
  "1.01": { title: "중요 계약 체결", about: "회사에 중요한 계약을 새로 맺음", order: 4 },
  "1.02": { title: "중요 계약 종료", about: "중요한 계약이 끝나거나 해지됨", order: 12 },
  "1.03": { title: "파산·법정관리 신청", about: "파산이나 법정관리 절차가 시작됨", order: 1 },
  "1.04": { title: "광산 안전 보고", about: "광산 안전 당국의 조치를 알림", order: 25 },
  "1.05": { title: "중대한 사이버 보안 사고", about: "회사가 중대하다고 판단한 해킹 등 보안 사고", order: 8 },
  "2.01": { title: "인수·매각 완료", about: "회사나 자산을 사거나 파는 일을 마침", order: 5 },
  "2.02": { title: "실적 발표", about: "분기·연간 실적 같은 영업 결과를 알림", order: 2 },
  "2.03": { title: "새 채무 발생", about: "돈을 빌리는 등 새로 갚을 의무가 생김", order: 13 },
  "2.04": { title: "채무 조기 상환 사유 발생", about: "빚을 예정보다 일찍 갚아야 하는 일이 생김", order: 11 },
  "2.05": { title: "사업 정리 비용", about: "사업을 접거나 줄이는 데 드는 비용을 알림", order: 10 },
  "2.06": { title: "자산 가치 크게 낮춤", about: "자산의 장부 가치를 크게 낮춤(손상 처리)", order: 9 },
  "3.01": { title: "상장 유지 기준 관련 통지", about: "거래소 상장 기준 미달 통지나 상장 시장 이전", order: 3 },
  "3.02": { title: "등록 없이 주식 발행", about: "공모 등록 없이 새 주식을 발행함", order: 14 },
  "3.03": { title: "주주 권리 변경", about: "주주의 권리가 크게 바뀜", order: 15 },
  "4.01": { title: "회계법인 변경", about: "감사하는 회계법인이 바뀜", order: 16 },
  "4.02": { title: "이전 재무제표 정정 예정", about: "이미 낸 재무제표를 고쳐 다시 내야 한다고 알림", order: 6 },
  "5.01": { title: "경영권 변경", about: "회사를 지배하는 주체가 바뀜", order: 7 },
  "5.02": { title: "임원·이사 변경", about: "임원·이사의 선임·퇴임이나 보수 계약", order: 17 },
  "5.03": { title: "정관 변경", about: "정관·내규나 회계연도가 바뀜", order: 19 },
  "5.04": { title: "직원 연금 계좌 거래 일시 중지", about: "직원 퇴직연금 안의 회사 주식 거래를 잠시 멈춤", order: 23 },
  "5.05": { title: "윤리 규정 변경", about: "임직원 윤리 규정을 고치거나 예외를 둠", order: 22 },
  "5.06": { title: "껍데기 회사 상태 변경", about: "사업이 없는 회사(셸 회사) 상태가 바뀜", order: 18 },
  "5.07": { title: "주주총회 투표 결과", about: "주주총회에서 투표한 결과를 알림", order: 20 },
  "5.08": { title: "주주의 이사 후보 제출 기한", about: "주주가 이사 후보를 낼 수 있는 기한을 알림", order: 24 },
  "7.01": { title: "투자자 대상 자료 공개", about: "발표 자료 등 모든 투자자에게 같이 공개하는 자료(공정공시)", order: 21 },
  "8.01": { title: "기타 알릴 사항", about: "위 항목에 없는 회사 소식", order: 20 },
  "9.01": { title: "재무제표·첨부 서류", about: "다른 항목에 딸린 첨부 서류", order: 99 },
};

/** 6.01~6.10 (자산유동화증권) — 표 하나로 */
const ABS_ITEM: ItemInfo = { title: "자산유동화증권 보고", about: "자산유동화증권(ABS) 관련 보고", order: 26 };
/** 표에 없는 번호 */
const UNKNOWN_ITEM: ItemInfo = { title: "기타 항목", about: "위 항목 표에 없는 번호", order: 90 };

/** 8-K 가 아닌 서식 → 제목 앞부분·괄호 안 덧말·한 줄 설명 */
export const FORMS: Readonly<Record<string, { title: string; extra: string | null; about: string }>> = {
  "10-Q": { title: "분기 보고서", extra: null, about: "분기 재무제표와 사업 내용을 담은 정식 보고서" },
  "10-K": { title: "연간 보고서", extra: null, about: "한 해 재무제표와 사업 내용을 담은 정식 보고서" },
  "20-F": { title: "연간 보고서", extra: "외국 기업", about: "외국 기업이 SEC에 내는 연간 보고서" },
  "40-F": { title: "연간 보고서", extra: "캐나다 기업", about: "캐나다 기업이 SEC에 내는 연간 보고서" },
  "6-K": { title: "외국 기업 수시 보고", extra: null, about: "외국 기업이 본국에서 알린 내용을 SEC에도 올린 것입니다. 무슨 내용인지는 원문을 봐야 알 수 있습니다." },
};

/** 정정(/A) 서식의 덧붙임 한 줄 */
export const AMENDED_NOTE = "먼저 낸 보고서를 고친 것입니다.";
/** 항목 번호가 비어 있는 8-K */
export const NO_ITEMS_NOTE = "항목 번호가 적혀 있지 않습니다. 무슨 내용인지는 원문을 봐야 알 수 있습니다.";

/** 항목 번호 하나의 제목·설명 */
export function itemInfo(no: string): ItemInfo {
  if (ITEMS_8K[no]) return ITEMS_8K[no];
  if (/^6\.(0[1-9]|10)$/.test(no)) return ABS_ITEM;
  return UNKNOWN_ITEM;
}

function baseForm(form: string): { base: string; amended: boolean } {
  const amended = form.endsWith("/A");
  return { base: amended ? form.slice(0, -2) : form, amended };
}

/** 제목에 쓸 항목: 9.01 을 뺀 것 중 차례가 가장 앞선 것 (같으면 번호 순) + 나머지 수. 9.01 만 있으면 9.01 */
function leadItem(items: readonly string[]): { no: string; rest: number } | null {
  const main = items.filter((x) => x !== "9.01");
  if (!main.length) return items.includes("9.01") ? { no: "9.01", rest: 0 } : null;
  const sorted = [...main].sort((a, b) => itemInfo(a).order - itemInfo(b).order || (a < b ? -1 : a > b ? 1 : 0));
  return { no: sorted[0]!, rest: main.length - 1 };
}

/**
 * 공시 제목:
 *  - 8-K 항목 하나(9.01 제외) '실적 발표(8-K 2.02)', 여럿이면 차례가 가장 앞선 항목 + '외 N건' '중요 계약 체결 외 2건(8-K 1.01)' (N 은 9.01 을 뺀 나머지 수),
 *    9.01 만 '재무제표·첨부 서류(8-K 9.01)', 모르는 번호 '기타 항목(8-K 1.09)', 항목이 비어 있음 '수시 보고(8-K)'
 *  - 정정 '임원·이사 변경 정정(8-K/A 5.02)' · '분기 보고서 정정(10-Q/A)'
 *  - '분기 보고서(10-Q)' · '연간 보고서(10-K)' · '연간 보고서(20-F, 외국 기업)' · '연간 보고서(40-F, 캐나다 기업)' · '외국 기업 수시 보고(6-K)'
 */
export function filingTitle(form: string, items: readonly string[]): string {
  const { base, amended } = baseForm(form);
  const fix = amended ? " 정정" : "";
  if (base === "8-K") {
    const lead = leadItem(items);
    if (!lead) return `수시 보고${fix}(${form})`;
    return `${itemInfo(lead.no).title}${lead.rest > 0 ? ` 외 ${lead.rest}건` : ""}${fix}(${form} ${lead.no})`;
  }
  const f = FORMS[base];
  if (!f) return form;
  return `${f.title}${fix}(${form}${f.extra ? `, ${f.extra}` : ""})`;
}

/**
 * 펼친 줄의 내용: 8-K 는 들어 있는 항목마다 '2.02 실적 발표 — 분기·연간 실적 같은 영업 결과를 알림' (번호 순서 그대로),
 * 그 밖 서식은 한 줄 설명(note). 정정이면 note 끝에 '먼저 낸 보고서를 고친 것입니다.'
 */
export function filingDetail(form: string, items: readonly string[]): { lines: string[]; note: string | null } {
  const { base, amended } = baseForm(form);
  const tail = amended ? AMENDED_NOTE : null;
  if (base === "8-K") {
    const lines = items.map((no) => {
      const i = itemInfo(no);
      return `${no} ${i.title} — ${i.about}`;
    });
    const note = [lines.length ? null : NO_ITEMS_NOTE, tail].filter((x): x is string => x !== null).join(" ");
    return { lines, note: note || null };
  }
  const f = FORMS[base];
  return { lines: [], note: [f?.about ?? null, tail].filter((x): x is string => x !== null).join(" ") || null };
}
