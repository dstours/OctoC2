import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const workflowsDir = join(import.meta.dir, "..", ".github", "workflows");
const workflowFiles = (await readdir(workflowsDir))
  .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
  .sort();
const errors: string[] = [];
const actionPattern = /^\s*uses:\s*([^#\s]+)(?:\s+#.*)?$/gm;

for (const file of workflowFiles) {
  const content = await readFile(join(workflowsDir, file), "utf8");
  try {
    Bun.YAML.parse(content);
  } catch (error) {
    errors.push(`${file}: invalid YAML: ${(error as Error).message}`);
    continue;
  }

  for (const match of content.matchAll(actionPattern)) {
    const reference = match[1] ?? "";
    if (reference.startsWith("./") || reference.startsWith("docker://")) {
      continue;
    }

    const separator = reference.lastIndexOf("@");
    const revision = separator >= 0 ? reference.slice(separator + 1) : "";
    if (!/^[0-9a-f]{40}$/.test(revision)) {
      errors.push(`${file}: action is not pinned to a full commit SHA: ${reference}`);
    }
  }
}

const ordinaryCi = await readFile(join(workflowsDir, "ci.yml"), "utf8");
if (!/^\s{2}push:\s*$/m.test(ordinaryCi) || !/^\s{2}pull_request:\s*$/m.test(ordinaryCi)) {
  errors.push("ci.yml must run automatically on both push and pull_request");
}

const liveE2e = await readFile(join(workflowsDir, "ci-e2e.yml"), "utf8");
if (/^\s{2}(?:push|pull_request):\s*$/m.test(liveE2e)) {
  errors.push("ci-e2e.yml must remain manual and must not run on push or pull_request");
}

if (errors.length > 0) {
  console.error("Workflow pin violations:");
  for (const error of errors) {
    console.error(`  - ${error}`);
  }
  process.exitCode = 1;
} else {
  console.log("All GitHub Actions are pinned to full commit SHAs.");
}
