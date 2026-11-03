import { spawn } from "node:child_process";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

// Every step is a package.json script, run exactly as `pnpm run <name>` would
// run it. This file only decides what runs alongside what; the commands
// themselves live in package.json and are not repeated here.
//
// One scheduler behind three entry points, so each tier gets the same pooling:
//
//   check   the type checks and the generated-document check, a few seconds
//   test    both suites, a couple of minutes, because every Vitest worker boots
//           the Workers runtime and replays the D1 migrations
//   verify  everything, and no slower than `test` alone: the checks finish
//           inside the shadow of the suites rather than after them
//
// Declared longest-first, which is the order the scheduler starts them in, so
// the two slow suites claim a slot before the short steps can crowd them out.
// `verify` is every step rather than a third list, so a step added here reaches
// it without being named twice.
const steps = [
  { name: "cli:check", tier: "check" },
  { name: "cli:test", tier: "test" },
  { name: "test:worker", tier: "test" },
  { name: "console:test", tier: "test" },
  { name: "docs:typecheck", tier: "check" },
  { name: "typecheck:bindings", tier: "check" },
  { name: "openapi:check", tier: "check" },
  { name: "suites:check", tier: "check" },
  { name: "typecheck:worker", tier: "check" },
  { name: "console:typecheck", tier: "check" },
  { name: "test:deploy-script", tier: "test" },
  { name: "test:swift-publish", tier: "test" },
  { name: "test:release-script", tier: "test" },
  { name: "test:indexnow", tier: "test" },
  { name: "test:update-models", tier: "test" },
  { name: "smoke:check", tier: "check" },
  { name: "smoke:test", tier: "test" },
];

const tier = process.argv[2];
if (tier !== "check" && tier !== "test" && tier !== "verify") {
  console.error("usage: node scripts/check.mjs <check|test|verify>");
  process.exit(2);
}
const selected = steps
  .filter((step) => tier === "verify" || step.tier === tier)
  .map((step) => step.name);

const pnpm = process.env.npm_execpath ?? "pnpm";
const runsUnderNode = pnpm.endsWith(".cjs") || pnpm.endsWith(".js") || pnpm.endsWith(".mjs");

function run(name) {
  return new Promise((resolve) => {
    const started = Date.now();
    const args = ["run", name];
    const child = runsUnderNode
      ? spawn(process.execPath, [pnpm, ...args], { cwd: projectRoot })
      : spawn(pnpm, args, { cwd: projectRoot });

    // Buffered, not streamed: parallel steps would otherwise interleave their
    // output line by line and make a failure impossible to read.
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", (error) => resolve({ name, ok: false, output: String(error), seconds: 0 }));
    child.on("close", (code) => {
      const seconds = Math.round((Date.now() - started) / 1000);
      console.log(`${code === 0 ? "PASS" : "FAIL"} ${name} (${seconds}s)`);
      resolve({ name, ok: code === 0, output, seconds });
    });
  });
}

// A pool rather than fixed lanes: the steps differ in cost by more than an
// order of magnitude, so hand-pairing them into lanes leaves one idle. Three
// slots is the useful width — the two test suites already run their own worker
// pools underneath, and a fourth concurrent step only makes them contend.
const slots = Math.max(2, Math.min(3, Math.floor(availableParallelism() / 4)));

for (const name of selected) console.log(`  ... ${name}`);

const started = Date.now();
const queue = [...selected];
const results = [];
let failed = false;

await Promise.all(
  Array.from({ length: slots }, async () => {
    // Stop taking work once something has failed: the run already has to be
    // fixed and repeated, so later steps would only add noise and delay.
    while (queue.length > 0 && !failed) {
      const result = await run(queue.shift());
      results.push(result);
      if (!result.ok) failed = true;
    }
  }),
);

const failures = results.filter((result) => !result.ok);
for (const failure of failures) {
  console.error(`\n${"=".repeat(70)}\n${failure.name} failed\n${"=".repeat(70)}\n${failure.output}`);
}

const total = Math.round((Date.now() - started) / 1000);
if (failures.length > 0) {
  const skipped = selected.length - results.length;
  console.error(
    `\n${tier} failed in ${total}s: ${failures.map((f) => f.name).join(", ")}` +
      (skipped > 0 ? ` (${skipped} step${skipped === 1 ? "" : "s"} not run)` : ""),
  );
  process.exit(1);
}
console.log(`\n${tier} passed in ${total}s`);
