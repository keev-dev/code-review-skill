#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ReviewError, copyRecursive, ensureDir, pathExists, removeRecursive } from "./lib/util.mjs";

const SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL_TARGET = path.join(process.cwd(), ".agents", "skills", "code-review");
const GLOBAL_TARGET = path.join(os.homedir(), ".agents", "skills", "code-review");

function parse(argv) {
  const options = { link: false, force: false, target: null, global: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--link") options.link = true;
    else if (arg === "--copy") options.link = false;
    else if (arg === "--force") options.force = true;
    else if (arg === "--global") options.global = true;
    else if (arg === "--target") {
      const value = argv[index + 1];
      if (!value) throw new ReviewError("--target needs a directory");
      options.target = path.resolve(value);
      index += 1;
    } else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new ReviewError(`Unknown option: ${arg}`);
  }
  options.target = options.target || (options.global ? GLOBAL_TARGET : LOCAL_TARGET);
  return options;
}

function removeTarget(target) {
  if (!pathExists(target) && !isLink(target)) return;
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) fs.unlinkSync(target);
  else removeRecursive(target);
}

function isLink(target) {
  try {
    return fs.lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}

function copyInstall(target) {
  ensureDir(target);
  writeTop("SKILL.md", target);
  writeTop("AGENTS.md", target);
  writeTop("lenses.json", target);
  for (const directory of ["scripts", "references", "assets"]) {
    copyRecursive(
      path.join(SOURCE, directory),
      path.join(target, directory),
      (from, entry) => entry !== "node_modules" && entry !== ".code-review",
    );
  }
}

function writeTop(file, target) {
  const source = path.join(SOURCE, file);
  if (!pathExists(source)) return;
  copyRecursive(source, path.join(target, file));
}

function linkInstall(target) {
  ensureDir(path.dirname(target));
  if (process.platform === "win32") {
    fs.symlinkSync(SOURCE, target, "junction");
  } else {
    fs.symlinkSync(SOURCE, target, "dir");
  }
}

function main() {
  const options = parse(process.argv.slice(2));
  if (options.help) {
    console.log(`Install the code-review skill

Usage:
  node scripts/install.mjs [--copy | --link] [--global] [--force] [--target <dir>]

  --copy       copy the skill into the target (default)
  --link       create a junction (Windows) or symlink (Unix) to this checkout
  --global     install under the user profile instead of the current repository
  --force      replace an existing target
  --target     destination (default: ./.agents/skills/code-review)
`);
    return 0;
  }

  if (path.resolve(options.target) === path.resolve(SOURCE)) {
    console.log("Target is the source checkout; nothing to install.");
    return 0;
  }

  if ((pathExists(options.target) || isLink(options.target)) && !options.force) {
    throw new ReviewError(`Target already exists: ${options.target}\nPass --force to replace it.`);
  }
  if (pathExists(options.target) || isLink(options.target)) removeTarget(options.target);

  if (options.link) linkInstall(options.target);
  else copyInstall(options.target);

  console.log(`Installed ${options.link ? "link" : "copy"} at ${options.target}`);
  console.log("Restart the agent session (or reload skills) to pick it up.");
  console.log("");
  console.log("Quick check from a repository:");
  console.log(`  node "${path.join(options.target, "scripts", "review.mjs")}" collect`);
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  if (error instanceof ReviewError) {
    console.error(`error: ${error.message}`);
    process.exitCode = error.code || 1;
  } else {
    console.error(error?.stack || String(error));
    process.exitCode = 1;
  }
}
