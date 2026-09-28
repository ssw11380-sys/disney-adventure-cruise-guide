import type { Db } from "../db/index.js";
import { seoulIso } from "../lib/time.js";

/**
 * 기능 켜고 끄기 (3-15). 플래그 목록은 여기 한 곳에만 둔다.
 *  - 기본값은 코드에, 바꾼 값만 meta(features)에 저장 → 관리 API 로 바꾸면 재배포 없이 반영 (앱은 60초마다 /api/features 를 받는다)
 *  - 기능 하나에 플래그 하나. 완전히 켠 뒤 한 달이 지나면 플래그를 지우고 코드에 합친다
 *  - 새 기능(3-19·3-24 의 새 동작, P2 전부)은 플래그 뒤에 둔다
 */
export const FEATURES = {
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
} as const satisfies Record<string, { default: boolean; description: string }>;

export type FeatureKey = keyof typeof FEATURES;
export const FEATURE_KEYS = Object.keys(FEATURES) as FeatureKey[];
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

  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
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
    for (const k of FEATURE_KEYS) features[k] = s.overrides[k] ?? FEATURES[k].default;
    return { features, updatedAt: s.updatedAt };
  }

  /** DB 를 못 읽으면 마지막 값, 그것도 없으면 꺼짐 (끄기 스위치가 오류로 다시 켜지지 않게, 앱과 같은 쪽으로) */
  async enabled(key: FeatureKey): Promise<boolean> {
    const s = await this.load().catch(() => this.cache?.stored ?? null);
    if (!s) return false;
    return s.overrides[key] ?? FEATURES[key].default;
  }

  /** 관리 화면용: 기본값·설명·바꾼 값까지 */
  async detail(): Promise<Array<{ key: FeatureKey; enabled: boolean; default: boolean; overridden: boolean; description: string }>> {
    const s = await this.load();
    return FEATURE_KEYS.map((k) => ({ key: k, enabled: s.overrides[k] ?? FEATURES[k].default, default: FEATURES[k].default, overridden: k in s.overrides, description: FEATURES[k].description }));
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
    return this.all();
  }
}

export class UnknownFeatureError extends Error {
  constructor(public readonly keys: string[]) {
    super(`모르는 기능 플래그: ${keys.join(", ")}`);
    this.name = "UnknownFeatureError";
  }
}
