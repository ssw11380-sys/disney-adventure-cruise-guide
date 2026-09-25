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
  /** 한 단 화면을 넓은 창 가운데에 모을 때 내용의 최대 폭 (Screen readable) */
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
} as const;

/**
 * 발견·설정·비중 화면의 넓은 창 배치 (3-42 웨이브 E, 기능 플래그 foldLayout — 쓸지는 화면이 useFoldLayout 으로 정한다). 단위 dp.
 * 잔고 표와 같은 생각(한 줄 44 표, 폭에 맞춰 열 고르기)을 쓰되, 함께 만드는 잔고 작업(layout 무리)과 겹치지 않게 따로 둔다.
 * ※ 추정값: 폰 실측 전이다. 실측을 받으면 여기 숫자만 바꾼다 (화면 코드는 이 이름만 쓴다)
 */
export const foldScreens = {
  /** 발견 순위 표 한 줄 높이 = 누르는 크기 44 (글자는 fontCap.row 까지만 커져 한 줄에 들어간다) */
  tableRowH: 44,
  /** 발견 순위 표 머리 높이 */
  tableHeadH: 40,
  /**
   * 발견 순위 표 열 폭 (글자 100%). 큰 글씨에서는 배율(최대 fontCap.row)만큼 넓혀 고른다 (lib/discoverColumns).
   * 현재가 "$1,220.40" · 등락률 "+29.90%" · 금액 "1,234억원"·"$4.34T" · 거래량 "1.8억"·"5,000만" · 보유 표시 "보유" 가 100% 에서 줄이지 않고 들어가는 폭
   */
  discoverCol: { rank: 30, price: 86, rate: 62, tradingValue: 76, volume: 64, marketCap: 76, mark: 44 },
  /** 발견 순위 표 이름 칸 최소 폭 (글자 100%) — 이보다 좁아지면 덜 중요한 열(보유 → 시가총액 → 다른 값)부터 뺀다 */
  discoverNameMin: 146,
  /**
   * 발견 순위 표 이름 칸 최대 폭 (글자 100%) — 이보다 넓게 남는 폭은 숫자 열에 고루 나눠, 이름과 현재가 사이가 멀어지지 않게 한다
   * ("한화에어로스페이스" 가 한 줄에 들어가는 폭)
   */
  discoverNameMax: 200,
  /** 테마 히트맵 타일 기준 폭: 칸 수 = 폭 ÷ 이 값 (넓은 창만. 좁은 창은 지금처럼 3칸) */
  heatTileW: 150,
  /** 넓은 창 테마·업종 목록 칸 수 */
  themeListCols: 2,
  /** 설정 카드 두 칸 배치에서 한 칸의 최소 폭 (글자 100%, 큰 글씨는 배율의 절반만큼 넓힘) — 이보다 좁으면 지금처럼 한 칸 */
  settingsColMin: 300,
  /** 비중 원 지름: 카드 폭에 맞춰 이 범위 안에서 (넓은 창) */
  donutMin: 120,
  donutMax: 180,
  /** 비중 카드 범례 열 폭 (넓은 창, 글자 100%): 금액 "1,234,567,890원" · 비중 "100.0%" — 넘치면 글자를 줄인다 */
  legendAmountW: 96,
  legendPctW: 48,
  /** 비중 카드 범례 이름 칸 최소 폭 — 원 옆에 이만큼 남지 않으면 원 아래에 범례를 둔다 */
  legendNameMin: 64,
  /** 비중 카드 범례 이름 칸이 바라는 폭 ("한화에어로스페이스" 한 줄) — 원은 이만큼을 남기고 남은 폭에서 donutMin~donutMax 로 */
  legendNameIdeal: 110,
} as const;
