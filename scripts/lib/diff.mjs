import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ensureDir,
  normalizeNewlines,
  removeRecursive,
  runGit,
  sha1,
} from "./util.mjs";

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

export function fileLines(text) {
  const normalized = normalizeNewlines(text);
  if (normalized === "") return [];
  const lines = normalized.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function parseHunks(patch) {
  const lines = normalizeNewlines(patch).split("\n");
  const hunks = [];
  let current = null;
  let oldLine = 0;
  let newLine = 0;

  const finish = () => {
    if (!current) return;
    current.additions = current.addedLines.length;
    current.deletions = current.deletedLines.length;
    current.id = `H${hunks.length + 1}`;
    hunks.push(current);
    current = null;
  };

  for (const line of lines) {
    const match = line.match(HUNK_HEADER);
    if (match) {
      finish();
      const oldStart = Number(match[1]);
      const oldLines = match[2] === undefined ? 1 : Number(match[2]);
      const newStart = Number(match[3]);
      const newLines = match[4] === undefined ? 1 : Number(match[4]);
      current = {
        id: "",
        header: line,
        oldStart,
        oldLines,
        newStart,
        newLines,
        addedLines: [],
        deletedLines: [],
        additions: 0,
        deletions: 0,
        section: (match[5] || "").trim(),
      };
      oldLine = oldStart;
      newLine = newStart;
      continue;
    }
    if (!current) continue;
    if (line === "\\ No newline at end of file") continue;
    if (line.startsWith("diff --git") || line.startsWith("--- ") || line.startsWith("+++ ")) {
      finish();
      continue;
    }
    if (line.startsWith("+")) {
      current.addedLines.push(newLine);
      newLine += 1;
      continue;
    }
    if (line.startsWith("-")) {
      current.deletedLines.push(oldLine);
      oldLine += 1;
      continue;
    }
    if (line.startsWith(" ") || line === "") {
      oldLine += 1;
      newLine += 1;
      continue;
    }
    // A blank line at the end of a per-file patch, or metadata we do not need.
    if (line.trim() === "") continue;
    finish();
  }
  finish();
  return hunks;
}

export function makeWholeFileHunks(content, side, maxLines = 80) {
  const lines = fileLines(content);
  if (lines.length === 0) return [];
  const hunks = [];
  for (let start = 0; start < lines.length; start += maxLines) {
    const end = Math.min(lines.length, start + maxLines);
    const count = end - start;
    const numberStart = start + 1;
    const addedLines = [];
    const deletedLines = [];
    for (let line = numberStart; line < numberStart + count; line += 1) {
      if (side === "new") addedLines.push(line);
      else deletedLines.push(line);
    }
    hunks.push({
      id: `H${hunks.length + 1}`,
      header: side === "new" ? `@@ -0,0 +${numberStart},${count} @@` : `@@ -${numberStart},${count} +0,0 @@`,
      oldStart: side === "new" ? 0 : numberStart,
      oldLines: side === "new" ? 0 : count,
      newStart: side === "new" ? numberStart : 0,
      newLines: side === "new" ? count : 0,
      addedLines,
      deletedLines,
      additions: addedLines.length,
      deletions: deletedLines.length,
      section: "",
    });
  }
  return hunks;
}

function blockFromHunks(hunks, index, side) {
  const first = hunks[0];
  const last = hunks[hunks.length - 1];
  const oldStarts = hunks.filter((hunk) => hunk.oldLines > 0).map((hunk) => hunk.oldStart);
  const newStarts = hunks.filter((hunk) => hunk.newLines > 0).map((hunk) => hunk.newStart);
  const oldStart = oldStarts.length ? Math.min(...oldStarts) : 1;
  const newStart = newStarts.length ? Math.min(...newStarts) : 1;
  const oldEnd = oldStarts.length
    ? Math.max(...hunks.map((hunk) => (hunk.oldLines > 0 ? hunk.oldStart + hunk.oldLines - 1 : 0)))
    : oldStart;
  const newEnd = newStarts.length
    ? Math.max(...hunks.map((hunk) => (hunk.newLines > 0 ? hunk.newStart + hunk.newLines - 1 : 0)))
    : newStart;
  const addedLines = [...new Set(hunks.flatMap((hunk) => hunk.addedLines))].sort((a, b) => a - b);
  const deletedLines = [...new Set(hunks.flatMap((hunk) => hunk.deletedLines))].sort((a, b) => a - b);
  const startLine = side === "old" ? oldStart : newStart;
  const endLine = side === "old" ? Math.max(oldStart, oldEnd) : Math.max(newStart, newEnd);
  return {
    id: `B${index + 1}`,
    startLine: Number.isFinite(startLine) ? startLine : 1,
    endLine: Number.isFinite(endLine) ? endLine : 1,
    oldStart: Number.isFinite(oldStart) ? oldStart : 1,
    oldEnd,
    newStart: Number.isFinite(newStart) ? newStart : 1,
    newEnd,
    side,
    hunkIds: hunks.map((hunk) => hunk.id),
    addedLines,
    deletedLines,
    additions: addedLines.length,
    deletions: deletedLines.length,
    additionsTotal: hunks.reduce((sum, hunk) => sum + hunk.additions, 0),
    deletionsTotal: hunks.reduce((sum, hunk) => sum + hunk.deletions, 0),
    header: first.header,
    section: first.section || last.section || "",
    oversized: (side === "old" ? oldEnd - oldStart + 1 : newEnd - newStart + 1) > 220,
  };
}

export function groupHunksIntoBlocks(hunks, { side = "new", gap = 12, maxLines = 90 } = {}) {
  if (!hunks || hunks.length === 0) return [];
  const sorted = [...hunks].sort((a, b) => {
    const aLine = side === "old" ? a.oldStart : a.newStart;
    const bLine = side === "old" ? b.oldStart : b.newStart;
    return aLine - bLine;
  });
  const groups = [];
  for (const hunk of sorted) {
    const hunkStart = side === "old" ? hunk.oldStart : hunk.newStart;
    const hunkCount = side === "old" ? hunk.oldLines : hunk.newLines;
    const hunkEnd = Math.max(hunkStart, hunkStart + Math.max(0, hunkCount - 1));
    const previous = groups[groups.length - 1];
    if (previous) {
      const previousHunks = previous.hunks;
      const previousLast = previousHunks[previousHunks.length - 1];
      const previousStart = side === "old" ? previousHunks[0].oldStart : previousHunks[0].newStart;
      const previousCount = side === "old" ? previousLast.oldLines : previousLast.newLines;
      const previousEnd = Math.max(
        previousStart,
        (side === "old" ? previousLast.oldStart : previousLast.newStart) + Math.max(0, previousCount - 1),
      );
      const mergedStart = Math.min(previousStart, hunkStart);
      const mergedEnd = Math.max(previousEnd, hunkEnd);
      if (hunkStart - previousEnd <= gap && mergedEnd - mergedStart + 1 <= maxLines) {
        previous.hunks.push(hunk);
        continue;
      }
    }
    groups.push({ hunks: [hunk] });
  }
  return groups.map((group, index) => blockFromHunks(group.hunks, index, side));
}

export function splitBlocksAtBlankLines(blocks, text, {
  side = "new",
  maxBlockLines = 38,
  minBlockLines = 12,
  splitLookahead = 34,
} = {}) {
  const lines = fileLines(text);
  if (!blocks || blocks.length === 0 || lines.length === 0) return blocks;

  const result = [];
  for (const block of blocks) {
    const span = block.endLine - block.startLine + 1;
    if (span <= maxBlockLines) {
      result.push(block);
      continue;
    }

    let chunkStart = block.startLine;
    while (chunkStart <= block.endLine) {
      if (block.endLine - chunkStart + 1 <= maxBlockLines) {
        result.push(makeSplitBlock(block, chunkStart, block.endLine, side));
        break;
      }
      let splitAt = null;
      const lower = chunkStart + minBlockLines;
      const upper = Math.min(block.endLine - 1, chunkStart + splitLookahead);
      for (let line = lower; line <= upper; line += 1) {
        const value = lines[line - 1];
        if (value !== undefined && value.trim() === "") {
          splitAt = line;
          break;
        }
      }
      if (!splitAt) {
        result.push(makeSplitBlock(block, chunkStart, block.endLine, side));
        break;
      }
      result.push(makeSplitBlock(block, chunkStart, splitAt, side));
      chunkStart = splitAt + 1;
    }
  }

  return result.map((block, index) => ({
    ...block,
    id: `B${index + 1}`,
    additions: block.addedLines.length,
    deletions: block.deletedLines.length,
    additionsTotal: block.addedLines.length,
    deletionsTotal: block.deletedLines.length,
  }));
}

function makeSplitBlock(block, startLine, endLine, side) {
  const oldSpan = Math.max(0, block.oldEnd - block.oldStart);
  const newSpan = Math.max(1, block.endLine - block.startLine);
  const startOffset = Math.max(0, startLine - block.startLine);
  const endOffset = Math.max(startOffset, endLine - block.startLine);
  const oldFrom = block.oldStart + Math.floor((startOffset / newSpan) * oldSpan);
  const oldTo = block.oldStart + Math.ceil((endOffset / newSpan) * oldSpan);
  return {
    ...block,
    startLine,
    endLine,
    oldStart: side === "old" ? startLine : oldFrom,
    oldEnd: side === "old" ? endLine : Math.max(oldFrom, oldTo),
    addedLines: block.addedLines.filter((line) => line >= startLine && line <= endLine),
    deletedLines: side === "old"
      ? block.deletedLines.filter((line) => line >= startLine && line <= endLine)
      : block.deletedLines.filter((line) => line >= oldFrom && line <= oldTo),
    oversized: endLine - startLine + 1 > 220,
  };
}

export function diffStatBetweenTexts(oldText, newText) {
  if (normalizeNewlines(oldText) === normalizeNewlines(newText)) {
    return { additions: 0, deletions: 0, binary: false };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "code-review-diff-"));
  try {
    const oldFile = path.join(dir, "old.txt");
    const newFile = path.join(dir, "new.txt");
    fs.writeFileSync(oldFile, oldText, "utf8");
    fs.writeFileSync(newFile, newText, "utf8");
    const result = runGit(
      ["diff", "--no-index", "--numstat", "--no-color", "--", oldFile, newFile],
      { allowFailure: true, cwd: dir },
    );
    const output = typeof result.stdout === "string" ? result.stdout : result.stdout.toString("utf8");
    const first = output.split("\n").find((line) => line.trim() !== "");
    if (!first) return { additions: 0, deletions: 0, binary: false };
    const [added, deleted] = first.split("\t");
    if (added === "-" || deleted === "-") return { additions: 0, deletions: 0, binary: true };
    return {
      additions: Number(added) || 0,
      deletions: Number(deleted) || 0,
      binary: false,
    };
  } finally {
    removeRecursive(dir);
  }
}

const LANGUAGE_BY_EXTENSION = {
  ".astro": "astro",
  ".bash": "bash",
  ".c": "c",
  ".cc": "cpp",
  ".clj": "clojure",
  ".cpp": "cpp",
  ".cs": "csharp",
  ".css": "css",
  ".cxx": "cpp",
  ".dart": "dart",
  ".diff": "diff",
  ".dockerfile": "docker",
  ".ex": "elixir",
  ".exs": "elixir",
  ".go": "go",
  ".graphql": "graphql",
  ".gql": "graphql",
  ".h": "c",
  ".hpp": "cpp",
  ".html": "html",
  ".htm": "html",
  ".java": "java",
  ".js": "javascript",
  ".json": "json",
  ".jsonc": "json",
  ".jsx": "jsx",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".less": "less",
  ".lua": "lua",
  ".md": "markdown",
  ".mdx": "mdx",
  ".mjs": "javascript",
  ".mts": "typescript",
  ".php": "php",
  ".prisma": "prisma",
  ".ps1": "powershell",
  ".py": "python",
  ".rb": "ruby",
  ".rs": "rust",
  ".scala": "scala",
  ".scss": "scss",
  ".sh": "bash",
  ".sql": "sql",
  ".svelte": "svelte",
  ".swift": "swift",
  ".tf": "terraform",
  ".toml": "toml",
  ".ts": "typescript",
  ".tsx": "tsx",
  ".vue": "vue",
  ".xml": "xml",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".zig": "zig",
};

const CODE_LANGUAGES = new Set([
  "astro", "bash", "c", "clojure", "cpp", "csharp", "css", "dart", "docker", "elixir",
  "go", "graphql", "html", "java", "javascript", "jsx", "kotlin", "less", "lua", "mdx",
  "php", "powershell", "prisma", "python", "ruby", "rust", "scala", "scss", "sql", "svelte",
  "swift", "terraform", "tsx", "typescript", "vue", "zig",
]);

const SQL_LANGUAGES = new Set(["sql", "prisma"]);

export function languageFor(filePath) {
  const base = path.basename(filePath).toLowerCase();
  if (base === "dockerfile" || base.startsWith("dockerfile.")) return "docker";
  if (base === "makefile" || base === "gnumakefile") return "makefile";
  if (base === "cmakelists.txt") return "cmake";
  if (base === ".gitignore" || base === ".gitattributes" || base === ".editorconfig") return "config";
  const extension = path.extname(base);
  return LANGUAGE_BY_EXTENSION[extension] || (base.includes(".") ? extension.slice(1) || "text" : "text");
}

export function isCodeLanguage(language) {
  return CODE_LANGUAGES.has(language);
}

export function isSqlLanguage(language) {
  return SQL_LANGUAGES.has(language);
}

export function pathFingerprint(filePath, oldText, newText) {
  return sha1(`${filePath}\0${oldText}\0${newText}`);
}

export function summarizeHunks(hunks) {
  return {
    hunks: hunks.length,
    additions: hunks.reduce((sum, hunk) => sum + hunk.additions, 0),
    deletions: hunks.reduce((sum, hunk) => sum + hunk.deletions, 0),
  };
}

export function patchHasModeOnlyChange(patch) {
  return /^old mode /m.test(patch) || /^new mode /m.test(patch) || /^new file mode /m.test(patch) || /^deleted file mode /m.test(patch);
}
