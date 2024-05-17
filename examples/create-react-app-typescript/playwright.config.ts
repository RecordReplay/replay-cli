import { defineConfig } from "@playwright/test";
import { devices as replayDevices } from "@replayio/playwright";

export default defineConfig({
  forbidOnly: !!process.env.CI,
  use: {
    trace: "on-first-retry",
    defaultBrowserType: "chromium",
  },
  webServer: {
    command: "yarn run start",
    port: 3000,
    timeout: 30 * 1000,
    reuseExistingServer: !process.env.CI,
  },
  reporter: [
    ["@replayio/playwright/reporter"],
    // replicating Playwright's defaults
    process.env.CI ? (["dot"] as const) : (["list"] as const),
  ],
  projects: [
    {
      name: "replay-chromium",
      use: {
        ...replayDevices["Replay Chromium"],
      },
    },
  ],
});
