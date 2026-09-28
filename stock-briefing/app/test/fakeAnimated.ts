/**
 * 테스트용 RN Animated (노드 환경). 값·interpolate·multiply 를 실제처럼 계산하고, timing·loop 는 시작만 기록한다
 * (끝내기는 테스트가 finish() 로). 로그인 그림(LoginHero)이 시계 하나에 붙인 속성들을 "시계가 t 일 때" 값으로 읽어
 * 순수 함수(lib/loginHero heroFrame)와 같은지 본다.
 */
export abstract class FakeNode {
  abstract get(): number;
  interpolate(cfg: { inputRange: number[]; outputRange: number[]; extrapolate?: string }): FakeNode {
    return new FakeInterp(this, cfg);
  }
}

export function interp(cfg: { inputRange: number[]; outputRange: number[] }, x: number): number {
  const xs = cfg.inputRange;
  const ys = cfg.outputRange;
  for (let i = 1; i < xs.length; i++) if (xs[i]! < xs[i - 1]!) throw new Error("inputRange 는 커지는 순서여야 합니다 (네이티브 드라이버 규칙)");
  if (x <= xs[0]!) return ys[0]!;
  const n = xs.length - 1;
  if (x >= xs[n]!) return ys[n]!;
  for (let i = 1; i <= n; i++) {
    if (x <= xs[i]!) {
      const r = xs[i] === xs[i - 1] ? 1 : (x - xs[i - 1]!) / (xs[i]! - xs[i - 1]!);
      return ys[i - 1]! + r * (ys[i]! - ys[i - 1]!);
    }
  }
  return ys[n]!;
}

class FakeInterp extends FakeNode {
  constructor(
    private src: FakeNode,
    private cfg: { inputRange: number[]; outputRange: number[] },
  ) {
    super();
  }
  get(): number {
    return interp(this.cfg, this.src.get());
  }
}

export class FakeValue extends FakeNode {
  constructor(public v: number) {
    super();
  }
  get(): number {
    return this.v;
  }
  setValue(v: number): void {
    this.v = v;
  }
  /** 움직임을 멈추고 지금 값을 알려 준다 (RN 과 같다) */
  stopAnimation(cb?: (v: number) => void): void {
    cb?.(this.v);
  }
}

class FakeMul extends FakeNode {
  constructor(
    private a: FakeNode,
    private b: FakeNode,
  ) {
    super();
  }
  get(): number {
    return this.a.get() * this.b.get();
  }
}

export interface FakeTiming {
  kind: "timing";
  value: FakeValue;
  config: { toValue: number; duration?: number; delay?: number; useNativeDriver?: boolean; isInteraction?: boolean };
  started: boolean;
  stopped: boolean;
  start: (cb?: (r: { finished: boolean }) => void) => void;
  stop: () => void;
  /** 끝까지 간 것으로 (값 = toValue, 콜백 finished: true) */
  finish: () => void;
}
export interface FakeLoop {
  kind: "loop";
  inner: FakeTiming;
  started: boolean;
  stopped: boolean;
  start: () => void;
  stop: () => void;
}

export function makeFakeAnimated() {
  const started: (FakeTiming | FakeLoop)[] = [];
  const timing = (value: FakeValue, config: FakeTiming["config"]): FakeTiming => {
    let cb: ((r: { finished: boolean }) => void) | undefined;
    const t: FakeTiming = {
      kind: "timing",
      value,
      config,
      started: false,
      stopped: false,
      start(c) {
        t.started = true;
        cb = c;
        started.push(t);
      },
      stop() {
        if (t.stopped) return;
        t.stopped = true;
        cb?.({ finished: false });
      },
      finish() {
        value.setValue(config.toValue);
        cb?.({ finished: true });
      },
    };
    return t;
  };
  const loop = (inner: FakeTiming): FakeLoop => {
    const l: FakeLoop = {
      kind: "loop",
      inner,
      started: false,
      stopped: false,
      start() {
        l.started = true;
        started.push(l);
      },
      stop() {
        l.stopped = true;
      },
    };
    return l;
  };
  const Animated = {
    View: "Animated.View",
    Value: FakeValue,
    timing,
    loop,
    multiply: (a: FakeNode, b: FakeNode) => new FakeMul(a, b),
    sequence: () => ({ start() {}, stop() {} }),
  };
  const Easing = { linear: (x: number) => x, out: (f: (x: number) => number) => f, cubic: (x: number) => x * x * x };
  return { Animated, Easing, started };
}

/** 스타일 값(배열·중첩·Animated 노드)을 숫자로 풀어 한 객체로 */
export function flatStyle(style: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const walk = (s: unknown) => {
    if (!s) return;
    if (Array.isArray(s)) return s.forEach(walk);
    if (typeof s !== "object") return;
    for (const [k, v] of Object.entries(s as Record<string, unknown>)) out[k] = resolve(v);
  };
  walk(style);
  return out;
}
function resolve(v: unknown): unknown {
  if (v instanceof FakeNode) return v.get();
  if (Array.isArray(v)) return v.map(resolve);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, resolve(x)]));
  return v;
}

/** 절대 위치 View 의 보이는 세로 자리: 보통 변형처럼 가운데 기준 [translateY, scaleY] 를 적용 */
export function visibleBox(style: Record<string, unknown>, parentTop = 0): { x: number; y: number; w: number; h: number; opacity: number } {
  const top = (style.top as number) ?? 0;
  const left = (style.left as number) ?? 0;
  const h = (style.height as number) ?? 0;
  const w = (style.width as number) ?? 0;
  let ty = 0;
  let sy = 1;
  for (const t of (style.transform as Record<string, number>[] | undefined) ?? []) {
    if ("translateY" in t) ty += t.translateY!;
    if ("scaleY" in t) sy *= t.scaleY!;
  }
  const c = parentTop + top + h / 2 + ty;
  return { x: left, y: c - (sy * h) / 2, w, h: sy * h, opacity: (style.opacity as number) ?? 1 };
}
