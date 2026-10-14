import { getPreferenceValues, LocalStorage } from "@raycast/api";
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
  return rel.startsWith("/Library") || rel.split("/").some((seg) => seg.startsWith(".")) || p.includes(".app/");
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

export type FolderLists = { pinned: string[]; recent: string[] };

export async function getVisitedFolders(): Promise<FolderLists> {
  const { extraFolders } = getPreferenceValues<Preferences>();
  const pinnedCandidates = (extraFolders ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(expandHome);

  const [history, spotlight] = await Promise.all([readHistory(), spotlightRecentFolders()]);
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
  return { pinned: [HOME, ...pinned.filter((p) => p !== HOME)], recent };
}

// ---------- Folder listing / search ----------

export async function listSubfolders(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const result: string[] = [];
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory() || (e.isSymbolicLink() && (await isDirectory(full)))) {
      if (!e.name.endsWith(".app")) result.push(full);
    }
  }
  return result.sort((a, b) => path.basename(a).localeCompare(path.basename(b), undefined, { sensitivity: "base" }));
}

/** Recursive folder-name search under `dir` using Spotlight. */
export async function searchFolders(dir: string, query: string, signal?: AbortSignal): Promise<string[]> {
  const q = query.replace(/["\\*]/g, "");
  if (!q) return [];
  try {
    const { stdout } = await execFileAsync(
      "mdfind",
      ["-onlyin", dir, `kMDItemContentType == "public.folder" && kMDItemFSName == "*${q}*"cd`],
      { maxBuffer: 10 * 1024 * 1024, timeout: 5000, signal },
    );
    return stdout
      .split("\n")
      .filter((p) => p && p !== dir && !isNoise(p))
      .sort((a, b) => a.split("/").length - b.split("/").length)
      .slice(0, 100);
  } catch {
    return [];
  }
}

export function matches(p: string, query: string): boolean {
  const name = path.basename(p).toLowerCase();
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return terms.every((t) => name.includes(t));
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

export function describeItems(paths: string[]): string {
  return paths.length === 1 ? `"${path.basename(paths[0])}"` : `${paths.length} items`;
}
