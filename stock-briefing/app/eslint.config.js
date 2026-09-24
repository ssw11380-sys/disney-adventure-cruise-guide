// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");

// 디자인 토큰 규칙 (3-20, docs/디자인-규칙.md): 간격·글자 크기·색은 src/tokens.ts 의 토큰만 쓴다
const SPACING = "/^(padding|margin|gap|rowGap|columnGap)(Top|Bottom|Left|Right|Horizontal|Vertical)?$/";
const designRules = [
  {
    selector: `Property[key.name=${SPACING}] > Literal[value!=0]`,
    message: "간격은 space 토큰으로 (space.xs·sm·md…). 0 만 직접 쓸 수 있다",
  },
  {
    selector: `Property[key.name=${SPACING}] > UnaryExpression > Literal`,
    message: "음수 간격도 -space.x 로",
  },
  {
    selector: "Property[key.name='fontSize'] > Literal",
    message: "글자 크기는 font 토큰으로 (hero·title·h2·body·small·tiny)",
  },
  {
    selector: "JSXAttribute[name.name='fontSize'] > JSXExpressionContainer > Literal",
    message: "글자 크기는 font 토큰으로",
  },
  {
    selector: "Literal[value=/^#[0-9A-Fa-f]{3,8}$/]",
    message: "색은 테마 토큰으로 (t.ink·t.accent…). hex 는 tokens.ts·widgets/palette.ts 에만",
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
    selector: "JSXText[value=/[◀▶◂▸▾▴■□●○✓✔]/]",
    message: "글자 기호 아이콘 대신 Ionicons (◀▶▾■●✓)",
  },
  {
    selector: "Literal[value=/[◀▶◂▸▾▴■□●○✓✔]/]",
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
