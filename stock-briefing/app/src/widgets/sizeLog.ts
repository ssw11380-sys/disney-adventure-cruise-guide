import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * 위젯 크기 진단 기록 (위젯 2차, 플래그 widgetFoldFit 이 켜져 있을 때만 적음). **배치에는 쓰지 않는다** — 넓은 모습은 위젯 폭 하나로만 정한다
 * (layout.ts wideExtrasOk). 이 기록은 설정 > 화면 정보 '공유' 글의 [위젯] 줄(diagnose.ts)에만 쓴다.
 *
 * 폴드 홈 화면이 위젯을 어떻게 두는지(① 한 그림을 두 화면이 같이 씀 · ② 화면마다 다시 그림 · ③ 두 화면에 따로 놓음)를 폰에서 알아보려고,
 * 위젯마다 최근에 받은 크기(widgetInfo)·그때 앱 화면 크기·알게 된 길을 몇 줄만 적는다. 서버로 보내지 않는다.
 *  - 같은 번호가 좁은 화면·넓은 화면에서 모두 그려졌으면 ①·②, 크기 변경 알림으로 크기가 번갈아 오면 ②, 같은 이름의 번호가 둘이면 ③
 * 잃어도 되는 기록이라 읽기·쓰기 실패는 모두 무시한다 (그리기를 막지 않는다). 읽고 고치기는 한 줄로 세운다 (태스크 핸들러와 앱이 동시에 적어도 한쪽을 잃지 않게)
 */

/** 크기를 알게 된 길: add = 위젯 추가 · resize = 크기 변경 알림 · update = 위젯 주기 갱신 · click = ↻·손익 누름 · app = 앱 즉시 갱신·백그라운드 작업·다시 그리기 */
export type SizeSource = "add" | "resize" | "update" | "click" | "app";

/** 한 번 받은 크기 (dp) */
export interface SizeRow {
  w: number;
  h: number;
  /** 그때 앱 화면의 폭·높이 (screenInfo, dp — 모르면 없음) */
  sw?: number;
  sh?: number;
  by: SizeSource;
  /** 마지막으로 본 시각 (같은 줄이 이어지면 TOUCH_MS 마다 새로) */
  at: number;
}

/** 위젯 번호 → 최근 줄 (오래된 것부터) */
export type SizeLog = Record<string, SizeRow[]>;

/** 한 키에 모두 (위젯 번호마다 키를 만들지 않는다 — 지운 위젯의 키가 남지 않게) */
export const SIZE_LOG_KEY = "widget.sizeLog";
/** 위젯 하나에 남기는 줄 수 */
export const SIZE_ROWS = 6;
/** 남기는 위젯 수 (넘으면 가장 오래 못 본 위젯부터 버린다) */
export const SIZE_WIDGETS = 8;
/** 같은 줄이 이어질 때 본 시각을 다시 적는 간격 (그리기마다 적지 않게) */
const TOUCH_MS = 3_600_000;

const SOURCES: readonly SizeSource[] = ["add", "resize", "update", "click", "app"];
const pos = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/** 위젯 하나의 지금 크기 (라이브러리 WidgetInfo 와 같은 이름) */
export interface SizeBox {
  widgetId?: number;
  width: number;
  height: number;
  screenInfo?: { screenWidthDp?: number; screenHeightDp?: number } | null;
}

/** 깨진 값은 버린다 */
export function parseSizeLog(raw: string | null | undefined): SizeLog {
  try {
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: SizeLog = {};
    for (const [id, rows] of Object.entries(v as Record<string, unknown>)) {
      if (!/^\d+$/.test(id) || !Array.isArray(rows)) continue;
      const ok = rows.flatMap((x): SizeRow[] => {
        const r = x as Partial<SizeRow> | null;
        if (!r || !pos(r.w) || !pos(r.h) || !SOURCES.includes(r.by as SizeSource) || typeof r.at !== "number" || !Number.isFinite(r.at)) return [];
        return [{ w: r.w, h: r.h, ...(pos(r.sw) && pos(r.sh) ? { sw: r.sw, sh: r.sh } : {}), by: r.by as SizeSource, at: r.at }];
      });
      if (ok.length) out[id] = ok.slice(-SIZE_ROWS);
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * 지금 크기를 기록에 더한다 (순수 함수). 다시 적을 필요가 없으면 null — 마지막 줄과 크기·화면·길이 같고 TOUCH_MS 안이면.
 * 같으면 본 시각만 새로, 다르면 줄을 더하고(위젯마다 SIZE_ROWS 줄), 위젯이 SIZE_WIDGETS 개를 넘으면 가장 오래 못 본 위젯을 버린다
 */
export function addSize(log: SizeLog, box: SizeBox, by: SizeSource, now: number): SizeLog | null {
  if (typeof box.widgetId !== "number" || !pos(box.width) || !pos(box.height)) return null;
  const id = String(box.widgetId);
  const sw = box.screenInfo?.screenWidthDp;
  const sh = box.screenInfo?.screenHeightDp;
  const row: SizeRow = { w: box.width, h: box.height, ...(pos(sw) && pos(sh) ? { sw, sh } : {}), by, at: now };
  const rows = log[id] ?? [];
  const last = rows.at(-1);
  const same = !!last && last.w === row.w && last.h === row.h && last.sw === row.sw && last.sh === row.sh && last.by === row.by;
  if (same && now - last.at < TOUCH_MS) return null;
  const next: SizeLog = { ...log, [id]: same ? [...rows.slice(0, -1), row] : [...rows, row].slice(-SIZE_ROWS) };
  const ids = Object.keys(next);
  if (ids.length > SIZE_WIDGETS) {
    const seen = (k: string) => Math.max(...next[k]!.map((r) => r.at));
    for (const k of ids.sort((a, b) => seen(a) - seen(b)).slice(0, ids.length - SIZE_WIDGETS)) delete next[k];
  }
  return next;
}

/** 기록 읽고 고치기를 한 줄로 */
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

/** 지금 크기를 적는다 (실패는 무시 — 그리기를 막지 않는다) */
export async function noteWidgetSize(box: SizeBox, by: SizeSource, now: number): Promise<void> {
  await serial(async () => {
    const next = addSize(parseSizeLog(await AsyncStorage.getItem(SIZE_LOG_KEY)), box, by, now);
    if (next) await AsyncStorage.setItem(SIZE_LOG_KEY, JSON.stringify(next));
  }).catch(() => undefined);
}

/** 진단용으로 읽기만 (못 읽으면 빈 기록) */
export async function readSizeLog(): Promise<SizeLog> {
  return serial(async () => parseSizeLog(await AsyncStorage.getItem(SIZE_LOG_KEY))).catch(() => ({}));
}

/** 위젯을 지우면 그 위젯 줄도 지운다 (플래그와 상관없이 — 지우기만 한다) */
export async function forgetWidgetSize(id: number): Promise<void> {
  await serial(async () => {
    const log = parseSizeLog(await AsyncStorage.getItem(SIZE_LOG_KEY));
    if (!(String(id) in log)) return;
    delete log[String(id)];
    await AsyncStorage.setItem(SIZE_LOG_KEY, JSON.stringify(log));
  }).catch(() => undefined);
}
