import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 15_000,
    // 계정(로그인) 관문은 기존 테스트에서 끈다 (비상 끄기와 같은 스위치). 계정 테스트는 파일 맨 위에서 vi.stubEnv("ACCOUNTS_DISABLED", "") 로 켠다
    env: { ACCOUNTS_DISABLED: "1" },
  },
});
