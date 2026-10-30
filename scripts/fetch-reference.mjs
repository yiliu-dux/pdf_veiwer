// Downloads reference material matching the pinned pdf.js version into
// reference/ (git-ignored):
//   reference/pdfjs-dist/  release zip: the stock viewer, used by the benchmark
//   reference/pdf.js/      source checkout, for reading (needs git)
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";

const { devDependencies } = JSON.parse(await readFile("package.json", "utf8"));
const version = devDependencies["pdfjs-dist"];
mkdirSync("reference", { recursive: true });

const dist = "reference/pdfjs-dist";
rmSync(dist, { recursive: true, force: true });
const zip = "reference/pdfjs-dist.zip";
const url = `https://github.com/mozilla/pdf.js/releases/download/v${version}/pdfjs-${version}-dist.zip`;
const res = await fetch(url);
if (!res.ok) {
  throw new Error(`${url}: ${res.status}`);
}
writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
mkdirSync(dist);
// bsdtar (Windows, macOS) reads zips; fall back to unzip elsewhere.
try {
  execFileSync("tar", ["-xf", zip, "-C", dist], { stdio: "ignore" });
} catch {
  execFileSync("unzip", ["-q", zip, "-d", dist]);
}
rmSync(zip);
console.log(`stock viewer ${version} -> ${dist}`);

const src = "reference/pdf.js";
if (!existsSync(src)) {
  execFileSync("git", ["clone", "--depth", "1", "--branch", `v${version}`, "https://github.com/mozilla/pdf.js.git", src], {
    stdio: "inherit",
  });
} else {
  console.log(`${src} exists; delete it to re-clone at v${version}`);
}
