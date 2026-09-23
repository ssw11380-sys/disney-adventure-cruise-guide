import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// 앱의 순수 함수(평가·합계·표기·지표) 단위 테스트. RN 모듈을 불러오지 않는 파일만 대상으로 한다.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
