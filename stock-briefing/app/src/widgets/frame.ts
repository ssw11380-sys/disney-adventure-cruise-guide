import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * 폴드 위젯 크기 맞추기 (위젯 2차, 플래그 widgetFoldFit — 서버 /api/widget features, 앱 fallback 꺼짐).
 * 한 위젯이 바깥 화면(접힘)과 안쪽 화면(펼침 — 커버 화면 미러링 켬)에 함께 보일 때 두 화면 모두에서 맞게 그린다.
 *
 * 라이브러리(react-native-android-widget 0.22.1)가 하는 일 — RNWidgetUtil · RNWidgetProvider · RNWidget · res/layout/rn_widget.xml:
 *  - 그림 크기는 그리는 순간 앱의 화면 방향 하나로 고른다. 세로면 (가장 좁은 폭 × 가장 큰 높이), 가로면 (가장 넓은 폭 × 가장 작은 높이).
 *    런처가 알려 준 크기 범위(OPTION_APPWIDGET_MIN/MAX_*)에서 고르므로, 런처가 두 화면의 칸 크기를 모두 넣어 주면
 *    두 벌이 실제 화면과 엇갈린다 (폴드8: 접으면 세로 → 안쪽 칸의 좁은 폭·큰 높이, 펴면 가로 → 바깥 칸의 넓은 폭·작은 높이).
 *  - 위젯 하나에 그림 한 장(라이트·다크)만 준다. 미러링이면 같은 위젯이 두 화면에 나오므로 두 화면이 같은 그림을 쓴다.
 *  - 그림은 늘이지 않고 왼쪽 위에 붙는다 (scaleType="matrix"). 칸보다 크면 오른쪽·아래가 잘리고, 작으면 남는 곳이 빈다.
 *  - 다시 그리는 때: 런처가 크기 범위를 바꿀 때(WIDGET_RESIZED), 주기 갱신(30분), 앱·백그라운드 작업·↻.
 *    접고 펴도 범위가 그대로면 다시 그리지 않아, 다른 화면에서 그린 그림이 다음 갱신까지 남는다.
 *  - JS 는 그 순간의 크기(widgetInfo)와 화면 크기(screenInfo)만 안다. 다른 화면의 칸 크기는 모른다.
 *
 * 그래서 위젯마다 두 방향(세로·가로)에서 본 크기를 기억해 두고, 두 방향을 서로 다른 화면(짧은 변이 DISPLAY_DIFF 넘게 다름 — 폴드 바깥/안쪽)에서 봤으면:
 *  - "both": 엇갈린 두 벌(세로 = 좁고 높음, 가로 = 넓고 낮음 — 위 라이브러리 규칙 모양)이면 한 그림이 두 화면에 번갈아 보이므로
 *    두 화면에 모두 들어가는 크기(폭 = 작은 폭, 높이 = 작은 높이)로 배치를 고른다. 그림에서 남는 오른쪽·아래는 투명 (render.tsx).
 *  - "wide": 그렇지 않으면(런처가 화면마다 크기를 바꿔 알려 줌 → 접고 펼 때마다 WIDGET_RESIZED 로 그 화면 크기로 다시 그린다)
 *    지금 크기로 그리되, 넓은 모습(평가금액 칸·두 열·지수 옆 칸)은 좁은 쪽 화면의 폭이 허락할 때만.
 *  - "none": 한 방향만 봤거나, 같은 화면을 돌린 것(일반 폰 — 짧은 변이 같다)이면 지금과 똑같다.
 * 같은 방향에서 크기가 바뀌면(크기 조절·격자·화면 확대) 다른 방향의 옛 크기는 버린다. FRAME_FORGET_MS 가 지나도 버리고, 위젯을 지우면 기억도 지운다.
 * 플래그가 꺼져 있으면 읽지도 적지도 않는다 (지금과 똑같은 그림).
 */

export interface ScreenLike {
  screenWidthDp?: number;
  screenHeightDp?: number;
}

/** 위젯 하나의 지금 크기 (라이브러리 WidgetInfo 와 같은 이름) */
export interface BoxInfo {
  widgetId?: number;
  width: number;
  height: number;
  screenInfo?: ScreenLike | null;
}

/** 한 방향에서 본 크기 (dp) · 그때 화면의 짧은 변 (dp, 같은 크기를 여러 화면에서 봤으면 가장 짧은 것) · 본 시각 */
export interface SeenSize {
  w: number;
  h: number;
  sw: number;
  at: number;
}

/** p: 세로 (폴드 접힘 — 바깥 화면), l: 가로 (폴드 펼침 — 안쪽 화면) */
export interface FrameMemo {
  p?: SeenSize;
  l?: SeenSize;
}

/** 어떻게 맞췄는지 (위 설명): none = 지금 크기 그대로 · wide = 넓은 모습만 좁은 화면 폭까지 · both = 두 화면에 모두 들어가는 크기 */
export type FrameFit = "none" | "wide" | "both";

/** 배치를 고를 크기 */
export interface LayoutBox {
  width: number;
  height: number;
  /** 넓은 모습(평가금액 칸·두 열·지수 옆 칸)을 고를 때 쓰는 가장 넓은 폭. 없으면 width */
  wideWidth?: number;
  fit: FrameFit;
}

/** 그릴 크기: width·height 로 배치를 고르고, outerWidth·outerHeight 는 실제 그림 크기 (넘는 곳은 투명 — render.tsx) */
export interface RenderFrame extends LayoutBox {
  outerWidth: number;
  outerHeight: number;
}

/** 다른 방향의 크기를 믿는 기간 (이만큼 접고 펴지 않으면 한 방향 크기로 돌아간다) */
export const FRAME_FORGET_MS = 14 * 86_400_000;
/** 두 방향의 화면 짧은 변이 이 비율 넘게 다르면 다른 화면 (폴드 바깥 약 475~594dp ↔ 안쪽 약 704~880dp). 폰을 돌린 것은 같다 */
export const DISPLAY_DIFF = 0.1;
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

/** 두 방향의 화면이 서로 다른 화면인지 (짧은 변 비교) */
export function differentDisplays(a: number, b: number): boolean {
  return Math.abs(a - b) / Math.max(a, b) > DISPLAY_DIFF;
}

/** 지금 본 크기를 기억에 더한다 (순수 함수). 방향·크기를 모르면 그대로 */
export function remember(memo: FrameMemo | null | undefined, box: BoxInfo, now: number): FrameMemo {
  const o = orientationOf(box.screenInfo);
  if (!o || !valid(box.width) || !valid(box.height)) return memo ?? {};
  const s = box.screenInfo!;
  const other = o === "p" ? "l" : "p";
  const same = memo?.[o];
  const sizeKept = !!same && same.w === box.width && same.h === box.height;
  const sw = Math.min(s.screenWidthDp!, s.screenHeightDp!);
  // 같은 크기를 다른 화면에서도 봤으면(엇갈린 두 벌은 방향만 같으면 같은 크기 — 안쪽 화면을 세로로 돌려도) 가장 짧은 변을 둔다
  const seen: SeenSize = { w: box.width, h: box.height, sw: sizeKept ? Math.min(same.sw, sw) : sw, at: now };
  let kept = memo?.[other];
  // 같은 방향인데 크기가 바뀜 = 크기 조절·격자·화면 확대가 바뀜 → 다른 방향의 옛 크기는 믿지 않는다
  if (kept && same && !sizeKept) kept = undefined;
  if (kept && now - kept.at > FRAME_FORGET_MS) kept = undefined;
  return o === "p" ? { p: seen, ...(kept ? { l: kept } : {}) } : { l: seen, ...(kept ? { p: kept } : {}) };
}

/**
 * 배치를 고를 크기 (위 설명의 none · wide · both). 기억에는 지금 크기가 이미 들어 있어야 한다 (remember 다음에 부른다)
 */
export function frameOf(memo: FrameMemo | null | undefined, box: BoxInfo): LayoutBox {
  const plain: LayoutBox = { width: box.width, height: box.height, fit: "none" };
  const p = memo?.p;
  const l = memo?.l;
  if (!p || !l || !valid(box.width) || !valid(box.height) || !differentDisplays(p.sw, l.sw)) return plain;
  const narrow = Math.min(p.w, l.w);
  // 라이브러리 규칙 모양으로 엇갈림 → 한 그림이 두 화면에 번갈아 보인다
  if (p.w <= l.w && p.h >= l.h) return { width: Math.min(narrow, box.width), height: Math.min(p.h, l.h, box.height), fit: "both" };
  return narrow < box.width ? { width: box.width, height: box.height, wideWidth: narrow, fit: "wide" } : plain;
}

const key = (id: number) => `widget.frame.${id}`;

function parse(raw: string | null): FrameMemo | null {
  try {
    const v = raw ? (JSON.parse(raw) as FrameMemo) : null;
    if (!v || typeof v !== "object") return null;
    const ok = (x: unknown): x is SeenSize => {
      const y = x as SeenSize | null;
      return !!y && typeof y === "object" && valid(y.w) && valid(y.h) && valid(y.sw) && typeof y.at === "number" && Number.isFinite(y.at);
    };
    return { ...(ok(v.p) ? { p: v.p } : {}), ...(ok(v.l) ? { l: v.l } : {}) };
  } catch {
    return null;
  }
}

/** 다시 적어야 하는지: 크기·화면·가진 방향이 바뀌었거나, 본 시각이 TOUCH_MS 넘게 지났을 때 */
function worthSaving(a: FrameMemo | null, b: FrameMemo): boolean {
  for (const o of ["p", "l"] as const) {
    const x = a?.[o];
    const y = b[o];
    if (!x !== !y) return true;
    if (x && y && (x.w !== y.w || x.h !== y.h || x.sw !== y.sw || y.at - x.at > TOUCH_MS)) return true;
  }
  return false;
}

/**
 * 위젯 하나를 그릴 크기. 켜져 있으면(widgetFoldFit) 지금 크기를 기억에 적고 두 화면에 맞춘 크기를 돌려준다.
 * 꺼져 있거나, 위젯 번호를 모르거나, 저장소를 못 읽으면 지금 크기 그대로
 */
export async function frameFor(box: BoxInfo, enabled: boolean, now = Date.now()): Promise<RenderFrame> {
  const plain: RenderFrame = { width: box.width, height: box.height, fit: "none", outerWidth: box.width, outerHeight: box.height };
  const id = box.widgetId;
  if (!enabled || typeof id !== "number") return plain;
  let memo: FrameMemo | null;
  try {
    memo = parse(await AsyncStorage.getItem(key(id)));
  } catch {
    return plain;
  }
  const next = remember(memo, box, now);
  if (worthSaving(memo, next)) await AsyncStorage.setItem(key(id), JSON.stringify(next)).catch(() => undefined);
  return { ...frameOf(next, box), outerWidth: box.width, outerHeight: box.height };
}

/** 앱이 떠 있을 때 접거나 펴면(화면 크기가 바뀜) 위젯을 다시 그리기까지 기다리는 시간 — 접는 동안 여러 번 오는 크기 변경을 한 번으로 */
export const FOLD_REDRAW_DELAY_MS = 1_000;

/** 화면(창이 아닌 기기 화면) 크기가 바뀌었는지: 접기·펴기·돌리기. 1dp 미만 차이(반올림)는 같다고 본다 */
export function screenChanged(a: { width: number; height: number } | null | undefined, b: { width: number; height: number } | null | undefined): boolean {
  if (!a || !b) return false;
  return Math.round(a.width) !== Math.round(b.width) || Math.round(a.height) !== Math.round(b.height);
}

/** 위젯을 지우면 기억도 지운다 (플래그와 상관없이 — 지우기만 한다) */
export async function forgetFrame(id: number): Promise<void> {
  await AsyncStorage.removeItem(key(id)).catch(() => undefined);
}
