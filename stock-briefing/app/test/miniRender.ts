import React from "react";

/**
 * 렌더러 패키지(react-dom·react-test-renderer) 없이 화면 함수 컴포넌트를 "훅 상태·key 를 지키며" 다시 그려 보는 최소 렌더러.
 * 입력 칸의 초안이 다시 그릴 때 남는지·지워지는지 같은 회귀(PF-06·07)를 노드 환경에서 본다.
 *  - 같은 자리·같은 타입·같은 key 면 상태 유지, key 나 타입이 바뀌면 새로 만든다 (React 재조정 규칙)
 *  - 훅: useState·useReducer·useEffect·useLayoutEffect·useMemo·useCallback·useRef·useContext(가까운 Provider 값, 없으면 기본값)
 *    ·useSyncExternalStore(바깥 저장소 — 바뀌면 다음 flush 에서 다시 그림)
 *  - 그리는 중 자기 상태를 바꾸면(이전 렌더 값 저장 패턴) 그 컴포넌트를 바로 다시 그린다
 *  - 문자열 타입 요소만 결과 트리에 남긴다 (RN 부품은 테스트에서 문자열 타입으로 가짜 모듈을 둔다)
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
}
interface Dispatcher {
  [name: string]: unknown;
}

const internals = (React as unknown as { __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: Dispatcher | null } })
  .__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

const changed = (a: Deps, b: Deps) => !a || !b || a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]));

export function render(element: React.ReactElement) {
  let root = element;
  let tree: (HostNode | string)[] = [];
  const instances = new Map<string, Instance>();
  const typeIds = new WeakMap<object, number>();
  let dirty = false;
  const effects: (() => void)[] = [];
  let current: Instance | null = null;
  let cursor = 0;
  let again = false;
  let pendingEffects: { i: number; create: () => unknown; deps: Deps }[] = [];

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
      else dirty = true;
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
  function refHook(init: unknown) {
    const { inst, i } = hookOf();
    if (!(i in inst.hooks)) inst.hooks[i] = { current: init };
    return inst.hooks[i];
  }

  // 바깥 저장소 구독: 그릴 때 값을 읽고, 구독 함수가 바뀌면 다시 구독한다. 저장소가 바뀌면 다음 flush 에서 다시 그린다 (지우면 구독 해제)
  function externalStoreHook<T>(subscribe: (onChange: () => void) => () => void, getSnapshot: () => T): T {
    const { inst, i } = hookOf();
    const prev = inst.hooks[i] as (EffectHook & { subscribe?: unknown }) | undefined;
    if (!prev || prev.subscribe !== subscribe) {
      prev?.cleanup?.();
      const hook: EffectHook & { subscribe?: unknown } = { subscribe };
      inst.hooks[i] = hook;
      hook.cleanup = subscribe(() => {
        if (!inst.dead) dirty = true;
      });
    }
    return getSnapshot();
  }

  const dispatcher: Dispatcher = {
    useSyncExternalStore: externalStoreHook,
    useState: stateHook,
    useReducer: reducerHook,
    useEffect: effect,
    useLayoutEffect: effect,
    useInsertionEffect: effect,
    useMemo: memoHook,
    useCallback: (fn: unknown, deps: Deps) => memoHook(() => fn, deps),
    useRef: refHook,
    useContext: (ctx: { _currentValue: unknown }) => ctx._currentValue,
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
    return node(out, iid, 0, seen);
  };

  const pass = () => {
    const seen = new Set<string>();
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

  const flush = () => {
    let n = 0;
    do {
      dirty = false;
      pass();
      if (++n > 25) throw new Error("다시 그리기가 끝나지 않습니다");
    } while (dirty);
  };

  flush();

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
