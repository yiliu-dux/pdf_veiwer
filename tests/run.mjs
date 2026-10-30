// Runs all checks in sequence. The benchmark compares against the stock
// pdf.js viewer; the others are pass/fail.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

if (!existsSync("tests/fixtures/heavy.pdf")) {
  execFileSync("node", ["tests/make-heavy-pdf.mjs", "2000", "150000", "single"], { stdio: "inherit" });
}
let failed = 0;
for (const t of [
  "smoke",
  "local-file",
  "iframe",
  "tab-status",
  "zoom-anchor",
  "bench",
]) {
  console.log(`\n=== ${t} ===`);
  try {
    execFileSync("node", [`tests/${t}.mjs`], { stdio: "inherit" });
  } catch {
    failed++;
  }
}
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exitCode = failed ? 1 : 0;
