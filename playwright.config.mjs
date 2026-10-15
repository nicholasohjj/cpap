import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests",
  testMatch: "**/*.ui.spec.mjs",
  timeout: 30000,
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:5173",
  },
  webServer: {
    command: "npm run dev -- --port 5173 --strictPort",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: true,
    timeout: 30000,
  },
});
