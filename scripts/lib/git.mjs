import fs from "node:fs";
import path from "node:path";
import {
  ReviewError,
  ensureDir,
  gitBuffer,
  gitText,
  isProbablyBinary,
  normalizeNewlines,
  readText,
  runGit,
  toPosix,
} from "./util.mjs";

export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const STATUS_LABELS = {
  A: "added",
  C: "copied",
  D: "deleted",
  M: "modified",
  R: "renamed",
  T: "modified",
  U: "unmerged",
  X: "unknown",
  B: "broken",
};

function resolveCommit(root, ref, { allowFailure = false } = {}) {
  const result = runGit(["rev-parse", "--verify", `${ref}^{commit}`], {
    cwd: root,
    allowFailure: true,
  });
  if (result.status !== 0) {
    if (allowFailure) return null;
    throw new ReviewError(`Unknown git ref: ${ref}`);
  }
  return gitText(["rev-parse", "--verify", `${ref}^{commit}`], { cwd: root }).trim();
}

function tryMergeBase(root, a, b) {
  const result = runGit(["merge-base", a, b], { cwd: root, allowFailure: true });
  if (result.status !== 0) return null;
  return gitText(["merge-base", a, b], { cwd: root }).trim();
}

export function ensureLocalExclude(root) {
  try {
    const excludePath = gitText(["rev-parse", "--git-path", "info/exclude"], { cwd: root }).trim();
    const absolute = path.isAbsolute(excludePath) ? excludePath : path.join(root, excludePath);
    ensureDir(path.dirname(absolute));
    const current = fs.existsSync(absolute) ? readText(absolute) : "";
    if (!/^\.code-review\/?$/m.test(current)) {
      const prefix = current === "" || current.endsWith("\n") ? "" : "\n";
      fs.appendFileSync(absolute, `${prefix}\n# Added by code-review\n.code-review/\n`, "utf8");
    }
  } catch {
    // A read-only or unusual git checkout should not block the review.
  }
}

export function getRepoInfo(root) {
  const gitDirResult = runGit(["rev-parse", "--is-inside-work-tree"], { cwd: root, allowFailure: true });
  if (gitDirResult.status !== 0) {
    throw new ReviewError(`Not a git repository: ${root}\nRun the review from a git checkout, or pass --root <repo>.`);
  }
  const topLevel = gitText(["rev-parse", "--show-toplevel"], { cwd: root }).trim();
  const headResult = runGit(["rev-parse", "--verify", "HEAD"], { cwd: root, allowFailure: true });
  const hasHead = headResult.status === 0;
  const head = hasHead ? gitText(["rev-parse", "HEAD"], { cwd: topLevel }).trim() : null;
  let branch = "HEAD";
  if (hasHead) {
    const branchResult = runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], {
      cwd: topLevel,
      allowFailure: true,
    });
    if (branchResult.status === 0) branch = gitText(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: topLevel }).trim();
    else branch = `detached@${head.slice(0, 8)}`;
  } else {
    branch = "unborn";
  }
  const status = hasHead ? gitText(["status", "--porcelain=v1"], { cwd: topLevel }) : "";
  return {
    root: topLevel,
    name: path.basename(topLevel),
    branch,
    head,
    headShort: head ? head.slice(0, 8) : null,
    hasHead,
    dirty: status.trim() !== "",
  };
}

export function resolveScope({ root, staged = false, base, range, commit, paths = [], includeUntracked = true }) {
  const repo = getRepoInfo(root);
  ensureLocalExclude(repo.root);

  const specified = [staged, Boolean(base), Boolean(range), Boolean(commit)].filter(Boolean).length;
  if (specified > 1) {
    throw new ReviewError("Choose only one scope: --staged, --base, --range, or --commit.");
  }

  const cleanPaths = paths
    .map((value) => toPosix(String(value)))
    .map((value) => value.replace(/^\.\//, ""))
    .filter(Boolean);
  const hasHead = repo.hasHead;

  let scope;
  if (range) {
    const separator = range.includes("...") ? "..." : range.includes("..") ? ".." : null;
    if (!separator) throw new ReviewError("--range must look like a..b or a...b.");
    const [left, right] = range.split(separator);
    if (!left || !right) throw new ReviewError("--range must name two refs.");
    let oldRef = resolveCommit(repo.root, left);
    const newRef = resolveCommit(repo.root, right);
    if (separator === "...") {
      const merge = tryMergeBase(repo.root, oldRef, newRef);
      if (merge) oldRef = merge;
    }
    scope = {
      kind: "range",
      label: `${left}${separator}${right}`,
      oldRef,
      newRef,
      newSource: "tree",
      diffArgs: [oldRef, newRef],
      includeUntracked: false,
      oldLabel: left,
      newLabel: right,
      hasHead,
      repo,
    };
  } else if (commit) {
    const newRef = resolveCommit(repo.root, commit);
    const parent = resolveCommit(repo.root, `${newRef}^`, { allowFailure: true });
    const oldRef = parent || EMPTY_TREE;
    scope = {
      kind: "commit",
      label: parent ? `${newRef.slice(0, 8)}^..${newRef.slice(0, 8)}` : `root commit ${newRef.slice(0, 8)}`,
      oldRef,
      newRef,
      newSource: "tree",
      diffArgs: [oldRef, newRef],
      includeUntracked: false,
      oldLabel: parent ? `${newRef.slice(0, 8)}^` : "empty tree",
      newLabel: newRef.slice(0, 8),
      hasHead,
      repo,
    };
  } else if (staged) {
    const oldRef = hasHead ? "HEAD" : EMPTY_TREE;
    scope = {
      kind: "staged",
      label: "staged changes vs HEAD",
      oldRef,
      newRef: null,
      newSource: "index",
      diffArgs: ["--cached", oldRef],
      includeUntracked: false,
      oldLabel: hasHead ? "HEAD" : "empty tree",
      newLabel: "index",
      hasHead,
      repo,
    };
  } else if (base) {
    let oldRef = resolveCommit(repo.root, base);
    let mergedFrom = null;
    if (hasHead) {
      const merge = tryMergeBase(repo.root, oldRef, "HEAD");
      if (merge && merge !== oldRef) {
        mergedFrom = oldRef;
        oldRef = merge;
      }
    }
    scope = {
      kind: "base",
      label: mergedFrom
        ? `${base} (merge-base ${oldRef.slice(0, 8)}) → working tree`
        : `${base} → working tree`,
      oldRef,
      newRef: null,
      newSource: "worktree",
      diffArgs: [oldRef],
      includeUntracked,
      oldLabel: base,
      newLabel: "working tree",
      hasHead,
      repo,
    };
  } else {
    const oldRef = hasHead ? "HEAD" : EMPTY_TREE;
    scope = {
      kind: "worktree",
      label: hasHead ? "working tree vs HEAD" : "working tree vs empty tree",
      oldRef,
      newRef: null,
      newSource: "worktree",
      diffArgs: [oldRef],
      includeUntracked,
      oldLabel: hasHead ? "HEAD" : "empty tree",
      newLabel: "working tree",
      hasHead,
      repo,
    };
  }

  scope.paths = cleanPaths;
  scope.pathsArgs = cleanPaths.length ? ["--", ...cleanPaths] : [];
  return scope;
}

function parseNameStatusZ(output) {
  const tokens = output.split("\0");
  const files = [];
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (!token) {
      index += 1;
      continue;
    }
    const match = token.match(/^([A-Z])(\d+)?$/);
    if (!match) {
      index += 1;
      continue;
    }
    const letter = match[1];
    if (letter === "R" || letter === "C") {
      const oldPath = tokens[index + 1];
      const newPath = tokens[index + 2];
      index += 3;
      if (!oldPath || !newPath) break;
      files.push({
        statusCode: letter,
        status: STATUS_LABELS[letter] || "modified",
        path: newPath,
        oldPath,
        copiedFrom: letter === "C" ? oldPath : null,
      });
      continue;
    }
    const filePath = tokens[index + 1];
    index += 2;
    if (!filePath) break;
    files.push({
      statusCode: letter,
      status: STATUS_LABELS[letter] || "modified",
      path: filePath,
      oldPath: null,
      copiedFrom: null,
    });
  }
  return files;
}

export function listChangedFiles(root, scope) {
  const args = [
    "diff",
    "--name-status",
    "-z",
    "--find-renames=20%",
    "--find-copies",
    "--diff-filter=ACDMRTUXB",
    ...scope.diffArgs,
  ];
  if (scope.paths.length) args.push("--", ...scope.paths);
  const output = gitText(args, { cwd: root });
  const files = parseNameStatusZ(output);

  if (scope.includeUntracked) {
    const untrackedArgs = ["ls-files", "--others", "--exclude-standard", "-z"];
    if (scope.paths.length) untrackedArgs.push("--", ...scope.paths);
    const untracked = gitText(untrackedArgs, { cwd: root }).split("\0").filter(Boolean);
    const seen = new Set(files.map((file) => file.path));
    for (const filePath of untracked) {
      if (seen.has(filePath)) continue;
      files.push({
        statusCode: "A",
        status: "added",
        path: filePath,
        oldPath: null,
        copiedFrom: null,
        untracked: true,
      });
    }
  }

  return files
    .filter((file) => !toPosix(file.path).startsWith(".code-review/") && !toPosix(file.oldPath || "").startsWith(".code-review/"))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function readBlob(root, ref, filePath) {
  if (!ref || ref === EMPTY_TREE || !filePath) {
    return { exists: false, buffer: Buffer.alloc(0) };
  }
  const result = gitBuffer(["cat-file", "blob", `${ref}:${filePath}`], {
    cwd: root,
    allowFailure: true,
  });
  if (result.status !== 0) return { exists: false, buffer: Buffer.alloc(0) };
  return { exists: true, buffer: result.stdout };
}

function readIndexBlob(root, filePath) {
  const result = gitBuffer(["cat-file", "blob", `:${filePath}`], {
    cwd: root,
    allowFailure: true,
  });
  if (result.status !== 0) return { exists: false, buffer: Buffer.alloc(0) };
  return { exists: true, buffer: result.stdout };
}

function readWorktree(root, filePath) {
  try {
    return { exists: true, buffer: fs.readFileSync(path.join(root, filePath)) };
  } catch {
    return { exists: false, buffer: Buffer.alloc(0) };
  }
}

function decodeBlob(buffer) {
  if (!buffer || buffer.length === 0) {
    return { text: "", binary: false, empty: true };
  }
  if (isProbablyBinary(buffer)) {
    return { text: "", binary: true, empty: false };
  }
  return { text: normalizeNewlines(buffer.toString("utf8")), binary: false, empty: false };
}

export function readFileContents(root, scope, file) {
  const newBlob = file.status === "deleted"
    ? { exists: false, buffer: Buffer.alloc(0) }
    : scope.newSource === "worktree"
      ? readWorktree(root, file.path)
      : scope.newSource === "index"
        ? readIndexBlob(root, file.path)
        : readBlob(root, scope.newRef, file.path);

  const oldPath = file.oldPath || file.path;
  const oldBlob = file.status === "added" || file.status === "copied"
    ? { exists: false, buffer: Buffer.alloc(0) }
    : readBlob(root, scope.oldRef, oldPath);

  const oldDecoded = file.copiedFrom ? { text: "", binary: false, empty: true } : decodeBlob(oldBlob.buffer);
  const newDecoded = decodeBlob(newBlob.buffer);
  return {
    oldText: oldDecoded.text,
    newText: newDecoded.text,
    oldBinary: oldDecoded.binary,
    newBinary: newDecoded.binary,
    oldExists: oldBlob.exists,
    newExists: newBlob.exists,
    oldBytes: oldBlob.buffer.length,
    newBytes: newBlob.buffer.length,
    binary: oldDecoded.binary || newDecoded.binary,
  };
}

export function getPatch(root, scope, file) {
  if (file.status === "added" || file.status === "copied") return "";
  const args = [
    "diff",
    "--no-color",
    "--unified=3",
    "--find-renames=20%",
    "--find-copies",
    ...scope.diffArgs,
  ];
  const paths = [...new Set([file.oldPath, file.path].filter(Boolean))];
  if (paths.length) args.push("--", ...paths);
  const result = runGit(args, { cwd: root, allowFailure: true });
  return typeof result.stdout === "string" ? result.stdout : result.stdout.toString("utf8");
}

export function getNumstat(root, scope, file) {
  const args = [
    "diff",
    "--numstat",
    "--find-renames=20%",
    "--find-copies",
    ...scope.diffArgs,
  ];
  const paths = [...new Set([file.oldPath, file.path].filter(Boolean))];
  if (paths.length) args.push("--", ...paths);
  const output = gitText(args, { cwd: root, allowFailure: true });
  const line = output.split("\n").find((entry) => entry.trim() !== "");
  if (!line) return { additions: 0, deletions: 0, binary: false };
  const [added, deleted] = line.split("\t");
  if (added === "-" || deleted === "-") return { additions: 0, deletions: 0, binary: true };
  return { additions: Number(added) || 0, deletions: Number(deleted) || 0, binary: false };
}
