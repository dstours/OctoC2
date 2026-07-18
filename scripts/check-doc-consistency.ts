import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const publicDocs = [
  "README.md",
  "docs/QUICKSTART.md",
  "docs/INSTALLATION.md",
  "docs/GITHUB_SETUP.md",
  "docs/ARCHITECTURE.md",
  "docs/CHANNELS.md",
  "docs/CLI.md",
  "docs/CONFIGURATION.md",
  "docs/TROUBLESHOOTING.md",
  "docs/DEVELOPMENT.md",
  "docs/PRODUCTION.md",
  "docs/RECOVERY.md",
  "docs/REMEDIATION_TRACEABILITY.md",
  "dashboard/README.md",
  "dashboard/index.html",
  "docs-site/src/App.tsx",
  "docs-site/index.html",
  "templates/proxy/README.md",
  "scripts/e2e-webui/index.html",
] as const;

const contents = new Map<string, string>();
for (const path of publicDocs) {
  contents.set(path, await readFile(join(root, path), "utf8"));
}

const errors: string[] = [];
const dashboardConfig = await readFile(
  join(root, "dashboard", "vite.config.ts"),
  "utf8",
);
const serverEntry = await readFile(join(root, "server", "src", "index.ts"), "utf8");
const runtimeConfig = await readFile(
  join(root, "server", "src", "config", "RuntimeConfig.ts"),
  "utf8",
);
const docsRegistry = await readFile(
  join(root, "docs-site", "src", "docs.ts"),
  "utf8",
);
const docsReader = await readFile(
  join(root, "docs-site", "src", "DocumentationPage.tsx"),
  "utf8",
);

function requireText(path: (typeof publicDocs)[number], text: string): void {
  if (!contents.get(path)?.includes(text)) {
    errors.push(`${path} must contain "${text}"`);
  }
}

for (const path of publicDocs) {
  const content = contents.get(path) ?? "";
  if (!/authorized use only/i.test(content)) {
    errors.push(`${path} must display the authorized-use notice`);
  }
}

for (const path of ["README.md", "docs/QUICKSTART.md", "docs/PRODUCTION.md"] as const) {
  requireText(path, "OCTOC2_HTTP_ENABLED");
  requireText(path, "OCTOC2_HTTP_SERVER_CERT");
  requireText(path, "OCTOC2_HTTP_SERVER_KEY");
  requireText(path, "OCTOC2_HTTP_CA_CERT");
  requireText(path, "127.0.0.1");
}

requireText("README.md", "127.0.0.1:5173");
requireText("dashboard/README.md", "127.0.0.1:5173");
requireText("docs-site/src/App.tsx", "127.0.0.1:5173");

const prohibitedClaims = [
  /\bproduction-ready\b/i,
  /\b11\s+(?:channels|tentacles)\s+(?:live|operational)\b/i,
  /\bzero infrastructure\b/i,
];
for (const [path, content] of contents) {
  for (const claim of prohibitedClaims) {
    if (claim.test(content)) {
      errors.push(`${path} contains prohibited readiness claim ${claim}`);
    }
  }
  if (
    /OCTOC2_(?:GITHUB_TOKEN|APP_PRIVATE_KEY|HTTP_DISABLED|GRPC_DISABLED)/.test(
      content,
    ) ||
    /SVC_APP_PRIVATE_KEY/.test(content)
  ) {
    errors.push(`${path} contains a removed or legacy listener/credential variable`);
  }
}

if (
  !/port:\s*5173/.test(dashboardConfig) ||
  !/host:\s*['"]127\.0\.0\.1['"]/.test(dashboardConfig)
) {
  errors.push("dashboard/vite.config.ts must bind the documented 127.0.0.1:5173");
}

for (const requiredSourceClaim of [
  'const httpEnabled = readBooleanFlag(env["OCTOC2_HTTP_ENABLED"])',
  'enabled: readBooleanFlag(env["OCTOC2_GRPC_ENABLED"])',
  'host: readHost(env["OCTOC2_HTTP_HOST"])',
  'host: readHost(env["OCTOC2_GRPC_HOST"])',
  'env["OCTOC2_HTTP_SERVER_CERT"]',
  'env["OCTOC2_HTTP_SERVER_KEY"]',
  'return value?.trim() || "127.0.0.1"',
]) {
  if (!runtimeConfig.includes(requiredSourceClaim)) {
    errors.push(
      `server/src/config/RuntimeConfig.ts is missing documented policy: ${requiredSourceClaim}`,
    );
  }
}
if (!serverEntry.includes("const listeners    = readListenerConfig();")) {
  errors.push("server/src/index.ts must use the validated listener configuration");
}

const containedArticles = [
  "docs/README.md",
  "docs/INSTALLATION.md",
  "docs/GITHUB_SETUP.md",
  "docs/QUICKSTART.md",
  "docs/ARCHITECTURE.md",
  "docs/CHANNELS.md",
  "docs/CONFIGURATION.md",
  "docs/CLI.md",
  "dashboard/README.md",
  "docs/PRODUCTION.md",
  "docs/RECOVERY.md",
  "templates/proxy/README.md",
  "docs/TROUBLESHOOTING.md",
  "docs/DEVELOPMENT.md",
  "docs/REMEDIATION_TRACEABILITY.md",
] as const;
for (const sourcePath of containedArticles) {
  if (!docsRegistry.includes(`sourcePath: '${sourcePath}'`)) {
    errors.push(`docs site must contain article ${sourcePath}`);
  }
}
if (
  contents.get("docs-site/src/App.tsx")?.includes("/blob/main/docs/") ||
  contents.get("docs-site/src/App.tsx")?.includes("docsUrl(")
) {
  errors.push("docs-site guide links must open the in-site article reader");
}
for (const requiredReaderContract of [
  "DOCUMENTATION_ID_BY_SOURCE",
  "documentationUrl(articleId, anchor)",
  "ReactMarkdown",
  "remarkGfm",
  "rehypeSlug",
]) {
  if (!docsReader.includes(requiredReaderContract)) {
    errors.push(
      `docs-site/src/DocumentationPage.tsx is missing reader contract: ${requiredReaderContract}`,
    );
  }
}

if (errors.length > 0) {
  console.error("Documentation consistency violations:");
  for (const error of errors) {
    console.error(`  - ${error}`);
  }
  process.exitCode = 1;
} else {
  console.log("Public documentation authorization, containment, listener, credential, and port claims are consistent.");
}
