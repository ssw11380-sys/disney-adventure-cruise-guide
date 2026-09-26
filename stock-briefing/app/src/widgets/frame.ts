import AsyncStorage from "@react-native-async-storage/async-storage";
import { layout } from "@/tokens";

/**
 * 폴드 위젯 크기 맞추기 (위젯 2차, 플래그 widgetFoldFit — 서버 /api/widget features, 앱 fallback 꺼짐).
 * 접는 폰의 바깥 화면(접힘)에 펼친 화면 모양(잔고 평가금액 칸·두 열, 지수·환율 옆 칸)이 나오지 않게 한다.
 *
 * 라이브러리(react-native-android-widget 0.22.1)가 하는 일 — RNWidgetUtil · RNWidgetProvider · RNWidget · res/layout/rn_widget.xml:
 *  - 그림 크기는 그리는 순간 앱의 화면 방향 하나로 고른다. 세로면 (가장 좁은 폭 × 가장 큰 높이), 가로면 (가장 넓은 폭 × 가장 작은 높이).
 *    런처가 알려 준 크기 범위(OPTION_APPWIDGET_MIN/MAX_*)에서 고른다.
 *  - 위젯 하나에 그림 한 장(라이트·다크)만 준다. 같은 위젯이 두 화면에 나오면 두 화면이 같은 그림을 쓴다.
 *  - 그림은 늘이지 않고 왼쪽 위에 붙는다 (scaleType="matrix"). 칸보다 크면 오른쪽·아래가 잘리고, 작으면 남는 곳이 빈다.
 *  - 다시 그리는 때: 런처가 위젯 옵션을 보내고 방향으로 고른 크기가 마지막으로 적어 둔 것과 다를 때(WIDGET_RESIZED), 주기 갱신(30분), 앱·백그라운드 작업·↻.
 *  - JS 는 그 순간의 크기(widgetInfo — 알림이 온 순간의 옵션·방향)와 화면 크기(screenInfo — 작업이 도는 순간의 앱 설정)만 안다.
 *    화면 방향·크기는 접는 순간 바뀌지만 옵션은 런처가 새 화면에 다시 놓을 때(홈 화면이 보일 때) 바뀌어, 그 사이 그리면 새 화면에 옛 화면 크기가 온다.
 *
 * 홈 화면이 위젯을 두는 방식은 셋 중 하나이고, 캡처만으로는 가릴 수 없다 (docs/폴드-위젯.md 10절, 설정 '화면 정보' 공유 글로 폰에서 확인):
 *  ① '범위': 같은 위젯이 두 화면에 — 두 화면의 칸 크기를 모두 범위에 넣는다. 세로(접힘)에서 고른 크기는 안쪽 칸, 가로(펼침)에서 고른 크기는 바깥 칸이 되어
 *     늘 반대 화면 모양이 그려지고, 접고 펴도 다시 그리지 않아 한 그림이 두 화면에 번갈아 보인다.
 *  ② '화면마다': 같은 위젯이 두 화면에 — 접고 펼 때 그 화면의 칸 크기로 옵션을 바꿔 보낸다 → WIDGET_RESIZED 로 곧 그 화면 크기로 다시 그린다.
 *  ③ '따로': 두 화면에 서로 다른 위젯(번호가 다름). 바깥 위젯도 펼친 채 그려질 수 있다(앱 즉시 갱신 등).
 *
 * 그래서 번호와 상관없는 규칙 하나와 위젯마다의 기억으로 막는다:
 *  1) 접는 폰(기기가 짧은 변 600dp 이상 화면을 보인 적 있음 — 기기 기억 widget.frame.device)에서 지금 화면의 짧은 변이 600dp 미만(바깥 화면,
 *     앱의 넓은 창 기준 layout.mediumMin 과 같음)이면 넓은 모습을 쓰지 않는다. ②③ 모두 바깥 화면에서 그린 그림에는 넓은 모습이 없다.
 *  2) 위젯마다 '어느 화면(짧은 변)·어느 방향에서 어떤 크기를 봤는지'를 화면·방향마다 한 줄씩 기억한다 (widget.frame.<번호>, 최대 4줄).
 *     - 바깥 화면(600dp 미만)에서 본 줄이 있고 지금 폭이 그 화면에 들어가면(폭 ≤ 그 화면 짧은 변) 넓은 모습을 쓰지 않는다 —
 *       ③ 바깥 위젯을 펼친 채 그려도, ① 바깥 칸 크기로 그려도 바깥 화면에 넓은 모습이 나오지 않는다.
 *     - 두 화면에서 본 적이 있으면 넓은 모습은 본 것 중 가장 좁은 폭이 허락할 때만.
 *  3) (플래그 widgetFoldBoth, 서버 기본 꺼짐 — 폰에서 ①로 확인된 뒤에만 켠다) ①로 보이면 두 화면에 모두 들어가는 크기(폭 = 본 것 중 가장 작은 폭,
 *     높이 = 가장 작은 높이)로 배치를 고르고 그림에서 남는 오른쪽·아래는 투명 (render.tsx). ③의 안쪽 위젯도 ①처럼 보여 칸이 비므로 기본은 끈다.
 *
 * 기억을 믿는 규칙 (검증 지적 — 접은 뒤 홈 화면을 열기 전 그린 옛 옵션 크기가 기억을 지우던 것):
 *  - 런처가 알려 준 크기(WIDGET_RESIZED·WIDGET_ADDED)는 그 줄을 바꾼다. 그 줄도 런처가 알려 준 크기였는데 달라졌으면(크기 조절·격자·화면 확대) 다른 줄은 버린다.
 *  - 그 밖의 그리기(주기·앱·백그라운드·↻)는 없던 줄을 더하거나 같은 크기의 본 시각만 새로 한다. 다른 크기는 옛 옵션일 수 있어 믿지 않고,
 *    그 줄을 FRAME_STALE_MS 동안 한 번도 같은 크기로 보지 못했을 때만 바꾼다 (알림 없이 크기가 바뀐 경우).
 *  - FRAME_FORGET_MS 동안 못 본 줄은 버리고, 위젯을 지우면 기억도 지운다. 읽고 적기는 한 줄로 세운다 (태스크 핸들러와 앱이 같은 키를 동시에 고치지 않게).
 * 플래그가 꺼져 있으면 읽지도 적지도 않는다 (지금과 똑같은 그림).
 */

export interface ScreenLike {
  screenWidthDp?: number;
  screenHeightDp?: number;
  density?: number;
}

/** 위젯 하나의 지금 크기 (라이브러리 WidgetInfo 와 같은 이름) */
export interface BoxInfo {
  widgetId?: number;
  width: number;
  height: number;
  screenInfo?: ScreenLike | null;
}

/** 크기를 알게 된 길: resize = 크기 변경 알림(WIDGET_RESIZED) · add = 위젯 추가(WIDGET_ADDED) · draw = 그 밖의 그리기(주기·앱·백그라운드·↻) */
export type SeenBy = "resize" | "add" | "draw";

/** 한 화면·한 방향에서 본 위젯 크기 (dp) */
export interface SeenSize {
  /** 방향 (라이브러리와 같은 기준 — 화면 폭 > 높이면 가로 l, 아니면 세로 p) */
  o: "p" | "l";
  /** 그때 화면의 짧은 변 (dp) — 어느 화면인지 가르는 데 쓴다 */
  sw: number;
  w: number;
  h: number;
  /** 이 크기를 마지막으로 본 시각 */
  at: number;
  /** 런처가 알려 준 크기(알림·추가)로 확인한 줄 — 그리기만으로 본 크기는 옛 화면 옵션일 수 있다 */
  t?: 1;
  /** 크기 변경 알림이 이 크기 그대로 온 마지막 시각 (접고 펼 때 런처가 이 화면 크기를 다시 보냄 — '화면마다' 증거) */
  r?: number;
}

export interface FrameMemo {
  /** 화면·방향마다 한 줄 (최대 MAX_SEEN — 넘으면 가장 오래 못 본 줄부터 버린다) */
  seen: SeenSize[];
}

/** 기기 기억 (위젯 번호와 상관없음): 짧은 변 WIDE_SCREEN_MIN 이상 화면을 마지막으로 본 시각 — 있으면 접는 폰(또는 태블릿) */
export interface DeviceMemo {
  big?: number;
}

/** 어떻게 맞췄는지: none = 지금 크기 그대로 · wide = 넓은 모습만 막거나 좁힘 · both = 두 화면에 모두 들어가는 크기 (widgetFoldBoth) */
export type FrameFit = "none" | "wide" | "both";

/** 배치를 고를 크기 */
export interface LayoutBox {
  width: number;
  height: number;
  /** 넓은 모습(평가금액 칸·두 열·지수 옆 칸)을 고를 때 쓰는 가장 넓은 폭. 0 이면 넓은 모습 없음. 없으면 width */
  wideWidth?: number;
  fit: FrameFit;
}

/** 그릴 크기: width·height 로 배치를 고르고, outerWidth·outerHeight 는 실제 그림 크기 (넘는 곳은 투명 — render.tsx) */
export interface RenderFrame extends LayoutBox {
  outerWidth: number;
  outerHeight: number;
}

/** 켠 기능 (서버 플래그 widgetFoldFit · widgetFoldBoth) */
export interface FoldFlags {
  fit: boolean;
  both?: boolean;
}

/** 다른 화면·방향의 크기를 믿는 기간 (이만큼 그 화면에서 보지 못하면 버린다 — 한 화면에서만 쓰게 되면 지금 그림으로 돌아간다) */
export const FRAME_FORGET_MS = 14 * 86_400_000;
/**
 * 그리기만으로 다른 크기를 봤을 때 기다리는 시간: 그 줄을 이만큼 한 번도 같은 크기로 보지 못했으면 바꾼다.
 * 접은 뒤 바깥 홈 화면을 열기 전에는 옵션이 옛 화면 것이라 몇 시간이고 옛 크기로 그려질 수 있다 (주머니 속 — 검증 지적)
 */
export const FRAME_STALE_MS = 86_400_000;
/** 접는 폰으로 보는 기간 (넓은 화면을 이만큼 못 보면 일반 폰으로 본다 — 백업을 다른 폰에 옮긴 경우 등) */
export const DEVICE_FORGET_MS = 90 * 86_400_000;
/**
 * 두 크기를 본 화면의 짧은 변이 이 비율 넘게 다르면 다른 화면. 폴드 바깥 ↔ 안쪽은 30% 넘게 다르다 (폴드8 캡처 약 594 ↔ 880dp, 420dpi 추정 475 ↔ 704dp).
 * 폰을 돌리면 가로의 짧은 변에서 상태 표시줄·아래 막대가 빠져 10~20% 짧아질 수 있다 (안드로이드 14 이하) — 이것은 같은 화면으로 본다
 */
export const DISPLAY_DIFF = 0.25;
/** 넓은 모습을 쓸 수 있는 화면의 짧은 변 (dp) — 앱의 넓은 창 기준(layout.mediumMin 600, 폴드8 바깥 약 475~594 · 안쪽 704~880)과 같다 */
export const WIDE_SCREEN_MIN = layout.mediumMin;
/** 기억하는 화면·방향 줄 수 (폴드: 두 화면 × 두 방향) */
export const MAX_SEEN = 4;
/** 크기가 같아도 이만큼 지나면 본 시각을 다시 적는다 (잊는 기간을 늘리려고 — 그리기마다 적지 않게) */
const TOUCH_MS = 3_600_000;

const valid = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/** 화면 방향 (라이브러리와 같은 기준: 폭 > 높이면 가로). 화면 크기를 모르면 null */
export function orientationOf(s: ScreenLike | null | undefined): "p" | "l" | null {
  const w = s?.screenWidthDp;
  const h = s?.screenHeightDp;
  if (!valid(w) || !valid(h)) return null;
  return w > h ? "l" : "p";
}

/** 화면의 짧은 변 (dp). 모르면 null */
export function shortSide(s: ScreenLike | null | undefined): number | null {
  const w = s?.screenWidthDp;
  const h = s?.screenHeightDp;
  return valid(w) && valid(h) ? Math.min(w, h) : null;
}

/** 두 짧은 변이 서로 다른 화면인지 */
export function differentDisplays(a: number, b: number): boolean {
  return Math.abs(a - b) / Math.max(a, b) > DISPLAY_DIFF;
}

/** 넓은 모습을 쓸 수 없는 좁은 화면인지 (짧은 변 600dp 미만 — 폴드 바깥 화면·일반 폰) */
export const narrowScreen = (sw: number) => sw < WIDE_SCREEN_MIN;

/** FRAME_FORGET_MS 가 지난 줄·증거를 버린다 */
function fresh(seen: readonly SeenSize[], now: number): SeenSize[] {
  return seen
    .filter((s) => now - s.at <= FRAME_FORGET_MS)
    .map((s) => {
      if (s.r === undefined || now - s.r <= FRAME_FORGET_MS) return s;
      const { r: _r, ...rest } = s;
      return rest;
    });
}

/**
 * 지금 본 크기를 기억에 더한다 (순수 함수). 방향·크기를 모르면 그대로. by: 크기를 알게 된 길 (위 설명 '기억을 믿는 규칙')
 */
export function remember(memo: FrameMemo | null | undefined, box: BoxInfo, now: number, by: SeenBy = "draw"): FrameMemo {
  const o = orientationOf(box.screenInfo);
  const sw = shortSide(box.screenInfo);
  if (!o || sw === null || !valid(box.width) || !valid(box.height)) return memo ?? { seen: [] };
  const told = by !== "draw";
  const cur: SeenSize = { o, sw, w: box.width, h: box.height, at: now, ...(told ? { t: 1 as const } : {}), ...(by === "resize" ? { r: now } : {}) };
  const seen = fresh(memo?.seen ?? [], now);
  const i = seen.findIndex((s) => s.o === o && !differentDisplays(s.sw, sw));
  const put = (row: SeenSize) => seen.map((s, j) => (j === i ? row : s));
  if (i < 0) {
    // 처음 본 화면·방향: 더한다 (넘치면 가장 오래 못 본 줄부터 버린다)
    const next = [...seen, cur];
    while (next.length > MAX_SEEN) next.splice(next.indexOf(next.reduce((a, b) => (b.at < a.at ? b : a))), 1);
    return { seen: next };
  }
  const old = seen[i]!;
  if (old.w === box.width && old.h === box.height) {
    // 같은 크기: 본 시각을 새로. 알림으로 같은 크기가 오면 '화면마다' 증거 (접고 펼 때 런처가 이 화면 크기를 다시 보냄)
    const r = by === "resize" ? now : old.r;
    return { seen: put({ o, sw, w: old.w, h: old.h, at: now, ...(told || old.t ? { t: 1 as const } : {}), ...(r !== undefined ? { r } : {}) }) };
  }
  if (!told) {
    // 그리기만으로 본 다른 크기: 옛 화면 옵션일 수 있어 믿지 않는다. 그 줄을 오래(FRAME_STALE_MS) 같은 크기로 못 봤을 때만 바꾼다
    return now - old.at > FRAME_STALE_MS ? { seen: put(cur) } : { seen };
  }
  // 런처가 알려 준 다른 크기: 그 줄을 바꾼다. 그 줄도 런처가 알려 준 크기였으면 크기 조절·격자·화면 확대 → 다른 화면·방향의 옛 크기도 믿지 않는다
  return old.t ? { seen: [cur] } : { seen: put(cur) };
}

/** 두 줄을 세로·가로로 (방향이 같으면 null) */
function portraitLandscape(a: SeenSize, b: SeenSize): [SeenSize, SeenSize] | null {
  if (a.o === b.o) return null;
  return a.o === "p" ? [a, b] : [b, a];
}

/**
 * 기억으로 본 홈 화면 모양: one = 한 화면에서만 봄 · range = 한 그림이 두 화면에 번갈아 보이는 것 같음(①, ③의 안쪽 위젯도 이렇게 보인다)
 * · perScreen = 화면마다 그 크기로 다시 그림(②). widgetFoldBoth 가 켜져 있을 때 range 면 두 화면에 들어가는 카드로 그린다
 */
export function launcherOf(memo: FrameMemo | null | undefined): "one" | "range" | "perScreen" {
  const seen = memo?.seen ?? [];
  let two = false;
  let sameSize = false;
  let differs = false;
  for (let i = 0; i < seen.length; i++) {
    for (let j = i + 1; j < seen.length; j++) {
      const a = seen[i]!;
      const b = seen[j]!;
      // 범위 런처라면 어느 화면에서든 세로 = (좁은 폭, 큰 높이), 가로 = (넓은 폭, 작은 높이) — 이 모양이 아니면 화면마다 따로 알려 준 것
      const pl = portraitLandscape(a, b);
      if (pl && (pl[0].w > pl[1].w || pl[0].h < pl[1].h)) differs = true;
      if (!differentDisplays(a.sw, b.sw)) continue;
      two = true;
      if (a.o === b.o) {
        if (a.w === b.w && a.h === b.h) sameSize = true;
        else differs = true;
      }
    }
  }
  if (!two) return "one";
  if (differs) return "perScreen";
  if (sameSize) return "range";
  // 모양만으로는 가릴 수 없음: 두 화면 모두에서 크기 변경 알림이 기억과 같은 크기로 온 적이 있으면(접을 때·펼 때) 화면마다.
  // 한 화면에서 한 번 온 알림(런처를 다시 시작해 옵션을 다시 보냄 등)만으로는 바꾸지 않는다 (검증 지적)
  const echoed = seen.filter((s) => s.r !== undefined);
  const echoTwo = echoed.some((a) => echoed.some((b) => differentDisplays(a.sw, b.sw)));
  return echoTwo ? "perScreen" : "range";
}

/**
 * 배치를 고를 크기 (위 설명의 1·2·3). 기억에는 지금 크기가 이미 들어 있어야 한다 (remember 다음에 부른다).
 * foldable: 이 기기가 넓은 화면(짧은 변 600dp 이상)을 보인 적이 있는지 (일반 폰은 false — 지금 그림 그대로)
 */
export function frameOf(memo: FrameMemo | null | undefined, box: BoxInfo, opts: { both?: boolean; foldable?: boolean } = {}): LayoutBox {
  if (!valid(box.width) || !valid(box.height)) return { width: box.width, height: box.height, fit: "none" };
  const seen = memo?.seen ?? [];
  const kind = launcherOf(memo);
  let width = box.width;
  let height = box.height;
  let fit: FrameFit = "none";
  if (opts.both && kind === "range") {
    width = Math.min(box.width, ...seen.map((s) => s.w));
    height = Math.min(box.height, ...seen.map((s) => s.h));
    if (width < box.width || height < box.height) fit = "both";
  }
  // 넓은 모습을 고를 폭: 두 화면에서 본 적이 있으면 본 것 중 가장 좁은 폭까지
  let wide = kind === "one" ? width : Math.min(width, ...seen.map((s) => s.w));
  // 접는 폰: 지금 바깥 화면이거나, 바깥 화면에서 본 적이 있고 지금 폭이 그 화면에 들어가면 넓은 모습 없음 (위 설명 1·2)
  if (opts.foldable) {
    const sw = shortSide(box.screenInfo);
    if ((sw !== null && narrowScreen(sw)) || seen.some((s) => narrowScreen(s.sw) && width <= s.sw)) wide = 0;
  }
  if (wide < width) return { width, height, wideWidth: wide, fit: fit === "both" ? "both" : "wide" };
  return { width, height, fit };
}

const key = (id: number) => `widget.frame.${id}`;
/** 기기 기억 키 (DeviceMemo) */
export const DEVICE_KEY = "widget.frame.device";

function parseMemo(raw: string | null | undefined): FrameMemo | null {
  try {
    const v = raw ? (JSON.parse(raw) as FrameMemo) : null;
    if (!v || typeof v !== "object" || !Array.isArray(v.seen)) return null;
    const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
    const rows = v.seen.flatMap((x): SeenSize[] => {
      const y = x as SeenSize | null;
      if (!y || typeof y !== "object" || (y.o !== "p" && y.o !== "l") || !valid(y.w) || !valid(y.h) || !valid(y.sw) || !num(y.at)) return [];
      return [{ o: y.o, sw: y.sw, w: y.w, h: y.h, at: y.at, ...(y.t === 1 ? { t: 1 as const } : {}), ...(num(y.r) ? { r: y.r } : {}) }];
    });
    return { seen: rows.slice(0, MAX_SEEN) };
  } catch {
    return null;
  }
}

function parseDevice(raw: string | null | undefined): DeviceMemo {
  try {
    const v = raw ? (JSON.parse(raw) as DeviceMemo) : null;
    return v && typeof v.big === "number" && Number.isFinite(v.big) ? { big: v.big } : {};
  } catch {
    return {};
  }
}

/** 다시 적어야 하는지: 화면·방향·크기·확인·증거가 바뀌었거나, 본 시각이 TOUCH_MS 넘게 지났을 때 */
function worthSaving(a: FrameMemo | null, b: FrameMemo): boolean {
  if (!a || a.seen.length !== b.seen.length) return true;
  return b.seen.some((y, i) => {
    const x = a.seen[i]!;
    return x.o !== y.o || x.sw !== y.sw || x.w !== y.w || x.h !== y.h || x.t !== y.t || x.r !== y.r || y.at - x.at > TOUCH_MS;
  });
}

/** 크기 기억 읽고 적기를 한 줄로 (같은 JS 안에서 태스크 핸들러·앱 즉시 갱신이 같은 키를 동시에 읽고 고쳐 한쪽 것을 잃지 않게) */
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

/**
 * 위젯 하나를 그릴 크기. 켜져 있으면(widgetFoldFit) 지금 크기를 기억에 적고 위 규칙으로 고른 크기를 돌려준다.
 * 꺼져 있거나 저장소를 못 읽으면 지금 크기 그대로. 위젯 번호를 모르면 기기 규칙(1)만. by: 크기를 알게 된 길 (remember)
 */
export async function frameFor(box: BoxInfo, flags: FoldFlags, now = Date.now(), by: SeenBy = "draw"): Promise<RenderFrame> {
  const plain: RenderFrame = { width: box.width, height: box.height, fit: "none", outerWidth: box.width, outerHeight: box.height };
  if (!flags.fit) return plain;
  const id = typeof box.widgetId === "number" ? box.widgetId : null;
  return serial(async () => {
    let memo: FrameMemo | null = null;
    let device: DeviceMemo = {};
    try {
      const got = new Map(await AsyncStorage.multiGet(id !== null ? [key(id), DEVICE_KEY] : [DEVICE_KEY]));
      if (id !== null) memo = parseMemo(got.get(key(id)));
      device = parseDevice(got.get(DEVICE_KEY));
    } catch {
      return plain;
    }
    const sw = shortSide(box.screenInfo);
    const bigNow = sw !== null && !narrowScreen(sw);
    if (bigNow && (device.big === undefined || now - device.big > TOUCH_MS)) await AsyncStorage.setItem(DEVICE_KEY, JSON.stringify({ big: now })).catch(() => undefined);
    const foldable = bigNow || (device.big !== undefined && now - device.big <= DEVICE_FORGET_MS);
    let next: FrameMemo | null = null;
    if (id !== null) {
      next = remember(memo, box, now, by);
      if (worthSaving(memo, next)) await AsyncStorage.setItem(key(id), JSON.stringify(next)).catch(() => undefined);
    }
    return { ...frameOf(next, box, { both: flags.both === true, foldable }), outerWidth: box.width, outerHeight: box.height };
  });
}

/** 설정 '화면 정보' 진단용: 위젯마다의 기억과 기기 기억을 읽기만 한다 (없거나 못 읽으면 null) */
export async function readFrames(ids: readonly number[]): Promise<{ memos: Map<number, FrameMemo | null>; device: DeviceMemo } | null> {
  try {
    const got = new Map(await AsyncStorage.multiGet([...ids.map(key), DEVICE_KEY]));
    return { memos: new Map(ids.map((id) => [id, parseMemo(got.get(key(id)))])), device: parseDevice(got.get(DEVICE_KEY)) };
  } catch {
    return null;
  }
}

/** 위젯을 지우면 기억도 지운다 (플래그와 상관없이 — 지우기만 한다) */
export async function forgetFrame(id: number): Promise<void> {
  await serial(() => AsyncStorage.removeItem(key(id)).catch(() => undefined));
}
