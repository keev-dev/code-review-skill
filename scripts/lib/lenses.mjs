import path from "node:path";
import { readJson, toPosix } from "./util.mjs";
import { isCodeLanguage } from "./diff.mjs";

function globToRegex(glob) {
  const normalized = toPosix(glob);
  let regex = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === "*") {
      if (normalized[index + 1] === "*") {
        if (normalized[index + 2] === "/") {
          regex += "(?:.*/)?";
          index += 2;
        } else {
          regex += ".*";
          index += 1;
        }
      } else {
        regex += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      regex += "[^/]";
      continue;
    }
    if ("\\^$+?.()|{}[]".includes(char)) {
      regex += `\\${char}`;
      continue;
    }
    regex += char;
  }
  return new RegExp(`^${regex}$`, "i");
}

function matchesAnyGlob(filePath, globs) {
  if (!Array.isArray(globs) || globs.length === 0) return null;
  for (const glob of globs) {
    if (globToRegex(glob).test(filePath)) return glob;
  }
  return null;
}

function matchesAnyKeyword(filePath, keywords) {
  if (!Array.isArray(keywords) || keywords.length === 0) return null;
  const lower = filePath.toLowerCase();
  for (const keyword of keywords) {
    if (lower.includes(String(keyword).toLowerCase())) return keyword;
  }
  return null;
}

function matchesAnyPattern(content, patterns) {
  if (!Array.isArray(patterns) || patterns.length === 0) return null;
  for (const pattern of patterns) {
    try {
      const regex = new RegExp(pattern, "m");
      if (regex.test(content)) return pattern;
    } catch {
      // An invalid pattern is ignored rather than breaking a review.
    }
  }
  return null;
}

export function loadLensConfig(skillRoot) {
  const file = path.join(skillRoot, "lenses.json");
  const config = readJson(file);
  if (!config || !config.lenses || typeof config.lenses !== "object") {
    throw new Error(`lenses.json is invalid: ${file}`);
  }
  return config;
}

export function lensCatalog(config) {
  const catalog = {};
  for (const [id, lens] of Object.entries(config.lenses)) {
    catalog[id] = {
      id,
      label: lens.label || id,
      color: lens.color || "#9aa7b8",
      kind: lens.kind || "builtin",
      doc: lens.doc || null,
      description: lens.description || "",
    };
  }
  return catalog;
}

export function detectLenses({ filePath, content, language, config }) {
  const pathForMatch = toPosix(filePath);
  const reasons = {};
  const ids = [];

  const add = (id, reason) => {
    if (!ids.includes(id)) ids.push(id);
    if (reason && !reasons[id]) reasons[id] = reason;
  };

  const excludedAlways = new Set(config.alwaysExcludeLanguages || []);
  if (isCodeLanguage(language) && !excludedAlways.has(language)) {
    for (const id of config.always || []) add(id, "always applied to source files");
  }

  for (const [id, lens] of Object.entries(config.lenses || {})) {
    if (lens.kind === "builtin") continue;
    const applies = lens.appliesTo || {};
    const glob = matchesAnyGlob(pathForMatch, applies.globs);
    if (glob) add(id, `path matches ${glob}`);
    const keyword = matchesAnyKeyword(pathForMatch, applies.pathKeywords);
    if (keyword) add(id, `path contains "${keyword}"`);
    const pattern = matchesAnyPattern(content || "", applies.contentPatterns);
    if (pattern) add(id, `content matches /${pattern}/`);
    if (Array.isArray(applies.languages) && applies.languages.includes(language)) {
      add(id, `language is ${language}`);
    }
  }

  const catalog = lensCatalog(config);
  const order = Object.keys(config.lenses);
  ids.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return {
    lenses: ids,
    reasons,
    catalog,
  };
}

export function validateLensIds(ids, config) {
  const known = new Set(Object.keys(config.lenses || {}));
  return (ids || []).filter((id) => !known.has(id));
}
