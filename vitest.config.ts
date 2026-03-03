import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.test.jsonc" },
        singleWorker: true,
        isolatedStorage: false,
        miniflare: {
          bindings: {
            REFRESH_KEY: "test-refresh-key",
            ENVIRONMENT: "test",
          },
        },
      },
    },
  },
});
