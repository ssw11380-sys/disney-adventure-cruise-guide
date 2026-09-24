// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");

// 디자인 토큰 규칙 (3-20, docs/디자인-규칙.md): 간격·글자 크기·색은 src/tokens.ts 의 토큰만 쓴다
const SPACING = "/^(padding|margin|gap|rowGap|columnGap|flexGap)(Top|Bottom|Left|Right|Horizontal|Vertical)?$/";
// 숫자만 (raw 가 숫자로 시작, 0 은 허용) — "auto"·"5%" 같은 문자열은 잡지 않는다. 식 안의 숫자(insets.bottom + 6, a ? 4 : 8)도 잡는다
const NUMBER = "Literal[raw=/^[0-9.]/][value!=0]";
const HEX = "/#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?\\b|^#[0-9A-Fa-f]{3}$/";
const GLYPH = "/[◀▶◂▸▾▴■□●○✓✔]/";
const designRules = [
  {
    selector: `Property[key.name=${SPACING}] ${NUMBER}`,
    message: "간격은 space 토큰으로 (space.xs·sm·md…). 0 만 직접 쓸 수 있다",
  },
  {
    selector: `Property[key.name='fontSize'] ${NUMBER}`,
    message: "글자 크기는 font 토큰으로 (hero·title·h2·body·small·tiny)",
  },
  {
    selector: `JSXAttribute[name.name='fontSize'] ${NUMBER}`,
    message: "글자 크기는 font 토큰으로",
  },
  {
    selector: `Literal[value=${HEX}]`,
    message: "색은 테마 토큰으로 (t.ink·t.accent…). hex 는 tokens.ts·widgets/palette.ts 에만",
  },
  {
    selector: `TemplateElement[value.raw=${HEX}]`,
    message: "색은 테마 토큰으로. hex 는 tokens.ts·widgets/palette.ts 에만",
  },
  {
    selector: "Literal[value=/^rgba?\\(/]",
    message: "색은 테마 토큰으로. rgba 는 tokens.ts·widgets/palette.ts 에만",
  },
  {
    selector: "JSXOpeningElement[name.name='Switch']",
    message: "스위치는 components/ui 의 Toggle 로 (모양 하나)",
  },
  {
    selector: `JSXText[value=${GLYPH}]`,
    message: "글자 기호 아이콘 대신 Ionicons (◀▶▾■●✓)",
  },
  {
    selector: `Literal[value=${GLYPH}]`,
    message: "글자 기호 아이콘 대신 Ionicons (◀▶▾■●✓)",
  },
  {
    selector: `TemplateElement[value.raw=${GLYPH}]`,
    message: "글자 기호 아이콘 대신 Ionicons (◀▶▾■●✓)",
  },
];

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ["dist/*"],
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/tokens.ts", "src/widgets/palette.ts"],
    rules: { "no-restricted-syntax": ["error", ...designRules] },
  },
]);
