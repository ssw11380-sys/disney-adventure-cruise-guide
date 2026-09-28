import { clampScale } from "@/lib/textScale";
import { font, fontCap, layout, space, touch } from "@/tokens";

/**
 * 숫자 기준 점(3-32, 플래그 numberBasis)을 어디에 어떤 모양으로 둘지 — '큰 글씨면 점만' (사용자가 맡긴 결정 A).
 * 순수 함수 (RN·훅을 부르지 않는다 → 단위 테스트). 목표: 켜도 계좌 패널·띠의 줄 수가 꺼졌을 때와 같다 (새 줄 0).
 *  - 글자 폭은 어림이다(안드로이드 기본 글꼴 — 숫자·라틴 Roboto, 한글 Noto CJK — 폭에 5% 여유). 모자랄 쪽으로 틀리지 않게 넉넉히 잡고,
 *    그래도 실제 글꼴이 더 넓을 때를 위해 '한 줄로 두고 글자를 조금 줄이는' 안전판(fitLine·noWrap)을 함께 쓴다
 *  - 점 옆 글의 폭은 지금 글이 아니라 나올 수 있는 가장 긴 글(MARK_TEXT_SAMPLES)로 잰다 — 대조 결과가 바뀌어도 배치가 흔들리지 않게
 *  - 차례: 점 + 글 → 점만(누르는 칸 44×44 그대로, 화면 읽기는 같은 문장) → 한 줄이던 것은 한 줄로 두고 글자를 조금(최대 MIN_FIT) 줄임
 *    → (휴대폰 촘촘만) 점을 총액 줄 옆으로 옮겨 '평가손익 · 당일' 줄은 꺼졌을 때와 같은 폭
 */

/** 어림 여유 (실제 글꼴보다 조금 넓게) */
const SLACK = 1.05;
/** 한 줄로 두려고 글자를 줄일 때의 하한 (띠 칸 숫자 0.6 · 이름 0.7 보다 위 — 잘리지 않게) */
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
  /** 촘촘: 점 자리 — 요약 묶음(총액 + '평가손익 · 당일' 줄) 옆(group) 또는 총액 줄 옆(total, 그 줄은 아래에 꺼졌을 때와 같은 폭) */
  spot: "group" | "total";
  /** 촘촘: '평가손익 · 당일' 줄을 한 줄로 두고 모자라면 글자를 줄인다 (꺼졌을 때 한 줄이고 점 옆에서도 MIN_FIT 까지 줄이면 들어갈 때) */
  fitLine: boolean;
}

/** 총액 글자는 남은 폭에 맞춰 0.6 까지 줄어든다 (계좌 패널 total·totalDense 의 minimumFontScale) */
const TOTAL_MIN = 0.6;

/**
 * 휴대폰·접은 화면 계좌 패널의 점 (index.tsx AccountPanel).
 *  - width: 패널 폭(창 폭 — 패널 좌우 여백 space.lg 는 여기서 뺀다), fontScale: 시스템 글자 배율(패널 글자는 상한 없이 커진다)
 *  - total: 총액 숫자 글('67,050,074'), line: 촘촘이면 '평가손익 +… +…% · 당일 +…' 한 줄 글 (기본 패널은 없음)
 * 기본 패널: 총액 줄 = 총액(0.6 까지 줄어듦) | 점 — 한 줄이 늘 한 줄이라 총액이 0.6 에도 안 들어가 잘릴 때만 점만.
 * 촘촘: 요약 묶음 | 점 — '평가손익 · 당일' 줄 수가 꺼졌을 때보다 늘면 점만 → 그래도 늘면(한 줄이던 것) 조금 줄여 한 줄 → 그래도 안 되면 총액 줄 옆
 */
export function panelBasisFit(o: { width: number; fontScale: number; total: string; line?: string | null }): PanelFit {
  const s = clampScale(o.fontScale);
  const room = o.width - space.lg * 2;
  const textW = markTextWidth(o.fontScale);
  const gap = space.sm;
  if (!o.line) {
    const need = (basisTextWidth(o.total, font.hero * s) + basisTextWidth(" 원", font.body * s)) * TOTAL_MIN;
    return { dotOnly: need > room - gap - textW, spot: "group", fitLine: false };
  }
  const line = o.line;
  const lineSize = font.small * s;
  const totalNeed = (basisTextWidth(o.total, font.h2 * s) + basisTextWidth(" 원", font.small * s)) * TOTAL_MIN;
  const off = lineCount(line, room, lineSize);
  const lineW = basisTextWidth(line, lineSize);
  // 한 줄이던 줄은 점 옆에서도 한 줄로 두고, 실제 글꼴이 어림보다 넓으면 글자를 조금 줄인다 (MIN_FIT 까지 들어갈 때만)
  const fit = (w: number) => off === 1 && lineW * MIN_FIT <= w;
  const textRoom = room - gap - textW;
  if (totalNeed <= textRoom && lineCount(line, textRoom, lineSize) === off) return { dotOnly: false, spot: "group", fitLine: fit(textRoom) };
  const dotRoom = room - DOT_MARK_W;
  if (totalNeed <= dotRoom && (lineCount(line, dotRoom, lineSize) === off || fit(dotRoom))) return { dotOnly: true, spot: "group", fitLine: fit(dotRoom) };
  return { dotOnly: true, spot: "total", fitLine: false };
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
  /** 칸 묶음을 줄바꿈하지 않는다 — 모자라면 칸 글자가 줄어든다 (한 줄 띠와 같은 규칙). 점 칸 때문에 새 줄이 생기지 않게 */
  noWrap: boolean;
}

/**
 * 넓은 창 두 줄 띠의 둘째 줄·촘촘 띠의 한 줄 (AccountBand): 칸 묶음(줄바꿈) | 점 | [비중].
 *  - width: 띠 폭(표 폭), pad: 띠 좌우 여백, cells: 점과 같은 줄의 칸들, action: '비중' 버튼이 있는지
 *  - 칸이 점 + 글과 한 줄에 들어가면 점 + 글, 아니면 점만. 점과 함께 한 줄에 들어가면(글자를 MIN_FIT 까지 줄여서라도) 줄바꿈을 막는다
 */
export function bandBasisFit(o: { width: number; pad: number; fontScale: number; cells: readonly BandCellText[]; action: boolean }): BandFit {
  const room = o.width - o.pad * 2 - (o.action ? bandActionWidth(o.fontScale) : 0);
  const sum = o.cells.reduce((a, c) => a + bandCellWidth(c, o.fontScale), 0);
  const textW = markTextWidth(o.fontScale);
  const dotOnly = sum + textW > room;
  const mark = dotOnly ? DOT_MARK_W : textW;
  return { dotOnly, noWrap: sum * MIN_FIT + mark <= room };
}
