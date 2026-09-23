import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// 앱의 순수 함수(평가·합계·표기·지표)와 위젯 렌더 결과 단위 테스트. 위젯 모듈은 테스트에서 가짜로 바꿔 끼운다.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  esbuild: { jsx: "automatic" },
  test: {
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    environment: "node",
  },
});
