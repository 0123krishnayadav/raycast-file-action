import {
  Action,
  ActionPanel,
  closeMainWindow,
  Icon,
  Image,
  Keyboard,
  List,
  PopToRootType,
  showHUD,
  showToast,
  Toast,
} from "@raycast/api";
import { ReactElement, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import path from "node:path";
import {
  describeItems,
  FolderLists,
  folderTitle,
  getFolderSuggestions,
  Item,
  listEntries,
  matches,
  Operation,
  parentQuery,
  PathAnchor,
  pathLabel,
  performOperation,
  prettyPath,
  readError,
  recordVisit,
  resolvePathQuery,
  searchFolders,
} from "./utils";

/** What choosing a folder does (↵): push a view, or run something. */
export type PickerConfig = {
  title: string;
  /** Title of the "use this folder" action, e.g. "Move Here" or "Open in Terminal". */
  pickLabel: string;
  pickIcon: Image.ImageLike;
  pickStyle?: Action.Style;
  /** Extra actions shown after the pick action. */
  extra?: (folder: string) => ReactNode;
} & ({ push: (folder: string) => ReactElement } | { run: (folder: string) => Promise<void> });

const NO_FOLDERS: FolderLists = { pinned: [], frequent: [], recent: [] };

/** Most folders/files listed per section; thousands of rows make Raycast sluggish. */
const LIST_LIMIT = 200;

/** Section subtitle for rows cut by `LIST_LIMIT`. */
export function moreHint(more: number): string | undefined {
  return more > 0 ? `+${more.toLocaleString()} more, type to narrow` : undefined;
}

/** Puts the most likely Tab target first: names starting with the last search term. */
function prefixFirst(list: string[], query: string): string[] {
  const term = query.toLowerCase().split(/\s+/).pop() ?? "";
  if (!term) return list;
  const starts = (p: string) => path.basename(p).toLowerCase().startsWith(term);
  return [...list.filter(starts), ...list.filter((p) => !starts(p))];
}

/**
 * Folders to offer: pinned, frequent (zoxide) and recent — or, with `dir`, what is inside it,
 * newest first (`recent` holds its subfolders, `files` the rest) — filtered by `query`,
 * plus a recursive Spotlight search while typing.
 */
export function useFolderSearch(query: string, dir?: string) {
  const [root, setRoot] = useState<FolderLists>();
  const [listing, setListing] = useState<{ dir: string; items: Item[]; error?: string }>();
  const [deep, setDeep] = useState<string[]>([]);
  const [searching, setSearching] = useState(false);
  const rootRequested = useRef(false);

  // Suggestions are loaded once and kept, so leaving a path ("Downloads/") shows them instantly.
  useEffect(() => {
    if (dir || rootRequested.current) return;
    rootRequested.current = true;
    getFolderSuggestions()
      .then(setRoot)
      .catch(() => setRoot(NO_FOLDERS));
  }, [dir]);

  useEffect(() => {
    if (!dir) return;
    let cancelled = false;
    listEntries(dir).then(
      (items) => !cancelled && setListing({ dir, items }),
      (e) => !cancelled && setListing({ dir, items: [], error: readError(e) }),
    );
    return () => {
      cancelled = true;
    };
  }, [dir]);

  // Recursive search (inside `dir`, or the whole home folder at the root), debounced.
  useEffect(() => {
    setDeep([]);
    // One letter matches half the disk; the lists above still filter on it.
    if (query.trim().length < 2) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setSearching(true);
      const res = await searchFolders(dir ?? process.env.HOME ?? "/", query.trim(), controller.signal);
      if (!controller.signal.aborted) {
        setDeep(res);
        setSearching(false);
      }
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
      setSearching(false);
    };
  }, [query, dir]);

  const current = dir && listing?.dir === dir ? listing : undefined;
  const q = query.trim();
  // Each folder appears once, in the first section that has it.
  const sections = useMemo(() => {
    // Hidden entries show once the filter starts with "." (like Alfred).
    const entries = (current?.items ?? []).filter((i) => q.startsWith(".") || !path.basename(i.path).startsWith("."));
    const paths = (dirs: boolean) => entries.filter((i) => i.isDir === dirs).map((i) => i.path);
    const folders = dir ? { ...NO_FOLDERS, recent: prefixFirst(paths(true), q) } : (root ?? NO_FOLDERS);

    const seen = new Set<string>();
    const take = (list: string[], limit = Infinity) => {
      const out: string[] = [];
      for (const p of list) {
        if (out.length >= limit) break;
        if (seen.has(p) || (q && !matches(p, q))) continue;
        seen.add(p);
        out.push(p);
      }
      return out;
    };
    const pinned = take(folders.pinned);
    const frequent = take(folders.frequent, q ? Infinity : 15);
    // All matches are marked seen (so none reappear under Deeper Matches), but only LIST_LIMIT are shown.
    const recent = take(folders.recent);
    const files = take(prefixFirst(paths(false), q));
    return {
      pinned,
      frequent,
      recent: recent.slice(0, LIST_LIMIT),
      deep: take(deep),
      files: files.slice(0, LIST_LIMIT),
      more: { folders: Math.max(0, recent.length - LIST_LIMIT), files: Math.max(0, files.length - LIST_LIMIT) },
    };
  }, [root, current, dir, deep, q]);

  const changed = useMemo(() => new Map(current?.items.map((i) => [i.path, i.changed])), [current]);
  const loading = dir ? !current : !root;
  return { sections, changed, isLoading: loading || searching, error: current?.error };
}

/**
 * Search text that can also be a path. ⇥ on a folder puts "Name/" in the search bar,
 * and from then on the list shows what is inside it ("Name/fir" filters that folder).
 */
export function usePathSearch() {
  const [text, setTextState] = useState("");
  const [anchor, setAnchor] = useState<PathAnchor>();
  // Row to highlight once it loads (the folder just left, after going up).
  const [focus, setFocus] = useState<string>();
  const target = resolvePathQuery(text, anchor);

  const setText = (next: string) => {
    setFocus(undefined);
    setTextState(next);
  };

  /** ⇥: "Downloads/fir" + first → "Downloads/first/". A file just completes its name. */
  const complete = (item: Item) => {
    if (target) {
      const typed = text.slice(0, text.length - target.filter.length);
      setText(typed + path.relative(target.dir, item.path) + (item.isDir ? "/" : ""));
    } else if (item.isDir) {
      const label = pathLabel(item.path) === "~/" ? "~/" : `${path.basename(item.path)}/`;
      setAnchor({ label, dir: item.path });
      setText(label);
    }
  };

  /** Up a level, highlighting the folder just left (like Finder). */
  const up = () => {
    const next = target && parentQuery(text, target, anchor);
    if (next === undefined) return;
    setText(next);
    setFocus(target?.dir);
  };

  /** Props that make a List follow this search (and release the highlight once it landed). */
  const listProps = {
    filtering: false,
    searchText: text,
    onSearchTextChange: setText,
    selectedItemId: focus,
    onSelectionChange: (id: string | null) => {
      if (id && id === focus) setFocus(undefined);
    },
  };

  return { text, target, complete, up, listProps };
}

export type PathSearch = ReturnType<typeof usePathSearch>;

/** Moving around in the search bar: ⇥ autocompletes, ⌘→ goes into a folder, ⌘← up a level. */
export function NavigationActions({ search, item }: { search: PathSearch; item?: Item }) {
  const into = item && item.path !== search.target?.dir ? item : undefined;
  return (
    <ActionPanel.Section title="Navigate">
      {into && (
        <Action
          title={into.isDir ? "Go into Folder" : "Autocomplete Name"}
          icon={into.isDir ? Icon.ArrowRight : Icon.Text}
          shortcut={{ modifiers: [], key: "tab" }}
          onAction={() => search.complete(into)}
        />
      )}
      {into?.isDir && (
        <Action
          title="Go into Folder"
          icon={Icon.ArrowRight}
          shortcut={{ modifiers: ["cmd"], key: "arrowRight" }}
          onAction={() => search.complete(into)}
        />
      )}
      {search.target && search.target.dir !== "/" && (
        <Action
          title="Go up"
          icon={Icon.ArrowLeft}
          shortcut={{ modifiers: ["cmd"], key: "arrowLeft" }}
          onAction={search.up}
        />
      )}
    </ActionPanel.Section>
  );
}

/** Pinned, frequent (zoxide) and recent folders; ⇥ / ⌘→ go into one in place, ⌘← back up. */
export function FolderPicker({ config }: { config: PickerConfig }) {
  const search = usePathSearch();
  const here = search.target?.dir;
  const query = search.target?.filter ?? search.text;
  const { sections, changed, isLoading, error } = useFolderSearch(query, here);
  const q = query.trim();

  const pick = (folder: string) =>
    "push" in config ? (
      <Action.Push
        title={config.pickLabel}
        icon={config.pickIcon}
        target={config.push(folder)}
        onPush={() => recordVisit([folder])}
      />
    ) : (
      <Action
        title={config.pickLabel}
        icon={config.pickIcon}
        style={config.pickStyle}
        onAction={async () => {
          await recordVisit([folder]);
          await config.run(folder);
        }}
      />
    );

  const folderItem = (p: string, keyPrefix: string) => {
    const date = changed.get(p);
    return (
      <List.Item
        key={keyPrefix + p}
        id={p}
        title={folderTitle(p)}
        subtitle={here && path.dirname(p) === here ? undefined : prettyPath(path.dirname(p))}
        icon={{ fileIcon: p }}
        accessories={[
          ...(date ? [{ date, tooltip: `Added or changed ${date.toLocaleString()}` }] : []),
          { icon: Icon.ChevronRight },
        ]}
        actions={
          <ActionPanel>
            {pick(p)}
            {config.extra?.(p)}
            <NavigationActions search={search} item={{ path: p, isDir: true }} />
            <ActionPanel.Section>
              <Action.ShowInFinder path={p} shortcut={{ modifiers: ["cmd"], key: "f" }} />
              <Action.CopyToClipboard title="Copy Path" content={p} shortcut={Keyboard.Shortcut.Common.CopyPath} />
            </ActionPanel.Section>
          </ActionPanel>
        }
      />
    );
  };

  // On top, or below the matches while filtering so ⇥ lands on the first match.
  const thisFolder = here && !error && (
    <List.Section title="This Folder">
      <List.Item
        key={"this:" + here}
        id={"this:" + here}
        title={config.pickLabel}
        subtitle={prettyPath(here)}
        icon={config.pickIcon}
        actions={
          <ActionPanel>
            {pick(here)}
            {config.extra?.(here)}
            <NavigationActions search={search} />
            <Action.ShowInFinder path={here} />
          </ActionPanel>
        }
      />
    </List.Section>
  );

  return (
    <List
      {...search.listProps}
      isLoading={isLoading}
      navigationTitle={here ? `${config.title} ${prettyPath(here)}` : config.title}
      searchBarPlaceholder="Search folders… ⇥ goes into one, ⌘← back up"
    >
      {error ? (
        <List.EmptyView
          icon={Icon.Warning}
          title={error}
          description={here && prettyPath(here)}
          actions={
            <ActionPanel>
              <NavigationActions search={search} />
            </ActionPanel>
          }
        />
      ) : (
        <List.EmptyView icon={Icon.Folder} title={q ? "No matching folders" : "No subfolders"} />
      )}
      {!q && thisFolder}
      {sections.pinned.length > 0 && (
        <List.Section title="Pinned">{sections.pinned.map((p) => folderItem(p, "pin:"))}</List.Section>
      )}
      {sections.frequent.length > 0 && (
        <List.Section title="Frequent" subtitle="zoxide">
          {sections.frequent.map((p) => folderItem(p, "frq:"))}
        </List.Section>
      )}
      {sections.recent.length > 0 && (
        <List.Section title={here ? "Subfolders" : "Recently Visited"} subtitle={moreHint(sections.more.folders)}>
          {sections.recent.map((p) => folderItem(p, "rec:"))}
        </List.Section>
      )}
      {sections.deep.length > 0 && (
        <List.Section title={here ? "Deeper Matches" : "Other Matching Folders"}>
          {sections.deep.map((p) => folderItem(p, "deep:"))}
        </List.Section>
      )}
      {q && thisFolder}
    </List>
  );
}

// ---------- Move / Copy destination ----------

const VERB: Record<Operation, { label: string; ing: string; past: string; icon: Icon }> = {
  move: { label: "Move", ing: "Moving", past: "Moved", icon: Icon.ArrowRight },
  copy: { label: "Copy", ing: "Copying", past: "Copied", icon: Icon.CopyClipboard },
};

async function transfer(op: Operation, sources: string[], destDir: string) {
  const toast = await showToast({ style: Toast.Style.Animated, title: `${VERB[op].ing}…` });
  try {
    const res = await performOperation(op, sources, destDir);
    toast.hide();
    // The full path, so a wrong pick is easy to spot and find.
    let msg = `${VERB[op].past} ${describeItems(res.done)} to ${prettyPath(destDir)}`;
    if (res.done.length === 0) msg = `Nothing to ${op} — already in ${prettyPath(destDir)}`;
    if (res.renamed.length) msg += ` (renamed: ${res.renamed.join(", ")})`;
    await closeMainWindow({ popToRootType: PopToRootType.Immediate });
    await showHUD(msg);
  } catch (e) {
    toast.style = Toast.Style.Failure;
    toast.title = `${VERB[op].label} failed`;
    toast.message = e instanceof Error ? e.message : String(e);
  }
}

/** Picker for where to move/copy `sources`: ↵ moves/copies straight into a folder, ⇥ goes into it. */
export function DestinationPicker({ op, sources }: { op: Operation; sources: string[] }) {
  const verb = VERB[op];
  return (
    <FolderPicker
      config={{
        title: `${verb.label} ${describeItems(sources)} to…`,
        pickLabel: `${verb.label} Here`,
        pickIcon: verb.icon,
        run: (folder) => transfer(op, sources, folder),
      }}
    />
  );
}
