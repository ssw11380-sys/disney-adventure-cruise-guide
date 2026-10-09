import { clampScale } from "@/lib/textScale";
import { font, fontCap, layout, space, touch } from "@/tokens";

/**
 * 숫자 기준 점(3-32, 플래그 numberBasis)을 어디에 어떤 모양으로 둘지 — '큰 글씨면 점만' (사용자가 맡긴 결정 A).
 * 순수 함수 (RN·훅을 부르지 않는다 → 단위 테스트). 목표: 켜도 계좌 패널·띠의 줄 수가 꺼졌을 때와 같다 (새 줄 0).
 *  - 글자 폭은 어림이다(안드로이드 기본 글꼴 — 숫자·라틴 Roboto, 한글 Noto CJK — 폭에 5% 여유). 어림은 실제보다 넓다(웹 미리보기 실측의 1.05~1.06배).
 *    그래서 '켠 모양'은 어림으로 재면 실제로도 그 줄 수 안에 들고, '끈 모양'의 줄 수는 어림만으로는 알 수 없다(어림이 2줄이어도 실제는 1줄일 수 있음).
 *    → 끈 줄 수에 기대지 않는다: 휴대폰 촘촘은 점 옆에서 '한 줄'로 들어갈 때만 옆에 두고, 띠는 끄고도 한 줄(여유를 뺀 어림)일 때만 줄바꿈을 막는다
 *  - 점 옆 글의 폭은 지금 글이 아니라 나올 수 있는 가장 긴 글(MARK_TEXT_SAMPLES)로 잰다 — 대조 결과가 바뀌어도 배치가 흔들리지 않게
 *  - 차례(휴대폰 촘촘): 점 + 글 → 점만(누르는 칸 44×44 그대로, 화면 읽기는 같은 문장) → 점을 총액 줄 옆으로 옮겨 '평가손익 · 당일' 줄은 꺼졌을 때와 같은 폭·같은 글자
 *    (그 줄은 줄이지도 한 줄로 묶지도 않는다 — 3-39 '말줄임 없이 다음 줄로' 그대로)
 */

/** 어림 여유 (실제 글꼴보다 조금 넓게) */
export const SLACK = 1.05;
/** 띠 칸 묶음을 한 줄로 두려고 칸 글자를 줄일 때의 하한 (띠 칸 숫자 0.6 · 이름 0.7 보다 위 — 잘리지 않게) */
export const MIN_FIT = 0.75;

/** 글자 한 자의 폭 (글자 크기 대비) — Roboto 숫자 0.56 · 쉼표 0.22 · 가운뎃점 0.26, Noto CJK 한글 1 을 조금 넉넉하게 */
function em(ch: string): number {
  if (/[가-힣ㄱ-ㅎㅏ-ㅣ]/.test(ch)) return 1;
  if (/[0-9$]/.test(ch)) return 0.57;
  if (ch === "," || ch === "." || ch === ":" || ch === "·") return 0.27;
  if (ch === " " || ch === " ") return 0.25;
  if (ch === "%") return 0.74;
  if (ch === "+" || ch === "-" || ch === "−") return 0.58;
  if (ch === "/" || ch === "(" || ch === ")") return 0.34;
  if (/[A-Z]/.test(ch)) return 0.66;
  if (/[a-z]/.test(ch)) return 0.55;
  // 그 밖의 기호·한자는 넓게
  return 1;
}

/** 글자 폭 어림 (dp). size 는 글자 배율을 곱한 실제 글자 크기 */
export function basisTextWidth(text: string, size: number): number {
  let sum = 0;
  for (const ch of text) sum += em(ch);
  return sum * size * SLACK;
}

/**
 * 점 옆 글(reconcileBadge)로 나올 수 있는 가장 긴 글들 — 폭은 이 중 가장 넓은 것으로 잰다.
 * '오래됨'은 어제 기록이면 날짜가 붙고('토스 대조 9/26 05:00'), 차이는 소수 둘째 자리(0.1% 근처는 셋째 자리)
 */
export const MARK_TEXT_SAMPLES: readonly string[] = ["숫자 기준", "토스 대조 대기", "토스 대조 12/31 23:59", "토스와 수량 다름", "토스와 차이 99.99%", "토스와 차이 0.104%", "토스와 0.1% 이내"];

/** 점 + 짧은 글 칸의 폭 (BasisMark: 점 지름 + 사이 space.xs + 글 font.tiny, 글자 확대 상한 fontCap.row). 누르는 칸 44 보다 좁지 않다 */
export function markTextWidth(fontScale: number): number {
  const size = font.tiny * clampScale(fontScale, fontCap.row);
  const text = Math.max(...MARK_TEXT_SAMPLES.map((t) => basisTextWidth(t, size)));
  return Math.max(touch.min, layout.basisDot + space.xs + text);
}

/** 점만 있을 때 칸 폭 = 누르는 칸 44 (점은 가운데라 옆 글과 19dp 떨어져 보인다 → 따로 띄우지 않는다) */
export const DOT_MARK_W = touch.min;

/**
 * 한 덩어리 글을 폭 width 에 넣을 때 줄 수 (어림). 줄은 띄어쓰기와 한글 글자 앞뒤에서만 바뀐다고 보고(숫자·기호 덩어리는 쪼개지 않음),
 * 줄 끝 띄어쓰기는 폭에 넣지 않는다. 폭이 0 이하면 Infinity
 */
export function lineCount(text: string, width: number, size: number): number {
  if (!(width > 0)) return Infinity;
  const atoms = text.match(/[가-힣ㄱ-ㅎㅏ-ㅣ]|[^\s가-힣ㄱ-ㅎㅏ-ㅣ]+|\s+/g) ?? [];
  let lines = 1;
  let x = 0;
  for (const a of atoms) {
    const w = basisTextWidth(a, size);
    if (/^\s+$/.test(a)) {
      if (x > 0) x += w;
      continue;
    }
    if (x > 0 && x + w > width) {
      lines += 1;
      x = w;
    } else x += w;
  }
  return lines;
}

// ── 휴대폰 계좌 패널 ─────────────────────────────────────────────────

export interface PanelFit {
  /** 점만 (글 없음) */
  dotOnly: boolean;
  /** 촘촘: 점 자리 — 요약 묶음(총액 + '평가손익 · 당일' 줄) 옆(group) 또는 총액 줄 옆(total, 그 줄은 아래에 꺼졌을 때와 같은 폭·같은 글자) */
  spot: "group" | "total";
  /**
   * 총액 줄 옆(total)일 때 점 줄이 위아래로 겹쳐 들어가는 dp (group 이면 0). 누르는 칸 44 가 총액 글 높이보다 높아 줄이 두꺼워지지 않게,
   * 그 차이의 반만큼 위아래를 음수 여백으로 거둔다 → 총액 줄이 차지하는 높이는 총액 글 높이(어림)와 같다
   */
  tuck: number;
}

/** 총액 글자는 남은 폭에 맞춰 0.6 까지 줄어든다 (계좌 패널 total·totalDense 의 minimumFontScale) */
const TOTAL_MIN = 0.6;
/**
 * 촘촘 총액 줄(font.h2 + ' 원') 높이 어림 — 글자 크기의 1.5배. 안드로이드 Roboto(글자 여백 포함 1.33배)·Noto CJK(1.45배)보다 높게 잡는다:
 * 낮게 잡으면 거둔 만큼 총액 글이 위아래 줄과 겹치므로, 틀리면 몇 dp 밀리는 쪽으로
 */
export const TOTAL_LINE = 1.5;

/**
 * 휴대폰·접은 화면 계좌 패널의 점 (index.tsx AccountPanel).
 *  - width: 패널 폭(창 폭 — 패널 좌우 여백 space.lg 는 여기서 뺀다), fontScale: 시스템 글자 배율(패널 글자는 상한 없이 커진다)
 *  - total: 총액 숫자 글('67,050,074'), line: 촘촘이면 '평가손익 +… +…% · 당일 +…' 한 줄 글 (기본 패널은 없음)
 * 기본 패널: 총액 줄 = 총액(0.6 까지 줄어듦) | 점 — 한 줄이 늘 한 줄이라 총액이 0.6 에도 안 들어가 잘릴 때만 점만.
 * 촘촘: 요약 묶음 | 점 — '평가손익 · 당일' 줄이 점 + 글 옆에서 한 줄(어림)이면 글, 점(44) 옆에서 한 줄이면 점만.
 *  어림은 실제보다 넓어 '옆에서 한 줄'이면 실제로도 한 줄이고 끈 줄(더 넓은 폭)도 한 줄 → 줄 수 같음.
 *  두 줄 이상이면 끈 줄 수를 어림으로 알 수 없으므로(어림 2줄이 실제 1줄일 수 있다) 옆에 두지 않고 점을 총액 줄 옆으로 —
 *  그 줄은 꺼졌을 때와 같은 폭·같은 글자라 줄 수가 늘 같다
 */
export function panelBasisFit(o: { width: number; fontScale: number; total: string; line?: string | null }): PanelFit {
  const s = clampScale(o.fontScale);
  const room = o.width - space.lg * 2;
  const textW = markTextWidth(o.fontScale);
  const gap = space.sm;
  if (!o.line) {
    const need = (basisTextWidth(o.total, font.hero * s) + basisTextWidth(" 원", font.body * s)) * TOTAL_MIN;
    return { dotOnly: need > room - gap - textW, spot: "group", tuck: 0 };
  }
  const line = o.line;
  const lineSize = font.small * s;
  const totalNeed = (basisTextWidth(o.total, font.h2 * s) + basisTextWidth(" 원", font.small * s)) * TOTAL_MIN;
  const textRoom = room - gap - textW;
  if (totalNeed <= textRoom && lineCount(line, textRoom, lineSize) === 1) return { dotOnly: false, spot: "group", tuck: 0 };
  const dotRoom = room - DOT_MARK_W;
  if (totalNeed <= dotRoom && lineCount(line, dotRoom, lineSize) === 1) return { dotOnly: true, spot: "group", tuck: 0 };
  return { dotOnly: true, spot: "total", tuck: Math.max(0, (touch.min - font.h2 * s * TOTAL_LINE) / 2) };
}

// ── 넓은 창 계좌 띠 ──────────────────────────────────────────────────

/** 띠 한 칸의 글 (AccountBand Cell 과 같은 값) */
export interface BandCellText {
  label: string;
  value: string;
  unit?: string | null;
  sub?: string | null;
  /** 총액 칸 (값 글자 font.h2) */
  big?: boolean;
  /** 줄의 첫 칸 (왼쪽 구분선·여백 없음) */
  first?: boolean;
}

/** 띠 한 칸의 자연 폭 (어림): 이름(font.tiny)과 값 줄(값 font.body·총액 font.h2 + 단위·등락률 font.small) 중 넓은 것 + 칸 여백 (글자 확대 상한 fontCap.row) */
export function bandCellWidth(c: BandCellText, fontScale: number): number {
  const s = clampScale(fontScale, fontCap.row);
  const label = basisTextWidth(c.label, font.tiny * s);
  const value = basisTextWidth(c.value, (c.big ? font.h2 : font.body) * s) + (c.unit ? basisTextWidth(` ${c.unit}`, font.small * s) : 0) + (c.sub ? basisTextWidth(` ${c.sub}`, font.small * s) : 0);
  // AccountBand styles.cell paddingRight space.sm, 첫 칸이 아니면 구분선(1) + paddingLeft space.sm
  return Math.max(label, value) + space.sm + (c.first ? 0 : space.sm + 1);
}

/** '비중' 버튼 칸 폭 (어림): 앞 간격 space.sm + 작은 버튼(좌우 space.md · 아이콘 14 · 사이 space.s · 글 font.small — 글자 상한 없음 · 테두리) */
export function bandActionWidth(fontScale: number): number {
  return space.sm + space.md * 2 + 14 + space.s + basisTextWidth("비중", font.small * clampScale(fontScale)) + 2;
}

export interface BandFit {
  dotOnly: boolean;
  /**
   * 칸 묶음을 줄바꿈하지 않는다 — 모자라면 칸 글자가 줄어든다 (한 줄 띠와 같은 규칙). 끄고도 칸이 한 줄인 띠에서 점 칸 때문에 새 줄이 생기지 않게.
   * 끄면 칸이 다음 줄로 넘어가는 띠(큰 글씨 · 좁은 폭 · 큰 금액)는 거짓 — 3-39 '줄여 자르지 않고 다음 줄로' 그대로, 점만 더한다
   */
  noWrap: boolean;
}

/**
 * '끄고 한 줄'로 볼 여유 — 여유를 뺀 칸 어림이 띠 안쪽 폭(어림)보다 2% 안에서 넘치면 끄고 한 줄로 본다.
 * 칸 어림(÷ SLACK)은 웹 미리보기 실측과 ±0.5% 지만 '비중' 버튼 어림이 실제보다 넓어(200% 에서 약 6dp) 안쪽 폭을 좁게 잡는다
 * (673 × 200% 촘촘: 칸 550.1 · 안쪽 폭 어림 544.6 · 실제 550.8 — 끄면 한 줄). 이 틈에서는 새 줄(+61dp)보다 칸 글자 조금(약 8%) 줄임을 고른다
 */
export const OFF_ONE_LINE_TOL = 1.02;

/**
 * 넓은 창 두 줄 띠의 둘째 줄·촘촘 띠의 한 줄 (AccountBand): 칸 묶음(줄바꿈) | 점 | [비중].
 *  - width: 띠 폭(표 폭), pad: 띠 좌우 여백, cells: 점과 같은 줄의 칸들, action: '비중' 버튼이 있는지
 *  - 칸이 점 + 글과 한 줄에 들어가면 점 + 글, 아니면 점만.
 *  - 끄고도 칸이 한 줄이면(어림에서 여유 SLACK 을 뺀 폭이 안쪽 폭 × OFF_ONE_LINE_TOL 안) 점과 함께 한 줄로 두고(글자를 MIN_FIT 까지 줄여서라도) 줄바꿈을 막는다.
 *    끄면 줄바꿈하는 띠는 그대로 줄바꿈 (칸 셋이 두 줄 — 점 칸 44 를 빼도 두 줄)
 */
export function bandBasisFit(o: { width: number; pad: number; fontScale: number; cells: readonly BandCellText[]; action: boolean }): BandFit {
  const room = o.width - o.pad * 2 - (o.action ? bandActionWidth(o.fontScale) : 0);
  const sum = o.cells.reduce((a, c) => a + bandCellWidth(c, o.fontScale), 0);
  const textW = markTextWidth(o.fontScale);
  const dotOnly = sum + textW > room;
  const mark = dotOnly ? DOT_MARK_W : textW;
  const offOneLine = sum / SLACK <= room * OFF_ONE_LINE_TOL;
  return { dotOnly, noWrap: offOneLine && sum * MIN_FIT + mark <= room };
}

/**
 * 넓은 창 계좌 띠에 매매일지 아이콘(44×44, 3-37 — 기능 플래그 tradeJournal)을 비중 뒤에 더해도 칸 묶음이 한 줄에 드는지.
 * 여유(SLACK) 없이 어림하고, 숫자 기준 점(mark)이 있으면 그 칸도 뺀다. 거짓이면 그 띠에는 아이콘을 두지 않는다 — 띠 줄 수가 켜기 전과 같게
 * (끄고도 줄바꿈하는 띠·점 때문에 이미 칸 글자를 줄이는 띠는 늘 거짓). 한 줄 띠는 칸이 줄바꿈하지 않아 부르지 않는다(늘 둔다)
 */
export function bandJournalFits(o: { width: number; pad: number; fontScale: number; cells: readonly BandCellText[]; action: boolean; mark: "dot" | "text" | null }): boolean {
  const markW = o.mark === "dot" ? DOT_MARK_W : o.mark === "text" ? markTextWidth(o.fontScale) : 0;
  const room = o.width - o.pad * 2 - (o.action ? bandActionWidth(o.fontScale) : 0) - markW - touch.min;
  const sum = o.cells.reduce((a, c) => a + bandCellWidth(c, o.fontScale), 0);
  return sum <= room;
}
