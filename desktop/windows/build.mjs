#!/usr/bin/env node
/**
 * Build Windows artifacts. NSIS installer requires Wine on Linux; on Windows
 * both NSIS and portable are produced.
 */
import { execSync } from "node:child_process";

const args =
  process.platform === "win32"
    ? "electron-builder --win"
    : "electron-builder --win portable nsis";

try {
  execSync(args, { stdio: "inherit" });
} catch (error) {
  if (process.platform !== "win32") {
    console.warn(
      "[build] NSIS failed (Wine required on Linux). Retrying portable only…",
    );
    execSync("electron-builder --win portable", { stdio: "inherit" });
  } else {
    throw error;
  }
}
