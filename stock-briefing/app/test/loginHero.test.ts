import { describe, expect, it } from "vitest";
import {
  BREATH_MIN,
  BREATH_MS,
  breathTrack,
  EASE_OUT,
  GLOW_START,
  GRID_LOGO_GAP,
  HERO_MS,
  heroFrame,
  heroLayout,
  heroScene,
  heroTracks,
  LIMIT_COUNT,
  LIMIT_GAP,
  LIMIT_START,
  LOGO_END,
  LOGO_START,
  layoutKey,
  MINI_COUNT,
  miniStairs,
  miniStairsBox,
  wordmarkBaseline,
  wordmarkH,
  revealScrollY,
  sampleTrack,
  SIDE_COUNT,
  SIDE_GAP,
  FLAME_START,
  HERO_START_DELAY_MS,
  PILLAR_CORE_W,
  PILLAR_H,
  PILLAR_W,
  SIDE_BAND,
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
  out.push(["pillar.grow", t.pillar.grow], ["pillar.opacity", t.pillar.opacity]);
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
      expect(f.pillar!.opacity).toBe(1);
      expect(f.pillar!.rect.h).toBeCloseTo(scene.pillar.base - scene.pillar.top, 6);
    });
  }
});

describe("모든 크기 · 모든 순간 (0~4.2초, 50ms 마다)", () => {
  // 검사가 많아(크기 약 290개 × 순간 85개 × 요소 70개) 틀린 것을 모았다가 한 번에 확인한다
  const check = (scene: HeroScene, L: LoginLayout, label: string, bad: string[], top = 0) => {
    const logo = { x: scene.logo.x, y: scene.logo.y, w: scene.logo.w + 8, h: scene.logo.h + 8 };
    for (const t of TIMES) {
      const f = heroFrame(scene, t);
      for (const it of f) {
        if (/^(side|limit|wick|cap)\d/.test(it.id)) {
          // 봉·꼬리·천장 띠: 그림 칸 안
          if (!inside(it.rect, scene.plot)) bad.push(`${label} t=${t} ${it.id} 칸 밖`);
          // 상한가 봉은 로고 묶음과 겹치지 않는다 (보일 때)
          if (!it.id.startsWith("side") && it.opacity > 0 && overlaps(it.rect, logo)) bad.push(`${label} t=${t} ${it.id} 로고와 겹침`);
        }
        // 불기둥은 그림 영역 안, 위 끝은 상태 표시줄(위 안전 영역) 아래 — 검증 5차 (빛줄기가 배터리·신호 아이콘에 꽂혀 보였다)
        if (it.id === "pillar" && (it.rect.x < 0 || it.rect.x + it.rect.w > L.heroW + EPS || it.rect.y < top - EPS)) bad.push(`${label} t=${t} ${it.id} 그림 영역 밖·상태 표시줄 밑`);
        if (it.id === "pillar" && it.opacity > 0 && it.rect.y + it.rect.h - 0.4 * it.rect.h < top - EPS) bad.push(`${label} t=${t} ${it.id} 밝은 곳이 상태 표시줄 밑`);
        // 상한가 봉은 시가(몸통 아래)를 기준으로 자란다: 자라는 동안 아래 끝이 제자리
        const m = /^limit(\d+)$/.exec(it.id);
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
      check(heroScene(L), L, `${W}×${H}(${top}/${bottom})`, bad, top);
    }
    expect(MANY.length).toBeGreaterThan(280);
    expect(bad.slice(0, 10)).toEqual([]);
  });

  it("로고 묶음은 그림 영역 안 — 입력 칸과 겹치지 않는다 (한 칸: 그림 아래 끝 위, 두 칸: 오른쪽 입력 칸 왼쪽)", () => {
    for (const [W, H, top, bottom] of MANY) {
      const L = heroLayout(W, H, { top, bottom });
      const lb = heroScene(L).logo;
      const label = `${W}×${H}(${top}/${bottom})`;
      expect(lb.y + lb.h, label).toBeLessThanOrEqual(L.heroH);
      expect(lb.y, label).toBeGreaterThanOrEqual(top);
      if (L.mode === "two") expect(lb.x + Math.ceil(lb.size * authLayout.wordmarkCanvas), label).toBeLessThanOrEqual(L.formX - L.gutter);
      else expect(lb.x + lb.w, label).toBeLessThanOrEqual(L.formX + L.formW);
    }
  });

  it("눈금은 로고 묶음 높이(± 8dp)에 걸리면 그리지 않는다 — 금색 선과 1~2dp 어긋난 줄이 틀어진 것처럼 보이지 않게. 나머지는 그림 칸 폭 전체", () => {
    let dropped = 0;
    for (const [W, H, top, bottom] of MANY) {
      const s = heroScene(heroLayout(W, H, { top, bottom }));
      const L = s.logo;
      dropped += 5 - s.grid.length;
      for (const g of s.grid) {
        const label = `${W}×${H} y=${g.y}`;
        expect(g.y < L.y - GRID_LOGO_GAP || g.y > L.y + L.h + GRID_LOGO_GAP, label).toBe(true);
        expect(Math.min(Math.abs(g.y - L.lineY), Math.abs(g.y - L.y)), label).toBeGreaterThanOrEqual(GRID_LOGO_GAP);
        expect([g.x1, g.x2]).toEqual([s.plot.x0, s.plot.x0 + s.plot.w]);
      }
    }
    expect(dropped).toBeGreaterThan(0);
    // 360×752: 로고 옆 줄(예전 첫 눈금 82.7 이 글자 칸 아래 끝 83 에 붙어 있었다)이 빠진다
    const phone = heroScene(heroLayout(360, 752, { top: 28, bottom: 24 }));
    expect(phone.grid.every((g) => g.y > phone.logo.y + phone.logo.h + GRID_LOGO_GAP)).toBe(true);
  });

  it("로고는 처음에 먼저 (0.2~0.8초): 첫 화면부터 브랜드가 보이고, 3.6~4.2초 절정에는 빛·불기둥만 바뀐다 (검증 지적 — 예전에는 3.7초까지 빈 차트)", () => {
    const t = heroTracks();
    const s = heroScene(heroLayout(933, 704, { top: 24, bottom: 16 }));
    expect(LOGO_START).toBe(200);
    expect(LOGO_END).toBe(800);
    expect(sampleTrack(t.logo.opacity, LOGO_START)).toBe(0);
    for (const tr of [t.logo.opacity, t.logo.shift, t.line, t.lineShow, t.sub]) expect(tr.input.at(-1)!).toBeLessThanOrEqual(LOGO_END);
    for (const ms of [800, 1500, 2500, 3600, HERO_MS]) {
      const f = byId(heroFrame(s, ms));
      expect(f.logo!.opacity, `t=${ms}`).toBe(1);
      expect(f.logo!.rect.y).toBe(s.logo.y);
      expect(f.line!.rect.w).toBe(authLayout.logoLineW);
      expect(f.sub!.opacity).toBe(1);
    }
    // 1.5초 화면: 로고·선·부제 + 횡보 16봉 (예전에는 빈 눈금만)
    const early = byId(heroFrame(s, 1500));
    expect(early.logo!.opacity).toBe(1);
    // 절정은 빛·불기둥
    expect(t.pillar.grow.input[0]).toBe(FLAME_START);
    expect(t.pillar.grow.input.at(-1)).toBe(HERO_MS);
    expect(byId(heroFrame(s, FLAME_START)).pillar!.opacity).toBe(0);
  });

  it("빛은 상한가 봉이 절반쯤 오른 뒤(2.6초)부터 켜진다 — 봉이 바닥에 있는 동안 빈 오른쪽 위가 먼저 붉어지지 않게", () => {
    const t = heroTracks();
    expect(GLOW_START).toBe(2600);
    for (const ms of [0, 1500, 1800, 2600]) expect(sampleTrack(t.glow, ms), `t=${ms}`).toBe(0);
    expect(sampleTrack(t.glow, 3000)).toBeGreaterThan(0);
    expect(sampleTrack(t.glow, 3600)).toBeCloseTo(0.7, 6);
    expect(sampleTrack(t.glow, HERO_MS)).toBe(1);
  });

  it("처음(0초)에는 봉·로고가 보이지 않고, 1.5초에는 횡보 16봉(+ 로고), 3.6초에는 상한가 10봉까지 (불기둥은 아직)", () => {
    const s = heroScene(heroLayout(360, 752, { top: 28, bottom: 24 }));
    const vis = (t: number, re: RegExp) => heroFrame(s, t).filter((x) => re.test(x.id) && x.opacity > 0).length;
    expect(vis(0, /^(side|limit)\d/)).toBe(0);
    expect(byId(heroFrame(s, 0)).logo!.opacity).toBe(0);
    expect(byId(heroFrame(s, 0)).line!.opacity).toBe(0);
    expect(vis(1500, /^side\d/)).toBe(16);
    expect(vis(1500, /^limit\d/)).toBe(0);
    expect(vis(3600, /^limit\d/)).toBe(10);
    expect(byId(heroFrame(s, 3600)).pillar!.opacity).toBe(0);
    // 2.5초: 상한가 봉 5개가 보이기 시작
    expect(vis(2500, /^limit\d/)).toBe(5);
  });
});

describe("불기둥 (검증 4·5차 — 마지막 종가에서 그림 위쪽으로 솟는 세로 빛 기둥: 뾰족한 끝·부풂·아래 크림 심지 없이, 몸통보다 넓게 보이게)", () => {
  it("그리는 칸은 몸통의 3배, 가운데 따뜻한 흰 심은 몸통보다 넓게(1.5~2배 — 검증 5차: 0.9 는 가는 흰 선으로 보였다), 높이는 그림 칸의 0.3~0.4", () => {
    expect(PILLAR_W).toBeGreaterThanOrEqual(2);
    expect(PILLAR_W).toBeLessThanOrEqual(3);
    expect(PILLAR_CORE_W).toBeGreaterThanOrEqual(1.5);
    expect(PILLAR_CORE_W).toBeLessThanOrEqual(2);
    expect(PILLAR_H).toBeGreaterThanOrEqual(0.3);
    expect(PILLAR_H).toBeLessThanOrEqual(0.4);
  });
  for (const [W, H, top, bottom] of SIZES) {
    it(`${W}×${H}: 마지막 봉 가운데에서 몸통 뒤(종가 조금 아래)부터 곧게 위로 — 같은 폭, 그림 영역 위 끝을 넘지 않고, 밝은 아래쪽은 상태 표시줄 아래`, () => {
      const L = heroLayout(W, H, { top, bottom });
      const s = heroScene(L);
      const last = s.limit[9]!;
      const P = s.pillar;
      expect(P.cx).toBeCloseTo(last.body.x + last.body.w / 2, 6);
      expect(P.w).toBeCloseTo(s.bw * PILLAR_W, 6);
      expect(P.coreW).toBeCloseTo(s.bw * PILLAR_CORE_W, 6);
      // 아래 끝은 몸통 위 끝보다 아래(몸통에 가려 봉에서 솟는 모양), 몸통 아래 끝보다는 위
      expect(P.base).toBeGreaterThan(last.body.y);
      expect(P.base).toBeLessThan(last.body.y + last.body.h);
      // 높이: 종가에서 그림 칸 h × PILLAR_H 까지 — 상태 표시줄(위 안전 영역) 아래 끝에 닿으면 거기서 멈춘다 (검증 5차, 그래도 h 의 0.28 이상)
      const rise = last.body.y - P.top;
      expect(rise).toBeLessThanOrEqual(PILLAR_H * s.plot.h + EPS);
      expect(P.top === L.safeTop || Math.abs(rise - PILLAR_H * s.plot.h) < EPS).toBe(true);
      expect(rise / s.plot.h).toBeGreaterThanOrEqual(0.28);
      expect(P.top).toBeGreaterThanOrEqual(top);
      expect(P.base - 0.4 * (P.base - P.top)).toBeGreaterThanOrEqual(top);
      // 빛의 가운데도 마지막 봉 종가
      expect(s.glow.cy).toBeCloseTo(last.body.y, 6);
    });
  }
});

describe("횡보 띠 자리 (검증 5차 — 가로 눈금이 윗꼬리를 가로지르고, 봉 묶음이 띠 위쪽으로 쏠려 바닥선 위에 약 18dp 빈 곳)", () => {
  it("모든 크기에서 가로 눈금이 횡보 봉(윗꼬리 끝 ~ 아래꼬리 끝)을 가로지르지 않고, 가장 낮은 아래꼬리는 바닥선 바로 위(6dp 안팎)", () => {
    const bad: string[] = [];
    for (const [W, H, top, bottom] of MANY) {
      const s = heroScene(heroLayout(W, H, { top, bottom }));
      const hi = Math.min(...s.side.map((c) => c.box.y));
      const lo = Math.max(...s.side.map((c) => c.box.y + c.box.h));
      for (const g of s.grid) if (g.y >= hi - 1 && g.y <= lo + 1) bad.push(`${W}×${H}(${top}) 눈금 ${g.y.toFixed(1)} · 횡보 ${hi.toFixed(1)}~${lo.toFixed(1)}`);
      if (s.baseline.y - lo > 7 || s.baseline.y - lo < 5) bad.push(`${W}×${H}(${top}) 바닥선과 ${(s.baseline.y - lo).toFixed(1)}dp`);
    }
    expect(bad).toEqual([]);
  });
});

describe("횡보 띠·천장 띠·시작 (검증 4차)", () => {
  it("횡보 띠 높이는 그림 칸의 0.2 (예전 0.14 — 봉이 납작한 점처럼 보였다), 횡보 봉 색은 불투명도 0.7", async () => {
    const { authColors } = await import("@/tokens");
    expect(SIDE_BAND).toBe(0.2);
    const s = heroScene(heroLayout(360, 752, { top: 28, bottom: 24 }));
    const ys = s.side.flatMap((c) => [c.box.y, c.box.y + c.box.h]);
    const bandBottom = s.plot.y0 + s.plot.h * 0.98;
    expect(Math.max(...ys)).toBeLessThanOrEqual(bandBottom + EPS);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(bandBottom - SIDE_BAND * s.plot.h - EPS);
    expect(authColors.sideUp).toMatch(/,\s*0\.7\)$/);
    expect(authColors.sideDown).toMatch(/,\s*0\.7\)$/);
  });
  it("천장 띠는 화면 한 픽셀 두께 (예전 1.5dp — 몸통 위에 굵은 크림 띠로 보였다), 몸통 위 끝(픽셀에 맞춘 자리)에", () => {
    const dpr = 2.625;
    const snap = (v: number) => Math.round(v * dpr) / dpr;
    const s = heroScene(heroLayout(475, 751, { top: 28, bottom: 24 }), snap, 1 / dpr);
    for (const c of s.limit) {
      expect(c.capH).toBeCloseTo(1 / dpr, 9);
      expect(Math.abs(c.body.y * dpr - Math.round(c.body.y * dpr))).toBeLessThan(1e-6);
    }
    // 크기를 모르면(테스트 기본) 0.5dp
    expect(heroScene(heroLayout(475, 751, { top: 28, bottom: 24 })).limit[0]!.capH).toBe(0.5);
  });
  it("첫 재생은 화면이 뜬 뒤 0.1초에 시작 (예전 0.22초)", () => {
    expect(HERO_START_DELAY_MS).toBe(100);
  });
});

describe("화면 픽셀에 맞춤 (폴드 dpr 2.625 — 봉마다 굵기가 달라 보이지 않게)", () => {
  const dpr = 2.625;
  const snap = (v: number) => Math.round(v * dpr) / dpr;
  const onPx = (v: number) => Math.abs(v * dpr - Math.round(v * dpr)) < 1e-6;
  for (const [W, H, top, bottom] of SIZES) {
    it(`${W}×${H}: 모든 봉 몸통 폭·꼬리 폭이 같고, 자리·눈금 y 가 픽셀 위`, () => {
      const s = heroScene(heroLayout(W, H, { top, bottom }), snap);
      const widths = new Set([...s.side.map((c) => c.box.w), ...s.limit.map((c) => c.body.w)]);
      expect(widths.size).toBe(1);
      expect(new Set(s.limit.map((c) => c.wick.w)).size).toBe(1);
      expect(new Set(s.side.map((c) => c.wickW)).size).toBe(1);
      for (const c of s.limit) for (const v of [c.body.x, c.body.w, c.body.y, c.body.h, c.wick.x, c.wick.w]) expect(onPx(v), `${v}`).toBe(true);
      for (const c of s.side) for (const v of [c.box.x, c.box.w, c.box.x + c.wickX, c.wickW, c.bodyTop, c.bodyBottom]) expect(onPx(v), `${v}`).toBe(true);
      for (const g of s.grid) expect(onPx(g.y)).toBe(true);
      // 맞춘 뒤에도 계단은 한 칸씩 오른다 (픽셀 반올림 오차 1px 안)
      s.limit.forEach((c, k) => {
        if (k) expect(Math.abs(s.limit[k - 1]!.body.y - c.body.y - s.step)).toBeLessThanOrEqual(1 / dpr + 1e-9);
      });
    });
  }
});

describe("그 밖", () => {
  it("같은 배치면 같은 열쇠 (입력할 때마다 그림을 다시 만들지 않게), 크기가 바뀌면 다른 열쇠", () => {
    const a = heroLayout(360, 752, { top: 28, bottom: 24 });
    expect(layoutKey(heroLayout(360, 752, { top: 28, bottom: 24 }))).toBe(layoutKey(a));
    expect(layoutKey(heroLayout(933, 704, { top: 28, bottom: 24 }))).not.toBe(layoutKey(a));
  });

  it("회원가입 머리의 작은 계단: 로고 글자에 맞춘 크기(30sp 85×94 · 34sp 95×106), 6개, 몸통·꼬리가 칸 안, 한 칸씩 오르고 몸통이 세로로 길다", () => {
    expect(miniStairsBox(30)).toMatchObject({ w: 85, h: 94 });
    expect(miniStairsBox(34)).toMatchObject({ w: 95, h: 106 });
    for (const size of [30, 34]) {
      const box = miniStairsBox(size);
      // 맨 아래(첫 봉 꼬리 끝 = 칸 아래 끝)를 로고 글자 바탕선에 — 로고 묶음(글자 칸 + 선) 아래 끝에서 바탕선까지
      expect(box.baselineGap).toBe(wordmarkH(size) + authLayout.logoLineGap + authLayout.logoLineH - wordmarkBaseline(size));
      const { bodies, wicks, bw } = miniStairs(box.w, box.h);
      expect(bodies).toHaveLength(MINI_COUNT);
      // 몸통 폭이 점처럼 작지 않다 (예전 60 칸은 4.6dp)
      expect(bw).toBeGreaterThanOrEqual(7);
      expect(Math.max(...wicks.map((x) => x.y + x.h))).toBeCloseTo(box.h, 6);
      for (const x of wicks) expect(inside(x, { x0: 0, y0: 0, w: box.w, h: box.h })).toBe(true);
      for (const [k, b] of bodies.entries()) {
        expect(b.h, `${size} ${k}`).toBeGreaterThan(1.5 * b.w);
        expect(inside(b, { x0: 0, y0: 0, w: box.w, h: box.h })).toBe(true);
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
