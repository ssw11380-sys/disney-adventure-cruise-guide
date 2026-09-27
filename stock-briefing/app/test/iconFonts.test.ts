import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 아이콘 글꼴 정리 (3-25 성능-10). @expo/vector-icons 묶음 입구("@expo/vector-icons")를 부르면 쓰지 않는 글꼴 18개(약 3.7MB)까지
 * 업데이트(OTA)·APK 에 들어간다. 앱은 Ionicons 한 가지만 쓰므로 "@expo/vector-icons/Ionicons" 만 부른다.
 *  - 소스(위젯 포함)에 묶음 입구를 부르는 곳이 없어야 한다 (lint no-restricted-imports 로도 막음)
 *  - 쓰는 아이콘 이름이 모두 Ionicons 글꼴에 있어야 한다 (없으면 ? 로 그려진다)
 */
const SRC = join(__dirname, "..", "src");
const req = createRequire(import.meta.url);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}

const sources = files(SRC).map((p) => ({ path: relative(SRC, p).replace(/\\/g, "/"), text: readFileSync(p, "utf8") }));

describe("아이콘 글꼴 (성능-10)", () => {
  it("묶음 입구 '@expo/vector-icons' 를 부르는 소스가 없다 (글꼴 한 가지씩만)", () => {
    const umbrella = sources.filter((s) => /from\s+["']@expo\/vector-icons["']|require\(\s*["']@expo\/vector-icons["']\s*\)/.test(s.text)).map((s) => s.path);
    expect(umbrella).toEqual([]);
  });

  it("쓰는 글꼴은 Ionicons 하나뿐이다", () => {
    const families = new Set<string>();
    for (const s of sources) for (const m of s.text.matchAll(/["']@expo\/vector-icons\/([A-Za-z0-9]+)["']/g)) families.add(m[1]!);
    expect([...families]).toEqual(["Ionicons"]);
  });

  it("아이콘을 쓰는 20개 파일이 모두 Ionicons 를 부른다", () => {
    const users = sources.filter((s) => /<Ionicons\b/.test(s.text));
    expect(users.length).toBeGreaterThanOrEqual(20);
    for (const s of users) expect(s.text, s.path).toMatch(/import Ionicons from "@expo\/vector-icons\/Ionicons";/);
  });

  it("소스의 아이콘 이름이 모두 Ionicons 글꼴에 있다 (깨진 아이콘 0)", () => {
    const glyphs = req("@expo/vector-icons/build/vendor/react-native-vector-icons/glyphmaps/Ionicons.json") as Record<string, number>;
    const names = new Set<string>();
    for (const s of sources) {
      // <Ionicons name="x"> · name={a ? "x" : "y"} (삼항의 두 갈래만) · icon("x", …) (탭 머리 버튼) · <Button icon="x"> (ui.tsx 가 Ionicons 로 그림)
      for (const m of s.text.matchAll(/<Ionicons\b[^>]*?name="([a-z0-9-]+)"/g)) names.add(m[1]!);
      for (const m of s.text.matchAll(/<Ionicons\b[^>]*?name=\{([^}]*)\}/g)) for (const q of m[1]!.matchAll(/[?:]\s*"([a-z0-9-]+)"/g)) names.add(q[1]!);
      for (const m of s.text.matchAll(/\bicon\(\s*"([a-z0-9-]+)"/g)) names.add(m[1]!);
      for (const m of s.text.matchAll(/\bicon="([a-z0-9-]+)"/g)) names.add(m[1]!);
    }
    expect(names.size).toBeGreaterThanOrEqual(25);
    const missing = [...names].filter((n) => !(n in glyphs));
    expect(missing).toEqual([]);
  });
});
