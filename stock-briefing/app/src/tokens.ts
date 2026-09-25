/**
 * 디자인 토큰 (3-20). 색·간격·글자 크기는 여기에만 있다 — 화면 코드는 숫자·hex 를 직접 쓰지 않는다(eslint 로 막음).
 * React Native 를 불러오지 않는 순수 모듈 (테스트·위젯에서 씀). 훅(useTheme)은 theme.ts.
 * 규칙은 docs/디자인-규칙.md. 대비·색 차이는 test/tokens.test.ts 가 지킨다:
 *  - 글자/바탕 조합 대비 4.5 이상 (라이트·다크 모두)
 *  - 강조색·보조선·실시간 점·경고·오류색은 상승·하락색과 ΔE2000 20 이상 (등락으로 읽히지 않게)
 *  - 가격 영역에 함께 그리는 선(이동평균·볼린저·평단)끼리 ΔE2000 15 이상
 *  - 비중 원 차트 조각 색: 등락색과 ΔE2000 20 이상, 바탕에서 3:1 이상, 모든 쌍 ΔE2000 15 이상, 닿는 조각끼리 색약 시뮬레이션에서도 구분
 */

export interface ChartColors {
  /** 이동평균선: 기간 → 색 */
  ma: Record<number, string>;
  rsi: string;
  macd: string;
  signal: string;
  /** 볼린저 밴드 선·면 */
  band: string;
  /**
   * 비중 원 차트 조각 색 (비중 보기). 앞에서부터 차례로 쓰고 순서를 바꾸지 않는다 (국내·원화 = 0번, 해외·달러 = 1번).
   * 빨강·파랑 계열은 등락으로 읽히므로 뺐다. 원이라 마지막 조각이 첫 조각과 닿으므로 첫 색은 모든 색과 멀다
   */
  pie: string[];
  /** 8번째 조각부터와 '기타' (회색) */
  pieOther: string;
}

export interface Theme {
  dark: boolean;
  bg: string; // 화면 바탕
  surface: string; // 패널
  surfaceAlt: string; // 표 머리·눌림·입력칸
  /** 넓은 잔고 표의 줄무늬 (짝수 줄 바탕, 3-42). surface 와 번갈아 칠해 줄을 눈으로 따라가게 한다 */
  zebra: string;
  /**
   * 넓은 잔고 표에서 누른 줄의 바탕 (3-42). surfaceAlt 는 줄무늬(zebra)와 거의 같은 색이라 줄무늬 줄을 눌러도 표시가 안 보여
   * 따로 둔다 — 줄무늬·바탕과 ΔE2000 3 이상 다르면서 그 위의 숫자·등락 글자는 4.5 이상 (test/tokens).
   * 라이트는 강조색(청록) 쪽으로 살짝 물들였다: 회색만으로는 글자 대비 4.5 를 지키면서 아주 밝은 줄무늬와 구분되게 할 수 없다
   */
  rowPressed: string;
  line: string; // 구분선
  lineStrong: string;
  ink: string;
  sub: string; // 보조 글자(값 옆 단위 등)
  muted: string; // 흐린 글자(설명·시각)
  accent: string; // 선택·링크·버튼 (등락색과 다른 청록)
  accentInk: string; // accent 위 글자
  gold: string; // 내 평단·보유
  heroFrom: string;
  heroTo: string;
  heroInk: string;
  heroMuted: string;
  up: string; // 상승 (글자·선)
  upBg: string;
  down: string; // 하락
  downBg: string;
  /** 등락률 상자처럼 색을 칠한 칸 (흰 글자가 4.5 이상 읽히는 진한 색) */
  upFill: string;
  downFill: string;
  onFill: string;
  /** 실시간·장중 표시 (등락색과 겹치지 않는 초록) */
  live: string;
  warn: string;
  /** 오류 (상승 빨강과 헷갈리지 않게 다크는 주황, 라이트는 자주) */
  danger: string;
  code: string;
  shadow: string;
  /** 모달 뒤 어둡게 */
  scrim: string;
  /** 밝은 칸 위 어두운 글자 (히트맵 타일) */
  inkOnLight: string;
  chart: ChartColors;
}

export const dark: Theme = {
  dark: true,
  bg: "#0B0D11",
  surface: "#12151B",
  surfaceAlt: "#1A1E26",
  zebra: "#161A21",
  rowPressed: "#20252E",
  line: "#20252E",
  lineStrong: "#2C323D",
  ink: "#E8EAED",
  sub: "#B4BAC4",
  muted: "#8A919D",
  accent: "#14B8A6",
  accentInk: "#0B0D11",
  gold: "#E3B341",
  heroFrom: "#12151B",
  heroTo: "#12151B",
  heroInk: "#E8EAED",
  heroMuted: "#8A919D",
  up: "#FF4B55",
  upBg: "rgba(255,75,85,0.14)",
  down: "#3D8EFF",
  downBg: "rgba(61,142,255,0.14)",
  upFill: "#D32F3A",
  downFill: "#2A68D0",
  onFill: "#FFFFFF",
  live: "#3FB950",
  warn: "#E3B341",
  danger: "#F97316",
  code: "#0F1217",
  shadow: "#000000",
  scrim: "rgba(0,0,0,0.55)",
  inkOnLight: "#111418",
  chart: {
    ma: { 5: "#22C55E", 10: "#5FC4DD", 20: "#E88C30", 60: "#D742D7", 120: "#7051EC", 200: "#9CA3AF" },
    rsi: "#D742D7",
    macd: "#14B8A6",
    signal: "#E88C30",
    band: "#14B8A6",
    // 보라 · 청록 · 갈색 주황 · 연보라 · 황토 · 자주 · 초록 (라이트와 같은 색상, 어두운 바탕용 밝기 OKLCH L 0.55~0.65)
    pie: ["#AD2CF1", "#049886", "#9A6418", "#A87ABD", "#A48E36", "#C33887", "#3B9423"],
    pieOther: "#8A919D",
  },
};

export const light: Theme = {
  dark: false,
  bg: "#EEF0F3",
  surface: "#FFFFFF",
  surfaceAlt: "#F5F6F8",
  zebra: "#F7F8FA",
  rowPressed: "#E8F0F0",
  line: "#E4E7EB",
  lineStrong: "#D3D7DD",
  ink: "#15181D",
  sub: "#454B55",
  muted: "#646B77",
  accent: "#0F766E",
  accentInk: "#FFFFFF",
  gold: "#87650A",
  heroFrom: "#FFFFFF",
  heroTo: "#FFFFFF",
  heroInk: "#15181D",
  heroMuted: "#646B77",
  up: "#D11A22",
  upBg: "rgba(209,26,34,0.08)",
  down: "#1E62E6",
  downBg: "rgba(30,98,230,0.08)",
  upFill: "#D11A22",
  downFill: "#1E62E6",
  onFill: "#FFFFFF",
  live: "#16762F",
  warn: "#8F5E0F",
  danger: "#9D174D",
  code: "#F5F6F8",
  shadow: "#000000",
  scrim: "rgba(0,0,0,0.45)",
  inkOnLight: "#111418",
  chart: {
    ma: { 5: "#15803D", 10: "#098DAE", 20: "#868613", 60: "#7A1F7A", 120: "#9F0CE9", 200: "#78716C" },
    rsi: "#7A1F7A",
    macd: "#0F766E",
    signal: "#868613",
    band: "#0F766E",
    // 보라 · 청록 · 주황 · 자홍 · 황토 · 자주 · 초록
    pie: ["#68279C", "#007E68", "#C27405", "#D041EE", "#846801", "#B65790", "#3B9B20"],
    pieOther: "#646B77",
  },
};

/**
 * 등락 색 (0 이면 기본 글자색). 값의 단위(원·달러·%)를 모르므로 반올림하지 않는다 —
 * 표기가 0 으로 보이는 값은 부르는 쪽이 format 의 shownSign 으로 0 을 넘긴다 (BH-38)
 */
export function changeColor(t: Theme, v: number | null | undefined): string {
  if (v === null || v === undefined || v === 0 || !Number.isFinite(v)) return t.ink;
  return v > 0 ? t.up : t.down;
}

/**
 * 같은 색의 완전히 투명한 값 (#RRGGBB → #RRGGBB00). 가장자리를 바탕색에서 투명으로 흐리게 칠할 때(그러데이션) 쓴다 —
 * 'transparent'(투명한 검정)에서 칠하면 라이트 테마에서 가운데가 회색으로 비친다. #RRGGBB 가 아니면 'transparent'
 */
export function clearOf(color: string): string {
  return /^#[0-9A-Fa-f]{6}$/.test(color) ? `${color}00` : "transparent";
}

/** 간격 7단계. 이 밖의 값은 쓰지 않는다 (0 은 허용) */
export const space = { xxs: 2, xs: 4, s: 6, sm: 8, md: 12, lg: 14, xl: 20 } as const;
export const radius = { sm: 4, md: 6, lg: 8 } as const;
/** 글자 크기 6단계 (위젯은 widgets/palette.ts 의 따로 정한 크기) */
export const font = {
  hero: 28,
  title: 20,
  h2: 16,
  body: 14,
  small: 12,
  tiny: 11,
} as const;

/** 누르는 요소의 최소 크기 (3-22): 보이는 높이 + hitSlop 이 44 이상 */
export const touch = { min: 44 } as const;

/** 보이는 높이가 h 인 요소를 위아래로 넓혀 44 로 맞추는 hitSlop. 좌우는 side (이웃과 겹치지 않게 간격의 절반 이하) */
export function slopFor(h: number, side = 0): { top: number; bottom: number; left: number; right: number } {
  const v = Math.max(0, Math.ceil((touch.min - h) / 2));
  return { top: v, bottom: v, left: side, right: side };
}

/**
 * 시스템 글자 크기 확대 상한 (3-22). 본문은 상한 없이 200% 까지 커진다.
 *  - row: 고정 폭 열이 있는 종목 줄·표 (숫자가 잘리지 않게 이 이상은 줄이 아니라 열 폭으로 받는다)
 *  - chrome: 탭 바·화면 머리 (높이를 글자에 맞춰 늘리되 화면을 다 먹지 않게)
 */
export const fontCap = { row: 1.4, chrome: 1.5 } as const;

/**
 * 넓은 창 배치 기준 (3-42 접는 폰, 기능 플래그 foldLayout). 단위는 모두 dp.
 * ※ 추정값: 폴드8·울트라의 창 크기(삼성 공식 해상도 ÷ 420dpi)로 정했고 폰 실측 전이다.
 *   사용자가 설정 '화면 정보'로 보낸 실제 값을 받으면 여기 숫자만 바꾼다 (화면 코드는 이 이름만 쓴다).
 * 추정 창 크기: 폴드8 접힘 475×751 · 펼침 가로 933×704 · 펼침 세로 704×933 / 울트라 접힘 411×960 · 펼침 세로 859×954 · 펼침 가로 954×859
 */
export const layout = {
  /** 폭 등급 '중간'의 시작 (안드로이드 창 크기 등급과 같음). 이보다 좁으면 '좁음' = 지금 휴대폰 화면 */
  mediumMin: 600,
  /** 폭 등급 '넓음'의 시작 (안드로이드 창 크기 등급과 같음) */
  expandedMin: 840,
  /** 2단(왼쪽 목록 + 오른쪽 상세)을 켜는 창 폭 (글자 100% 기준) */
  twoPaneMin: 840,
  /**
   * 2단을 끄는 창 폭. 켤 때보다 24dp 낮게 두어, 팝업 창·화면 분할을 끌어 크기를 바꿀 때
   * 기준선 근처에서 2단과 1단이 번갈아 깜빡이지 않게 한다 (히스테리시스)
   */
  twoPaneExit: 816,
  /** 2단 왼쪽 목록 폭 (글자 100%). 큰 글씨에서는 lib/windowClass 의 listPaneWidth 로 넓힌다 */
  listPaneW: 400,
  /**
   * 한 단 화면을 넓은 창 가운데에 모을 때 내용의 최대 폭 (Screen readable).
   * 긴 글 전용 — 주 화면(잔고·발견·브리핑·설정·종목 상세)에는 쓰지 않는다 (3-42 최종 설계: 넓어진 폭은 숫자 칸·두 번째 칸으로 채운다)
   */
  readableMax: 720,
  /** 창 높이가 이보다 낮으면 '높이 짧음' (펼친 폴드8 가로 704 는 짧음, 울트라 가로 859 는 아님) */
  shortHeight: 760,
  /** 왼쪽 세로 탭 막대 폭 (글자 100%, 화면 여백 제외) */
  railW: 80,
  /**
   * 왼쪽 세로 탭 막대의 끄기 여유 (히스테리시스). 막대는 폭 '넓음'(expandedMin) + 높이 짧음(shortHeight 미만)에서 켜고,
   * 켜진 뒤에는 폭이 expandedMin − 24 = 816 아래로 좁아지거나 높이가 shortHeight + 24 = 784 이상이 되어야 끈다
   * → 팝업 창을 끌어 크기를 바꿀 때 기준선 근처에서 탭이 아래·왼쪽을 번갈아 오가지 않는다 (2단 켜기·끄기 폭 차이와 같은 24)
   */
  railHysteresis: 24,
  /** 2단 사이 구분선 두께 */
  divider: 1,
  /**
   * 종목·지수 상세 차트의 폭 상한. foldLayout 이 꺼져 있거나 좁은 창(휴대폰·접힌 화면)이면 지금처럼 이 폭에서 멈춘다.
   * 켜져 있고 폭 등급이 중간 이상이면 상한 없이 패널 폭을 다 쓰고, 높이를 chartMaxHRatio 로 제한한다 (3-42 진단 6·7번)
   */
  chartMaxW: 720,
  /** 상세 차트 높이 = 차트 폭 × 이 비율 (지금 값 그대로) */
  chartAspect: 0.62,
  /**
   * 넓은 창(foldLayout 켜짐 + 폭 등급 중간 이상)에서 상세 차트 높이 상한 = 창 높이 × 이 비율.
   * 펼친 폴드8 가로(933×704)에서 차트가 352dp 로 줄어 날짜 줄까지 첫 화면에 들어온다 (추정 — 실측 뒤 조정)
   */
  chartMaxHRatio: 0.5,
  /**
   * 넓은 창 상세 차트 높이의 하한. 창 높이 × chartMaxHRatio 가 이보다 낮아도(위아래로 나눈 낮은 창 933×300 → 150) 여기서 멈춘다.
   * 200 = 가장 좁은 휴대폰(폭 360)의 차트 높이 (360 − 28) × 0.62 ≈ 206 과 비슷 — 거래량(16%)·보조 지표(20%)를 모두 켜도
   * 가격 칸이 약 100dp 남는다 (200 − 날짜 줄 18 − 32 − 40 − 칸 사이 6 × 2 = 98). 단 그 폭의 폭 × chartAspect 보다 높이지는 않는다
   */
  chartMinH: 200,
  /**
   * 넓은 창 높이 상한(창 높이 × chartMaxHRatio)을 서서히 거는 폭 구간. 창 폭 mediumMin(600)에서는 상한을 쓰지 않고(좁은 창과 같은 폭 × 0.62),
   * 600 + 96 = 696 에서 다 쓴다 → 팝업·분할 창을 끌어 폭이 599 ↔ 600 을 넘나들어도 높이가 354 → 200 처럼 뛰지 않는다 (폭 1dp 에 높이 약 2dp 이하).
   * 펼친 폴드8 세로(704)와 그 위아래 분할 창은 이미 다 적용되는 폭이다
   */
  chartCapRamp: 96,

  // ── 넓은 잔고 표 (3-42 웨이브 B) ──
  /** 넓은 창 맨 위 띠 높이: 지수 칸 두 줄(이름+등락률 / 값) + 오른쪽 시장 상태·검색 */
  stripH: 48,
  /**
   * 맨 위 띠 오른쪽 시장 상태 칸의 최대 폭 (글자 100%, 큰 글씨는 탭 글자 상한 150% 까지 배율만큼).
   * 칸 폭은 글자 폭에 맞추고(세션 / 실시간·시각 두 줄, 목업 약 140), 세션 이름이 길면 이 폭에서 접힌다
   */
  stripStatusMaxW: 200,
  /** 계좌 띠 한 줄 높이 */
  bandH: 52,
  /** 계좌 띠가 두 줄일 때 한 줄 높이 (48 × 2) */
  bandRowH: 48,
  /** 계좌 띠를 한 줄로 쓰는 최소 폭 (글자 100%, 큰 글씨는 배율만큼 높인다). 이보다 좁으면 두 줄 (펼친 폴드8 세로 704) */
  bandOneLineMin: 800,
  /**
   * 한 줄 계좌 띠에 국내·해외 수익률까지 넣는 최소 폭 (글자 100%, 큰 글씨는 배율만큼). 펼친 폴드8 가로(막대 뺀 853)·울트라 펼침(859·954)은
   * 넣고, 이보다 좁은 한 줄 띠(800~839)는 국내·해외 금액만 (수익률은 화면 읽기 문장에 그대로 있다)
   */
  bandRatesMin: 840,
  /**
   * 표 머리 높이 = 누르는 크기(44). 머리는 스크롤해도 위에 고정되고 바로 아래가 종목 줄이라, hitSlop 으로 넓히면
   * 이웃 줄을 누를 때 정렬이 바뀐다 → 머리 자체를 44 로 둔다 (3-22 휴대폰 머리와 같은 까닭)
   */
  headH: 44,
  /** 표 한 줄 높이 (휴대폰 줄 58 보다 낮은 한 줄 표) */
  rowH: 44,
  /**
   * 표 숫자 열 폭 (글자 100%). 큰 글씨는 lib/holdingsColumns pickCols 가 배율(최대 fontCap.row)만큼 넓힌다.
   * 보유: 현재가·등락률 ‖ 평가손익·수익률 ‖ 당일손익·평가금액·비중·평단·수량 / 관심: 현재가·등락률 ‖ 전일대비·거래량
   */
  cols: { price: 86, rate: 62, profit: 106, profitRate: 66, day: 82, value: 94, weight: 76, avg: 72, qty: 56, move: 82, volume: 72 },
  /** 열 묶음 사이 구분선 칸 폭 (가운데에 세로선) */
  colGap: 14,
  /** 종목 이름 칸 최소 폭. 이보다 좁아지면 숫자 열을 뒤에서부터 뺀다 */
  nameMinW: 146,
  /**
   * 큰 글씨(100% 초과)의 이름 칸 최소 폭: 큰 글씨에서는 이름이 두 줄까지 접히므로 조금 좁아도 된다
   * (펼친 폴드8 가로 130% — 막대 92 를 뺀 841 — 에서 숫자 6칸을 지키고, 이름과 현재가 사이 빈칸이 200dp 로 벌어지지 않게)
   */
  nameMinWrapW: 132,
  /** 비중 칸 막대 길이·두께 */
  weightBarW: 30,
  weightBarH: 4,
} as const;

/**
 * 넓은 창 종목 상세 (3-42 웨이브 C, 기능 플래그 foldLayout). 단위 dp. 폰 실측 전 추정값 — 실측을 받으면 여기 숫자만 바꾼다.
 * 어느 배치를 쓸지(좌우·윗줄+아랫줄·한 단)는 lib/detailLayout 의 detailMode 가 창 등급(layout)과 가로·세로로 정한다
 */
export const foldDetail = {
  /** 합친 머리(← 이름 | 가격·등락 | 시장 상태 | ‹ n/17 › | 수정)의 최소 높이. 큰 글씨·긴 시장 상태에서는 글자에 맞춰 늘어난다 */
  headH: 56,
  /**
   * 오른쪽 칸 폭 (좌우 배치의 오른쪽 칸, 윗줄+아랫줄 배치의 윗줄 오른쪽). 글자 100% — 큰 글씨는 늘어난 배율의 절반만큼 넓힌다.
   * ※ 설계서의 layout.detailSideW(웨이브 B 가 더할 값)와 같은 340 — 웨이브 B·C 를 합칠 때 한 이름으로 모은다
   */
  sideW: 340,
  /** 시세표 한 칸(왼쪽 항목명 + 오른쪽 값)의 최소 폭 (글자 100%). 칸 폭에 이만큼씩 몇 개 들어가는지로 한 줄의 칸 수를 정한다 */
  statMinW: 140,
  /**
   * 폭 중간(폴드8 펼침 세로) 한 단 배치의 차트 그림 높이 상한 = 창 높이 × 이 비율 → 차트와 핵심 숫자 11개가 첫 화면에 함께 들어온다.
   * 차트 그림의 최소 높이는 상세 차트 공통 값 layout.chartMinH (좌우 배치 왼쪽 칸도 같은 값 — 더 낮은 창에서는 왼쪽 칸이 스크롤된다)
   */
  wideChartHRatio: 0.32,
  /** 폴드8 펼침 세로 시세표의 '내 보유'(와 '원화 기준') 칸 폭 비율 — 시세 칸을 1 로 볼 때 (설계 200 | 168 × 3). 긴 원화 금액이 줄어들지 않게 */
  holdColFlex: 1.2,
  /** 폴드8 펼침 세로 '최근 브리핑'에 처음 보이는 개수 (설계 2건, 나머지는 '더 보기') */
  wideBriefings: 2,
  /**
   * 윗줄+아랫줄 배치의 차트 그림 높이 상한 = 창 높이 × 이 비율. 차트는 옆 칸(보유·시세·AI 분석) 높이에 맞춰 늘지만,
   * AI 분석을 '더 보기'로 펼쳐 옆 칸이 길어져도 차트가 끝없이 커지지 않게 한다
   */
  rowsChartMaxRatio: 0.6,
  /** 윗줄+아랫줄 배치(울트라 펼침 세로) 아랫줄 세 칸에 처음 보이는 개수 (나머지는 '더 보기') */
  rowsBriefings: 2,
  rowsNews: 4,
  rowsDisclosures: 3,
  /**
   * 아랫줄 '최근 브리핑' 칸 폭 비율 — 뉴스·공시 칸을 1 로 볼 때 (설계 329 | 265 | 265).
   * 브리핑 카드 머리(날짜 · '일부 데이터 없음' 표시 · ›)가 한 줄에 들어가게 한다
   */
  rowsBriefFlex: 1.25,
  /**
   * 윗줄+아랫줄 배치 오른쪽 칸의 AI 분석 미리보기 줄 수 ('더 보기'로 전체). 설계 목업처럼 기업개요 3줄 · 기술 지표 2줄,
   * 가치분석은 제목 줄만 두고 '더 보기'로 펼친다 (탭 없이 셋 다 닿게)
   */
  previewCompanyLines: 3,
  previewTechLines: 2,
  /** AI 분석 미리보기 줄 높이 (브리핑 요약 줄과 같다) */
  previewLineH: 22,
  /** 칸 제목 줄(내 보유 · 시세 · AI 기업개요 …)의 최소 높이. 제목 줄의 '더 보기'는 hitSlop 으로 44 를 채운다 */
  paneTitleH: 28,
  /** 칸에 맞춘 차트(FillChart)의 둘레(기간 칩·읽기 줄·이동평균 값·지표 칩·안내·패널 여백) 처음 어림. 실제보다 작게 잡아 재어 본 뒤 늘린다 */
  chromeGuess: 120,
  /** 머리 오른쪽 아이콘 크기 (휴대폰 화면 Stack 머리의 수정 아이콘과 같은 값) */
  headIcon: 21,
  /** 누를 수 없는 버튼(처음·끝 종목의 ‹ ›)의 흐림 (ui 의 Button 과 같은 값) */
  offOpacity: 0.45,
  /** ‹ › 로 넘겨 본 뒤 잔고로 돌아왔을 때 마지막에 본 종목 줄을 강조해 두는 시간 (ms) */
  returnMarkMs: 2400,
  /** 그 강조 테두리 두께 */
  returnMarkW: 2,
} as const;

/**
 * 넓은 창의 브리핑 화면 치수 (3-42 웨이브 D, 기능 플래그 foldLayout). 단위는 dp, 글자 100% 기준.
 * 브리핑 탭 2단(목록 + 본문)·펼친 폴드8 세로 카드 격자·전체 화면 브리핑 상세의 두 칸·계좌 브리핑 상세의 두·세 칸에만 쓴다 (접은 화면은 쓰지 않음).
 * ※ 웨이브 B 가 layout 에 더할 detailSideW(340)·briefCardMinW(300)와 값이 같다 — 합칠 때 sideW·cardMinW 를 그 이름으로 옮기면 된다
 */
export const foldBriefings = {
  /** 2단 목록 머리 (제목 · 변동 큰 순|등록순) 높이 */
  headH: 44,
  /** 목록 위 안내 한 줄(휴장·정렬 기준)의 최소 높이 */
  noticeH: 22,
  /** '내 계좌 브리핑' 줄 높이 */
  accountRowH: 60,
  /** 브리핑 줄 높이 (미확인 점 · 이름 · 등락률 · 시각 / 요약 한 줄) */
  rowH: 56,
  /** 고른 줄·카드 왼쪽 강조 막대 두께 */
  selBar: 3,
  /** 미확인 점 지름 */
  dot: 6,
  /** 변동 큰 순 1~3위 표시 칸 (한 변의 최소 — 큰 글씨에서는 글자만큼 커진다) */
  rank: 18,
  /** 카드 격자 한 칸 최소 폭 (큰 글씨에서는 배율만큼 넓힘) */
  cardMinW: 300,
  /** 카드 격자 최대 열 수 */
  cardMaxCols: 3,
  /** 카드 요약 최대 줄 수 ('요약' 보기) */
  cardLines: 3,
  /** 알약 모양 선택 칸의 보이는 높이 (hitSlop 으로 44) */
  pillH: 34,
  /** 알약 한 칸 최소 폭 */
  pillMinW: 56,
  /** 전체 화면 브리핑 상세를 두 칸으로 나눌 때 왼쪽 칸 폭 (폭 '넓음') */
  sideW: 340,
  /** 폭 '중간'(펼친 폴드8 세로)에서 왼쪽 칸 폭 — 오른쪽 본문이 접은 화면 폭만큼 남게 */
  sideNarrowW: 300,
  /**
   * 계좌 브리핑 상세 3칸(요약·수치 | 기여 표 | 지수·환율·일정)에서 가운데 기여 표 칸 폭:
   * 좌우 안쪽 여백 14×2 + 이름 약 122 · 금액 120 · 등락률 64 + 간격 8×2 (SPEC 이름 132·금액 110·등락률 64 와 같은 합)
   */
  accountContribW: 350,
  /** 계좌 브리핑 상세 3칸의 양옆 칸 최소 폭. 창이 기여 표 칸 + 이 폭 × 2 보다 좁으면 2칸(반씩) — lib/briefingPick accountColumns */
  accountColMinW: 280,
  /**
   * 계좌 브리핑 상세 3칸을 끄는 여유 (히스테리시스): 3칸은 912 에서 켜고, 켜진 뒤에는 912 − 24 = 888 아래로 좁아져야 2칸으로.
   * 창 크기를 끌어 바꿀 때 기준선 근처에서 칸 수가 번갈아 바뀌지 않게 (2단 켜기 840·끄기 816 차이와 같은 24)
   */
  accountColsHysteresis: 24,
} as const;
