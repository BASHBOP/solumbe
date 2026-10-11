import { lineNumberAt, stripNonCode } from "./text.js";

/**
 * @typedef {import('./ast.js').AstFacts} AstFacts
 * @typedef {import('./ast.js').CodeSymbol} CodeSymbol
 */

/**
 * A code symbol with a visibility flag, used internally before the flag is
 * stripped from the exported {@link CodeSymbol} shape.
 * @typedef {CodeSymbol & { isPublic: boolean }} VisibilitySymbol
 */

/**
 * @param {string} text
 * @returns {AstFacts}
 */
export function extractGoFacts(text) {
  const codeText = stripNonCode(text);
  const symbols = extractGoSymbols(codeText);
  return {
    imports: extractGoImports(text),
    exports: symbols.filter((symbol) => /^[A-Z]/.test(symbol.name)).map((symbol) => symbol.name),
    symbols,
  };
}

/**
 * @param {string} text
 * @returns {string[]}
 */
function extractGoImports(text) {
  /** @type {Set<string>} */
  const imports = new Set();
  for (const match of text.matchAll(/^\s*import\s+(?:"([^"]+)"|\(([\s\S]*?)\))/gm)) {
    if (match[1]) {
      imports.add(match[1]);
      continue;
    }
    for (const item of (match[2] ?? "").matchAll(/"([^"]+)"/g)) {
      imports.add(item[1]);
    }
  }
  return [...imports].slice(0, 100);
}

/**
 * The module path a `go.mod` declares.
 * @param {string} text
 * @returns {string | undefined}
 */
export function goModulePath(text) {
  return /^\s*module\s+"?([^\s"]+)"?/m.exec(text)?.[1];
}

/**
 * The repository directory a Go import path names. An import is a module path
 * followed by the package's directory under that module's `go.mod`, so it
 * resolves only against the modules the repository declares: the standard
 * library and dependencies name no directory here. Nested modules resolve
 * against the longest module path that matches.
 * @param {string} specifier
 * @param {{ dir: string, module: string }[]} modules `dir` is the directory holding the `go.mod`, "" at the root
 * @returns {string | undefined}
 */
export function goImportDir(specifier, modules) {
  /** @type {{ dir: string, module: string } | undefined} */
  let owner;
  for (const candidate of modules) {
    if (specifier !== candidate.module && !specifier.startsWith(`${candidate.module}/`)) continue;
    if (!owner || candidate.module.length > owner.module.length) owner = candidate;
  }
  if (!owner) return undefined;
  return [owner.dir, specifier.slice(owner.module.length + 1)].filter(Boolean).join("/");
}

/**
 * @param {string} text
 * @returns {CodeSymbol[]}
 */
function extractGoSymbols(text) {
  /** @type {CodeSymbol[]} */
  const symbols = [];
  /** @type {Set<string>} */
  const seen = new Set();
  const definitions = [
    { type: "function", pattern: /^\s*func\s+(?:\([^)]+\)\s*)?([A-Za-z_]\w*)\s*\(/gm },
    { type: "type", pattern: /^\s*type\s+([A-Za-z_]\w*)\b/gm },
    { type: "const", pattern: /^\s*const\s+([A-Za-z_]\w*)\b/gm },
    { type: "var", pattern: /^\s*var\s+([A-Za-z_]\w*)\b/gm },
  ];

  for (const definition of definitions) {
    for (const match of text.matchAll(definition.pattern)) {
      const key = `${definition.type}:${match[1]}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      symbols.push({ type: definition.type, name: match[1], line: lineNumberAt(text, match.index ?? 0) });
    }
  }
  return symbols;
}

/**
 * @param {string} text
 * @returns {AstFacts}
 */
export function extractCsharpFacts(text) {
  const codeText = stripNonCode(text);
  const symbols = extractCsharpSymbols(codeText);
  const exportable = new Set(["class", "interface", "struct", "enum", "record"]);
  return {
    imports: extractCsharpImports(codeText),
    exports: symbols.filter((s) => exportable.has(s.type) && s.isPublic).map((s) => s.name),
    symbols: symbols.map(({ isPublic: _isPublic, ...rest }) => rest),
  };
}

/**
 * @param {string} text
 * @returns {string[]}
 */
function extractCsharpImports(text) {
  /** @type {Set<string>} */
  const imports = new Set();
  for (const match of text.matchAll(/^\s*using\s+(?:static\s+)?([A-Za-z_][\w.]*)\s*;/gm)) {
    imports.add(match[1]);
  }
  return [...imports].slice(0, 100);
}

/**
 * @param {string} text
 * @returns {VisibilitySymbol[]}
 */
function extractCsharpSymbols(text) {
  /** @type {VisibilitySymbol[]} */
  const symbols = [];
  /** @type {Set<string>} */
  const seen = new Set();
  const accessModifiers = "(?:public|private|protected|internal|protected\\s+internal|private\\s+protected)";
  const otherModifiers = "(?:static|sealed|abstract|partial|virtual|override|async|readonly|extern|unsafe|new)";
  const modifierGroup = `(?:(?:${accessModifiers}|${otherModifiers})\\s+)*`;
  const definitions = [
    { type: "namespace", pattern: /\bnamespace\s+([A-Za-z_][\w.]*)/g, alwaysPublic: true },
    { type: "class", pattern: new RegExp(`\\b(${accessModifiers}\\s+)?${modifierGroup}class\\s+([A-Za-z_]\\w*)`, "g") },
    { type: "interface", pattern: new RegExp(`\\b(${accessModifiers}\\s+)?${modifierGroup}interface\\s+([A-Za-z_]\\w*)`, "g") },
    { type: "struct", pattern: new RegExp(`\\b(${accessModifiers}\\s+)?${modifierGroup}struct\\s+([A-Za-z_]\\w*)`, "g") },
    { type: "enum", pattern: new RegExp(`\\b(${accessModifiers}\\s+)?${modifierGroup}enum\\s+([A-Za-z_]\\w*)`, "g") },
    { type: "record", pattern: new RegExp(`\\b(${accessModifiers}\\s+)?${modifierGroup}record\\s+([A-Za-z_]\\w*)`, "g") },
  ];

  for (const definition of definitions) {
    for (const match of text.matchAll(definition.pattern)) {
      const name = match[match.length - 1];
      if (!name) continue;
      const key = `${definition.type}:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const isPublic = definition.alwaysPublic ? true : Boolean(match[1] && /\bpublic\b/.test(match[1]));
      symbols.push({ type: definition.type, name, line: lineNumberAt(text, match.index ?? 0), isPublic });
    }
  }

  const methodPattern = new RegExp(
    `^[ \\t]*(?:\\[[^\\]]*\\][ \\t]*\\r?\\n[ \\t]*)*` +
      `(?:(${accessModifiers})\\s+)?(?:${otherModifiers}\\s+)*` +
      `[A-Za-z_][\\w<>?\\[\\],\\.\\s]*?\\s+([A-Za-z_]\\w*)\\s*\\([^;{}=>]*?\\)\\s*(?:where[^{;]*)?\\{`,
    "gm",
  );
  const methodKeywords = new Set([
    "if",
    "for",
    "foreach",
    "while",
    "switch",
    "using",
    "lock",
    "catch",
    "try",
    "finally",
    "fixed",
    "do",
    "else",
    "return",
    "throw",
    "new",
    "checked",
    "unchecked",
  ]);
  for (const match of text.matchAll(methodPattern)) {
    const name = match[2];
    if (!name || methodKeywords.has(name)) continue;
    const key = `method:${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const isPublic = Boolean(match[1] && /\bpublic\b/.test(match[1]));
    symbols.push({ type: "method", name, line: lineNumberAt(text, match.index ?? 0), isPublic });
  }

  return symbols;
}

/**
 * @param {string} text
 * @returns {AstFacts}
 */
export function extractPythonFacts(text) {
  const codeText = stripPythonComments(text);
  const symbols = extractPythonSymbols(codeText);
  return {
    imports: extractPythonImports(codeText),
    exports: symbols.filter((s) => !s.name.startsWith("_")).map((s) => s.name),
    symbols,
  };
}

/**
 * @param {string} text
 * @returns {string}
 */
function stripPythonComments(text) {
  /** @type {string[]} */
  const chars = [];
  let index = 0;
  let inString = false;
  let stringQuote = "";
  let stringIsTriple = false;
  while (index < text.length) {
    const ch = text[index];
    const next2 = text.slice(index, index + 3);
    if (!inString && ch === "#") {
      while (index < text.length && text[index] !== "\n") {
        chars.push(" ");
        index += 1;
      }
      continue;
    }
    if (!inString && (next2 === '"""' || next2 === "'''")) {
      stringQuote = ch;
      stringIsTriple = true;
      inString = true;
      chars.push(" ", " ", " ");
      index += 3;
      continue;
    }
    if (inString && stringIsTriple && next2 === `${stringQuote}${stringQuote}${stringQuote}`) {
      chars.push(" ", " ", " ");
      index += 3;
      inString = false;
      stringIsTriple = false;
      stringQuote = "";
      continue;
    }
    if (!inString && (ch === '"' || ch === "'")) {
      stringQuote = ch;
      stringIsTriple = false;
      inString = true;
      chars.push(ch);
      index += 1;
      continue;
    }
    if (inString && !stringIsTriple && ch === stringQuote && text[index - 1] !== "\\") {
      inString = false;
      stringQuote = "";
      chars.push(ch);
      index += 1;
      continue;
    }
    chars.push(inString && ch !== "\n" ? " " : ch);
    index += 1;
  }
  return chars.join("");
}

/**
 * @param {string} text
 * @returns {string[]}
 */
function extractPythonImports(text) {
  /** @type {Set<string>} */
  const imports = new Set();
  for (const match of text.matchAll(/^\s*import\s+([A-Za-z_][\w.]*(?:\s*,\s*[A-Za-z_][\w.]*)*)/gm)) {
    for (const name of match[1].split(",")) {
      const cleaned = name.trim().split(/\s+as\s+/)[0];
      if (cleaned) imports.add(cleaned);
    }
  }
  for (const match of text.matchAll(/^\s*from\s+(\.*[A-Za-z_][\w.]*|\.+)\s+import\s+/gm)) {
    imports.add(match[1]);
  }
  return [...imports].slice(0, 100);
}

/**
 * @param {string} text
 * @returns {CodeSymbol[]}
 */
function extractPythonSymbols(text) {
  /** @type {CodeSymbol[]} */
  const symbols = [];
  /** @type {Set<string>} */
  const seen = new Set();
  const definitions = [
    { type: "class", pattern: /^[ \t]*class\s+([A-Za-z_]\w*)/gm },
    { type: "function", pattern: /^[ \t]*(?:async\s+)?def\s+([A-Za-z_]\w*)/gm },
  ];
  for (const definition of definitions) {
    for (const match of text.matchAll(definition.pattern)) {
      const name = match[1];
      if (!name) continue;
      const key = `${definition.type}:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      symbols.push({ type: definition.type, name, line: lineNumberAt(text, match.index ?? 0) });
    }
  }
  return symbols;
}

/**
 * @param {string} text
 * @returns {AstFacts}
 */
export function extractJavaFacts(text) {
  const codeText = stripNonCode(text);
  const symbols = extractJavaSymbols(codeText);
  const exportable = new Set(["class", "interface", "enum", "record"]);
  return {
    imports: extractJavaImports(codeText),
    exports: symbols.filter((s) => exportable.has(s.type) && s.isPublic).map((s) => s.name),
    symbols: symbols.map(({ isPublic: _isPublic, ...rest }) => rest),
  };
}

/**
 * @param {string} text
 * @returns {string[]}
 */
function extractJavaImports(text) {
  /** @type {Set<string>} */
  const imports = new Set();
  for (const match of text.matchAll(/^\s*import\s+(?:static\s+)?([A-Za-z_][\w.]*(?:\.\*)?)\s*;/gm)) {
    imports.add(match[1]);
  }
  return [...imports].slice(0, 100);
}

/**
 * @param {string} text
 * @returns {VisibilitySymbol[]}
 */
function extractJavaSymbols(text) {
  /** @type {VisibilitySymbol[]} */
  const symbols = [];
  /** @type {Set<string>} */
  const seen = new Set();
  const accessModifiers = "(?:public|private|protected)";
  const otherModifiers = "(?:static|final|abstract|sealed|non-sealed|strictfp|default)";
  const modifierGroup = `(?:(?:${accessModifiers}|${otherModifiers})\\s+)*`;
  const definitions = [
    { type: "package", pattern: /^\s*package\s+([A-Za-z_][\w.]*)\s*;/gm, alwaysPublic: true },
    { type: "class", pattern: new RegExp(`\\b(${accessModifiers}\\s+)?${modifierGroup}class\\s+([A-Za-z_]\\w*)`, "g") },
    { type: "interface", pattern: new RegExp(`\\b(${accessModifiers}\\s+)?${modifierGroup}interface\\s+([A-Za-z_]\\w*)`, "g") },
    { type: "enum", pattern: new RegExp(`\\b(${accessModifiers}\\s+)?${modifierGroup}enum\\s+([A-Za-z_]\\w*)`, "g") },
    { type: "record", pattern: new RegExp(`\\b(${accessModifiers}\\s+)?${modifierGroup}record\\s+([A-Za-z_]\\w*)`, "g") },
  ];
  for (const definition of definitions) {
    for (const match of text.matchAll(definition.pattern)) {
      const name = match[match.length - 1];
      if (!name) continue;
      const key = `${definition.type}:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const isPublic = definition.alwaysPublic ? true : Boolean(match[1] && /\bpublic\b/.test(match[1]));
      symbols.push({ type: definition.type, name, line: lineNumberAt(text, match.index ?? 0), isPublic });
    }
  }

  const methodPattern = new RegExp(
    `^[ \\t]*(?:@[A-Za-z_][\\w.]*(?:\\([^)]*\\))?[ \\t]*\\r?\\n[ \\t]*)*` +
      `(?:(${accessModifiers})\\s+)?(?:${otherModifiers}\\s+)*` +
      `(?:<[^>]+>\\s+)?[A-Za-z_][\\w<>?\\[\\],\\.\\s]*?\\s+([A-Za-z_]\\w*)\\s*\\([^;{}=]*?\\)\\s*(?:throws\\s+[A-Za-z_][\\w.,\\s]*)?\\{`,
    "gm",
  );
  const methodKeywords = new Set(["if", "for", "while", "switch", "catch", "try", "synchronized", "return", "new"]);
  for (const match of text.matchAll(methodPattern)) {
    const name = match[2];
    if (!name || methodKeywords.has(name)) continue;
    const key = `method:${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const isPublic = Boolean(match[1] && /\bpublic\b/.test(match[1]));
    symbols.push({ type: "method", name, line: lineNumberAt(text, match.index ?? 0), isPublic });
  }
  return symbols;
}

/**
 * @param {string} text
 * @returns {AstFacts}
 */
export function extractRubyFacts(text) {
  const codeText = stripRubyComments(text);
  const symbols = extractRubySymbols(codeText);
  return {
    imports: extractRubyImports(codeText),
    exports: symbols.filter((s) => s.type === "class" || s.type === "module").map((s) => s.name),
    symbols,
  };
}

/**
 * @param {string} text
 * @returns {string}
 */
function stripRubyComments(text) {
  const lines = text.split("\n");
  /** @type {string[]} */
  const out = [];
  let inHeredoc = false;
  let inBlockComment = false;
  for (const line of lines) {
    if (inBlockComment) {
      if (/^=end\b/.test(line)) inBlockComment = false;
      out.push("");
      continue;
    }
    if (/^=begin\b/.test(line)) {
      inBlockComment = true;
      out.push("");
      continue;
    }
    if (inHeredoc) {
      out.push("");
      continue;
    }
    out.push(line.replace(/(^|[^$])#.*$/, "$1"));
  }
  return out.join("\n");
}

/**
 * @param {string} text
 * @returns {string[]}
 */
function extractRubyImports(text) {
  /** @type {Set<string>} */
  const imports = new Set();
  for (const match of text.matchAll(/^\s*require(?:_relative)?\s+["']([^"']+)["']/gm)) {
    imports.add(match[1]);
  }
  return [...imports].slice(0, 100);
}

/**
 * @param {string} text
 * @returns {CodeSymbol[]}
 */
function extractRubySymbols(text) {
  /** @type {CodeSymbol[]} */
  const symbols = [];
  /** @type {Set<string>} */
  const seen = new Set();
  const definitions = [
    { type: "module", pattern: /^[ \t]*module\s+([A-Z][\w:]*)/gm },
    { type: "class", pattern: /^[ \t]*class\s+([A-Z][\w:]*)/gm },
    { type: "method", pattern: /^[ \t]*def\s+(?:self\.)?([A-Za-z_]\w*[!?=]?)/gm },
  ];
  for (const definition of definitions) {
    for (const match of text.matchAll(definition.pattern)) {
      const name = match[1];
      if (!name) continue;
      const key = `${definition.type}:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      symbols.push({ type: definition.type, name, line: lineNumberAt(text, match.index ?? 0) });
    }
  }
  return symbols;
}

/**
 * @param {string} text
 * @returns {AstFacts}
 */
export function extractRustFacts(text) {
  const codeText = stripNonCode(text);
  const symbols = extractRustSymbols(codeText);
  return {
    imports: extractRustImports(codeText),
    exports: symbols.filter((s) => s.isPublic).map((s) => s.name),
    symbols: symbols.map(({ isPublic: _isPublic, ...rest }) => rest),
  };
}

/**
 * @param {string} text
 * @returns {string[]}
 */
function extractRustImports(text) {
  /** @type {Set<string>} */
  const imports = new Set();
  for (const match of text.matchAll(/^\s*use\s+([A-Za-z_][\w:]*(?:::[\w:{}*,\s]+)?)\s*;/gm)) {
    const cleaned = match[1].replace(/\s+/g, "");
    imports.add(cleaned);
  }
  return [...imports].slice(0, 100);
}

/**
 * @param {string} text
 * @returns {VisibilitySymbol[]}
 */
function extractRustSymbols(text) {
  /** @type {VisibilitySymbol[]} */
  const symbols = [];
  /** @type {Set<string>} */
  const seen = new Set();
  const visibility = "(?:pub(?:\\s*\\([^)]*\\))?)";
  const definitions = [
    { type: "mod", pattern: new RegExp(`^[ \\t]*(${visibility}\\s+)?mod\\s+([A-Za-z_]\\w*)`, "gm") },
    { type: "struct", pattern: new RegExp(`^[ \\t]*(${visibility}\\s+)?struct\\s+([A-Za-z_]\\w*)`, "gm") },
    { type: "enum", pattern: new RegExp(`^[ \\t]*(${visibility}\\s+)?enum\\s+([A-Za-z_]\\w*)`, "gm") },
    { type: "trait", pattern: new RegExp(`^[ \\t]*(${visibility}\\s+)?(?:unsafe\\s+)?trait\\s+([A-Za-z_]\\w*)`, "gm") },
    {
      type: "function",
      pattern: new RegExp(`^[ \\t]*(${visibility}\\s+)?(?:async\\s+|unsafe\\s+|const\\s+|extern\\s+(?:"[^"]+"\\s+)?)*fn\\s+([A-Za-z_]\\w*)`, "gm"),
    },
    { type: "type", pattern: new RegExp(`^[ \\t]*(${visibility}\\s+)?type\\s+([A-Za-z_]\\w*)`, "gm") },
  ];
  for (const definition of definitions) {
    for (const match of text.matchAll(definition.pattern)) {
      const name = match[2];
      if (!name) continue;
      const key = `${definition.type}:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const isPublic = Boolean(match[1]);
      symbols.push({ type: definition.type, name, line: lineNumberAt(text, match.index ?? 0), isPublic });
    }
  }
  return symbols;
}
