import type { Db } from "../db/index.js";
import { seoulIso } from "../lib/time.js";

/**
 * 기능 켜고 끄기 (3-15). 플래그 목록은 여기 한 곳에만 둔다.
 *  - 기본값은 코드에, 바꾼 값만 meta(features)에 저장 → 관리 API 로 바꾸면 재배포 없이 반영 (앱은 60초마다 /api/features 를 받는다)
 *  - 기능 하나에 플래그 하나. 완전히 켠 뒤 한 달이 지나면 플래그를 지우고 코드에 합친다
 *  - 새 기능(3-19·3-24 의 새 동작, P2 전부)은 플래그 뒤에 둔다
 */
export const FEATURES = {
  informationFocus: { default: true, description: "잔고 핵심 금액·상태 우선 표시와 기준 펼치기, 관심 희망가 차이 방향 안내. 끄면 기존 전체 기준 설명과 부호 표시" },
  accountLiveRefresh: { default: true, description: "앱 연결 중 계좌 원본을 완료 후 30초 간격으로 확인. 끄면 기존 정기·체결·수동 동기화만 유지" },
  widgetLeanLive: { default: true, description: "위젯 핵심 숫자 중심 보기와 앱 실행 중 시세 5초 묶음 전달. 끄면 기존 표시와 1분 간격, 수량 즉시 전달·마지막 시세 전달 보완은 유지" },
  watchlistSteps: { default: true, description: "별도 관심종목·관심 시작 가격·구매희망 가격, 관심 기준 및 잔고 전일 종가 기준 5% 구간 서버 알림. 끄면 메뉴·조회·알림 중지, 저장값 보존" },
  settingsSections: { default: true, description: "설정 분류 목록과 선택한 항목만 펼치기. 끄면 기존 전체 설정 화면" },
  widgetClarity: { default: true, description: "위젯 정보 기준 개선: 앱 실시간 평가·시세와 조회 시각·합계 제외와 지난 값 경고·전일 대비·개인화. 끄면 기존 위젯" },
  tossAccountSnapshot: { default: true, description: "토스 원본 계좌 평가: 동기화 때 받은 전체 주식 평가를 통화별로 보존하고 잔고의 기본 기준으로 표시. 끄면 기록·조회·표시 없이 기존 실시간 평가" },
  briefingParallel: { default: true, description: "보고서 속도 개선: 종목 두 개의 자료 수집·분석을 동시에 진행하며 각 종목의 분석 뒤 요약, 저장 순서와 세션 알림을 유지. 끄면 기존 순차 처리" },
  analysisWaitRecovery: { default: true, description: "분석 대기 개선: 갱신 중 이전 보고서를 유지하고 조회 전용 상태 경로로 서버에서 완성된 결과를 회수. 끄면 기존 대기·오류 화면, 상태 경로 404" },
  briefingLiveProgress: { default: true, description: "브리핑 진행 표시: 시작부터 준비·처리 개수·마무리 상태를 표시. 끄면 기존 늦음·실패 안내만 표시" },
  tossReconcile: { default: true, description: "토스 계좌 자동 대조: 동기화마다 기록·경고, 설정 화면 '토스 대조' 줄 (3-13)" },
  briefingSources: { default: true, description: "브리핑 상세의 근거(뉴스·공시 출처) 카드 (3-12)" },
  briefingDigest: { default: true, description: "브리핑 알림을 세션당 1건으로 묶고 조용한 시간·끈 종목을 지킴 (3-19). 끄면 종목마다 1건(예전)" },
  briefingTabMovers: { default: true, description: "브리핑 탭 기본 정렬 '변동 큰 순'과 상위 3종목 먼저 (3-19). 끄면 등록순(예전)" },
  briefingManualRun: { default: true, description: "브리핑 수동 생성 전 확인 창, 상세의 '이 종목 다시 만들기' (3-19). 끄면 확인 없이 바로(예전)" },
  widgetPnlToggle: { default: true, description: "잔고 위젯 합계 옆 손익을 눌러 누적·당일 전환 (위젯 요청). 끄면 누적만, 누르면 앱(예전)" },
  widgetIndexLine: { default: true, description: "잔고 위젯 합계 아래 코스피·나스닥·환율 한 줄 (위젯 요청). 끄면 줄이 사라지고 /api/widget 응답에 지수를 넣지 않음" },
  widgetMarket: {
    default: true,
    description: "지수·환율 위젯 (APK 1.4.0): 코스피·코스닥·나스닥·S&P500·다우·필라반도체와 원/달러·원/100엔·원/위안. 끄면 위젯에 짧은 안내만 보이고 /api/widget 응답에 지수 판을 넣지 않음",
  },
  widgetPolish: {
    default: true,
    description:
      "잔고 위젯 다듬기: 두 시장 세션 칩(미국 주간거래 · 한국 휴장), 지수 줄 계좌 비중 순서·환율 등락률·지난 값 흐리게+날짜, 종목 줄 '수익'·'오늘' 표시와 원화 손익, 손익 전환 ⇅ 표시, '보유 17 · 관심 1', 줄 간격 줄이기. 끄면 예전 모습 그대로이고 /api/widget 에 칩 시장별 문구·지수 두 개(코스닥·S&P500)를 넣지 않음",
  },
  widgetExtended: {
    default: true,
    description:
      "위젯 연장 거래 시간 갱신 (위젯 리뷰 1): 미국 프리·애프터·주간거래 등 달력으로는 닫혀 있어도 보유 종목이 거래되는 세션이면 /api/widget 칩에 시장별 ext 를 넣고, 새 앱 위젯이 장중처럼 15분마다 갱신하고 그 시장 시세가 30분 넘게 묵으면 '지연'. 끄면 칩에 ext 를 넣지 않아 예전처럼 휴장 규칙(최대 2시간 재사용, 지연 없음)",
  },
  widgetFoldFit: {
    default: true,
    description:
      "폴드 위젯 크기 맞추기 (위젯 2차, 앱만 — /api/widget features 로 전달): 넓은 모습(잔고 평가금액 칸·두 열, 지수·환율 넓은 모양 — 구역 안 옆 칸·큰 값 글자)을 위젯 폭 560dp 이상에서만 씀(폴드8 바깥 화면 4x2 약 507~516dp 에 평가금액 칸이 나오던 것). 폭 하나로만 정하고 화면 크기·방향·위젯마다의 기억은 보지 않음. 안쪽 화면에 넓게 늘린 위젯(약 780dp)은 그대로, 달라지는 것은 폭 504~559dp 위젯뿐. 켜져 있을 때만 위젯 크기 진단 기록(기기 안)을 적고 설정 '화면 정보' 공유 글 끝에 [위젯] 진단 줄을 붙임. 끄면 예전 기준 그대로(그림이 한 글자도 같음)이고 공유 글도 예전과 같음",
  },
  widgetRefreshLog: {
    default: true,
    description:
      "설정 화면 위젯 자동 갱신 기록 (위젯 리뷰 2, 앱만): '마지막 자동 갱신 10:47 · 오늘 평균 간격 18분', 장중 1시간 넘게 자동 갱신 작업이 돌지 않거나 실패만 하면 경고(사유별 안내), '이 앱 설정 열기' 버튼(앱 정보 → 배터리 → 제한 없음). 끄면 설정 화면에 보이지 않음(기기 안 기록은 계속 적음, 서버 작업 없음)",
  },
  allocationView: {
    default: true,
    description: "비중 보기: 잔고 탭 계좌 평가의 '비중' 버튼과 국내·해외/통화/업종/종목별 원 차트 화면 (앱만, 서버 작업 없음). 끄면 버튼이 사라지고 화면을 열어도 잔고 계산을 하지 않음",
  },
  accountBriefing: {
    default: true,
    description: "계좌 한 장 브리핑 (3-31): 세션마다 계좌 요약 1건(기여도 상위·지수·환율 영향·오늘 일정)을 만들고 세션 알림 앞머리에 씀, 브리핑 탭 '내 계좌 브리핑' 카드. 끄면 만들지 않고(모델 호출 0) 알림·화면이 예전 그대로",
  },
  accountBriefingLlm: {
    default: false,
    description:
      "계좌 브리핑의 설명 문단을 모델이 쓰기 (3-31, 실험). 모델 설명은 숫자·부호·권유 표현 검사를 거치지만 자유 문장을 완전히 막을 수 없어 기본 꺼짐. 끄면 숫자로 만든 기본 설명만 쓰고 계좌 브리핑의 모델 호출 0",
  },
  marketSummary: {
    default: true,
    description:
      "시장 전체 요약 (AI 문장 없음, 모델 호출 0): 세션마다 방금 끝난 장(아침 미국·오후 한국)의 지수·환율·금리·업종·내 보유 종목과 지수 비교·일정·언론사 뉴스 제목을 코드로 요약해 브리핑 탭 맨 위 카드·상세 화면·세션 알림 첫 줄에 보임. 끄면 요약을 만들지도 조회하지도 않고(재무부·섹터 ETF·뉴스 요청 0) 카드·알림 첫 줄이 사라져 지금 모습 그대로",
  },
  foldLayout: {
    default: true,
    description:
      "접는 폰·넓은 창 화면 (3-42, 앱만, 서버 작업 없음): 창 폭 등급(좁음·중간·넓음)과 높이가 짧은 창에 맞춘 배치 — 넓고 낮은 창(펼친 폴드8 가로)은 탭을 왼쪽 세로 막대로, 넓은 창에서는 탭 머리 대신 맨 위 띠 · 잔고 44dp 넓은 표 · 종목 상세 좌우 배치 · 브리핑 목록+본문 2단 · 발견 한 줄 표 · 설정 카드 두 칸 · 비중 2×2 (가운데로 모으는 읽기 폭은 쓰지 않음). 끄면 창 크기와 상관없이 휴대폰 화면 그대로(탭은 아래)",
  },
  detailPolish: {
    default: true,
    description:
      "종목 상세 다듬기 (앱만, 서버 작업 없음): 휴대폰·접은 화면 시세 머리 아래 '보유 160주 · 평가손익 …(…%)' 한 줄, 차트를 과거로 옮겼을 때 차트 위 조작 줄의 '2일 전까지 보는 중 · 최신으로' 버튼, 휴대폰·접은 화면 차트 폭을 패널 폭 전부로(오른쪽 빈 띠 없음)·가격 축 글자를 오른쪽 끝에 맞춤. 끄면 모두 사라지고 예전 화면 그대로",
  },
  pollSaver: {
    default: true,
    description:
      "끊겼을 때 데이터 절약 (3-25 성능-16): 자주 묻는 GET(잔고·상세·지수·장 상태·플래그·/health)에 ETag·304(바뀐 것 없으면 본문 없음)·바뀐 부분만(226, 앱이 A-IM: json-delta 로 물을 때)·gzip. 앱은 웹소켓이 끊긴 동안 값이 그대로면 3초→4초로 늦추고(화면 지연 5초 안), 장이 닫히면 5분(열리는 순간 바로), 웹소켓 다시 붙기 간격 최대 2분. 끄면 응답이 바이트까지 예전과 같고 앱도 예전 주기(3초·1분·30초)",
  },
  oneHand: {
    default: true,
    description:
      "한 손 조작 (3-24, 앱 — 서버는 목록·상세의 inTossSnapshot 값만 늘 더함): 잔고 줄을 왼쪽으로 밀면 수정·삭제 버튼(지우면 토스 동기화에서도 빠지는 종목(inTossSnapshot)은 '동기화 제외', 관심은 '관심 해제' — 지우기는 늘 확인 창), 넓은 표는 길게 누르기 메뉴, 화면 읽기 동작(수정·지우기). 햅틱 6곳(줄 밀기·길게 누르기·정렬·관심 추가/해제·삭제 결과·당겨서 새로고침 — 휴대폰 '터치 진동'이 꺼져 있으면 울리지 않음)과 설정 > 표시 '누를 때 진동' 스위치. 휴대폰·접은 화면 종목 상세 아래 고정 막대(관심 추가/해제·보유 수정 · 차트 크게)와 스크롤하면 머리에 현재가. 끄면 모두 사라지고 예전 화면 그대로(차트 십자선 진동은 예전처럼 늘)",
  },
  firstRun: {
    default: true,
    description:
      "첫 실행 안내 (3-24, 앱만): 새 사용자에게 한 번 한 화면(위젯 추가법·알림 권한·토스 연동 상태 — 서버 주소·토큰 입력 없음), 탭 첫 화면에 있을 때만 저절로 열림, '시작하기' 한 번으로 닫힘, 설정 > 정보 '처음 사용 안내 다시 보기'. 새 사용자 = 이번 실행에서 서버에서 새로 받은 자료로 등록 종목 0개 + 토스 연동 기록 없음(키 없음·동기화한 적 없음). 종목이 있거나 토스가 연결되어 있으면 띄우지 않음(기존 사용자). 서버에 닿지 않으면 기다림. 끄면 안내·버튼이 사라짐",
  },
  emptyGuide: {
    default: true,
    description:
      "빈 화면·연결 오류 안내 (3-24, 앱만): 잔고·관심·발견·브리핑·비중·설정(알림·토스 칸)의 빈 상태에 안내 문구와 행동 버튼 1개, 서버 연결 오류(인터넷·시간 초과·토큰 틀림·틀린 서버 주소 — 서버에는 닿지만 앱의 서버가 아닌 주소) 화면·끊김 띠·검색·지수 차트에 '설정 열기'(설정 > 서버 연결 칸을 펼쳐 보여 줌)와 설정 칸 이름에 맞춘 오류 문구. 예외: 서버 주소가 틀려 이 플래그를 받을 수 없을 때는 이 기기가 마지막으로 받은 값이 켬이면 연결 오류 안내만 켬(받은 적 없거나 끔이면 켜지 않음). 끄면 예전 빈 화면·오류 글 그대로",
  },
  tradeRecords: {
    default: true,
    description:
      "매매 기록 기반 (3-36): 시장(한국·미국) 거래일마다 장 마감 뒤(한국 16:05·미국 정규장 마감 5분 뒤, 서머타임·조기 폐장 반영) 토스 보유 조회로 계좌 스냅샷 1줄(종목별 수량·평단·현재가·통화·환율·원화 합계)을 저장하고, 토스 주문 내역의 체결을 주문번호로 중복 없이 저장. 놓친 거래일은 값을 지어내지 않고 빈칸 표시, 최근 5·30거래일 빈칸은 /health·관리 화면·로그로 경고. 읽기 /api/snapshots·/api/trades·/api/trade-records, 앱은 설정 > 서버 '매매 기록' 한 줄. 끄면 쓰지도 부르지도 않고(토스 호출 0) 새 경로는 빈 값, /health 에 칸 없음, 앱 줄 없음",
  },
  indicatorScores: {
    // 나눠 켜기 1단계(추세)부터 켬 — 앱에 켜고 끄는 화면이 없어 꺼 두면 사용자에게 보이지 않음(2026-09-28 결정). 끄기: PUT /api/admin/features {"indicatorScores": false}
    default: true,
    description:
      "종목 상세 '지표 점수' (3-44 1단계, 코드 계산 · AI 글 아님, 기본 켜짐): 기업개요 탭 맨 위 요약 카드(가치 지표는 '계산 준비 중', 추세 지표 점수 0~100·띠·한 줄 뜻, 종합 줄은 두 점수가 모두 있을 때 평균 — 1단계는 '없음 · 이유')와 기술분석 탭 맨 위 추세 상세 카드(5묶음·사실 문장·지난주보다 5점 넘게 바뀐 이유), 레버리지 ETF 는 이 상품 자체 점수 없이 기초자산 참고 줄과 레버리지 주의 사실 상자. 장 마감 뒤 하루 한 번(한국 20:10 · 미국 17:30 ET) 등록 종목을 계산해 indicator_scores 에 기록, GET /api/scores/:code. 잔고 목록·알림·위젯·브리핑·AI 글에는 넣지 않음. 끄면 계산·일봉 요청·저장·화면이 모두 0건이고 경로는 404",
  },
  valueScore: {
    // 3-44 2단계의 되돌리기 스위치 (indicatorScores 안의 가치 부분만). 끄기: PUT /api/admin/features {"valueScore": false}
    default: true,
    description:
      "지표 점수의 가치 지표 점수·종합 (3-44 2단계, 미국 보통주만, indicatorScores 가 켜져 있을 때만 뜻이 있음): SEC 재무(companyfacts, 최근 4분기·공시일 기준)와 주 1회 비교 기준(Nasdaq 스크리너 업종·시가총액 + SEC frames, 표 value_references)으로 가치 지표 점수 0~100·띠·5묶음·지표별 값, 두 점수가 모두 있으면 종합(평균·차이 30 이상 안내). 재무는 표 value_fundamentals 에 저장하고 장 마감 뒤(뉴욕 17:30)·백그라운드로만 받음 — 화면 요청은 SEC 를 기다리지 않음. 끄면 1단계 그대로(가치 '지금 계산하지 않음', 종합 없음)이고 SEC·Nasdaq 요청·저장이 0건",
  },
  krValueScore: {
    // 3-44 3단계의 되돌리기 스위치 (한국 간이 가치만). 끄기: PUT /api/admin/features {"krValueScore": false}
    default: true,
    description:
      "지표 점수의 한국 종목 가치 지표 점수·종합 (3-44 3단계 '간이 계산', indicatorScores · valueScore 가 켜져 있을 때만 뜻이 있음): 네이버 증권 재무 요약(최근 5개 분기·3개 결산, 실적 열만 — 증권사 추정 열은 버림)과 주 1회 한국 비교 기준(일요일 05:00 KST, 네이버 업종 구성 종목·시가총액 — 한국 상장 보통주끼리만)으로 가치 지표 점수 0~100·띠·'간이 계산' 배지·5묶음·지표별 값, 추세와 함께 종합. 재무는 표 value_fundamentals(cik 칸 'naver')에 저장하고 밤 02:30 에 분기에 한 번 돌아가며(새 분기 실적이 나올 때가 된 회사·120일 넘은 회사, 밤마다 700종목까지 — 첫 채우기는 며칠 밤) 받음, 화면 요청은 네이버를 기다리지 않음. 우선주·스팩·리츠·ETF 는 '대상 아님'. 끄면 한국 가치 줄은 '지금 계산하지 않음'(종합 없음)이고 네이버 재무·업종 요청 0건 — 미국 가치(valueScore)는 그대로",
  },
  // ── 가치 점수 개선 1단계 (2026-09-29, 사용자 결정 '추천대로' — 검토 보고서 개선안 [2]·[3]·[4]·[5]·[8 일부]·[9]·[10]). 모두 글·표시만, 점수 숫자는 그대로 ──
  valueDirectionWords: {
    default: true,
    description:
      "가치 묶음 방향 말 (개선안 [2], 서버 글만): 묶음 설명 '높을수록 … 주가 수준이 낮은 편' → '막대가 길수록: 이익·순자산·매출에 비해 주가가 낮은 쪽 (비교 회사 기준)'(다섯 묶음 모두 '막대가 길수록'), 비교 시점 안내·가치 함정 표시도 '주가 수준 막대가 조금 길게(이익에 비해 주가가 실제보다 낮아 보이는 쪽으로)'처럼 막대 말로('주가가 실제보다 낮은 쪽으로'는 '저평가'로 읽힐 수 있어 바꿈). 끄면 지금 글 그대로",
  },
  valueFamilyTwoSided: {
    default: true,
    description:
      "가치 묶음 두 쪽 문장 (개선안 [2], 서버 글만): 묶음 한 줄(가장 튀는 지표 하나) → '막대를 길게 만든 지표: 기업가치 ÷ 영업이익 80점 · PER 71점' / '막대를 짧게 만든 지표: PBR 5점 · PSR 25점'(위치 67 이상 · 33 이하, 띠가 높은 편·낮은 편인 묶음은 같은 쪽만, 숫자 뒤 '점'은 위치 점수 — 'PER 71배'로 읽히지 않게, 지표 이름·숫자·'점'은 좁은 화면에서도 낱말 가운데서 줄이 바뀌지 않게 묶음), 적자 0점 사실 글은 그대로. 끄면 지금 한 줄 그대로",
  },
  valuePerPlain: {
    default: true,
    description:
      "PER 줄 정직하게 (개선안 [3], 서버 글만, 점수 그대로): 경기 민감 회사의 PER 줄 첫 숫자를 남과 같은 최근 4분기 PER(예: 엔비디아 27.9배)로 보이고 '순위에는 최근 4분기 이익과 5년 평균 이익을 반씩 섞은 44.8배를 썼습니다' 한 줄, 위치 줄 앞에 '순위용 44.8배 기준:'(위치·문장은 섞은 값으로 매긴 것). 끄면 섞은 값 그대로",
  },
  valueMedianText: {
    default: true,
    description:
      "적자 회사 덩어리 글 (개선안 [3], 사용자 결정 Q4 ① '글만', 서버 글만, 점수 그대로): PER·기업가치 ÷ 영업이익 줄의 가운데값을 '흑자 회사 가운데값 58.6배 · 비교한 업종 68곳 중 43%는 적자'로('100배 넘음' 대신), 적자 비율이 10% 이상이면 위치 옆 '(흑자 회사끼리 59)', 흑자 회사끼리 보면 띠가 달라질 때 '비교한 회사의 43%가 적자라 흑자 회사끼리만 볼 때보다 위치 점수가 높게 나왔습니다. 흑자 회사끼리 보면 가운데쯤입니다.', 머리 문장 회사 수와 지표 값이 있는 회사 수가 다르면 '이익 자료가 있는 152곳 중'(기업가치 ÷ 영업이익은 '영업이익 자료가 있는 64곳 중'). 끄면 지금 글 그대로",
  },
  valuePriceNote2: {
    default: true,
    description:
      "가격 안내 숫자로 (개선안 [3], 서버 글만): '시세 표의 PER·PBR과 조금 다를 수 있습니다' → 경기 민감 회사는 '이 종목은 순위에 쓴 PER(섞은 값)이 시세 표의 PER과 크게 다릅니다(아래 PER 줄에 두 값)'(valuePerPlain 을 끄면 '이 종목의 PER은 순위용 계산이 달라 시세 표와 크게 다릅니다'), 20거래일 평균과 마지막 종가가 5% 넘게 다르면 '마지막 종가로는 PER n배 · PBR n배'. 끄면 지금 한 줄 그대로",
  },
  valueOneOffAbs: {
    default: true,
    description:
      "영업 외 손익 표시 기준 (개선안 [3], 서버 글만, 점수 그대로): 표시 '영업 외 손익이 커서…'를 시장 상위 5% 대신 '영업 외 손익이 세전이익의 30% 이상'일 때 보이고, PER 줄에 '영업이익으로 계산하면(세금 n% 가정) PER 약 n배' 한 줄 — 영업 외 **이익**이고 세전이익·영업이익이 모두 플러스일 때만. 영업 외 손실(세전이익 < 영업이익 — 이자 비용이 큰 회사)과 영업손실 회사(영업이익 ≤ 0 — 이익이 영업 밖에서만 나는 회사)는 새 기준·영업이익 기준 PER 없이 예전 기준(시장 상위 5%) 그대로. 끄면 지금 기준·글 그대로",
  },
  compositeFormula: {
    default: true,
    description:
      "종합 줄 작게·식 보이기 (개선안 [4], 사용자 결정 Q3 ①, 서버 + 앱 OTA, 앱 fallback 꺼짐): 서버가 종합에 식 '= (51 + 80) ÷ 2'를 넣고 차이 안내를 30점 대신 25점부터, 안내 글에서 '두 점수를 함께 보세요'(명령형)를 빼 '두 점수 차이가 29점입니다. 평균 하나로는 이 차이가 가려집니다.'. 앱은 종합 숫자를 두 점수보다 작게(20 → 16)·식을 옆에, 화면 읽기 '51과 80을 더해 2로 나눈 값'. 끄면 서버 응답·앱 화면 모두 지금 그대로",
  },
  compositeGapHide: {
    default: true,
    description:
      "종합 숫자 대신 문장 (개선안 [4], 사용자 결정 Q3 ①, 서버만): 두 점수 차이가 30점을 넘으면 종합을 '없음 · 두 점수 차이가 42점이라 평균을 보이지 않습니다'로(인텔 30 + 71 → 51 같은 가운데 숫자 착시를 막음, 예전 앱도 같은 모양으로 그림). 끄면 지금처럼 평균 숫자 + 차이 안내",
  },
  valueFinancialNote: {
    default: true,
    description:
      "금융사 재무 건전성 글 (개선안 [5], 서버 글만, 점수 그대로): 미국 금융사 비교 무리 '대형 은행, 228개 회사' → '은행 · Nasdaq 분류, 228곳 — 그중 186곳은 시가총액 50억 달러 미만', 재무 건전성 묶음 설명 '막대가 길수록: 총자산에 비해 자기자본 여유가 큰 쪽', 묶음 줄에 '자기자본 ÷ 총자산 7.5% · 업종 가운데값 11.1% · 시가총액 500억 달러 넘는 은행 7곳 가운데값 9.3%'와 '감독에 쓰는 자본비율(BIS·CET1)과 다른 단순 비율 — 이 막대 하나로 건전성을 말할 수는 없습니다', 한국은 '은행·보험·증권·카드를 함께 비교'. 끄면 지금 글 그대로",
  },
  valueInsurerNote: {
    default: true,
    description:
      "보험사 재무 건전성 안내 (개선안 [5], 서버 글만, valueFinancialNote 와 함께 켜졌을 때만): 보험사는 '가진 채권·주식의 평가이익(손실)이 자본에 크게 들어 있어 자기자본 ÷ 총자산의 뜻이 은행과 다릅니다'. 끄면 보험사는 금융사 일반 안내('금융사 감독에 쓰는 자본비율과 다른 단순 비율입니다 …')",
  },
  valueReasonDetail: {
    default: true,
    description:
      "점수 없음·대상 아님 이유 글 (개선안 [9], 서버 글만): 버크셔 B '주가 수준을 계산할 재무 숫자가 없습니다' → '이 앱이 이 회사의 주식 수 자료를 읽지 못해 계산하지 않았습니다. 회사 재무에 문제가 있다는 뜻은 아닙니다.', 분기 실적이 4개가 안 되는 한국 회사(삼성에피스홀딩스) '분기 실적이 아직 3개뿐입니다(4개 필요 …)'(하나도 없으면 '아직 없습니다'), 우선주 '보통주 화면의 점수를 참고하세요'(명령형) → '같은 회사 보통주(삼성전자) 화면에 가치 지표 점수가 있습니다'(보통주 재무가 있을 때만). 끄면 지금 글 그대로 (리츠 잘못 분류는 플래그와 상관없이 고침)",
  },
  valueWordingFacts: {
    default: true,
    description:
      "사실과 다른 설명 문장 고침 (개선안 [10], 서버 글만, 점수 그대로): 순손실 회사의 '이익의 현금 뒷받침' 줄 → '순손실 회사라 … 읽지 않습니다. 순손실은 2.39억 달러이고, 영업활동에서도 현금이 0.61억 달러 빠져나갔습니다(순손실보다 적은 금액).'(묶음 머리 문장·두 쪽 문장 대표로 고르지 않음), 초기 단계 표시 → '2021~2025년, 자료가 있는 5년 모두 영업손실입니다'(몇 년인지 코드가 셈), 경기 민감 까닭 '업황에 따라…' → 업종 목록이면 '업황에 따라 이익이 크게 오르내리는 업종이라', 이익률 기준이면 '최근 5년 영업이익률 변동이 커서(가장 낮은 해 −26.7% · 가장 높은 해 31.6%)'(해마다 오르기만·내리기만 했으면 '−26.7%에서 31.6%로 해마다 올라 변동 폭이 커서'), 한국 자본이 아주 작은 회사(부채비율 1,000% 이상) '순자산으로 나누는 PBR·ROE 는 작은 변화에도 크게 바뀝니다'. 끄면 지금 글 그대로",
  },
  valueAiSafeWording: {
    default: true,
    description:
      "AI 가치분석 글 안전하게 (개선안 [8] 중 서버 부분): 새 프롬프트 value_analysis_safe.md('평가하는 애널리스트'·'강점/리스크'·'가치투자 관점 요약' 대신 숫자 사실 정리) + 가치분석 금지어 검사(브리핑 금지어 + 점수 글 금지어 + 가치 판정·시점·권유 말 — 내재가치·저점·고점·바닥·과열·할인된 가격·건전·해자·경쟁력·유리/불리·관심을 가질 필요·Strong Buy 등, 활용형·돌려 말하기 — 쌉니다·싼·비쌉니다·나빠졌·수도 있·들어갈 때입니다·사도 됩니다·편이 낫·매입할·사들일·확률·늘릴 회사·cheap 등, 6차 — 나쁩니다·사셔도 됩니다·사도 무방·사도 문제없·살 시기·살 차례·들어갈 때죠·더 나은 선택·매입 구간·늦지 않, 7차 — 화면에서 같은 문장으로 보이는 변형(두 칸·NBSP·탭·전각 공백, 낱말 하나만 *·**·_·` 강조, '&nbsp;'·'&#49492;' 엔티티·태그·링크·분해해 적은 한글·폭 없는 공백)도 검사용 복사본(강조 표시 빼고 빈칸 한 칸으로)으로 같은 검사, '이익 안정성'·'위험가중자산'·'공정가치로 평가된' 같은 사실 말은 예외. 걸린 줄은 빼고 끝에 '(문장 검사에서 N줄을 뺐습니다)', 전에 만든 글·요청 ID 로 회수하는 상태 확인 경로도 보일 때 검사, 뺀 줄 수는 서버 기록 'AI 가치분석 문장 검사'). 앱 안전망: AI 가치분석 글 바로 위에 'AI가 쓴 글 · 틀릴 수 있음 · 참고 정보이며 투자 권유가 아닙니다' 한 줄(휴대폰·넓은 창·울트라 미리보기 모든 배치, 지표 점수 플래그와 상관없이 — 앱 fallback 켜짐). 끄면 예전 프롬프트·글·화면 그대로",
  },
  briefingTrim: {
    default: true,
    description:
      "브리핑 탭 틀린 문장·되풀이 정리 (브리핑 2차 4, 앱만): 탭 휴장 줄('국내 종목 브리핑 없음' → 맞는 말, 한국 요약이 휴장을 말하면 숨김), 계좌 카드·상세 휴장 줄에 브리핑 날짜, 업종 말을 부호에 맞춤, 계좌 상세 기본 설명 카드 빼기·제목 '보유분·지수·환율', 시장 요약 상세 되풀이 문장 빼기, 설정 알림 설명. 끄면 예전 글 그대로",
  },
  briefingSafeWording: {
    default: true,
    description:
      "종목 브리핑 AI 글 안전하게 (브리핑 2차 6): 새 프롬프트(평가 꼬리표·지지/저항·체크포인트·보유자 해석 없음), 지지·저항 후보를 모델에 넘기지 않음, 요약 첫 줄은 시세로 만든 가격 줄, 금지어 검사, 앱 카드·상세에 'AI가 쓴 글' 표시. 끄면 예전 프롬프트·요약·화면 그대로",
  },
  briefingCompactTop: {
    default: true,
    description: "브리핑 탭 맨 위 두 줄 (브리핑 2차 2, 앱만): 접은 화면의 시장 요약·계좌 카드를 넓은 창 줄 모양 두 줄(계좌 먼저)과 안내 한 줄로, 넓은 창도 계좌 줄을 위로. 끄면 예전 카드 그대로",
  },
  moversMerge: {
    default: true,
    description: "변동 카드 합치기 (브리핑 2차 3, 앱만): '변동 큰 종목' 카드를 없애고 목록 1~3위에 순위, 계좌 카드·줄에 당일 손익 기여 상위 3종목(원화 금액만). 계좌 브리핑이 없거나 실패하면 예전 카드. 끄면 예전 그대로",
  },
  priceAlerts: {
    default: true,
    description:
      "가격·등락률·거래량 알림 (3-29, 앱을 켜 둔 동안): 종목 상세 '알림'에서 조건 저장(표 price_alerts, 백업 포함, 한 종목 5개·모두 30개·거래량 10개), 앱이 앞에 있는 동안 실시간 체결·시세로 확인해 화면 위 알림·진동(설정 '누를 때 진동')·알림 목록 한 줄(소리 없음), 거래량 급증은 서버가 30분봉으로 오늘 정규장 누적을 지난 거래일(최대 20일) 개장 뒤 같은 경과 시간 평균과 견줌. 조건마다 하루 한 번. 끄면 버튼·설정 칸·알림이 없고 /api/price-alerts 는 빈 목록·409, 봉 조회 0 (저장된 조건은 지우지 않음)",
  },
  densityMode: {
    default: true,
    description:
      "잔고 촘촘 모드 (3-39, 앱만): 설정 > 표시 '잔고 표시' 기본/촘촘(기기에 저장). 촘촘이면 휴대폰·접은 화면 잔고 종목 줄 최소 58 → 44dp, 지수 띠 두 줄 칸, 계좌 요약 세 줄(매입금액·국내/해외 숨김, 환율 안내는 추정·현재 환율 환산일 때만, 비중 버튼은 보유 구역 머리로) — 첫 화면 보유 줄(웹 미리보기) 360×752 3 → 9, 폴드8 접은 화면 장전 2 → 8·장중 1 → 7. 넓은 창은 두 줄 계좌 띠만 첫 줄로(표 줄은 이미 44). 화면 읽기 문장 그대로. 끄면 설정 칸이 없고 저장된 값과 상관없이 지금 모양",
  },
  maCustom: {
    default: true,
    description:
      "이동평균선 기간·색 (3-39, 앱만): 선 6개의 기간(2~240)·색(8가지)·보이기를 새 화면 '이동평균선'(차트 칩 '설정'·설정 > 표시)에서 정해 기기에 저장(chartPrefs.maLines.v1), 종목·지수 상세와 전체 화면 차트가 같이 씀. 처음 값은 지금과 같은 5·10·20·60·120·200·같은 색. 끄면 칩 6개(5·10·20·60·120·200) 켜고 끄기·색 그대로이고 저장한 선은 지우지 않음",
  },
  accounts: {
    default: true,
    description:
      "로그인·회원가입 (계정 A단계): 아이디·비밀번호 로그인, 자동 로그인(기본 켬 — 1년 유지·쓸 때마다 연장, 서버가 401 session_invalid 를 줄 때만 로그아웃 · 끄면 12시간·앱을 닫으면 다시 로그인), 회원가입(아이디·비밀번호 2번·이메일), 주인 계정 '서성원'(처음 비밀번호 1111 — 한 번 권유·설정 띠, 서버를 다시 켜도 되돌리지 않음), 비밀번호 변경(다른 기기 로그아웃)·모든 기기에서 로그아웃·이메일 변경. /api/* 는 세션(X-Session-Token)이 있어야 하고(플래그·로그인·가입만 빼고, API 토큰 확인은 그 앞에 그대로), 주인 아닌 계정은 공유 경로 목록(시장·종목 정보 — 보유 정보는 뺌)만 열리고 개인 경로는 빈 값·403 personal_data_not_ready, 관리 경로는 403. API 토큰만으로는 주인 개인 데이터 0 (위젯·푸시 포함 — 주인 세션만). 끄면(비상 모드) 로그인 화면이 없고 /api/auth/* 는 404 — 계정 전과 같음(세션 머리글이 없으면 API 토큰 = 주인). 막는 것은 주인 아닌 계정의 세션을 보낸 요청뿐(로그아웃·다시 설치한 가입자 폰·API 토큰을 꺼낸 사람은 못 막음 → 가입자가 있으면 끄기 전에 API_TOKEN 을 바꾸고 새 값은 주인 폰에만). 비상 끄기: Railway 변수 ACCOUNTS_DISABLED=1",
  },
  chartHighLow: {
    default: true,
    description:
      "차트 최고·최저가 표시 (3-46, 앱만): 종목 상세(휴대폰·넓은 창)·지수 상세·전체 화면 차트의 보이는 구간 가장 높은 고가에 빨간 ↓와 '255,000원 (-22.3%, 26.07.27)', 가장 낮은 저가에 파란 ↑와 '181,100원 (+9.3%, 26.07.14)'(% = 현재가가 그 값보다 몇 % 높은지·낮은지, 소수 한 자리 버림), 드래그·확대하면 보이는 봉으로 다시 계산, 가격 축 위아래에 글자 자리 여백. 설정 > 표시 '차트 최고·최저가 표시'(기본 켬, 기기에 저장 settings.chartHighLow). 끄면 설정 줄이 없고 차트는 지금 그대로",
  },
  notifBack: {
    default: true,
    description:
      "브리핑 알림 뒤로 가기 (브리핑 3차 1, 앱만): 계좌·묶음·종목 브리핑 알림을 누르면 브리핑 탭으로 바꾼 뒤 그 브리핑을 열어 '뒤로'가 브리핑 탭(지금은 콜드 스타트면 잔고 탭). 앱을 쓰던 중이면 쌓인 화면(종목 상세 등)은 닫힘, 입력 중 화면(잔고 수정·종목 검색·이동평균선·첫 실행 안내) 위면 지금처럼 위에 쌓기만. 펼친 가로 2단은 새 화면 없이 오른쪽 칸에서 그 브리핑을 고름(묶음 알림은 시장 요약). 가격 알림·위젯은 그대로. 끄면 지금 그대로",
  },
  briefingStatus: {
    default: true,
    description:
      "브리핑 늦음·실패 안내 (브리핑 3차 2): 브리핑 탭 맨 위(2단은 왼쪽 목록 맨 위, 카드 격자는 목록 위)에 오늘 예약 시각이 지난 가장 최근 회차가 늦었는지(완료가 예약 + 20분 뒤)·일부/모두 못 만들었는지(못 만든 종목 이름 5개까지 — 누르면 그 브리핑, 2단은 오른쪽 칸)·실행되지 않았는지(예약 + 45분, 서버가 예약 뒤에 켜졌으면 + 5분)·20분 넘게 만드는 중인지 차분한 안내 한 덩어리(문제가 없으면 안 보임). 이유는 오류 원문 대신 쉬운 말(붐빔·장애·설정·끝까지 못 씀·그 밖·서버 다시 시작), 실패 브리핑 카드·목록 줄·상세도 쉬운 말. 실행이 끝날 때 meta briefing_run_log 에 한 줄(최근 20건), GET /api/briefings/status. '잠시 뒤 다시 만들어집니다'는 쓰지 않음(스케줄러가 다시 만들지 않음). 끄면 예전 '최근 실행에서 N개 종목이 실패했습니다 + 오류 원문' 안내, 경로 404, 실행 기록을 쓰지 않고, 실패 브리핑 글은 원문",
  },
  accountSinceLast: {
    default: true,
    description:
      "지난 브리핑과 비교 (브리핑 3차 3): 계좌 브리핑을 만들 때 보유 종목별 수량·원화 평가(data.positions)를 더 저장하고, 같은 세션(오전↔오전·오후↔오후)의 날짜가 앞선 성공한 계좌 브리핑 중 가장 최근(10일 안)과 비교해 저장(data.sinceLast — 총 평가금액·평가손익 변화, 새·없어진·수량 늘어남/줄어듦 종목, 비중 변화 0.5%p 이상 큰 순 3개, 목록 headline.since). 한쪽 브리핑 합계에서만 빠진 종목(시세·환율을 받지 못함)은 금액·비중 비교에서 양쪽 모두 빼고(카드에 밝힘, 한 줄에 'N종목 빼고 비교'), 종목별 값이 없어 뺄 수 없으면 카드에만 설명과 함께 보이고 목록 한 줄은 싣지 않음. 앱은 계좌 상세 '지난 오전 브리핑과 비교' 카드와 브리핑 탭 계좌 카드·줄의 '9/25(금) 오전보다 총 평가 …' 한 줄(2단 계좌 줄에는 없음). 두 브리핑에 저장된 숫자끼리 비교 — 매매 기록(체결)과 맞춘 '샀음/팔았음'은 아님. 끄면 두 칸을 저장하지 않고 지난 브리핑을 찾지 않으며 화면이 지금 그대로",
  },
  accountExposure: {
    default: true,
    description:
      "비중 한 줄 (브리핑 3차 4): 계좌 브리핑을 만들 때 가장 큰 종목·상위 3종목(4종목 이상)·레버리지·인버스 상품·미국 상장 종목의 비중(보유 종목 원화 평가금액 기준, 비용 차감, 현금 제외, 소수 한 자리 — 여럿의 합은 원 값을 더한 뒤 반올림)을 계산해 저장(data.exposure — 그때 기준 그대로, 기준 시각 = 브리핑 asOf). 레버리지·인버스 가리기는 지표 점수 1단계와 같은 규칙(토스 웹 상품 정보 → 종목 마스터 분류 → 정적 표 → 이름 규칙, 공용 productKindOf) · 상품 정보는 종목마다 최대 8초·동시에 4개(시세와 같은 24시간 캐시라 대부분 새 호출 없음), 받지 못하면 표·이름 규칙으로 가리고 그 수를 guessedByName 으로. 시세가 없어 합계에서 뺀 종목은 비중에 없고 excluded 로 셈. 앱은 계좌 상세 총 평가 카드(폰)·총 평가 띠(2단 오른쪽 칸·넓은 창)에 '비중 · 가장 큰 종목 … · 상위 3종목 … · 레버리지·인버스 … · 미국 상장 …' + '레버리지·인버스: SOXL(3배) · … · 보유 종목 평가금액 기준, 현금 제외 · 08:38 기준' 두 줄(판단하는 말·색 없음). 브리핑 탭 카드·줄에는 넣지 않음. 끄면 칸을 저장하지 않고 상품 정보를 부르지 않으며 화면이 지금 그대로",
  },
  holdingEvents: {
    default: true,
    description:
      "다가오는 일정 (브리핑 3차 5): 계좌 브리핑을 만들 때 보유 종목의 30일 안 배당락일(토스 웹 배당 요약 — 회사가 발표한 앞날 날짜, 미국은 네이버 배당락일과 맞춰 다르면 빼고 로그, 토스를 받지 못하면 미국은 네이버 날짜만)을 받아 저장(data.events — 그때 기준 그대로), 그 주 첫 오전 계좌 브리핑이면 이번 주(브리핑 날짜 ~ 일요일) 일정도(목록 headline.week). 모두 합쳐 최대 20초(배당 요약 12시간·캘린더 6시간 캐시, 못 받으면 24시간 안 캐시, 그것도 없으면 '받지 못함'으로 밝힘 — 계좌 브리핑·알림을 늦추지 않게). 한국 종목 배당은 보통 기준일 뒤에 정해져 앞날 날짜가 거의 없음(토스에 있을 때만). 앱은 계좌 상세 '오늘 일정' 아래 '다가오는 일정' 카드, 브리핑 탭 계좌 카드·줄의 '이번 주 일정 · …' 한 줄(2단 계좌 줄에는 없음). /health 에 holdingEvents(마지막으로 모두 받은 시각·경고). 끄면 칸을 저장하지 않고 배당·캘린더·네이버 호출 0, 화면이 지금 그대로",
  },
  holdingEarnings: {
    // 로드맵 3-38 '미국 실적 예정일은 제출된 공시만' 규칙과 부딪혀 사용자 승인 뒤 켬 (설계 '브리핑 3차 5' 사용자에게 여쭐 것 1)
    default: false,
    description:
      "다가오는 일정에 실적 발표일 넣기 (브리핑 3차 5, holdingEvents 가 켜져 있을 때만 뜻이 있음, 기본 꺼짐 — 사용자 승인 뒤 켬): 토스증권 공개 캘린더(로그인 없음, 큰 종목만 — 회사가 확정하기 전 날짜가 섞일 수 있어 '예정')에서 보유 종목의 실적 발표일·토스가 준 한국 시각 글('오전 5시 이후', 한국 종목은 날짜만)을 창이 걸친 달(보통 두 달)마다 받아 넣음. 한 달이라도 받지 못하면 실적 줄을 모두 빼고 '실적 발표일을 받지 못했습니다'. 끄면 캘린더 호출 0이고 배당락일만",
  },
  // 사용자 결정 2026-09-28 '토스 앱만 열기' → 기본 켬 (웹 주소는 휴대폰에서 'PC로 접속해주세요' 막다른 화면이라 버림)
  tossOpen: {
    default: true,
    description:
      "종목 상세 '토스 앱 열기' (3-48, 앱만, 사용자 결정 '토스 앱만 열기'): '시세' 칸 제목 줄 오른쪽 버튼 → 안내 시트('토스 앱 → 증권 → 검색에서 \"종목명\"(코드)을 찾아 주세요. 주문은 토스 앱에서 직접 합니다.') → [토스 앱 열기]가 토스 앱 자체를 연다(supertoss:// — 종목 화면으로 바로 가지 않음, 종목은 사용자가 토스 앱에서 검색). 못 열면 시트에 안내 + Play 스토어 토스 앱 페이지. 주문·로그인 API·서버 호출 없음, 웹 주소 없음. 이름이 있는 종목 모두(지수·환율 제외). 끄면 버튼이 없음",
  },
  numberBasis: {
    default: true,
    description:
      "숫자 기준·토스 대조 배지 (3-32): 잔고 계좌 합계 옆 점과 짧은 글(토스와 0.1% 이내·차이 N%·수량 다름·대기), 누르면 '숫자 기준' 창(시세 기준·시각·비용 차감·환율·당일손익·토스 대조·최근 7일 장중 비율), 대조 기록 뒤 실시간 연결로 앱에 알림(reconcile). 잔고·자산 위젯 기준 시각 뒤 '· NXT·주간거래 포함'(자리가 남을 때만, /api/widget &ms=1 응답에 종목 기준 b), 브리핑 탭 계좌 카드·줄 'HH:MM 기준', 계좌 브리핑 상세 '시세 기준' 줄(새 브리핑에 quoteBasis 저장). 끄면 모두 예전 그대로",
  },
  flowTab: {
    default: true,
    description:
      "종목 상세 '수급' 탭 (3-33): 한국 종목의 개인·외국인·기관·기타법인 순매수(산 주식 수 − 판 주식 수) 5·20·60일 합계와 날마다 막대(20일 기본), 외국인 보유율 60일 추이·5·20·60일 전과 %p 차이·한도 종목의 한도 소진율. 자료는 토스증권 웹 공개 자료(KRX+NXT 합산, 로그인 없음) → 막히면 네이버 증권(KRX만, 화면에 기준을 밝힘), 메모리 캐시(평일 장 시간 10분·그 밖 60분), 저장 없음. 오늘 값은 저녁(20:30) 확정 전까지 잠정으로만 보이고 합계에 넣지 않음. 토스 Open API 키가 있으면 종목마다 12시간에 한 번 최근 20일을 대조해 개수만 표시(원자료는 관리 경로 GET /api/admin/investor-flow/check). 미국 종목은 '해당 없음'. 새 경로 GET /api/investor-flow/:code(공용). 끄면 탭이 없고 경로 404, 토스 웹·네이버·Open API 수급 호출 0 — 화면이 지금과 한 글자도 같음",
  },
  holdingThemes: {
    default: true,
    description:
      "내 종목 테마 (3-35 1단계, 사실만): 보유 종목을 발견 탭과 같은 테마·업종에 묶고(미국 = 토스 '주요 사업' 테마 중 미국 테마북에 있는 것 → 없으면 네이버 업종, 한국 = 네이버 테마를 주 1회 거꾸로 찾는 표 → 없으면 업종, 레버리지 단일 종목은 기초 종목으로, 반도체 지수 상품은 미국 업종 '반도체', 지수 전체 상품은 묶지 않음) 묶음마다 오늘·1주 등락률·오른/내린/보합 수(발견 탭 값 그대로)·거래대금 평소(최근 20거래일, 이 앱이 장 마감 뒤 기록 — 배포 뒤 5거래일부터)의 몇 %·든 내 종목과 정규장 등락률, 계좌 한 줄 '내 종목이 많이 속한 테마'. GET /api/holdings/themes, 잔고 탭 '테마' 버튼 → '내 종목 테마' 화면, 계좌 브리핑 상세 카드(만들 때 저장 data.holdingThemes, 최대 8초). 예약: 한국 테마 표 일요일 05:40 KST, 거래대금 기록 한국 평일 20:10 KST · 미국 평일 16:15 뉴욕. 끄면 버튼·화면·카드가 없고 경로 404, 예약이 돌아도 요청·계산·저장 0건, 계좌 브리핑에 칸 없음, /health 응답 예전과 같음(모은 기록은 지우지 않음)",
  },
  filingAlerts: {
    default: true,
    description:
      "새 공시 알림 (3-38): 보유 미국 종목(ETF·ETN 제외)의 SEC EDGAR 새 공시(8-K·10-Q·10-K·6-K·20-F·40-F와 정정 — 공식 submissions API, 로그인·키 없음)를 서버가 5분마다(미국 동부 평일 06:00~22:59, 요청 사이 160ms) 확인해 표 sec_filings 에 저장(처음 보는 종목은 기준 잡기 — 알리지 않음, 접수 24시간 넘은 것도 알리지 않음, 90일 보관). 제목은 서식·8-K 항목 번호를 우리말로 옮긴 것('실적 발표(8-K 2.02)'). GET /api/filings/alerts, /api/widget &ms=1 응답에 새 알림 접수 번호(filingIds — 있을 때만), /health 에 filingAlerts. 앱은 백그라운드 확인(15분)·앱이 앞에 있을 때(5분)에 알림 1건(채널 '공시 알림', 조용한 시간이면 끝난 뒤, 종목별 알림에서 끈 종목·이 기기 '공시 알림' 끔은 알리지 않음), 설정 > 알림 '공시 알림' 줄, '일정·공시' 화면의 '최근 공시 (미국)'. 한국 공시(DART)는 키 뒤. 끄면 SEC 확인 호출 0, 경로 404, 위젯 응답·/health 가 예전과 같고 앱 알림·설정 줄·화면 칸 없음(받아 둔 표는 지우지 않음)",
  },
  holdingSchedule: {
    default: true,
    description:
      "일정·공시 화면 (3-38): 계좌 브리핑 상세 '다가오는 일정' 카드(없으면 '오늘 일정' 카드) 맨 아래 '일정·공시 모두 보기' → /schedule 화면 — 30일 안 배당락일(다가오는 일정과 같은 출처·캐시, 열 때 받음 · 실적 발표일은 holdingEarnings 를 읽기만) + 최근 30일 미국 공시(filingAlerts 가 켜져 있을 때) + 한국 공시 안내(DART 키 뒤). GET /api/schedule. 끄면 줄 없음(카드가 지금과 같음), 경로 404, 화면은 '지금은 볼 수 없습니다' 한 줄",
  },
  // 앱에 켜고 끄는 화면이 없어 꺼 두면 보이지 않음 → 기본 켬 (3-44 와 같은 결정, 2026-09-28). 끄기: PUT /api/admin/features {"tradeJournal": false}
  tradeJournal: {
    default: true,
    description:
      "매매일지 (3-37): 설정·잔고 계좌 칸·종목 상세에서 여는 '매매일지'(기록 — 체결 목록·이동평균법 실현손익·거래 메모, 수익률 — 스냅샷 시간가중 수익률(10거래일 뒤), 양도세 추정 탭은 따로 journalTax). 새 표 trade_notes·fx_rates. tradeRecords 가 꺼져 있으면 꺼진 것으로 봄. 끄면 입구·화면 없음, /api/journal* 빈 값·쓰기 409, 환율 받기 0건",
  },
  // 양도세 추정은 틀린 숫자의 해가 가장 커서(세금 신고로 이어질 수 있음) 기본 끔 — 토스 표본 대조·분사 모양 확인 뒤 켠다. 켜기: PUT /api/admin/features {"journalTax": true}
  journalTax: {
    default: false,
    description:
      "매매일지 '양도세 추정' 탭 (3-37, tradeJournal 이 켜져 있을 때만 뜻이 있음, 기본 끔): 해외주식 결제일 기준환율(서울외국환중개 매매기준율, 못 받으면 하나은행 고시)·22%·250만 원 공제로 계산한 참고용 추정, 매매기준율 배경 받기. 끄면 탭·화면·합계가 없고 /api/journal/tax 는 { enabled: false }, 매매기준율·하나은행 요청 0건 — 기록(매도별 실현손익·'확인 필요' 표시)·수익률은 그대로",
  },
  watchGroups: {
    default: true,
    description:
      "관심 종목 그룹·순서 (3-34): 잔고 탭 '관심' 칸(수량 없는 등록 종목)만 — 관심 탭의 별도 관심종목(watch_items, watchlistSteps)은 건드리지 않음. 잔고 관심 칸 칩(전체·그룹·그룹 없음)·그룹 머리 접기·'관심 그룹·순서' 화면(만들기·이름·지우기·끌기·↑↓), 관심 줄 메뉴 '그룹 옮기기·위로·아래로'. 서버 /api/watch-groups (표 watch_groups + registered_stocks 칸 watch_group_id·watch_position). 끄면 앱이 부르지 않고 잔고가 지금 그대로(관심은 등록순), 서버 GET 빈 값·쓰기 409, 저장값은 지우지 않음",
  },
} as const satisfies Record<string, { default: boolean; description: string }>;

export type FeatureKey = keyof typeof FEATURES;
export const FEATURE_KEYS = Object.keys(FEATURES) as FeatureKey[];

/** 값을 한 번도 읽지 못했을 때 켜짐으로 보는 플래그 — 켜짐이 '막는 쪽'인 보안 관문 (계정: 꺼지면 API 토큰만으로 주인 데이터가 열린다) */
export const FAIL_ON: ReadonlySet<FeatureKey> = new Set<FeatureKey>(["accounts"]);
export const FEATURES_META_KEY = "features";

interface Stored {
  overrides: Partial<Record<FeatureKey, boolean>>;
  updatedAt: string | null;
}

/** 서버 캐시 유지 시간: 여러 인스턴스·DB 직접 수정도 앱 반영 기준(60초) 안에 따라가게 */
const CACHE_MS = 30_000;

export class FeatureService {
  private cache: { at: number; stored: Stored } | null = null;
  /** 바꾸기는 한 줄로 (읽고-고쳐-쓰기 사이에 다른 변경이 사라지지 않게) */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly changeListeners = new Set<() => void>();

  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
    /** 저장된 값과 상관없이 꺼짐으로 보는 플래그 (비상 끄기 — 계정 ACCOUNTS_DISABLED=1). 앱에도 꺼짐으로 준다 */
    private readonly forcedOff: ReadonlySet<FeatureKey> = new Set(),
  ) {}

  private async load(): Promise<Stored> {
    if (this.cache && this.now().getTime() - this.cache.at < CACHE_MS) return this.cache.stored;
    const row = await this.db.selectFrom("meta").select("value").where("key", "=", FEATURES_META_KEY).executeTakeFirst();
    let stored: Stored = { overrides: {}, updatedAt: null };
    if (row) {
      try {
        const v = JSON.parse(row.value) as Partial<Stored>;
        const overrides: Stored["overrides"] = {};
        // 지운 플래그의 옛 값은 버린다
        for (const k of FEATURE_KEYS) if (typeof v.overrides?.[k] === "boolean") overrides[k] = v.overrides[k];
        stored = { overrides, updatedAt: typeof v.updatedAt === "string" ? v.updatedAt : null };
      } catch {
        /* 깨진 값은 기본값으로 */
      }
    }
    this.cache = { at: this.now().getTime(), stored };
    return stored;
  }

  /** 앱에 주는 값: 모든 플래그의 현재 상태 */
  async all(): Promise<{ features: Record<FeatureKey, boolean>; updatedAt: string | null }> {
    const s = await this.load();
    const features = {} as Record<FeatureKey, boolean>;
    for (const k of FEATURE_KEYS) features[k] = !this.forcedOff.has(k) && (s.overrides[k] ?? FEATURES[k].default);
    return { features, updatedAt: s.updatedAt };
  }

  /**
   * DB 를 못 읽으면 마지막 값, 그것도 없으면 꺼짐 (끄기 스위치가 오류로 다시 켜지지 않게, 앱과 같은 쪽으로).
   * 보안 관문(FAIL_ON — 계정)만은 켜짐: 서버를 막 켰는데 읽기가 실패해도 'API 토큰 = 주인'으로 열리지 않게 (끄려면 비상 끄기 ACCOUNTS_DISABLED)
   */
  async enabled(key: FeatureKey): Promise<boolean> {
    if (this.forcedOff.has(key)) return false;
    const s = await this.load().catch(() => this.cache?.stored ?? null);
    if (!s) return FAIL_ON.has(key);
    return s.overrides[key] ?? FEATURES[key].default;
  }

  /** 관리 화면용: 기본값·설명·바꾼 값까지 */
  async detail(): Promise<Array<{ key: FeatureKey; enabled: boolean; default: boolean; overridden: boolean; description: string }>> {
    const s = await this.load();
    return FEATURE_KEYS.map((k) => ({ key: k, enabled: !this.forcedOff.has(k) && (s.overrides[k] ?? FEATURES[k].default), default: FEATURES[k].default, overridden: k in s.overrides, description: FEATURES[k].description }));
  }

  /** true/false 로 바꾸고, null 이면 기본값으로 되돌린다. 모르는 키는 거절 */
  set(patch: Record<string, boolean | null>): Promise<{ features: Record<FeatureKey, boolean>; updatedAt: string | null }> {
    const unknown = Object.keys(patch).filter((k) => !(FEATURE_KEYS as string[]).includes(k));
    if (unknown.length) return Promise.reject(new UnknownFeatureError(unknown));
    const run = this.queue.then(() => this.setNow(patch));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async setNow(patch: Record<string, boolean | null>): Promise<{ features: Record<FeatureKey, boolean>; updatedAt: string | null }> {
    this.cache = null; // 다른 인스턴스가 바꾼 값 위에 쓴다
    const s = await this.load();
    const overrides = { ...s.overrides };
    for (const [k, v] of Object.entries(patch) as Array<[FeatureKey, boolean | null]>) {
      if (v === null) delete overrides[k];
      else overrides[k] = v;
    }
    const next: Stored = { overrides, updatedAt: seoulIso(this.now()) };
    const value = JSON.stringify(next);
    await this.db.insertInto("meta").values({ key: FEATURES_META_KEY, value }).onConflict((oc) => oc.column("key").doUpdateSet({ value })).execute();
    this.cache = { at: this.now().getTime(), stored: next };
    for (const fn of this.changeListeners) {
      try {
        fn();
      } catch {
        /* 알림 실패는 바꾸기를 막지 않는다 */
      }
    }
    return this.all();
  }

  /** 플래그를 바꾼 뒤(이 서버에서) 부른다 — 계정 A단계 검증 6차: 비상 모드 → 보통 모드가 되면 세션 없이 연 실시간 스트림을 바로 닫게 */
  onChange(fn: () => void): () => void {
    this.changeListeners.add(fn);
    return () => this.changeListeners.delete(fn);
  }
}

export class UnknownFeatureError extends Error {
  constructor(public readonly keys: string[]) {
    super(`모르는 기능 플래그: ${keys.join(", ")}`);
    this.name = "UnknownFeatureError";
  }
}
