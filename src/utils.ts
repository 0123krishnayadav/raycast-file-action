import { getPreferenceValues, LocalStorage } from "@raycast/api";
import { runAppleScript } from "@raycast/utils";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type Operation = "move" | "copy";

const HISTORY_KEY = "visitedFolders";
const HISTORY_LIMIT = 100;
const HOME = homedir();

type HistoryEntry = { path: string; time: number };

export function expandHome(p: string): string {
  return p.startsWith("~") ? path.join(HOME, p.slice(1)) : p;
}

export function prettyPath(p: string): string {
  return p === HOME || p.startsWith(HOME + "/") ? "~" + p.slice(HOME.length) : p;
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

// ---------- Visited folders ----------

async function readHistory(): Promise<HistoryEntry[]> {
  const raw = await LocalStorage.getItem<string>(HISTORY_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as HistoryEntry[];
  } catch {
    return [];
  }
}

export async function recordVisit(folders: string[]): Promise<void> {
  const now = Date.now();
  const unique = [...new Set(folders)];
  const history = (await readHistory()).filter((e) => !unique.includes(e.path));
  const next = [...unique.map((p) => ({ path: p, time: now })), ...history].slice(0, HISTORY_LIMIT);
  await LocalStorage.setItem(HISTORY_KEY, JSON.stringify(next));
}

function isNoise(p: string): boolean {
  const rel = p.startsWith(HOME) ? p.slice(HOME.length) : p;
  return (
    rel.startsWith("/Library") ||
    rel.split("/").some((seg) => seg.startsWith(".") || seg === "node_modules") ||
    p.includes(".app/")
  );
}

/** Folders macOS recently used (opened in Finder, etc.), via Spotlight. */
async function spotlightRecentFolders(): Promise<HistoryEntry[]> {
  try {
    const { stdout } = await execFileAsync(
      "mdfind",
      [
        "-onlyin",
        HOME,
        "-attr",
        "kMDItemLastUsedDate",
        'kMDItemContentType == "public.folder" && kMDItemLastUsedDate >= $time.today(-60)',
      ],
      { maxBuffer: 10 * 1024 * 1024, timeout: 5000 },
    );
    return stdout
      .split("\n")
      .map((line) => line.match(/^(.*?)\s+kMDItemLastUsedDate = (.+)$/))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map((m) => ({ path: m[1], time: Date.parse(m[2].replace(" ", "T").replace(" +0000", "Z")) || 0 }))
      .filter((e) => !isNoise(e.path));
  } catch {
    return [];
  }
}

const ZOXIDE_BINS = [
  "/opt/homebrew/bin/zoxide",
  "/usr/local/bin/zoxide",
  path.join(HOME, ".cargo/bin/zoxide"),
  path.join(HOME, ".local/bin/zoxide"),
  path.join(HOME, ".nix-profile/bin/zoxide"),
  "/run/current-system/sw/bin/zoxide",
];

/** Folders from zoxide, most used first (frecency). Empty if zoxide isn't installed. */
async function zoxideFolders(): Promise<string[]> {
  // Raycast doesn't inherit the shell PATH, so look in the usual install locations.
  for (const bin of ZOXIDE_BINS) {
    try {
      const { stdout } = await execFileAsync(bin, ["query", "--list"], { timeout: 3000 });
      return stdout.split("\n").filter(Boolean);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") return [];
    }
  }
  return [];
}

export type FolderLists = { pinned: string[]; frequent: string[]; recent: string[] };

export async function getFolderSuggestions(): Promise<FolderLists> {
  const { extraFolders } = getPreferenceValues<Preferences>();
  const pinnedCandidates = (extraFolders ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(expandHome);

  const [history, spotlight, frequent] = await Promise.all([readHistory(), spotlightRecentFolders(), zoxideFolders()]);
  const merged = new Map<string, number>();
  for (const e of [...history, ...spotlight]) {
    merged.set(e.path, Math.max(merged.get(e.path) ?? 0, e.time));
  }

  const pinned: string[] = [];
  for (const p of pinnedCandidates) if (await isDirectory(p)) pinned.push(p);

  const sorted = [...merged.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p);
  const recent: string[] = [];
  for (const p of sorted) {
    if (pinned.includes(p) || p === HOME) continue;
    if (await isDirectory(p)) recent.push(p);
    if (recent.length >= 60) break;
  }
  // zoxide already drops folders that no longer exist.
  return { pinned: [HOME, ...pinned.filter((p) => p !== HOME)], frequent, recent };
}

// ---------- Folder listing / search ----------

/** `changed`: when it last arrived here or changed (only set for folder listings). */
export type Item = { path: string; isDir: boolean; changed?: Date };

/** App bundles and installer packages are folders on disk but act like files. */
export function isPackage(p: string): boolean {
  return /\.(app|bundle|pkg)$/i.test(p);
}

/** Everything in `dir` (hidden entries included), newest first. */
export async function listEntries(dir: string): Promise<Item[]> {
  const names = await fs.readdir(dir);
  const items = await Promise.all(
    names.map(async (name) => {
      const full = path.join(dir, name);
      // stat follows symlinks; a broken link still lists, as a file.
      const st = await fs.stat(full).catch(() => fs.lstat(full).catch(() => undefined));
      // ctime, not mtime: moving or unzipping something here keeps its old mtime but bumps
      // ctime, so this tracks Finder's "Date Added" (mtime alone misses moved-in items).
      return { path: full, isDir: !!st?.isDirectory() && !isPackage(name), changed: st?.ctime };
    }),
  );
  return items.sort((a, b) => (b.changed?.getTime() ?? 0) - (a.changed?.getTime() ?? 0));
}

/**
 * Search text one level above `target` ("Downloads/first/" → "Downloads/", "Downloads/" → "~/"),
 * or undefined at "/". Keeps what was typed when it still leads there.
 */
export function parentQuery(
  text: string,
  target: { dir: string; filter: string },
  anchor?: PathAnchor,
): string | undefined {
  const parent = path.dirname(target.dir);
  if (parent === target.dir) return undefined;
  const typed = text.slice(0, text.length - target.filter.length).replace(/[^/]*\/$/, "");
  return typed && resolvePathQuery(typed, anchor)?.dir === parent ? typed : pathLabel(parent);
}

/** Search-bar text that lists `dir`: "/", "~/", "~/Downloads/". */
export function pathLabel(dir: string): string {
  return dir === "/" ? "/" : `${prettyPath(dir)}/`;
}

/** Short reason a folder can't be listed, for the empty view. */
export function readError(e: unknown): string {
  switch ((e as NodeJS.ErrnoException).code) {
    case "ENOENT":
      return "No such folder";
    case "ENOTDIR":
      return "Not a folder";
    case "EACCES":
    case "EPERM":
      return "No permission to open this folder";
    default:
      return e instanceof Error ? e.message : String(e);
  }
}

/** A name Tab put in the search bar ("Downloads/") and the folder it stands for. */
export type PathAnchor = { label: string; dir: string };

/**
 * Search text with a "/" is a path: "Downloads/fir" lists `Downloads` filtered by "fir".
 * It starts at `anchor.dir` when it begins with `anchor.label`; otherwise "/" is the root,
 * "~/" is home, and anything else is relative to `cwd`.
 */
export function resolvePathQuery(
  text: string,
  anchor: PathAnchor | undefined,
  cwd = HOME,
): { dir: string; filter: string } | undefined {
  if (!text.includes("/")) return undefined;
  let base = cwd;
  let rel = text;
  if (anchor && text.startsWith(anchor.label)) {
    base = anchor.dir;
    rel = text.slice(anchor.label.length);
  } else if (text.startsWith("~/")) {
    base = HOME;
    rel = text.slice(2);
  }
  const slash = rel.lastIndexOf("/");
  return { dir: path.resolve(base, rel.slice(0, slash + 1)), filter: rel.slice(slash + 1) };
}

/** Recursive folder-name search under `dir` using Spotlight (same term rules as `matches`). */
export async function searchFolders(dir: string, query: string, signal?: AbortSignal): Promise<string[]> {
  // Spotlight matches the folder name on the last term; `matches` checks the rest against the path.
  const q = (query.trim().split(/\s+/).pop() ?? "").replace(/["\\*]/g, "");
  if (!q) return [];
  try {
    const { stdout } = await execFileAsync(
      "mdfind",
      ["-onlyin", dir, `kMDItemContentType == "public.folder" && kMDItemFSName == "*${q}*"cd`],
      { maxBuffer: 10 * 1024 * 1024, timeout: 5000, signal },
    );
    return stdout
      .split("\n")
      .filter((p) => p && p !== dir && !isNoise(p) && matches(p, query))
      .sort((a, b) => a.split("/").length - b.split("/").length)
      .slice(0, 100);
  } catch {
    return [];
  }
}

/** zoxide-style: the last term must be in the folder name, every term somewhere in the path. */
/** Display name; the home folder shows as "Home". */
export function folderTitle(p: string): string {
  return p === HOME ? "Home" : path.basename(p) || p;
}

export function matches(p: string, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  // Home matches "home", "~" and the user name.
  const name = (p === HOME ? `home ~ ${path.basename(p)}` : path.basename(p)).toLowerCase();
  const full = `${prettyPath(p)} ${name}`.toLowerCase();
  return name.includes(terms[terms.length - 1]) && terms.every((t) => full.includes(t));
}

// ---------- File operations ----------

async function uniqueDestination(destDir: string, name: string): Promise<string> {
  let candidate = path.join(destDir, name);
  if (!(await exists(candidate))) return candidate;
  const ext = path.extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  for (let i = 2; ; i++) {
    candidate = path.join(destDir, `${base} ${i}${ext}`);
    if (!(await exists(candidate))) return candidate;
  }
}

export type OperationResult = { done: string[]; renamed: string[]; skipped: string[] };

export async function performOperation(op: Operation, sources: string[], destDir: string): Promise<OperationResult> {
  const result: OperationResult = { done: [], renamed: [], skipped: [] };
  for (const src of sources) {
    const name = path.basename(src);
    if (op === "move" && path.dirname(src) === destDir) {
      result.skipped.push(name);
      continue;
    }
    if (destDir === src || destDir.startsWith(src + "/")) {
      throw new Error(`Cannot ${op} "${name}" into itself`);
    }
    const dest = await uniqueDestination(destDir, name);
    if (path.basename(dest) !== name) result.renamed.push(path.basename(dest));

    if (op === "copy") {
      await execFileAsync("ditto", [src, dest]);
    } else {
      try {
        await fs.rename(src, dest);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
        // Different volume: copy, then remove the original.
        await execFileAsync("ditto", [src, dest]);
        await fs.rm(src, { recursive: true, force: true });
      }
    }
    result.done.push(name);
  }
  return result;
}

/** Puts the files themselves on the clipboard (⌘V pastes them in Finder, Mail, Slack…). */
export async function copyFilesToClipboard(paths: string[]): Promise<void> {
  // Raycast's Clipboard.copy takes one file; NSPasteboard takes any number.
  const ok = await runAppleScript(
    `function run(argv) {
      ObjC.import("AppKit");
      const pb = $.NSPasteboard.generalPasteboard;
      pb.clearContents;
      return pb.writeObjects($(argv.map((p) => $.NSURL.fileURLWithPath(p))));
    }`,
    paths,
    { language: "JavaScript" },
  );
  if (ok !== "true") throw new Error("The clipboard did not accept the files");
}

export function describeItems(paths: string[]): string {
  return paths.length === 1 ? `"${path.basename(paths[0])}"` : `${paths.length} items`;
}
