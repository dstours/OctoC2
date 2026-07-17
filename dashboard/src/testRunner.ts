import { resolve } from "node:path";

const dashboardRoot = resolve(import.meta.dir, "..");
const testFiles = new Set<string>();

for (const pattern of ["**/*.test.ts", "**/*.test.tsx"]) {
  const glob = new Bun.Glob(pattern);
  for await (const file of glob.scan({ cwd: resolve(dashboardRoot, "src") })) {
    testFiles.add(`src/${file.replace(/\\/g, "/")}`);
  }
}

const files = [...testFiles].sort();
if (files.length === 0) {
  throw new Error("No dashboard test files were found");
}

interface FailedTestFile {
  file: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}

const failures: FailedTestFile[] = [];
let nextFile = 0;

async function runWorker(): Promise<void> {
  while (true) {
    const index = nextFile++;
    const file = files[index];
    if (!file) return;

    const child = Bun.spawn(
      [Bun.which("bun") ?? process.execPath, "test", file, "--timeout", "30000"],
      {
        cwd: dashboardRoot,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const stdoutPromise = new Response(child.stdout).text();
    const stderrPromise = new Response(child.stderr).text();
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      stdoutPromise,
      stderrPromise,
    ]);

    if (exitCode === 0) {
      console.log(`PASS ${file}`);
    } else {
      failures.push({ file, stdout, stderr, exitCode });
      console.error(`FAIL ${file} (exit ${exitCode})`);
    }
  }
}

const workerCount = Math.min(4, files.length);
await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`\n--- ${failure.file} ---`);
    if (failure.stdout.trim()) console.error(failure.stdout.trimEnd());
    if (failure.stderr.trim()) console.error(failure.stderr.trimEnd());
  }
  console.error(`\n${failures.length}/${files.length} dashboard test files failed.`);
  process.exit(1);
}

console.log(`\nAll ${files.length} dashboard test files passed in isolated processes.`);
