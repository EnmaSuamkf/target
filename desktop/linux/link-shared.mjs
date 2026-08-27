/** Copies ../shared into ./shared so dev and electron-builder both resolve ./shared/*. */
import { cpSync, existsSync, rmSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const wrapperDir = path.dirname(fileURLToPath(import.meta.url));
const dest = path.join(wrapperDir, "shared");
const src = path.join(wrapperDir, "../shared");

if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
