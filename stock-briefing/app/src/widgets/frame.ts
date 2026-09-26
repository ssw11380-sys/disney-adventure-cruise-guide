import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * 폴드 위젯 크기 맞추기 (위젯 2차, 플래그 widgetFoldFit — 서버 /api/widget features, 앱 fallback 꺼짐).
 * 한 위젯이 바깥 화면(접힘)과 안쪽 화면(펼침 — 커버 화면 미러링 켬)에 함께 보일 때 두 화면 모두에서 맞게 그린다.
 *
 * 라이브러리(react-native-android-widget 0.22.1)가 하는 일 — RNWidgetUtil · RNWidgetProvider · RNWidget · res/layout/rn_widget.xml:
 *  - 그림 크기는 그리는 순간 앱의 화면 방향 하나로 고른다. 세로면 (가장 좁은 폭 × 가장 큰 높이), 가로면 (가장 넓은 폭 × 가장 작은 높이).
 *    런처가 알려 준 크기 범위(OPTION_APPWIDGET_MIN/MAX_*)에서 고른다.
 *  - 위젯 하나에 그림 한 장(라이트·다크)만 준다. 같은 위젯이 두 화면에 나오면 두 화면이 같은 그림을 쓴다.
 *  - 그림은 늘이지 않고 왼쪽 위에 붙는다 (scaleType="matrix"). 칸보다 크면 오른쪽·아래가 잘리고, 작으면 남는 곳이 빈다.
 *  - 다시 그리는 때: 런처가 위젯 옵션을 보내고 방향으로 고른 크기가 마지막으로 적어 둔 것과 다를 때(WIDGET_RESIZED), 주기 갱신(30분), 앱·백그라운드 작업·↻.
 *  - JS 는 그 순간의 크기(widgetInfo)와 화면 크기(screenInfo)만 안다. 다른 화면의 칸 크기는 모른다.
 *
 * 삼성 런처가 크기를 알려 주는 방식은 둘 중 하나다:
 *  - '범위': 두 화면의 칸 크기를 모두 범위에 넣는다 (Launcher3 폴드 방식). 그러면 어느 화면에 있든 세로에서 본 크기는 늘 같고(좁은 폭 × 큰 높이),
 *    가로에서 본 크기도 늘 같아(넓은 폭 × 작은 높이) 두 벌이 실제 화면과 엇갈린다. 접고 펴도 옵션이 같으면 다시 그리지 않아 한 그림이 두 화면에 번갈아 보인다.
 *  - '화면마다': 접고 펼 때 그 화면의 칸 크기로 옵션을 바꿔 보낸다 → WIDGET_RESIZED 로 곧 그 화면 크기로 다시 그린다.
 *    2026-09-26 캡처(같은 분에 두 화면이 서로 다른 그림, 각자 제 칸 모양)는 이쪽을 가리킨다.
 *
 * 그래서 위젯마다 '어느 화면(짧은 변)·어느 방향에서 어떤 크기를 봤는지'를 화면·방향마다 한 줄씩 기억한다 (방향만으로 묶으면 한 화면을 돌린 것이
 * 다른 화면의 기억을 덮어 배운 것을 잃는다 — 검증 지적). 서로 다른 화면(짧은 변이 DISPLAY_DIFF 넘게 다름 — 폴드 바깥/안쪽)에서 본 적이 있으면:
 *  - 두 화면에서 같은 방향으로 같은 크기를 봄 → '범위' (확실) → "both"
 *  - 두 화면에서 같은 방향으로 다른 크기를 봄, 또는 세로·가로 두 벌이 라이브러리 규칙 모양(세로 = 좁고 높음)이 아님 → '화면마다' (확실) → "wide"
 *  - 둘 다 아니면 크기 변경 알림이 기억과 같은 크기로 왔는지(접고 펼 때 온 알림 — perScreen 증거)를 본다. 있으면 "wide", 없으면 "both"
 *  "both": 두 화면에 모두 들어가는 크기(폭 = 본 것 중 가장 작은 폭, 높이 = 가장 작은 높이)로 배치를 고르고 그림에서 남는 오른쪽·아래는 투명 (render.tsx).
 *  "wide": 지금 크기로 그리되 넓은 모습(평가금액 칸·두 열·지수 옆 칸)은 본 것 중 가장 좁은 폭이 허락할 때만.
 *  "none": 한 화면에서만 봤으면(일반 폰을 돌린 것, 안쪽에서만 보이는 위젯을 펼친 채로만 그림) 지금과 똑같다.
 * 같은 화면·방향에서 크기가 바뀌면(크기 조절·격자·화면 확대) 다른 기억과 증거는 모두 버린다. FRAME_FORGET_MS 가 지난 줄도 버리고, 위젯을 지우면 기억도 지운다.
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

/** 한 화면·한 방향에서 본 위젯 크기 (dp) */
export interface SeenSize {
  /** 방향 (라이브러리와 같은 기준 — 화면 폭 > 높이면 가로 l, 아니면 세로 p) */
  o: "p" | "l";
  /** 그때 화면의 짧은 변 (dp) — 어느 화면인지 가르는 데 쓴다 */
  sw: number;
  w: number;
  h: number;
  /** 마지막으로 본 시각 */
  at: number;
}

export interface FrameMemo {
  /** 화면·방향마다 한 줄 (최대 MAX_SEEN — 넘으면 가장 오래 못 본 줄부터 버린다) */
  seen: SeenSize[];
  /**
   * '화면마다' 런처 증거를 마지막으로 본 시각: 크기 변경 알림(WIDGET_RESIZED)이 왔는데 그 화면·방향의 크기가 기억과 같았다
   * (크기는 그대로인데 옵션이 바뀜 = 접고 펼 때 그 화면 크기로 다시 보낸 것). FRAME_FORGET_MS 가 지나면 버린다
   */
  ps?: number;
}

/** 어떻게 맞췄는지 (위 설명): none = 지금 크기 그대로 · wide = 넓은 모습만 가장 좁은 폭까지 · both = 두 화면에 모두 들어가는 크기 */
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

/** 다른 화면·방향의 크기를 믿는 기간 (이만큼 그 화면에서 보지 못하면 버린다 — 한 화면에서만 쓰게 되면 지금 그림으로 돌아간다) */
export const FRAME_FORGET_MS = 14 * 86_400_000;
/**
 * 두 크기를 본 화면의 짧은 변이 이 비율 넘게 다르면 다른 화면. 폴드 바깥 ↔ 안쪽은 30% 넘게 다르다 (폴드8 캡처 약 594 ↔ 880dp, 420dpi 추정 475 ↔ 704dp).
 * 폰을 돌리면 가로의 짧은 변에서 상태 표시줄·아래 막대가 빠져 10~20% 짧아질 수 있다 (안드로이드 14 이하) — 이것은 같은 화면으로 본다
 */
export const DISPLAY_DIFF = 0.25;
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

/** 두 짧은 변이 서로 다른 화면인지 */
export function differentDisplays(a: number, b: number): boolean {
  return Math.abs(a - b) / Math.max(a, b) > DISPLAY_DIFF;
}

/**
 * 지금 본 크기를 기억에 더한다 (순수 함수). 방향·크기를 모르면 그대로.
 * resized: 이 그리기가 크기 변경 알림(WIDGET_RESIZED) 때문인지 — 크기가 기억과 같으면 '화면마다' 런처 증거
 */
export function remember(memo: FrameMemo | null | undefined, box: BoxInfo, now: number, resized = false): FrameMemo {
  const o = orientationOf(box.screenInfo);
  if (!o || !valid(box.width) || !valid(box.height)) return memo ?? { seen: [] };
  const sw = Math.min(box.screenInfo!.screenWidthDp!, box.screenInfo!.screenHeightDp!);
  const cur: SeenSize = { o, sw, w: box.width, h: box.height, at: now };
  const seen = (memo?.seen ?? []).filter((s) => now - s.at <= FRAME_FORGET_MS);
  const ps = memo?.ps !== undefined && now - memo.ps <= FRAME_FORGET_MS ? memo.ps : undefined;
  const i = seen.findIndex((s) => s.o === o && !differentDisplays(s.sw, sw));
  if (i < 0) {
    // 처음 본 화면·방향: 더한다 (넘치면 가장 오래 못 본 줄부터 버린다)
    const next = [...seen, cur];
    while (next.length > MAX_SEEN) next.splice(next.indexOf(next.reduce((a, b) => (b.at < a.at ? b : a))), 1);
    return { seen: next, ...(ps !== undefined ? { ps } : {}) };
  }
  const same = seen[i]!;
  // 같은 화면·방향인데 크기가 바뀜 = 크기 조절·격자·화면 확대가 바뀜 → 다른 화면·방향의 옛 크기도, 런처 증거도 믿지 않는다
  if (same.w !== box.width || same.h !== box.height) return { seen: [cur] };
  const next = seen.map((s, j) => (j === i ? cur : s));
  const evidence = resized ? now : ps;
  return { seen: next, ...(evidence !== undefined ? { ps: evidence } : {}) };
}

/** 두 줄을 세로·가로로 (방향이 같으면 null) */
function portraitLandscape(a: SeenSize, b: SeenSize): [SeenSize, SeenSize] | null {
  if (a.o === b.o) return null;
  return a.o === "p" ? [a, b] : [b, a];
}

/**
 * 기억으로 본 런처 모양: one = 한 화면에서만 봄 · range = 한 그림이 두 화면에 번갈아 보임 · perScreen = 화면마다 그 크기로 다시 그림
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
  // 모양만으로는 가릴 수 없음: 접고 펼 때 크기 변경 알림이 온 적 있으면 화면마다, 아니면 한 그림이 두 화면에 보이는 것으로 (둘 다에 들어가게)
  return memo?.ps !== undefined ? "perScreen" : "range";
}

/**
 * 배치를 고를 크기 (위 설명의 none · wide · both). 기억에는 지금 크기가 이미 들어 있어야 한다 (remember 다음에 부른다)
 */
export function frameOf(memo: FrameMemo | null | undefined, box: BoxInfo): LayoutBox {
  const plain: LayoutBox = { width: box.width, height: box.height, fit: "none" };
  const seen = memo?.seen ?? [];
  if (!valid(box.width) || !valid(box.height)) return plain;
  const kind = launcherOf(memo);
  if (kind === "one") return plain;
  const narrow = Math.min(box.width, ...seen.map((s) => s.w));
  if (kind === "range") return { width: narrow, height: Math.min(box.height, ...seen.map((s) => s.h)), fit: "both" };
  return narrow < box.width ? { width: box.width, height: box.height, wideWidth: narrow, fit: "wide" } : plain;
}

const key = (id: number) => `widget.frame.${id}`;

function parse(raw: string | null): FrameMemo | null {
  try {
    const v = raw ? (JSON.parse(raw) as FrameMemo) : null;
    if (!v || typeof v !== "object" || !Array.isArray(v.seen)) return null;
    const ok = (x: unknown): x is SeenSize => {
      const y = x as SeenSize | null;
      return !!y && typeof y === "object" && (y.o === "p" || y.o === "l") && valid(y.w) && valid(y.h) && valid(y.sw) && typeof y.at === "number" && Number.isFinite(y.at);
    };
    const ps = typeof v.ps === "number" && Number.isFinite(v.ps) ? v.ps : undefined;
    return { seen: v.seen.filter(ok).slice(0, MAX_SEEN), ...(ps !== undefined ? { ps } : {}) };
  } catch {
    return null;
  }
}

/** 다시 적어야 하는지: 화면·방향·크기·증거가 바뀌었거나, 본 시각이 TOUCH_MS 넘게 지났을 때 */
function worthSaving(a: FrameMemo | null, b: FrameMemo): boolean {
  if (!a || a.seen.length !== b.seen.length) return true;
  if ((a.ps === undefined) !== (b.ps === undefined) || (a.ps !== undefined && b.ps! - a.ps > TOUCH_MS)) return true;
  return b.seen.some((y, i) => {
    const x = a.seen[i]!;
    return x.o !== y.o || x.sw !== y.sw || x.w !== y.w || x.h !== y.h || y.at - x.at > TOUCH_MS;
  });
}

/**
 * 위젯 하나를 그릴 크기. 켜져 있으면(widgetFoldFit) 지금 크기를 기억에 적고 두 화면에 맞춘 크기를 돌려준다.
 * 꺼져 있거나, 위젯 번호를 모르거나, 저장소를 못 읽으면 지금 크기 그대로.
 * resized: 크기 변경 알림(WIDGET_RESIZED) 때문에 그리는지 (remember)
 */
export async function frameFor(box: BoxInfo, enabled: boolean, now = Date.now(), resized = false): Promise<RenderFrame> {
  const plain: RenderFrame = { width: box.width, height: box.height, fit: "none", outerWidth: box.width, outerHeight: box.height };
  const id = box.widgetId;
  if (!enabled || typeof id !== "number") return plain;
  let memo: FrameMemo | null;
  try {
    memo = parse(await AsyncStorage.getItem(key(id)));
  } catch {
    return plain;
  }
  const next = remember(memo, box, now, resized);
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
