import { describe, it, expect, beforeAll } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { writeFileSync, rmSync } from "fs";
import { pickIssueTitle, loadTitleTemplates } from "../lib/titleTemplates.ts";

const REAL_TEMPLATES_PATH = join(import.meta.dir, "../../../implant/config/title-templates.json");

describe("pickIssueTitle", () => {
  const ctx = { shortId: "a1b2c3d4", hostname: "h", date: "Jan 1" };

  it("replaces {shortId} in a template", () => {
    const templates = ["Task: review config for {shortId}"] as const;
    const result = pickIssueTitle(templates, ctx);
    expect(result).toBe("Task: review config for a1b2c3d4");
  });

  it("returns a template unchanged when no placeholder", () => {
    const templates = ["Chore: update dependencies"] as const;
    const result = pickIssueTitle(templates, ctx);
    expect(result).toBe("Chore: update dependencies");
  });

  it("replaces all occurrences of {shortId} in a template", () => {
    const templates = ["Task: {shortId} review config for {shortId}"] as const;
    const result = pickIssueTitle(templates, ctx);
    expect(result).toBe("Task: a1b2c3d4 review config for a1b2c3d4");
  });

  it("picks from templates uniformly (all 3 appear in 100 runs)", () => {
    const templates = ["Fix: alpha", "Fix: beta", "Fix: gamma"] as const;
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      seen.add(pickIssueTitle(templates, { shortId: "x", hostname: "h", date: "Jan 1" }));
    }
    expect(seen.size).toBe(3);
  });
});

describe("pickIssueTitle — extended placeholders", () => {
  const ctx = { shortId: "a1b2c3d4", hostname: "build-host", date: "Mar 30" };

  it("replaces {shortBeaconId} with shortId", () => {
    const result = pickIssueTitle(["Task: adjust for {shortBeaconId}"], ctx);
    expect(result).toBe("Task: adjust for a1b2c3d4");
  });

  it("replaces {hostname} with ctx.hostname", () => {
    const result = pickIssueTitle(["Maintenance: sync on {hostname}"], ctx);
    expect(result).toBe("Maintenance: sync on build-host");
  });

  it("replaces {date:short} with ctx.date", () => {
    const result = pickIssueTitle(["Update: review on {date:short}"], ctx);
    expect(result).toBe("Update: review on Mar 30");
  });

  it("replaces all four placeholder types in one template", () => {
    const result = pickIssueTitle(
      ["Fix {shortId} {shortBeaconId} {hostname} {date:short}"],
      ctx
    );
    expect(result).toBe("Fix a1b2c3d4 a1b2c3d4 build-host Mar 30");
  });
});

describe("loadTitleTemplates", () => {
  it("throws if file doesn't exist", async () => {
    await expect(
      loadTitleTemplates("/nonexistent/path/title-templates.json")
    ).rejects.toThrow();
  });

  it("throws if JSON is not an array", async () => {
    const tmpPath = join(tmpdir(), `title-templates-test-${Date.now()}.json`);
    writeFileSync(tmpPath, JSON.stringify({ not: "an array" }));
    try {
      await expect(loadTitleTemplates(tmpPath)).rejects.toThrow();
    } finally {
      rmSync(tmpPath, { force: true });
    }
  });

  it("throws if JSON array contains non-string elements", async () => {
    const tmpPath = join(tmpdir(), `title-templates-test-${Date.now()}.json`);
    writeFileSync(tmpPath, JSON.stringify(["valid title", 42, "another title"]));
    try {
      await expect(loadTitleTemplates(tmpPath)).rejects.toThrow();
    } finally {
      rmSync(tmpPath, { force: true });
    }
  });

  it("throws if JSON is an empty array", async () => {
    const tmpPath = join(tmpdir(), `title-templates-test-${Date.now()}.json`);
    writeFileSync(tmpPath, JSON.stringify([]));
    try {
      await expect(loadTitleTemplates(tmpPath)).rejects.toThrow();
    } finally {
      rmSync(tmpPath, { force: true });
    }
  });

  it("returns the parsed array for valid input", async () => {
    const tmpPath = join(tmpdir(), `title-templates-test-${Date.now()}.json`);
    const titles = ["Fix: something", "Chore: update deps", "Task: review {shortId}"] as const;
    writeFileSync(tmpPath, JSON.stringify(titles));
    try {
      const result = await loadTitleTemplates(tmpPath);
      expect(result).toEqual(titles);
      expect(result).toHaveLength(3);
    } finally {
      rmSync(tmpPath, { force: true });
    }
  });
});

describe("real-templates integration", () => {
  const realCtx = { shortId: "a3f8", hostname: "beacon-host", date: "Mar 30" };
  let templates: string[];

  beforeAll(async () => {
    templates = await loadTitleTemplates(REAL_TEMPLATES_PATH);
  });

  it("loads the real title-templates.json without error", async () => {
    const loaded = await loadTitleTemplates(REAL_TEMPLATES_PATH);
    expect(Array.isArray(loaded)).toBe(true);
    expect(loaded.length).toBeGreaterThan(0);
    for (const t of loaded) {
      expect(typeof t).toBe("string");
    }
    // Also set templates for other tests to use
    templates = loaded;
  });

  it("pickIssueTitle with real templates produces a clean title", () => {
    const title = pickIssueTitle(templates, realCtx);
    expect(typeof title).toBe("string");
    expect(title.length).toBeGreaterThan(0);
    expect(/\{[^}]+\}/.test(title)).toBe(false);
    expect(title.length).toBeGreaterThanOrEqual(5);
    expect(title.length).toBeLessThanOrEqual(120);
  });

  it("pickIssueTitle called 20 times never leaves raw placeholders", () => {
    for (let i = 0; i < 20; i++) {
      const title = pickIssueTitle(templates, realCtx);
      expect(typeof title).toBe("string");
      expect(title.length).toBeGreaterThan(0);
      expect(/\{[^}]+\}/.test(title)).toBe(false);
    }
  });
});
