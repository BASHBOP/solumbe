import path from "node:path";
import { readDecoratorCalls } from "./text.js";

// Markdown this repository ships as source. `skill` files are agent
// instructions the repository asks contributors to edit — they are the
// implementation of a skill, not commentary about one — so they are indexed
// and classified apart from prose documentation.
const markdownExtensions = new Set([".md", ".mdx", ".markdown"]);
const docExtensions = new Set([...markdownExtensions, ".rst", ".adoc"]);

/**
 * @param {string} file
 * @returns {string}
 */
export function classifyFile(file) {
  const base = path.basename(file);
  if (isTestFilePath(file)) return "test";
  if (/\.(hbs|handlebars)$/i.test(base)) return "template";
  if (/(^|\/)(i18n|locale|locales|translations|messages|languages)(\/|$)/i.test(file) && /\.(json|ya?ml)$/i.test(base)) return "translation";
  if ((/\.(json|ya?ml)$/i.test(base) || base === ".snapshot") && /(feature[-_]?flag|flags|config|environment|settings)/i.test(file)) return "config";
  if (/^changelog(?:\.[a-z0-9_-]+)?\.md$/i.test(base)) return "changelog";
  if (isSkillFilePath(file)) return "skill";
  if (docExtensions.has(path.extname(base).toLowerCase())) return "doc";
  if (/(^|\/)app\/api\/.*\/route\.[cm]?[jt]s$/.test(file)) return "apiRoute";
  if (base === "page.tsx" || base === "page.ts" || base === "layout.tsx" || base === "layout.ts") return "route";
  if (base.endsWith(".controller.ts")) return "controller";
  if (base.endsWith(".service.ts")) return "service";
  if (base.endsWith(".module.ts")) return "module";
  if (base.endsWith(".dto.ts")) return "dto";
  if (base.endsWith(".schema.ts") || file.includes("/schemas/") || /\.prisma$/i.test(base)) return "schema";
  if (/\.sql$/i.test(base)) return "migration";
  if (base.startsWith("use") && /\.(ts|tsx)$/.test(base)) return "hook";
  if (
    file.startsWith("redux/apis/") ||
    file.startsWith("src/redux/apis/") ||
    file.startsWith("services/") ||
    file.startsWith("src/services/") ||
    file === "lib/api-client.ts" ||
    file === "src/lib/api-client.ts" ||
    file === "utils/api-client.ts" ||
    file === "src/utils/api-client.ts"
  )
    return "apiClient";
  if (/^[A-Z]/.test(base) && /\.(tsx|jsx)$/.test(base)) return "component";
  return "source";
}

/**
 * @param {string} file
 * @returns {boolean}
 */
export function isTestFilePath(file) {
  const normalized = file.replaceAll("\\", "/");
  return (
    /(^|\/)(__tests__|test|tests|__snapshots__|snapshots)(\/|$)/.test(normalized) ||
    /\.(spec|test)\.[jt]sx?$/.test(normalized) ||
    /\.snap$/.test(normalized) ||
    /(^|\/)[^/]+_test\.go$/.test(normalized)
  );
}

// Code a test runner executes. Everything else under a test directory — a
// README, a suite summary, a `.snap` snapshot, a JSON fixture — is material a
// test reads or a note about the tests, not a test to run.
const runnableTestExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".go", ".cs", ".py", ".java", ".rb", ".rs"]);

/**
 * @param {string} file
 * @returns {boolean}
 */
export function isRunnableTestPath(file) {
  const normalized = String(file ?? "").replaceAll("\\", "/");
  return isTestFilePath(normalized) && runnableTestExtensions.has(path.extname(normalized).toLowerCase());
}

// ISO 639-1 language codes. A translation file named or nested by one of these
// (optionally with a script or region subtag: en-GB, pt_BR, zh-Hant, es-419)
// is one locale of a catalog its siblings repeat key for key.
const languageCodes = new Set(
  (
    "aa ab ae af ak am an ar as av ay az ba be bg bi bm bn bo br bs ca ce ch co cr cs cu cv cy da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy " +
    "ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo " +
    "lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl " +
    "sm sn so sq sr ss st su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu"
  ).split(" "),
);

/**
 * @param {string} segment
 * @returns {boolean}
 */
function isLocaleSegment(segment) {
  const match = /^([a-z]{2,3})(?:[-_]([a-z]{4}))?(?:[-_]([a-z]{2}|\d{3}))?$/i.exec(segment);
  if (!match) return false;
  const [, language, script, region] = match;
  // Two-letter codes must be real languages so `ui.json` beside `api.json` is
  // not read as two locales. A three-letter language (pcm-NG, fil-PH) counts
  // only with a subtag, which no ordinary file or directory name carries.
  return language.length === 2 ? languageCodes.has(language.toLowerCase()) : Boolean(script || region);
}

/**
 * The locale a translation file holds: `en-NG` for `messages/en-NG.json`, `fr`
 * for `locales/fr/common.json`. Null when no path component names a locale.
 * @param {string} file
 * @returns {string | null}
 */
export function localeOf(file) {
  const segments = String(file ?? "")
    .replaceAll("\\", "/")
    .split("/");
  for (const [index, segment] of segments.entries()) {
    const parts = index < segments.length - 1 ? [segment] : segment.split(".").slice(0, -1);
    const locale = parts.find(isLocaleSegment);
    if (locale) return locale;
  }
  return null;
}

/**
 * The catalog a locale file belongs to, with its locale replaced by `*`:
 * `messages/en-GB.json` and `messages/fr.json` are both `messages/*.json`,
 * `locales/en/common.json` is `locales/*\/common.json`, `devise.en.yml` is
 * `devise.*.yml`. Null when no path component names a locale.
 * @param {string} file
 * @returns {string | null}
 */
export function localeCatalogKey(file) {
  const segments = String(file ?? "")
    .replaceAll("\\", "/")
    .split("/");
  let localized = false;
  /** @param {string} part */
  const mask = (part) => {
    if (!isLocaleSegment(part)) return part;
    localized = true;
    return "*";
  };
  const key = segments
    .map((segment, index) => {
      if (index < segments.length - 1) return mask(segment);
      const parts = segment.split(".");
      return parts.map((part, partIndex) => (partIndex === parts.length - 1 ? part : mask(part))).join(".");
    })
    .join("/");
  return localized ? key : null;
}

// True for the markdown that makes up an agent skill package: any markdown
// under a `skills/` directory, plus the conventional `SKILL.md` entrypoint
// wherever it lives. Companion pages (examples.md, reference.md) ship with the
// skill and are edited alongside it, so they carry the same kind.
/**
 * @param {string} file
 * @returns {boolean}
 */
export function isSkillFilePath(file) {
  const normalized = String(file ?? "").replaceAll("\\", "/");
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  if (!markdownExtensions.has(path.extname(base).toLowerCase())) return false;
  if (/^skill\.md$/i.test(base)) return true;
  return normalized
    .split("/")
    .slice(0, -1)
    .some((segment) => segment.toLowerCase() === "skills");
}

// True when the file is indexable markdown — a skill page or prose
// documentation. Exposed so the code map and the impact ranker agree on what
// counts as markdown without each re-deriving the extension list.
/**
 * @param {string} file
 * @returns {boolean}
 */
export function isMarkdownFilePath(file) {
  const normalized = String(file ?? "").replaceAll("\\", "/");
  return markdownExtensions.has(path.extname(normalized).toLowerCase());
}

/**
 * @param {{ kind: string }} file
 * @returns {boolean}
 */
export function isNotableFile(file) {
  return ["route", "apiRoute", "controller", "service", "module", "apiClient"].includes(file.kind);
}

// Returns both the primary domain (existing behavior, used for display/scoring)
// and the full set of domain tags this file should be discoverable under.
// Feature subdirs (components/livestream/*) get both "components" and "livestream"
// so domain searches don't miss them.
/**
 * @param {string} file
 * @returns {{ primary: string, all: string[] }}
 */
export function inferDomainInfo(file) {
  const normalized = file.replaceAll("\\", "/").replace(/^src\//, "");
  const parts = normalized.split("/");
  /** @type {Set<string>} */
  const all = new Set();
  /** @param {string} value */
  const add = (value) => {
    const cleaned = cleanDomain(value);
    if (cleaned) all.add(cleaned);
  };

  // Treat parts[i] as a feature directory only if a deeper segment exists —
  // otherwise it's actually the file (e.g. components/Button.tsx → parts[1]
  // is the file, not a feature).
  /** @param {number} i */
  const isDir = (i) => i < parts.length - 1;

  /** @type {string} */
  let primary;
  if (normalized.startsWith("app/api/") && parts[2]) {
    primary = cleanDomain(parts[2]);
    if (isDir(3)) add(parts[3]);
  } else if ((parts[0] === "app" || parts[0] === "pages") && parts[1]) {
    primary = cleanDomain(parts[1]);
    if (isDir(2)) add(parts[2]);
  } else if (normalized.startsWith("redux/apis/") && parts[2]) {
    primary = cleanDomain(parts[2].replace(/-api\.[jt]s$/, "").replace(/-apis\.[jt]s$/, ""));
  } else if (normalized.startsWith("services/") && parts[1]) {
    primary = cleanDomain(parts[1].replace(/-service\.[jt]s$/, ""));
  } else {
    const sharedRoots = new Set(["components", "lib", "utils", "schemas", "hooks", "types"]);
    if (sharedRoots.has(parts[0])) {
      primary = cleanDomain(parts[0]);
      if (isDir(1)) add(parts[1]);
    } else {
      const interestingRoots = new Set(["app", "src", "redux", "services"]);
      if (interestingRoots.has(parts[0]) && parts[1]) {
        primary = cleanDomain(parts[1]);
        if (isDir(2)) add(parts[2]);
      } else {
        primary = cleanDomain(parts[0] ?? "root");
      }
    }
  }

  add(primary);
  return { primary, all: [...all] };
}

/**
 * @param {string} value
 * @returns {string}
 */
function cleanDomain(value) {
  return (
    value
      .replace(/\.[cm]?[jt]sx?$/, "")
      .replace(/-api$/, "")
      .replace(/-apis$/, "")
      .replace(/-service$/, "")
      .replace(/[()[\]]/g, "")
      .replace(/^\.+$/, "root") || "root"
  );
}

/**
 * @param {string} file
 * @returns {string | undefined}
 */
export function inferNextRoute(file) {
  const normalized = file.replaceAll("\\", "/");
  if (!normalized.startsWith("app/") && !normalized.startsWith("src/app/") && !normalized.startsWith("pages/") && !normalized.startsWith("src/pages/")) {
    return undefined;
  }

  if (!/(page|layout|route)\.[cm]?[jt]sx?$/.test(path.basename(normalized))) {
    return undefined;
  }

  return (
    normalized
      .replace(/^src\//, "")
      .replace(/^app/, "")
      .replace(/^pages/, "")
      .replace(/\/(page|layout|route)\.[cm]?[jt]sx?$/, "")
      .replace(/\([^/]+\)\//g, "")
      .replace(/\[[^/]+\]/g, (segment) => `:${segment.slice(1, -1)}`) || "/"
  );
}

/**
 * @param {string} text
 * @returns {string | undefined}
 */
export function inferControllerBasePath(text) {
  return readDecoratorCalls(text, ["Controller"]).find((call) => call.argument !== undefined)?.argument;
}

/**
 * @param {string} text
 * @returns {{ method: string, path: string }[]}
 */
export function extractHttpMethods(text) {
  return readDecoratorCalls(text, ["Get", "Post", "Put", "Patch", "Delete", "Options", "Head"]).map((call) => ({
    method: call.name.toUpperCase(),
    path: call.argument?.trim() || "/",
  }));
}
