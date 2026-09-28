import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AccountExposure } from "@/api/types";
import { EXPOSURE_BASIS, exposureView, levInvLabel } from "@/lib/accountExposure";

/**
 * 브리핑 3차 4 — 비중 한 줄 (플래그 accountExposure), 앱 글·화면 읽기 (순수).
 * 공용 픽스처(shared/fixtures/accountExposure.json)의 서버 결과(expected)로 만든 두 줄·화면 읽기 문장이 픽스처의 app 과 같아야 한다 — 서버 테스트는 같은 픽스처로 계산을 본다
 */
type Case = { name: string; expected: AccountExposure; app: { line1: string; line2: string; speech: string } };
const fixture = JSON.parse(readFileSync(new URL("../../shared/fixtures/accountExposure.json", import.meta.url), "utf8")) as { cases: Case[] };

/** 서버 검사기(backend/src/analysis/scoreWording.ts)의 금지어·미래형 정규식을 그대로 읽어 쓴다 */
const src = readFileSync(new URL("../../backend/src/analysis/scoreWording.ts", import.meta.url), "utf8");
const BANNED = new RegExp(/SCORE_BANNED_RE =\s*\/(.+)\/;/.exec(src)![1]!, "g");
const FUTURE = new RegExp(/SCORE_FUTURE_RE = \/(.+)\/;/.exec(src)![1]!, "g");
/** 판단하는 말 (사실만 — 높다·낮다·쏠림·치우침·위험·주의·좋·나쁘·과하·많·적) */
const JUDGE = /높|낮|쏠|치우|집중|편중|위험|주의|좋|나쁘|과하|과도|많|적은|적다|너무|걱정|조심|분산/;

describe("공용 픽스처: 서버가 저장한 비중 → 두 줄·화면 읽기", () => {
  for (const c of fixture.cases) {
    it(c.name, () => {
      const v = exposureView(c.expected);
      expect(v.line1.join(" · ")).toBe(c.app.line1);
      expect(v.line2.join(" · ")).toBe(c.app.line2);
      expect(v.speech).toBe(c.app.speech);
      // 문구 검사 (권유·전망·미래형·판단하는 말 0건)
      for (const s of [...v.line1, ...v.line2, v.speech]) {
        expect(s.match(BANNED), s).toBeNull();
        expect(s.match(FUTURE), s).toBeNull();
        expect(JUDGE.test(s), s).toBe(false);
      }
      // 화면 읽기는 기호 없이 (%·()·· 없음)
      expect(v.speech).not.toMatch(/[%()·:]/);
    });
  }
});

describe("모양", () => {
  const base = fixture.cases.find((c) => c.name === "levInv")!.expected;

  it("첫 묶음은 '비중', 둘째 줄에 늘 '보유 종목 평가금액 기준, 현금 제외'와 기준 시각", () => {
    const v = exposureView(base);
    expect(v.line1[0]).toBe("비중");
    expect(v.line2).toContain(EXPOSURE_BASIS);
    expect(v.line2).toContain("08:38 기준");
  });

  it("레버리지·인버스 이름표: 배수를 알면 '3배'·'-2배', 모르면 '레버리지'·'인버스', 소수 배수 그대로", () => {
    expect(levInvLabel({ code: "SOXL", name: "SOXL", kind: "leveraged", L: 3, weight: 6.1 })).toBe("SOXL(3배)");
    expect(levInvLabel({ code: "X", name: "X", kind: "leveraged", L: 1.5, weight: 1 })).toBe("X(1.5배)");
    expect(levInvLabel({ code: "X", name: "X", kind: "leveraged", L: null, weight: 1 })).toBe("X(레버리지)");
    expect(levInvLabel({ code: "Y", name: "KODEX 인버스", kind: "inverse", L: 1, weight: 1 })).toBe("KODEX 인버스(-1배)");
    expect(levInvLabel({ code: "Y", name: "Y", kind: "inverse", L: null, weight: 1 })).toBe("Y(인버스)");
  });

  it("미국 상장 비중이 0.0 으로 반올림돼도 미국 종목이 있으면 '미국 상장 0.0%' ('없음'은 종목이 없을 때만)", () => {
    const v = exposureView({ ...base, us: { weight: 0, count: 1 } });
    expect(v.line1).toContain("미국 상장 0.0%");
    expect(exposureView({ ...base, us: { weight: 0, count: 0 } }).line1).toContain("미국 상장 없음");
  });

  it("기준 시각을 읽지 못하면 시각 조각을 빼고 (틀린 시각을 보이지 않게)", () => {
    const v = exposureView({ ...base, asOf: "?" });
    expect(v.line2.some((p) => p.endsWith(" 기준") && p !== EXPOSURE_BASIS)).toBe(false);
    expect(v.speech.startsWith("비중, 가장 큰 종목")).toBe(true);
  });

  it("레버리지·인버스가 많아도 모두 둘째 줄에 (묶음째 줄바꿈 — 좁은 칸에서도 잘리지 않게 조각마다 따로)", () => {
    const items = Array.from({ length: 6 }, (_, i) => ({ code: `L${i}`, name: `상품${i}`, kind: "leveraged" as const, L: 2, weight: 1 }));
    const v = exposureView({ ...base, levInv: { weight: 6, items } });
    expect(v.line2.slice(0, 6)).toEqual(["레버리지·인버스: 상품0(2배)", "상품1(2배)", "상품2(2배)", "상품3(2배)", "상품4(2배)", "상품5(2배)"]);
  });
});
