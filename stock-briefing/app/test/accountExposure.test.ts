import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AccountExposure } from "@/api/types";
import { EXPOSURE_ABOUT, EXPOSURE_BASIS, exposureView, LEV_NAMES_MAX, levInvLabel } from "@/lib/accountExposure";

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

  it("첫 묶음은 '비중', 둘째 줄에 늘 '현금 제외'(짧게 — 자세한 기준은 화면 아래)와 기준 시각", () => {
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
    // 합계에서 뺀(비중을 모르는) 종목
    expect(levInvLabel({ name: "SOXL", kind: "leveraged", L: 3 }, true)).toBe("SOXL(3배, 계산에서 뺌)");
    expect(levInvLabel({ name: "Y", kind: "inverse", L: null }, true)).toBe("Y(인버스, 계산에서 뺌)");
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

  it("레버리지·인버스가 많으면 앞 3개(값 큰 순)만 이름을 보이고 '외 N종목' (검토 지적 — 긴 이름 6종목이 글자 200% 에서 8줄이 되던 것) · 화면 읽기도 같게", () => {
    expect(LEV_NAMES_MAX).toBe(3);
    const items = Array.from({ length: 6 }, (_, i) => ({ code: `L${i}`, name: `상품${i}`, kind: "leveraged" as const, L: 2, weight: 1 }));
    const v = exposureView({ ...base, levInv: { weight: 6, items, uncounted: [] } });
    expect(v.line2.slice(0, 5)).toEqual(["레버리지·인버스: 상품0(2배)", "상품1(2배)", "상품2(2배)", "외 3종목", EXPOSURE_BASIS]);
    expect(v.speech).toContain("상품2 2배, 외 3종목, 미국 상장");
    expect(v.speech).not.toContain("상품3");
    // 딱 3개면 '외' 없음
    expect(exposureView({ ...base, levInv: { weight: 3, items: items.slice(0, 3), uncounted: [] } }).line2).not.toContainEqual(expect.stringMatching(/^외 /));
    // 합계에서 뺀 것은 넣은 것 뒤에 (넣은 것 2 + 뺀 것 2 → 앞 3개 + '외 1종목')
    const two = exposureView({ ...base, levInv: { weight: 2, items: items.slice(0, 2), uncounted: [{ code: "U1", name: "뺀1", kind: "inverse", L: 1 }, { code: "U2", name: "뺀2", kind: "leveraged", L: null }] } });
    expect(two.line2.slice(0, 4)).toEqual(["레버리지·인버스: 상품0(2배)", "상품1(2배)", "뺀1(-1배, 계산에서 뺌)", "외 1종목"]);
  });

  it("환율·시세를 받지 못해 미국·레버리지 종목이 모두 합계에서 빠진 날 (검토 지적): '없음'이 아니라 '비중 알 수 없음' · 화면 읽기도", () => {
    const fx = fixture.cases.find((c) => c.name === "fxMissing")!;
    const v = exposureView(fx.expected);
    expect(v.line1).toContain("미국 상장 비중 알 수 없음");
    expect(v.line1).toContain("레버리지·인버스 비중 알 수 없음");
    expect(v.line1.join(" ")).not.toMatch(/미국 상장 없음|레버리지·인버스 없음/);
    expect(v.speech).toContain("미국 상장 종목 비중 알 수 없음");
    expect(v.speech).not.toContain("미국 상장 종목 없음");
    expect(v.line2).toContain("시세나 환율을 받지 못한 2종목은 빼고 계산");
    // 미국 종목 일부만 빠졌으면 넣은 것만으로 비중 (둘째 줄 안내가 밝힘)
    expect(exposureView({ ...base, us: { weight: 30.1, count: 2, uncounted: 1 }, excluded: 1 }).line1).toContain("미국 상장 30.1%");
  });

  it("합계에서 뺀 종목 안내는 이유(시세·환율)를 둘 다 적는다 — '시세가 없는'만 쓰면 환율 때문에 뺀 날 틀린 말", () => {
    const v = exposureView({ ...base, excluded: 3 });
    expect(v.line2).toContain("시세나 환율을 받지 못한 3종목은 빼고 계산");
    expect(v.line2.join(" ")).not.toContain("시세가 없는");
  });

  it("예전 모양(uncounted 칸 없음)은 0·빈 목록으로 — 지금과 같은 글", () => {
    const old = { ...base, levInv: { weight: base.levInv.weight, items: base.levInv.items }, us: { weight: base.us.weight, count: base.us.count } } as AccountExposure;
    expect(exposureView(old)).toEqual(exposureView(base));
    const none = { ...base, levInv: { weight: 0, items: [] }, us: { weight: 0, count: 0 } } as AccountExposure;
    expect(exposureView(none).line1).toEqual(expect.arrayContaining(["레버리지·인버스 없음", "미국 상장 없음"]));
  });

  it("합계에 넣은 종목이 1개여도 뺀 종목이 있으면 '보유 1종목'이라 쓰지 않는다 (보유는 여럿)", () => {
    const one = fixture.cases.find((c) => c.name === "one")!.expected;
    expect(exposureView(one).line1).toContain("보유 1종목");
    const v = exposureView({ ...one, excluded: 2, us: { weight: 0, count: 0, uncounted: 2 } });
    expect(v.line1).not.toContain("보유 1종목");
    expect(v.line1).toContain("가장 큰 종목 삼성전자 100.0%");
  });

  it("화면 아래 설명: '미국 상장'의 뜻(국내 상장 해외 ETF 는 들지 않음) · 문구 검사", () => {
    expect(EXPOSURE_ABOUT).toContain("미국 상장은 미국 거래소에서 달러로 거래하는 종목만");
    expect(EXPOSURE_ABOUT).toContain("국내에 상장된 해외 ETF는");
    expect(EXPOSURE_ABOUT).toContain("현금 제외");
    expect(EXPOSURE_ABOUT.match(BANNED)).toBeNull();
    expect(EXPOSURE_ABOUT.match(FUTURE)).toBeNull();
    expect(JUDGE.test(EXPOSURE_ABOUT)).toBe(false);
  });
});
