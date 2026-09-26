import React from "react";

/**
 * 렌더러 패키지(react-dom·react-test-renderer) 없이 화면 함수 컴포넌트를 "훅 상태·key 를 지키며" 다시 그려 보는 최소 렌더러.
 * 입력 칸의 초안이 다시 그릴 때 남는지·지워지는지 같은 회귀(PF-06·07)를 노드 환경에서 본다.
 *  - 같은 자리·같은 타입·같은 key 면 상태 유지, key 나 타입이 바뀌면 새로 만든다 (React 재조정 규칙)
 *  - 훅: useState·useReducer·useEffect·useLayoutEffect·useMemo·useCallback·useRef·useId(인스턴스마다 고정된 id)·useContext(가까운 Provider 값, 없으면 기본값)
 *    · useSyncExternalStore(react-query 의 useQuery 가 쓴다): 그린 뒤 구독하고, 저장소가 알려 오면 값이 바뀐 경우에만 바로 다시 그린다
 *      → 체결이 와도 다시 그리지 않는지(렌더 횟수)를 실제 QueryClient 로 볼 수 있다. 바뀐 컴포넌트는 memo 건너뛰기에서도 다시 그린다
 *  - 그리는 중 자기 상태를 바꾸면(이전 렌더 값 저장 패턴) 그 컴포넌트를 바로 다시 그린다
 *  - 문자열 타입 요소만 결과 트리에 남긴다 (RN 부품은 테스트에서 문자열 타입으로 가짜 모듈을 둔다)
 *  - React.memo: 기본은 속성 비교 없이 늘 다시 그린다. render(el, { memo: true }) 면 React 처럼 속성이 같고(compare 가 있으면 그것으로)
 *    그 아래에서 상태·바깥 저장소가 바뀌지 않았으면 다시 그리지 않고 지난 결과를 쓴다 (다시 그리지 않는지 보는 회귀 테스트용)
 */
export interface HostNode {
  type: string;
  props: Record<string, unknown>;
  children: (HostNode | string)[];
}

type Deps = readonly unknown[] | undefined;
interface EffectHook {
  deps?: Deps;
  cleanup?: () => void;
}
interface Instance {
  hooks: unknown[];
  dead: boolean;
  /** memo 부품의 지난 속성·결과·그 아래 인스턴스 id ({ memo: true } 일 때만) */
  memo?: { props: Record<string, unknown>; out: (HostNode | string)[]; ids: Set<string> };
}
interface Dispatcher {
  [name: string]: unknown;
}

const internals = (React as unknown as { __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: Dispatcher | null } })
  .__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

const changed = (a: Deps, b: Deps) => !a || !b || a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]));

const shallowEqual = (a: Record<string, unknown>, b: Record<string, unknown>) => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && Object.is(a[k], b[k]));
};

/** 아직 닫지 않은 렌더들 (cleanupRenders 가 닫는다) */
const liveRenders = new Set<() => void>();

/**
 * 지금까지 만든 렌더를 모두 닫는다 (testing-library 의 cleanup 과 같다): 인스턴스를 지우고 effect 정리·바깥 저장소 구독 해제.
 * 바깥 저장소가 알리면 바로 다시 그리므로, 앞 테스트의 화면이 열린 채 남아 있으면 모듈 저장소를 지울 때 그 화면이 다시 그려져
 * 다음 테스트에 끼어든다 → 모듈 저장소를 쓰는 테스트 파일은 beforeEach 에서 부른다
 */
export function cleanupRenders(): void {
  for (const close of [...liveRenders]) close();
}

export function render(element: React.ReactElement, opts: { memo?: boolean } = {}) {
  let root = element;
  let tree: (HostNode | string)[] = [];
  const instances = new Map<string, Instance>();
  const typeIds = new WeakMap<object, number>();
  let dirty = false;
  let flushing = false;
  const effects: (() => void)[] = [];
  let current: Instance | null = null;
  let cursor = 0;
  let again = false;
  let pendingEffects: { i: number; create: () => unknown; deps: Deps }[] = [];
  /** 지난 그리기 뒤에 상태·바깥 저장소가 바뀐 인스턴스 (memo 건너뛰기를 막는다). touchedNow 는 이번 그리기에서 보는 몫 */
  const touched = new Set<Instance>();
  let touchedNow = new Set<Instance>();

  let nextTypeId = 0;
  const typeId = (t: object) => {
    if (!typeIds.has(t)) typeIds.set(t, ++nextTypeId);
    return typeIds.get(t);
  };
  const hookOf = () => {
    if (!current) throw new Error("훅은 컴포넌트를 그리는 중에만 쓸 수 있습니다");
    return { inst: current, i: cursor++ };
  };
  // effect 는 그 컴포넌트를 끝까지 그린 뒤 deps 가 바뀐 것만 반영한다 (그리는 중 다시 그리면 앞선 시도는 버림)
  const effect = (create: () => unknown, deps: Deps) => {
    const { i } = hookOf();
    pendingEffects.push({ i, create, deps });
  };
  function reducerHook<S, A>(reducer: (s: S, a: A) => S, arg: unknown, init?: (a: unknown) => S): [S, (a: A) => void] {
    const { inst, i } = hookOf();
    if (!(i in inst.hooks)) inst.hooks[i] = { value: init ? init(arg) : arg };
    const hook = inst.hooks[i] as { value: S; dispatch?: (a: A) => void };
    hook.dispatch ??= (a: A) => {
      if (inst.dead) return;
      const next = reducer(hook.value, a);
      if (Object.is(next, hook.value)) return;
      hook.value = next;
      if (current === inst) again = true;
      else {
        dirty = true;
        touched.add(inst);
      }
    };
    return [hook.value, hook.dispatch];
  }
  const call = (f: unknown, ...args: unknown[]) => (f as (...a: unknown[]) => unknown)(...args);
  const stateHook = (init: unknown) =>
    reducerHook<unknown, unknown>((s, a) => (typeof a === "function" ? call(a, s) : a), init, (v) => (typeof v === "function" ? call(v) : v));
  function memoHook<T>(fn: () => T, deps: Deps): T {
    const { inst, i } = hookOf();
    const h = inst.hooks[i] as { value: T; deps: Deps } | undefined;
    if (h && !changed(h.deps, deps)) return h.value;
    const value = fn();
    inst.hooks[i] = { value, deps };
    return value;
  }
  // 외부 저장소: 그린 뒤 구독(effect 와 같은 때), 알림이 오면 값이 바뀐 경우에만 다시 그린다 (React 와 같은 규칙)
  function storeHook(subscribe: (onChange: () => void) => () => void, getSnapshot: () => unknown) {
    const { inst, i } = hookOf();
    const value = getSnapshot();
    if (!(i in inst.hooks)) inst.hooks[i] = { value, get: getSnapshot };
    const box = inst.hooks[i] as { value: unknown; get: () => unknown };
    box.value = value;
    box.get = getSnapshot;
    effect(
      () =>
        subscribe(() => {
          if (inst.dead || Object.is(box.get(), box.value)) return;
          dirty = true;
          touched.add(inst);
          if (!flushing) flush();
        }),
      [subscribe],
    );
    return value;
  }
  let nextId = 0;
  // React 19.2 와 같은 모양의 id ('_r_1_'), 인스턴스가 살아 있는 동안 그대로
  function idHook() {
    const { inst, i } = hookOf();
    if (!(i in inst.hooks)) inst.hooks[i] = `_r_${(++nextId).toString(32)}_`;
    return inst.hooks[i] as string;
  }
  function refHook(init: unknown) {
    const { inst, i } = hookOf();
    if (!(i in inst.hooks)) inst.hooks[i] = { current: init };
    return inst.hooks[i];
  }

  const dispatcher: Dispatcher = {
    useState: stateHook,
    useReducer: reducerHook,
    useEffect: effect,
    useLayoutEffect: effect,
    useInsertionEffect: effect,
    useMemo: memoHook,
    useCallback: (fn: unknown, deps: Deps) => memoHook(() => fn, deps),
    useRef: refHook,
    useId: idHook,
    useContext: (ctx: { _currentValue: unknown }) => ctx._currentValue,
    useSyncExternalStore: storeHook,
    useDebugValue() {},
  };

  const children = (list: React.ReactNode, parent: string, seen: Set<string>): (HostNode | string)[] => {
    const arr = Array.isArray(list) ? list : [list];
    return arr.flatMap((c: React.ReactNode, i: number) => (Array.isArray(c) ? children(c, `${parent}/a${i}`, seen) : node(c, parent, i, seen)));
  };

  const node = (el: React.ReactNode, parent: string, index: number, seen: Set<string>): (HostNode | string)[] => {
    if (el === null || el === undefined || typeof el === "boolean") return [];
    if (typeof el === "string" || typeof el === "number") return [String(el)];
    if (!React.isValidElement(el)) return [];
    const e = el as React.ReactElement<Record<string, unknown>>;
    const id = `${parent}/${e.key !== null ? `k:${e.key}` : `i:${index}`}`;
    const { type, props } = e;
    if (type === React.Fragment) return children(props.children as React.ReactNode, id, seen);
    // 컨텍스트 공급자(React 19 는 Context 자체가 Provider): 그 아래를 그리는 동안만 값을 바꾼다
    if (typeof type === "object" && type !== null && (type as { $$typeof?: symbol }).$$typeof === Symbol.for("react.context")) {
      const ctx = type as unknown as { _currentValue: unknown };
      const prev = ctx._currentValue;
      ctx._currentValue = props.value;
      try {
        return children(props.children as React.ReactNode, id, seen);
      } finally {
        ctx._currentValue = prev;
      }
    }
    if (typeof type === "string") return [{ type, props, children: children(props.children as React.ReactNode, id, seen) }];
    // React.memo 는 속성 비교 없이 늘 다시 그린다 (결과는 같다)
    const isMemo = typeof type === "object" && type !== null && (type as { $$typeof?: symbol }).$$typeof === Symbol.for("react.memo");
    const fn: unknown = isMemo ? (type as unknown as { type: unknown }).type : type;
    if (typeof fn !== "function") throw new Error(`지원하지 않는 요소: ${String(type)}`);
    const iid = `${id}:${typeId(fn)}`;
    seen.add(iid);
    let inst = instances.get(iid);
    if (!inst) {
      inst = { hooks: [], dead: false };
      instances.set(iid, inst);
    }
    const memoOn = isMemo && opts.memo === true;
    if (memoOn && inst.memo) {
      const compare = (type as unknown as { compare?: ((a: unknown, b: unknown) => boolean) | null }).compare ?? shallowEqual;
      const quiet = !touchedNow.has(inst) && ![...inst.memo.ids].some((x) => {
        const d = instances.get(x);
        return d !== undefined && touchedNow.has(d);
      });
      if (quiet && compare(inst.memo.props, props)) {
        for (const x of inst.memo.ids) seen.add(x);
        return inst.memo.out;
      }
    }
    let out: React.ReactNode;
    let tries = 0;
    do {
      again = false;
      current = inst;
      cursor = 0;
      pendingEffects = [];
      out = (fn as (p: unknown) => React.ReactNode)(props);
      if (++tries > 25) throw new Error("그리는 중 상태 변경이 끝나지 않습니다");
    } while (again);
    current = null;
    // 마지막으로 그린 결과의 effect 만 반영 (deps 가 바뀐 것만)
    for (const p of pendingEffects) {
      const prev = inst.hooks[p.i] as EffectHook | undefined;
      if (prev && !changed(prev.deps, p.deps)) continue;
      const hook: EffectHook = { deps: p.deps, cleanup: prev?.cleanup };
      inst.hooks[p.i] = hook;
      effects.push(() => {
        hook.cleanup?.();
        const c = p.create();
        hook.cleanup = typeof c === "function" ? (c as () => void) : undefined;
      });
    }
    if (!memoOn) return node(out, iid, 0, seen);
    // memo 부품: 그 아래 인스턴스 id 를 따로 모아 두었다가, 다음에 건너뛸 때 살아 있는 것으로 센다
    const sub = new Set<string>();
    const result = node(out, iid, 0, sub);
    for (const x of sub) seen.add(x);
    inst.memo = { props, out: result, ids: sub };
    return result;
  };

  const pass = () => {
    const seen = new Set<string>();
    touchedNow = new Set(touched);
    touched.clear();
    const prev = internals.H;
    internals.H = dispatcher;
    try {
      tree = node(root, "", 0, seen);
    } finally {
      internals.H = prev;
      current = null;
    }
    for (const [iid, inst] of instances) {
      if (seen.has(iid)) continue;
      inst.dead = true;
      instances.delete(iid);
      for (const h of inst.hooks) (h as EffectHook | undefined)?.cleanup?.();
    }
    while (effects.length) effects.shift()!();
  };

  function flush() {
    let n = 0;
    flushing = true;
    try {
      do {
        dirty = false;
        pass();
        if (++n > 25) throw new Error("다시 그리기가 끝나지 않습니다");
      } while (dirty);
    } finally {
      flushing = false;
    }
  }

  flush();

  function unmount() {
    liveRenders.delete(unmount);
    for (const [iid, inst] of instances) {
      inst.dead = true;
      instances.delete(iid);
      for (const h of inst.hooks) (h as EffectHook | undefined)?.cleanup?.();
    }
    tree = [];
  }
  liveRenders.add(unmount);

  const all = (nodes: (HostNode | string)[] = tree): HostNode[] => nodes.flatMap((n) => (typeof n === "string" ? [] : [n, ...all(n.children)]));

  return {
    get tree() {
      return tree;
    },
    /** 새 속성·새 서버 값으로 다시 그린다 (부모가 다시 그리는 것과 같음) */
    rerender(next: React.ReactElement = root) {
      root = next;
      flush();
    },
    /** 누르기·입력 같은 이벤트를 보낸 뒤 바뀐 상태로 다시 그린다 */
    act(fn: () => void) {
      fn();
      flush();
    },
    all,
    /** 화면을 닫는다 (effect 정리·바깥 저장소 구독 해제) */
    unmount,
    /** 이름표(accessibilityLabel)로 요소 하나 */
    byLabel(label: string): HostNode {
      const hits = all().filter((n) => n.props.accessibilityLabel === label);
      if (hits.length !== 1) throw new Error(`"${label}" 요소가 ${hits.length}개입니다`);
      return hits[0];
    },
    has(label: string): boolean {
      return all().some((n) => n.props.accessibilityLabel === label);
    },
    /** 화면 글자 전체 (한 줄로) */
    text(): string {
      const walk = (ns: (HostNode | string)[]): string => ns.map((n) => (typeof n === "string" ? n : walk(n.children))).join("");
      return walk(tree);
    },
  };
}
