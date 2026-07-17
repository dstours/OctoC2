import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const bunVersion = (await readFile(join(root, ".bun-version"), "utf8")).trim();
const nodeVersion = (await readFile(join(root, ".node-version"), "utf8")).trim();
const nvmVersion = (await readFile(join(root, ".nvmrc"), "utf8")).trim();
const rootManifest = JSON.parse(
  await readFile(join(root, "package.json"), "utf8"),
) as {
  packageManager?: string;
  engines?: { node?: string };
};
const errors: string[] = [];

if (nvmVersion !== nodeVersion) {
  errors.push(`.nvmrc (${nvmVersion}) does not match .node-version (${nodeVersion})`);
}
if (rootManifest.packageManager !== `bun@${bunVersion}`) {
  errors.push(`packageManager must be bun@${bunVersion}`);
}
if (!rootManifest.engines?.node?.includes(nodeVersion)) {
  errors.push(`package.json engines.node must include tested Node ${nodeVersion}`);
}

const filesWithBunPin = [
  ".devcontainer/Dockerfile",
  ".github/workflows/ci.yml",
  ".github/workflows/ci-e2e.yml",
  ".github/workflows/pages.yml",
] as const;
for (const path of filesWithBunPin) {
  const content = await readFile(join(root, path), "utf8");
  if (!content.includes(bunVersion)) {
    errors.push(`${path} must pin Bun ${bunVersion}`);
  }
}

const devcontainer = await readFile(
  join(root, ".devcontainer", "devcontainer.json"),
  "utf8",
);
if (!devcontainer.includes(`"version": "${nodeVersion}"`)) {
  errors.push(`.devcontainer/devcontainer.json must pin Node ${nodeVersion}`);
}

if (errors.length > 0) {
  console.error("Toolchain policy violations:");
  for (const error of errors) {
    console.error(`  - ${error}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Toolchain pins agree on Bun ${bunVersion} and Node ${nodeVersion}.`);
}
