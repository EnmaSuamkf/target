#!/usr/bin/env node
/**
 * Build macOS artifacts. DMG requires macOS (uses native dmgbuild); on Linux
 * we produce the .app bundle only so cross-platform CI can verify structure.
 */
import { execSync } from "node:child_process";

const env = { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" };
const args =
  process.platform === "darwin"
    ? "electron-builder --mac"
    : "electron-builder --mac dir";

execSync(args, { stdio: "inherit", env });
