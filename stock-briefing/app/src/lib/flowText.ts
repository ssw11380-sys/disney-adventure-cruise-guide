/**
 * 종목 상세 '수급' 탭 (3-33, 플래그 flowTab) 화면 글 — 모두 이 파일 한 곳에 둔다 (문구 검사 대상: test/flowView.test.ts).
 * 사실만 쓴다: '산 주식 수 − 판 주식 수'가 얼마였는지. 좋다·나쁘다·주가가 어떻게 된다는 뜻을 붙이지 않는다 (판단 낱말·색·배지 없음)
 */

/** 탭 이름·화면 읽기 이름 */
export const FLOW_TAB = { label: "수급", a11y: "수급, 투자자별 매매" } as const;

/** 분류 이름 (합계 줄·막대 줄·표 머리) */
export const FLOW_NAMES = { individual: "개인", foreign: "외국인", institution: "기관", otherCorp: "기타법인" } as const;

export const FLOW_TEXT = {
  // 카드 1 (합계)
  sumTitle: "투자자별 매매",
  sumSub2: "산 주식 수에서 판 주식 수를 뺀 값",
  signNote: "+는 산 주식이 더 많았다는 뜻, -는 판 주식이 더 많았다는 뜻입니다.",
  zeroNoteToss: "네 값을 더하면 0에 가깝습니다. 누군가 판 주식은 다른 누군가가 산 것이기 때문입니다.",
  zeroNoteNaver: "기타법인 값이 없어 세 값을 더해도 대개 0이 되지 않습니다.",
  individualLater: "(개인은 장이 끝난 뒤에 나옵니다)",
  tableTitle: "기간별 합계",
  /** 넓은 칸 세 기간 표 위 설명 (표 머리가 '5일 | 20일 | 60일'뿐이라 달력 날짜로 읽지 않게) */
  sumSubWide: "장이 열린 날 기준 최근 5·20·60일 합계",
  // 카드 2 (막대)
  barsTitle: "날마다 (막대 하나 = 하루)",
  barsHint: "막대를 누르면 그날 값을 위에 보여 줍니다. 세 줄은 같은 눈금입니다.",
  tableOpen: "날짜별 숫자 보기",
  tableClose: "날짜별 숫자 접기",
  tableDate: "날짜",
  /** 날짜별 숫자 표 위 단위 (칸에는 '주'를 쓰지 않아 큰 글씨에서도 숫자와 단위가 두 줄로 갈라지지 않게) */
  tableUnit: "단위: 주",
  // 카드 3 (외국인 보유율)
  ratioTitle: "외국인 보유율",
  ratioAbout: "이 종목의 전체 주식 가운데 외국인이 가진 몫입니다.",
  ratioRevise: "외국인 보유율은 다음 날 오전에 한 번 더 고쳐지기도 합니다.",
  // 카드 4 (읽는 법, 처음엔 접힘)
  aboutTitle: "이 숫자들이 뜻하는 것",
  about: [
    "개인: 개인 투자자입니다.",
    "외국인: 금융감독원에 등록한 외국인 투자자입니다.",
    "기관: 증권사·보험사·투신·사모펀드·은행·연기금 등을 합친 값입니다.",
    "기타법인: 투자 회사가 아닌 일반 회사 등입니다. 회사가 자기 회사 주식을 사면 보통 여기에 들어갑니다.",
    "순매수라고도 부릅니다. 산 주식 수에서 판 주식 수를 뺀 값입니다.",
    "오늘 값은 장이 끝난 뒤 저녁 8시 30분 무렵 확정됩니다. 그 전에는 합계에 넣지 않습니다.",
    "모두 지난 기록입니다. 이 숫자만으로 주가가 어떻게 될지는 알 수 없습니다.",
  ],
  // 상태
  fail: "수급 자료를 받지 못했습니다.",
  retry: "다시 시도",
  retryA11y: "수급 자료 다시 불러오기",
  loading: "수급 자료를 불러오는 중",
  empty: "이 종목은 아직 투자자별 매매 자료가 없습니다.",
  off: "지금은 수급 자료를 볼 수 없습니다.",
  usTitle: "해당 없음",
  us: [
    "미국 주식은 이 탭에 보여 줄 자료가 없습니다.",
    "미국 거래소는 개인·외국인·기관이 날마다 사고판 주식 수를 공개하지 않습니다.",
    "공매도 잔고처럼 한 달에 두 번 나오는 자료는 지금 보여 주지 않습니다.",
  ],
} as const;

/** 칩 글 · 화면 읽기 */
export const periodLabel = (n: number) => `${n}일`;

export const sumSub1 = (n: number) => `최근 ${n}일 합계 (장이 열린 날 기준)`;
export const shortData = (k: number) => `받은 자료가 ${k}일치라 ${k}일 합계입니다.`;
/** 네이버 폴백은 한 번에 60줄까지라, 집계 중인 오늘 줄이 끼면 확정 줄이 59개 (종목 자료가 짧은 것이 아님) */
export const shortDataNaverCap = (k: number) => `네이버 증권 자료는 한 번에 60일치까지라, 집계 중인 오늘 값을 빼면 ${k}일 합계입니다.`;
export const missingNote = (m: number) => `(${m}일은 값이 없어 빼고 더했습니다)`;
/** 오늘 잠정 줄 (합계에 넣지 않음). date 는 요일 없는 날짜 '9월 29일' (괄호가 겹치지 않게) */
export const todayNote = (date: string) => `오늘(${date}) 값은 집계 중이라 합계와 막대에 넣지 않았습니다.`;
export const todayValues = (time: string | null, foreign: string, institution: string) => `${time ? `${time}까지 ` : ""}외국인 ${foreign} · 기관 ${institution}`;

/**
 * 고른 날 조각: ['9월 28일 (월)', '개인 +742만 주', '외국인 -598만 주', '기관 -363만 주', '종가 270,000원'].
 * 주 수에 늘 '주'를 붙인다 (옆의 종가 '원'과 헷갈리지 않게). 화면은 조각마다 한 덩어리로 그려 숫자와 단위가 줄에서 갈라지지 않는다
 */
export const pickedParts = (date: string, ind: string, fr: string, inst: string, close: string | null): string[] => [
  date,
  `개인 ${ind}`,
  `외국인 ${fr}`,
  `기관 ${inst}`,
  ...(close ? [`종가 ${close}원`] : []),
];
/** 고른 날 한 줄 (화면 읽기·막대 값): '9월 28일 (월) · 개인 +742만 주 · 외국인 -598만 주 · 기관 -363만 주 · 종가 270,000원' */
export const pickedLine = (date: string, ind: string, fr: string, inst: string, close: string | null) => pickedParts(date, ind, fr, inst, close).join(" · ");

// 보유율
export const ratioDateLine = (date: string) => `${date} · ${FLOW_TEXT.ratioAbout}`;
export const agoLine = (n: number, value: string, change: string) => `${n}일 전 ${value} → ${change}`;
/** 화면 읽기 (기호 '→'·'%p'를 말로): '5일 전 46.48%, 지금은 그때보다 0.04퍼센트포인트 높습니다'. abs 는 부호 없는 '0.04' */
export function agoSpeech(n: number, value: string, abs: string, sign: number): string {
  const head = `${n}일 전 ${value}`;
  if (sign > 0) return `${head}, 지금은 그때보다 ${abs}퍼센트포인트 높습니다`;
  if (sign < 0) return `${head}, 지금은 그때보다 ${abs}퍼센트포인트 낮습니다`;
  return `${head}, 지금과 같습니다`;
}
export const agoMissing = (n: number) => `${n}일 전 자료 없음`;
export const highLow = (high: string, low: string) => `가장 높음 ${high} · 가장 낮음 ${low}`;
export const pctPointNote = (from: string, to: string, change: string) => `%p는 퍼센트끼리 뺀 값입니다 (${from} → ${to}는 ${change}).`;
export const limitNote = (limitPct: string, usedPct: string) => `이 종목은 외국인이 가질 수 있는 몫이 전체 주식의 ${limitPct}로 정해져 있습니다. 지금 그 한도의 ${usedPct}를 채웠습니다.`;

// 출처
export const sourceToss = (when: string) => `자료: 토스증권 웹 공개 화면 · 한국거래소와 넥스트레이드 거래를 합친 값 · ${when} 반영`;
export const sourceNaver = (when: string) => `자료: 네이버 증권 · 한국거래소 거래만 (넥스트레이드 거래가 빠져 토스 앱 숫자와 같지 않습니다) · ${when}에 받음`;
export const checkLine = (days: number, same: number, when: string) =>
  same === days ? `토스증권 Open API 원자료와 최근 ${days}일 비교: ${days}일 모두 같음 (${when} 확인)` : `토스증권 Open API 원자료와 최근 ${days}일 비교: ${days}일 가운데 ${same}일 같음 (${when} 확인)`;
export const staleLine = (when: string) => `새 자료를 받지 못해 ${when}에 받은 값입니다.`;

// 화면 읽기
/** 합계 한 줄: '개인, 최근 20일 합계, 판 주식이 산 주식보다 3,348만 주 많았습니다' */
export function sumSpeech(name: string, period: number, abs: string | null, sign: number): string {
  const head = `${name}, 최근 ${period}일 합계`;
  if (abs === null) return `${head}, 값 없음`;
  if (sign > 0) return `${head}, 산 주식이 판 주식보다 ${abs} 많았습니다`;
  if (sign < 0) return `${head}, 판 주식이 산 주식보다 ${abs} 많았습니다`;
  return `${head}, 산 주식과 판 주식이 같았습니다`;
}
export const barsSpeechHead = (from: string, to: string, n: number) => `날마다 막대, ${from}부터 ${to}까지 ${n}일.`;
export const barsSpeechRow = (name: string, up: number, down: number) => `${name}은 산 쪽이 많은 날 ${up}일, 판 쪽이 많은 날 ${down}일.`;
export const ratioSpeech = (n: number, fromDate: string, from: string, toDate: string, to: string, high: string, low: string) =>
  `외국인 보유율 ${n}일, ${fromDate} ${from}에서 ${toDate} ${to}, 가장 높음 ${high}, 가장 낮음 ${low}`;
/** 날짜별 숫자 표 한 줄: '9월 28일 월요일, 개인 +742만 주, 외국인 -598만 주, 기관 -363만 주' */
export const tableRowSpeech = (date: string, ind: string, fr: string, inst: string) => `${date}, 개인 ${ind}, 외국인 ${fr}, 기관 ${inst}`;
/** 넓은 창 세 기간 표 머리 */
export const TABLE_HEAD = "구분";
