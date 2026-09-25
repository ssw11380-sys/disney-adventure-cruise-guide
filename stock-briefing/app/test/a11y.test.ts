import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { sentence, speakAmount, speakMove, speakProfit, speakRate, stockRowLabel } from "@/lib/a11y";
import { headerH, isBigText, LINE, LINE_COL, LINE_H, lineCols, lineH, TAB_ICON, tabBarH, THEME_ROW_H, themeRowH } from "@/lib/textScale";
import { font, fontCap, slopFor, space, touch } from "@/tokens";

/**
 * 큰 글씨·화면 읽기 (3-22).
 *  - 누르는 요소(Pressable)는 모두 역할과 이름표가 있고, 입력칸·스위치는 이름표가 있다
 *  - 누르는 요소는 보이는 높이 + hitSlop 이 44 이상: hitSlop 을 주거나, 스타일에 minHeight: touch.min(또는 그보다 큰 줄 높이)을 둔다
 *  - 글자 크기에 따른 줄 높이·열 폭(lib/textScale)은 100% 에서 예전 값과 같고, 큰 글씨에서 내용이 들어간다
 *  - 잔고 한 줄은 한 문장으로 읽힌다
 */
const SRC = fileURLToPath(new URL("../src", import.meta.url));

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsxFiles(p));
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

interface El {
  file: string;
  where: string;
  tag: string;
  attrs: Map<string, string>;
  /** style 이 가리키는 styles.xxx 의 정의 (그 파일의 StyleSheet.create 안에서만 찾는다) */
  styleDefs: string;
}

/** JSX 여는 태그를 모두 모은다 (태그 이름·속성 원문) */
function elements(): El[] {
  const out: El[] = [];
  for (const f of tsxFiles(SRC)) {
    const text = readFileSync(f, "utf8");
    const sheet = text.slice(Math.max(text.lastIndexOf("StyleSheet.create("), 0));
    const src = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const file = relative(SRC, f).replace(/\\/g, "/");
    const visit = (node: ts.Node) => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const attrs = new Map<string, string>();
        for (const a of node.attributes.properties) if (ts.isJsxAttribute(a)) attrs.set(a.name.getText(src), a.initializer ? a.initializer.getText(src) : "true");
        const style = attrs.get("style") ?? "";
        const styleDefs = [...style.matchAll(/styles\.(\w+)/g)].map((m) => sheet.match(new RegExp(`\\n\\s*${m[1]}: \\{[^\\n]*`))?.[0] ?? "").join("\n");
        const line = src.getLineAndCharacterOfPosition(node.getStart(src)).line + 1;
        out.push({ file, where: `${file}:${line}`, tag: node.tagName.getText(src), attrs, styleDefs });
      }
      ts.forEachChild(node, visit);
    };
    visit(src);
  }
  return out;
}

const all = elements();
const of = (tag: string) => all.filter((e) => e.tag === tag);
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

describe("화면 읽기 이름표", () => {
  it("누르는 요소가 충분히 있다 (검사가 실제로 도는지)", () => expect(of("Pressable").length).toBeGreaterThanOrEqual(50));

  it("누르는 요소는 모두 역할(accessibilityRole)과 이름표(accessibilityLabel)가 있다", () => {
    const missing = of("Pressable")
      .filter((e) => !e.attrs.has("accessibilityRole") || !e.attrs.has("accessibilityLabel"))
      .map((e) => `${e.where} ${e.attrs.has("accessibilityRole") ? "" : "역할 없음 "}${e.attrs.has("accessibilityLabel") ? "" : "이름표 없음"}`);
    expect(missing).toEqual([]);
  });

  it("입력칸은 모두 이름표가 있다 (자리 표시 글자는 입력하면 사라져서 이름이 되지 못한다)", () => {
    const inputs = of("TextInput");
    expect(inputs.length).toBeGreaterThanOrEqual(11);
    expect(inputs.filter((e) => !e.attrs.has("accessibilityLabel")).map((e) => e.where)).toEqual([]);
  });

  it("스위치는 모두 이름표가 있다", () => {
    const toggles = of("Toggle");
    expect(toggles.length).toBeGreaterThanOrEqual(6);
    expect(toggles.filter((e) => !e.attrs.has("accessibilityLabel")).map((e) => e.where)).toEqual([]);
  });
});

describe("누르는 크기 44 이상", () => {
  /**
   * 44 예외 (이유를 적어 둔다):
   *  - 잔고 표 머리의 정렬 칸: 위는 정렬 버튼, 아래는 첫 종목 줄이라 넓히면 이웃을 누를 때 정렬이 바뀐다. 같은 정렬은 "정렬" 버튼으로도 된다
   */
  const EXCEPT = [{ file: "app/(tabs)/index.tsx", label: "a11y ??" }];
  const excepted = (e: El) => EXCEPT.some((x) => e.file === x.file && (e.attrs.get("accessibilityLabel") ?? "").includes(x.label));

  it("slopFor 는 보이는 높이를 44 로 채운다", () => {
    for (const h of [17, 18, 21, 24, 28, 31, 32, 33, 34, 40, 44, 58]) {
      const s = slopFor(h);
      expect(h + s.top + s.bottom).toBeGreaterThanOrEqual(touch.min);
    }
    expect(slopFor(60).top).toBe(0);
  });

  it("누르는 요소는 hitSlop 이 있거나 최소 높이가 44 이상이다", () => {
    // FB.rowH·FB.accountRowH: 넓은 창 브리핑 목록 줄 56·60 (3-42 — 44 이상인지는 test/foldBriefings.test.tsx 가 지킨다)
    const big = /minHeight: (touch\.min|LINE_H|HEAT_TILE_H|FB\.(rowH|accountRowH))|height: (rowH|lineH)|absoluteFill/;
    const small = of("Pressable").filter((e) => !excepted(e) && !e.attrs.has("hitSlop") && !big.test(e.attrs.get("style") ?? "") && !big.test(e.styleDefs));
    expect(small.map((e) => e.where)).toEqual([]);
  });

  it("예외는 목록에 적은 것만 (예외가 조용히 늘지 않게)", () => expect(of("Pressable").filter(excepted).length).toBe(1));

  it("hitSlop 은 숫자를 직접 쓰지 않고 slopFor·상수로 준다 (보이는 높이와 함께 바뀌게)", () => {
    const raw = of("Pressable").filter((e) => /^\{\s*\d+\s*\}$/.test(e.attrs.get("hitSlop") ?? ""));
    expect(raw.map((e) => `${e.where} hitSlop=${e.attrs.get("hitSlop")}`)).toEqual([]);
  });

  it("가로 스크롤 안의 칩은 스크롤 영역이 44 를 품는다 (안드로이드는 스크롤 영역 밖 터치를 자식에게 주지 않는다)", () => {
    // 차트 칩 띠(chart/ChipStrip, 3-42 에서 끝 흐림과 함께 옮김): 스크롤 틀을 위아래 hitSlop 만큼 넓히고 같은 만큼 음수 여백 → 보이는 배치는 그대로.
    // 스크롤 영역은 그 틀을 위아래로 꽉 채운다 (내용 위아래 여백 = hitSlop)
    const strip = read("components/chart/ChipStrip.tsx");
    expect(strip).toMatch(/chipScroll: \{ marginVertical: -CHIP_SLOP\.top \}/);
    expect(strip).toMatch(/chips: \{[^}]*paddingVertical: CHIP_SLOP\.top/);
    expect(strip).toMatch(/<View style=\{\[styles\.chipScroll, style\]\}>\s*<ScrollView/);
    expect(strip).toMatch(/contentContainerStyle=\{styles\.chips\}/);
    // 흐린 가장자리는 누르기를 가로채지 않는다
    expect(strip).toMatch(/fade: \{[^}]*pointerEvents: "none"/);
    // 차트의 두 칩 띠(조작 줄·오버레이 줄)가 모두 이 틀을 쓴다
    const chart = read("components/CandleChart.tsx");
    expect(chart.match(/<ChipStrip\b/g)?.length).toBe(2);
    expect(chart).not.toMatch(/<ScrollView\b/);
    // 발견 칩 줄: 위아래 여백(8)이 칩 hitSlop(6) 보다 크다
    expect(read("app/(tabs)/discover.tsx")).toMatch(/chips: \{[^}]*paddingVertical: space\.sm/);
    expect(space.sm).toBeGreaterThanOrEqual(slopFor(32).top);
  });

  it("가장 작은 글자(배지·차트 축)가 10px 이상이다", () => expect(font.tiny).toBeGreaterThanOrEqual(10));
});

describe("큰 글씨: 줄 높이·열 폭 (lib/textScale)", () => {
  const SCALES = [1.15, 1.3, 1.5, 1.8, 2];

  it("100% 에서는 3-21 까지의 값과 똑같다 (평소 화면은 그대로)", () => {
    expect(lineCols(1)).toEqual(LINE_COL);
    expect(lineH(1)).toBe(LINE_H);
    expect(themeRowH(1)).toBe(THEME_ROW_H);
    expect(tabBarH(1)).toBe(58);
    expect(headerH(1)).toBe(52);
    expect(isBigText(1)).toBe(false);
    // 작은 글씨(85%)는 100% 로 본다
    expect(lineH(0.85)).toBe(LINE_H);
    expect(lineCols(0.85)).toEqual(LINE_COL);
  });

  it("종목 줄(고정 높이): 이름 두 줄 + 보조 줄 두 줄이 들어간다", () => {
    for (const s of SCALES) {
      const c = Math.min(s, fontCap.row);
      const content = (2 * font.body + 2 * font.small) * LINE * c + space.xxs;
      expect(lineH(s), `${s}`).toBeGreaterThanOrEqual(Math.ceil(content));
    }
  });

  it("종목 줄 숫자 열: 큰 숫자도 최소 글자 비율(0.6) 안에서 한 줄에 들어간다", () => {
    for (const s of SCALES) {
      const c = Math.min(s, fontCap.row);
      const digit = font.body * c * 0.62; // 고정폭 숫자 한 자 폭 (대략)
      const col = lineCols(s);
      expect("1,234,567".length * digit * 0.6, `${s} 현재가`).toBeLessThanOrEqual(col.price);
      expect("+12,345,678".length * digit * 0.6, `${s} 오른쪽`).toBeLessThanOrEqual(col.right);
    }
  });

  it("테마 줄: 이름·대표 종목·막대 세 줄이 들어간다", () => {
    for (const s of SCALES) {
      const c = Math.min(s, fontCap.row);
      expect(themeRowH(s), `${s}`).toBeGreaterThanOrEqual(Math.ceil((font.body + font.tiny * 2) * LINE * c + space.xxs * 2));
    }
  });

  it("탭 바: 아이콘 + 탭 이름(150% 상한) + 여백이 들어간다 → 200% 에서도 탭 이름이 잘리지 않는다", () => {
    for (const s of [1, ...SCALES]) {
      const c = Math.min(s, fontCap.chrome);
      // 아이콘 + 이름 한 줄 + 탭 바 위아래 여백(6·6) + 탭 칸 위아래 여백(5·5)
      expect(tabBarH(s), `${s}`).toBeGreaterThanOrEqual(Math.ceil(TAB_ICON + font.tiny * LINE * c + space.s * 2 + 10) - 1);
    }
  });

  it("화면 머리: 제목이 상한 없이 커지는 만큼 높아진다", () => {
    for (const s of SCALES) expect(headerH(s) - headerH(1)).toBeGreaterThanOrEqual(Math.floor(font.h2 * LINE * (s - 1)));
  });

  it("글자 확대 상한: 줄은 140%, 탭 바·머리는 150%", () => {
    expect(fontCap.row).toBe(1.4);
    expect(fontCap.chrome).toBe(1.5);
  });
});

describe("화면 읽기 문장", () => {
  it("금액·등락을 말로 바꾼다", () => {
    expect(speakAmount("+20,000원")).toBe("20,000원");
    expect(speakAmount("-$1,234.50")).toBe("1,234.50달러");
    expect(speakAmount("▲2,500")).toBe("2,500");
    expect(speakAmount("$1.2B")).toBe("12억 달러");
    expect(speakAmount("$3.5M")).toBe("350만 달러");
    expect(speakAmount("$1.20T")).toBe("1.2조 달러");
    expect(speakAmount("5.5조원")).toBe("5.5조원");
    expect(speakRate(2.856)).toBe("2.86% 상승");
    expect(speakRate(-1.2)).toBe("1.20% 하락");
    expect(speakRate(0)).toBe("보합");
    expect(speakRate(null)).toBeNull();
    expect(speakProfit("-1,500원", -1)).toBe("1,500원 손실");
    expect(speakProfit("0원", 0)).toBe("손익 없음");
    expect(speakMove("$2.80", -1)).toBe("2.80달러 하락");
    expect(sentence(["a", null, "", "-", false, "b"])).toBe("a, b");
  });

  it("보유 종목 한 줄을 한 문장으로 읽는다", () => {
    expect(
      stockRowLabel({
        name: "삼성전자",
        us: false,
        holding: { quantity: "10", avg: "70,000원", profit: "20,000원", profitSign: 1, profitRate: 2.86 },
        price: { text: "72,000원", changeRate: 1.5, live: true },
      }),
    ).toBe("삼성전자, 국내, 10주 보유, 평단 70,000원, 현재가 72,000원, 1.50% 상승, 실시간, 평가손익 20,000원 이익, 수익률 2.86% 상승");
  });

  it("관심 종목·시세 없음도 한 문장 (시세가 없으면 평가가 없어 관심으로 읽힌다)", () => {
    expect(stockRowLabel({ name: "애플", us: true, price: { text: "$230.10", changeRate: -1.2 }, move: { text: "-$2.80", sign: -1 }, volume: "5,000만주" })).toBe(
      "애플, 미국, 관심, 현재가 230.10달러, 1.20% 하락, 전일 대비 2.80달러 하락, 거래량 5,000만주",
    );
    expect(stockRowLabel({ name: "SOXL", us: true, price: null, missing: "시세 없음" })).toBe("SOXL, 미국, 관심, 시세 없음");
  });

  it("평단·시세가 없는 보유 종목은 보유로 읽고 합계 제외를 알린다 (BH-26 · BH-30)", () => {
    expect(
      stockRowLabel({
        name: "SK하이닉스",
        us: false,
        holding: { quantity: "10", avg: "없음", profit: "-", profitSign: 0, profitRate: null },
        price: { text: "300,000원", changeRate: 1.2 },
        note: "합계 제외",
      }),
    ).toBe("SK하이닉스, 국내, 10주 보유, 평단 없음, 현재가 300,000원, 1.20% 상승, 평가손익 없음, 합계 제외");
    expect(stockRowLabel({ name: "애플", us: true, holding: { quantity: "10", avg: "200.00달러", profit: "-", profitSign: 0, profitRate: null }, price: null, missing: "시세 없음", note: "합계 제외" })).toBe(
      "애플, 미국, 10주 보유, 평단 200.00달러, 시세 없음, 평가손익 없음, 합계 제외",
    );
  });

  it("잔고 줄·계좌 요약·발견 줄이 이 문장 도구를 쓴다", () => {
    expect(read("components/StockRow.tsx")).toMatch(/stockRowLabel\(/);
    expect(read("app/(tabs)/index.tsx")).toMatch(/<View accessible accessibilityLabel=\{label\}/);
    expect(read("components/discover/DiscoverRow.tsx")).toMatch(/speakRate\(/);
  });
});
