import { defineConfig } from "vitest/config";

// Two suites, for the two questions asked of a live deployment:
//
//   monitor  Is something down? A few cheap checks, one per part that can fail
//            on its own (the proxy path, usage, management, console),
//            run on a schedule.
//   deploy   Did this deploy break something? Every format, refusal, client
//            and management path, run once after a deploy, together with the
//            monitor checks: `vitest run` runs both.
//
// A failed test is tried once more before it counts, so one dropped packet on
// the way to a live deployment does not read as an outage.
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 60_000,
    retry: 1,
    projects: [
      { extends: true, test: { name: "monitor", include: ["tests/monitor/**/*.smoke.ts"] } },
      { extends: true, test: { name: "deploy", include: ["tests/deploy/**/*.smoke.ts"] } },
    ],
  },
});
