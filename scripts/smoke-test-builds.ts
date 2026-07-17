import { open, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

interface BinaryExpectation {
  path: string;
  formats: readonly string[];
}

const binaries: readonly BinaryExpectation[] = [
  { path: "implant/dist/beacon-linux-x64", formats: ["elf"] },
  { path: "implant/dist/beacon-linux-arm64", formats: ["elf"] },
  { path: "implant/dist/beacon-windows-x64.exe", formats: ["pe"] },
  { path: "implant/dist/beacon-macos-arm64", formats: ["macho"] },
  { path: "implant/dist/beacon-macos-x64", formats: ["macho"] },
  { path: "server/dist/svc-server", formats: ["elf"] },
  { path: "octoctl/dist/octoctl", formats: ["elf"] },
  { path: "proxy/dist/octoproxy", formats: ["elf"] },
];

function detectFormat(header: Uint8Array): string {
  const hex = Buffer.from(header).toString("hex");
  if (hex.startsWith("7f454c46")) return "elf";
  if (hex.startsWith("4d5a")) return "pe";
  if (
    hex.startsWith("cffaedfe") ||
    hex.startsWith("feedfacf") ||
    hex.startsWith("cafebabe") ||
    hex.startsWith("bebafeca")
  ) {
    return "macho";
  }
  return "unknown";
}

for (const expectation of binaries) {
  const absolutePath = join(root, expectation.path);
  const metadata = await stat(absolutePath);
  if (!metadata.isFile() || metadata.size < 100_000) {
    throw new Error(`${expectation.path} is missing or implausibly small`);
  }

  const file = await open(absolutePath, "r");
  try {
    const header = new Uint8Array(8);
    await file.read(header, 0, header.length, 0);
    const format = detectFormat(header);
    if (!expectation.formats.includes(format)) {
      throw new Error(
        `${expectation.path} has unexpected executable format "${format}"`,
      );
    }
  } finally {
    await file.close();
  }
}

for (const path of ["dashboard/dist/index.html", "docs-site/dist/index.html"]) {
  const html = await readFile(join(root, path), "utf8");
  const normalized = html.toLowerCase();
  if (
    !normalized.includes("<!doctype html>") ||
    !normalized.includes("<div id=\"root\">")
  ) {
    throw new Error(`${path} is not a valid built application shell`);
  }
}

console.log(
  `Smoke-checked ${binaries.length} compiled executables and 2 web builds.`,
);
