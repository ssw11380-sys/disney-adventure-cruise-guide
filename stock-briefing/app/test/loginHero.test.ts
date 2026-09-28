import { describe, expect, it } from "vitest";
import {
  BREATH_MIN,
  BREATH_MS,
  breathTrack,
  EASE_OUT,
  HERO_MS,
  heroFrame,
  heroLayout,
  heroScene,
  heroTracks,
  LIMIT_COUNT,
  LIMIT_GAP,
  LIMIT_START,
  layoutKey,
  MINI_COUNT,
  miniStairs,
  revealScrollY,
  sampleTrack,
  SIDE_COUNT,
  SIDE_GAP,
  type FrameItem,
  type HeroScene,
  type LoginLayout,
  type Track,
} from "@/lib/loginHero";
import { authLayout } from "@/tokens";

/**
 * 로그인 첫 화면 그림의 시간표·매 순간의 모습 (hero-spec.md 6·9장). 그리는 쪽(LoginHero)이 이 시간표를 네이티브 시계에 그대로 잇는다.
 *  - 시간표: 4.2초에 끝, 횡보 70ms·상한가 205ms 간격, 모두 나타나기만(줄지 않음), 숨쉬기 1 → 0.82 → 1 (3.6초)
 *  - 마지막 장면: 횡보 16 + 상한가 10, 계단이 한 칸씩 오름, 윗꼬리 없음
 *  - 모든 크기·모든 순간: 봉·꼬리가 그림 칸 안, 상한가 봉은 시가(아래) 기준으로 자람, 로고 묶음과 겹치지 않음, 로고는 입력 칸과 겹치지 않음
 */
const SIZES: [number, number, number, number][] = [
  [360, 752, 28, 24],
  [475, 751, 28, 24],
  [933, 704, 24, 16],
  [704, 933, 28, 24],
];
// 더 넓게: 작은 폰 ~ 태블릿, 세로·가로, 안전 영역 여러 값
const MANY: [number, number, number, number][] = [...SIZES];
for (const W of [320, 360, 393, 412, 475, 600, 704, 768, 840, 933, 1024, 1280])
  for (const H of [568, 640, 704, 751, 800, 933, 1024, 1366]) for (const [top, bottom] of [
    [24, 16],
    [28, 24],
    [48, 34],
  ] as const) MANY.push([W, H, top, bottom]);
const TIMES = Array.from({ length: HERO_MS / 50 + 1 }, (_, i) => i * 50);
const EPS = 0.01;

const inside = (r: { x: number; y: number; w: number; h: number }, b: { x0: number; y0: number; w: number; h: number }) =>
  r.x >= b.x0 - EPS && r.y >= b.y0 - EPS && r.x + r.w <= b.x0 + b.w + EPS && r.y + r.h <= b.y0 + b.h + EPS;
const overlaps = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const byId = (items: FrameItem[]) => Object.fromEntries(items.map((i) => [i.id, i]));
const allTracks = (): [string, Track][] => {
  const t = heroTracks();
  const out: [string, Track][] = [
    ["grid", t.grid],
    ["glow", t.glow],
    ["logo.opacity", t.logo.opacity],
    ["line", t.line],
    ["lineShow", t.lineShow],
    ["sub", t.sub],
  ];
  t.side.forEach((s, i) => out.push([`side${i}.opacity`, s.opacity], [`side${i}.scale`, s.scale]));
  t.limit.forEach((s, k) => out.push([`limit${k}.show`, s.show], [`limit${k}.grow`, s.grow], [`limit${k}.cap`, s.cap]));
  t.flames.forEach((s, i) => out.push([`flame${i}.grow`, s.grow], [`flame${i}.opacity`, s.opacity]));
  return out;
};

describe("시간표 (hero-spec 6장)", () => {
  it("모든 요소가 4.2초 안에 끝나고, 입력 시각은 커지는 순서 (네이티브 드라이버 규칙)", () => {
    const ends = allTracks().map(([, tr]) => tr.input[tr.input.length - 1]!);
    expect(Math.max(...ends, heroTracks().logo.shift.input.at(-1)!)).toBe(HERO_MS);
    for (const [name, tr] of [...allTracks(), ["logo.shift", heroTracks().logo.shift] as [string, Track]]) {
      expect(tr.input.length, name).toBe(tr.output.length);
      for (let i = 1; i < tr.input.length; i++) expect(tr.input[i]!, name).toBeGreaterThan(tr.input[i - 1]!);
    }
  });

  it("불투명도·크기는 줄지 않는다 (나타나기만 — 깜빡임 없음), 로고는 8dp 아래에서 제자리로", () => {
    for (const [name, tr] of allTracks()) for (let i = 1; i < tr.output.length; i++) expect(tr.output[i]!, name).toBeGreaterThanOrEqual(tr.output[i - 1]!);
    const shift = heroTracks().logo.shift;
    expect(shift.output[0]).toBe(8);
    expect(shift.output.at(-1)).toBe(0);
  });

  it("횡보 봉 16개는 70ms 간격(0.15~1.5초), 상한가 봉 10개는 205ms 간격(1.5~3.605초) — 몸통은 감속 곡선", () => {
    const t = heroTracks();
    expect(t.side).toHaveLength(SIDE_COUNT);
    expect(t.limit).toHaveLength(LIMIT_COUNT);
    t.side.forEach((s, i) => expect(s.scale.input[0]).toBe(150 + SIDE_GAP * i));
    expect(t.side.at(-1)!.scale.input.at(-1)).toBe(1500);
    t.limit.forEach((s, k) => expect(s.grow.input[0]).toBe(LIMIT_START + LIMIT_GAP * k));
    expect(LIMIT_GAP).toBe(205);
    expect(t.limit.at(-1)!.grow.input.at(-1)).toBe(3605);
    // 감속: 처음 10% 시간에 27% 자람 (ease-out cubic)
    expect(EASE_OUT[1]).toEqual([0.1, 0.271]);
    expect(sampleTrack(t.limit[0]!.grow, LIMIT_START + 26)).toBeCloseTo(0.271, 3);
    // 천장 띠는 몸통이 다 자란 뒤 0.08초 동안 0 → 0.55
    expect(t.limit[0]!.cap).toEqual({ input: [1760, 1840], output: [0, 0.55] });
  });

  it("숨쉬기: 3.6초에 한 번, 밝기 1 → 0.82 → 1 (코사인 모양, 18% 폭 — 깜빡임과 거리가 멀다)", () => {
    const b = breathTrack();
    expect(BREATH_MS).toBe(3600);
    expect(sampleTrack(b, 0)).toBe(1);
    expect(sampleTrack(b, 0.5)).toBeCloseTo(BREATH_MIN, 6);
    expect(sampleTrack(b, 1)).toBeCloseTo(1, 6);
    expect(Math.min(...b.output)).toBeCloseTo(0.82, 6);
    // 한 주기에 내려갔다 올라오기 한 번
    const ys = b.output;
    const turns = ys.slice(1, -1).filter((y, i) => (y - ys[i]!) * (ys[i + 2]! - y) < 0).length;
    expect(turns).toBe(1);
  });
});

describe("마지막 장면 (t = 4.2초)", () => {
  for (const [W, H, top, bottom] of SIZES) {
    it(`${W}×${H}: 횡보 16 + 상한가 10, 모두 다 보이고 제 크기, 계단이 한 칸씩 오른다`, () => {
      const scene = heroScene(heroLayout(W, H, { top, bottom }));
      const f = byId(heroFrame(scene, HERO_MS));
      expect(scene.side).toHaveLength(16);
      expect(scene.limit).toHaveLength(10);
      scene.side.forEach((c, i) => {
        expect(f[`side${i}`]!.opacity).toBe(1);
        expect(f[`side${i}`]!.rect.y).toBeCloseTo(c.box.y, 6);
        expect(f[`side${i}`]!.rect.h).toBeCloseTo(c.box.h, 6);
      });
      scene.limit.forEach((c, k) => {
        expect(f[`limit${k}`]!.opacity).toBe(1);
        expect(f[`limit${k}`]!.rect).toEqual(c.body);
        expect(f[`cap${k}`]!.opacity).toBeCloseTo(0.55, 6);
        if (k > 0) {
          const prev = scene.limit[k - 1]!;
          // 종가(몸통 위)가 정확히 한 계단씩 위로, 오른쪽으로 한 칸씩
          expect(prev.body.y - c.body.y).toBeCloseTo(scene.step, 2);
          expect(c.body.x).toBeGreaterThan(prev.body.x);
          // 시가 갭(+1.8%)만큼 전날 종가보다 조금 위에서 시작
          expect(c.body.y + c.body.h).toBeLessThan(prev.body.y + 0.1 * scene.step);
        }
      });
      // 첫 상한가 봉은 횡보 마지막 봉 종가(띠 위쪽)에서 작은 갭(한 계단의 6%)만큼 위에서 시작한다 (횡보 → 돌파)
      expect(scene.limit[0]!.body.y + scene.limit[0]!.body.h).toBeCloseTo(scene.side[15]!.bodyTop - 0.06 * scene.step, 6);
      expect(f.logo!.opacity).toBe(1);
      expect(f.logo!.rect.y).toBe(scene.logo.y);
      expect(f.line!.rect.w).toBe(authLayout.logoLineW);
      expect(f.glow!.opacity).toBe(1);
      scene.flames.forEach((fl, i) => expect(f[`flame${i}`]!.opacity).toBeCloseTo(fl.opacity, 6));
    });
  }
});

describe("모든 크기 · 모든 순간 (0~4.2초, 50ms 마다)", () => {
  // 검사가 많아(크기 약 290개 × 순간 85개 × 요소 70개) 틀린 것을 모았다가 한 번에 확인한다
  const check = (scene: HeroScene, L: LoginLayout, label: string, bad: string[]) => {
    const logo = { x: scene.logo.x, y: scene.logo.y, w: scene.logo.w + 8, h: scene.logo.h + 8 };
    for (const t of TIMES) {
      const f = heroFrame(scene, t);
      for (const it of f) {
        if (/^(side|limit|wick|cap)d/.test(it.id)) {
          // 봉·꼬리·천장 띠: 그림 칸 안
          if (!inside(it.rect, scene.plot)) bad.push(`${label} t=${t} ${it.id} 칸 밖`);
          // 상한가 봉은 로고 묶음과 겹치지 않는다 (보일 때)
          if (!it.id.startsWith("side") && it.opacity > 0 && overlaps(it.rect, logo)) bad.push(`${label} t=${t} ${it.id} 로고와 겹침`);
        }
        // 불기둥 빛은 그림 영역 가로 안, 위로는 상태 표시줄 밑까지 (화면 위 끝을 넘지 않음)
        if (/^flame|^core/.test(it.id) && (it.rect.x < 0 || it.rect.x + it.rect.w > L.heroW + EPS || it.rect.y < -EPS)) bad.push(`${label} t=${t} ${it.id} 화면 밖`);
        // 상한가 봉은 시가(몸통 아래)를 기준으로 자란다: 자라는 동안 아래 끝이 제자리
        const m = /^limit(d)$/.exec(it.id);
        if (m) {
          const c = scene.limit[+m[1]!]!;
          if (Math.abs(it.rect.y + it.rect.h - (c.body.y + c.body.h)) > 1e-6) bad.push(`${label} t=${t} ${it.id} 아래 끝이 움직임`);
        }
      }
    }
  };
  it("봉은 칸 안, 상한가 봉은 로고와 겹치지 않고, 빛은 화면 안 (작은 폰 ~ 태블릿 · 세로 · 가로)", () => {
    const bad: string[] = [];
    for (const [W, H, top, bottom] of MANY) {
      const L = heroLayout(W, H, { top, bottom });
      check(heroScene(L), L, `${W}×${H}(${top}/${bottom})`, bad);
    }
    expect(MANY.length).toBeGreaterThan(280);
    expect(bad.slice(0, 10)).toEqual([]);
  });

  it("로고 묶음은 그림 영역 안 — 입력 칸과 겹치지 않는다 (한 칸: 그림 아래 끝 위, 두 칸: 오른쪽 입력 칸 왼쪽)", () => {
    for (const [W, H, top, bottom] of MANY) {
      for (const kb of [false, true]) {
        const L = heroLayout(W, H, { top, bottom }, kb);
        const lb = heroScene(L).logo;
        const label = `${W}×${H}(${top}/${bottom})${kb ? " 키보드" : ""}`;
        expect(lb.y + lb.h, label).toBeLessThanOrEqual(L.heroH);
        expect(lb.y, label).toBeGreaterThanOrEqual(top);
        if (L.mode === "two") expect(lb.x + Math.ceil(lb.size * authLayout.wordmarkCanvas), label).toBeLessThanOrEqual(L.formX - L.gutter);
        else expect(lb.x + lb.w, label).toBeLessThanOrEqual(L.formX + L.formW);
      }
    }
  });

  it("눈금은 로고 묶음을 지나지 않는다 (지나는 줄은 로고 오른쪽에서 옅게 시작)", () => {
    for (const [W, H, top, bottom] of MANY) {
      const s = heroScene(heroLayout(W, H, { top, bottom }));
      const L = s.logo;
      for (const g of s.grid) {
        const crossesY = g.y >= L.y - 6 && g.y <= L.y + L.h + 6;
        if (crossesY && L.x < g.x2 && L.x + L.w > s.plot.x0) {
          expect(g.x1, `${W}×${H} y=${g.y}`).toBeGreaterThanOrEqual(L.x + L.w);
          expect(g.fade).toBeGreaterThan(0);
        } else expect(g.fade).toBe(0);
      }
    }
  });

  it("처음(0초)에는 봉·로고가 보이지 않고, 1.5초에는 횡보 16봉만, 3.6초에는 상한가 10봉까지 (로고는 아직)", () => {
    const s = heroScene(heroLayout(360, 752, { top: 28, bottom: 24 }));
    const vis = (t: number, re: RegExp) => heroFrame(s, t).filter((x) => re.test(x.id) && x.opacity > 0).length;
    expect(vis(0, /^(side|limit)\d/)).toBe(0);
    expect(byId(heroFrame(s, 0)).logo!.opacity).toBe(0);
    expect(byId(heroFrame(s, 0)).line!.opacity).toBe(0);
    expect(vis(1500, /^side\d/)).toBe(16);
    expect(vis(1500, /^limit\d/)).toBe(0);
    expect(vis(3600, /^limit\d/)).toBe(10);
    expect(byId(heroFrame(s, 3600)).logo!.opacity).toBe(0);
    // 2.5초: 상한가 봉 5개가 보이기 시작
    expect(vis(2500, /^limit\d/)).toBe(5);
  });
});

describe("그 밖", () => {
  it("같은 배치면 같은 열쇠 (입력할 때마다 그림을 다시 만들지 않게), 크기·키보드가 바뀌면 다른 열쇠", () => {
    const a = heroLayout(360, 752, { top: 28, bottom: 24 });
    expect(layoutKey(heroLayout(360, 752, { top: 28, bottom: 24 }))).toBe(layoutKey(a));
    expect(layoutKey(heroLayout(360, 752, { top: 28, bottom: 24 }, true))).not.toBe(layoutKey(a));
    expect(layoutKey(heroLayout(933, 704, { top: 28, bottom: 24 }))).not.toBe(layoutKey(a));
  });

  it("회원가입 머리의 작은 계단: 6개, 몸통·꼬리가 칸 안, 한 칸씩 오르고 몸통이 세로로 길다", () => {
    for (const w of [authLayout.miniStairsW, 72, 112]) {
      const { bodies, wicks } = miniStairs(w, authLayout.miniStairsH);
      expect(bodies).toHaveLength(MINI_COUNT);
      for (const x of wicks) expect(inside(x, { x0: 0, y0: 0, w, h: authLayout.miniStairsH })).toBe(true);
      if (w === authLayout.miniStairsW) for (const x of bodies) expect(x.h).toBeGreaterThan(1.5 * x.w);
      for (const [k, b] of bodies.entries()) {
        expect(inside(b, { x0: 0, y0: 0, w, h: authLayout.miniStairsH })).toBe(true);
        if (k) expect(b.y).toBeLessThan(bodies[k - 1]!.y);
      }
    }
  });

  it("키보드: 누른 칸이 가려지면 칸(과 아래 버튼)이 키보드 위에 오게, 보이면 그대로", () => {
    // 창 752, 키보드 300 → 보이는 높이 452. 비밀번호 칸 y 420(높이 48) + 아래 [로그인]까지 116
    expect(revealScrollY({ y: 420, h: 48, below: 116, scrollY: 0, viewportH: 752, kb: 300 })).toBe(420 + 48 + 116 + 16 - 452);
    // 이미 보이면 null
    expect(revealScrollY({ y: 100, h: 48, scrollY: 0, viewportH: 752, kb: 300 })).toBeNull();
    // 칸이 위로 지나가 있으면 칸 위로
    expect(revealScrollY({ y: 100, h: 48, scrollY: 200, viewportH: 752, kb: 300 })).toBe(84);
    // 아래로 보이고 싶은 것이 너무 크면 칸 위쪽이 가려지지 않는 데까지만
    expect(revealScrollY({ y: 500, h: 48, below: 600, scrollY: 0, viewportH: 752, kb: 300 })).toBe(484);
  });
});
