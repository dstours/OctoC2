import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const manifests = [
  "package.json",
  "shared/package.json",
  "implant/package.json",
  "server/package.json",
  "dashboard/package.json",
  "octoctl/package.json",
  "proxy/package.json",
  "docs-site/package.json",
] as const;
const dependencySections = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;
const alignedPackages = new Set([
  "@grpc/grpc-js",
  "@grpc/proto-loader",
  "@octokit/rest",
  "bun-types",
  "jose",
  "libsodium-wrappers",
  "protobufjs",
  "typescript",
]);

interface Manifest {
  description?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  overrides?: Record<string, string>;
}

function isExactVersion(specifier: string): boolean {
  return (
    specifier.startsWith("workspace:") ||
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(
      specifier,
    )
  );
}

const errors: string[] = [];
const alignedVersions = new Map<string, Map<string, string[]>>();

for (const manifestPath of manifests) {
  const manifest = JSON.parse(
    await readFile(join(root, manifestPath), "utf8"),
  ) as Manifest;

  if (
    !manifest.description ||
    !/authorized systems research/i.test(manifest.description)
  ) {
    errors.push(`${manifestPath}: description must retain the authorized-use scope`);
  }

  for (const section of dependencySections) {
    for (const [name, specifier] of Object.entries(manifest[section] ?? {})) {
      if (!isExactVersion(specifier)) {
        errors.push(`${manifestPath}: ${section}.${name} must be exact, found "${specifier}"`);
      }

      if (!alignedPackages.has(name) || manifestPath === "docs-site/package.json") {
        continue;
      }

      const versions = alignedVersions.get(name) ?? new Map<string, string[]>();
      const locations = versions.get(specifier) ?? [];
      locations.push(manifestPath);
      versions.set(specifier, locations);
      alignedVersions.set(name, versions);
    }
  }

  for (const [name, specifier] of Object.entries(manifest.overrides ?? {})) {
    if (!isExactVersion(specifier)) {
      errors.push(`${manifestPath}: overrides.${name} must be exact, found "${specifier}"`);
    }
  }
}

for (const [name, versions] of alignedVersions) {
  if (versions.size <= 1) {
    continue;
  }
  const details = [...versions]
    .map(([version, locations]) => `${version} (${locations.join(", ")})`)
    .join("; ");
  errors.push(`${name} is not aligned across Bun workspaces: ${details}`);
}

if (errors.length > 0) {
  console.error("Dependency policy violations:");
  for (const error of errors) {
    console.error(`  - ${error}`);
  }
  process.exitCode = 1;
} else {
  console.log("Dependency versions are exact and critical runtime packages are aligned.");
}
