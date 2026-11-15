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
import { ReactElement, ReactNode, useEffect, useMemo, useState } from "react";
import path from "node:path";
import {
  describeItems,
  FolderLists,
  folderTitle,
  getFolderSuggestions,
  listSubfolders,
  matches,
  Operation,
  performOperation,
  prettyPath,
  recordVisit,
  searchFolders,
} from "./utils";

/** What choosing a folder does: push a view, or run something. */
export type PickerConfig = {
  title: string;
  /** Title of the "use this folder" action, e.g. "Move Here" or "Open in Terminal". */
  pickLabel: string;
  pickIcon: Image.ImageLike;
  pickStyle?: Action.Style;
  /** ↵ picks the folder (true), or browses into it with ⌘↵ to pick (false). */
  pickOnEnter: boolean;
  /** Extra actions shown after the pick/browse pair. */
  extra?: (folder: string) => ReactNode;
} & ({ push: (folder: string) => ReactElement } | { run: (folder: string) => Promise<void> });

/**
 * Folders to offer: pinned, frequent (zoxide) and recent — or, with `dir`, its subfolders —
 * filtered by `query`, plus a recursive Spotlight search while typing.
 */
export function useFolderSearch(query: string, dir?: string) {
  const [folders, setFolders] = useState<FolderLists>({ pinned: [], frequent: [], recent: [] });
  const [deep, setDeep] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    (async () => {
      try {
        if (dir) {
          setFolders({ pinned: [], frequent: [], recent: await listSubfolders(dir) });
          recordVisit([dir]);
        } else {
          setFolders(await getFolderSuggestions());
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
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

  const q = query.trim();
  // Each folder appears once, in the first section that has it.
  const sections = useMemo(() => {
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
    const recent = take(folders.recent);
    return { pinned, frequent, recent, deep: take(deep) };
  }, [folders, deep, q]);

  return { sections, isLoading: loading || searching, error };
}

type Props = { config: PickerConfig; dir?: string };

/** Root: pinned, frequent (zoxide) and recent folders. With `dir`: browse that folder's subfolders. */
export function FolderPicker({ config, dir }: Props) {
  const [query, setQuery] = useState("");
  const { sections, isLoading, error } = useFolderSearch(query, dir);
  const q = query.trim();

  const pick = (folder: string, shortcut?: Keyboard.Shortcut) =>
    "push" in config ? (
      <Action.Push
        title={config.pickLabel}
        icon={config.pickIcon}
        shortcut={shortcut}
        target={config.push(folder)}
        onPush={() => recordVisit([folder])}
      />
    ) : (
      <Action
        title={config.pickLabel}
        icon={config.pickIcon}
        style={config.pickStyle}
        shortcut={shortcut}
        onAction={async () => {
          await recordVisit([folder]);
          await config.run(folder);
        }}
      />
    );

  const browse = (folder: string, shortcut?: Keyboard.Shortcut) => (
    <Action.Push
      title="Open Folder"
      icon={Icon.ArrowRight}
      shortcut={shortcut}
      target={<FolderPicker config={config} dir={folder} />}
    />
  );

  const folderItem = (p: string, keyPrefix: string) => (
    <List.Item
      key={keyPrefix + p}
      title={folderTitle(p)}
      subtitle={dir && path.dirname(p) === dir ? undefined : prettyPath(path.dirname(p))}
      icon={{ fileIcon: p }}
      accessories={[{ icon: Icon.ChevronRight }]}
      actions={
        <ActionPanel>
          {config.pickOnEnter ? (
            <>
              {pick(p)}
              {config.extra?.(p)}
              {browse(p, { modifiers: ["cmd"], key: "arrowRight" })}
            </>
          ) : (
            <>
              {browse(p)}
              {pick(p, { modifiers: ["cmd"], key: "return" })}
              {config.extra?.(p)}
            </>
          )}
          <Action.ShowInFinder path={p} shortcut={{ modifiers: ["cmd"], key: "f" }} />
          <Action.CopyToClipboard title="Copy Path" content={p} shortcut={Keyboard.Shortcut.Common.CopyPath} />
        </ActionPanel>
      }
    />
  );

  return (
    <List
      isLoading={isLoading}
      filtering={false}
      onSearchTextChange={setQuery}
      navigationTitle={dir ? folderTitle(dir) : config.title}
      searchBarPlaceholder={dir ? `Search in ${prettyPath(dir)}…` : "Search frequent & recent folders, or any folder…"}
    >
      {error ? (
        <List.EmptyView icon={Icon.Warning} title="Cannot read folder" description={error} />
      ) : (
        <List.EmptyView icon={Icon.Folder} title={q ? "No matching folders" : "No subfolders"} />
      )}
      {dir && !error && (
        <List.Section title="This Folder">
          <List.Item
            title={config.pickLabel}
            subtitle={prettyPath(dir)}
            icon={config.pickIcon}
            actions={
              <ActionPanel>
                {pick(dir)}
                {config.extra?.(dir)}
                <Action.ShowInFinder path={dir} />
              </ActionPanel>
            }
          />
        </List.Section>
      )}
      {sections.pinned.length > 0 && (
        <List.Section title="Pinned">{sections.pinned.map((p) => folderItem(p, "pin:"))}</List.Section>
      )}
      {sections.frequent.length > 0 && (
        <List.Section title="Frequent" subtitle="zoxide">
          {sections.frequent.map((p) => folderItem(p, "frq:"))}
        </List.Section>
      )}
      {sections.recent.length > 0 && (
        <List.Section title={dir ? "Subfolders" : "Recently Visited"}>
          {sections.recent.map((p) => folderItem(p, "rec:"))}
        </List.Section>
      )}
      {sections.deep.length > 0 && (
        <List.Section title={dir ? "Deeper Matches" : "Other Matching Folders"}>
          {sections.deep.map((p) => folderItem(p, "deep:"))}
        </List.Section>
      )}
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
    let msg = `${VERB[op].past} ${describeItems(res.done)} to ${path.basename(destDir) || destDir}`;
    if (res.done.length === 0) msg = `Nothing to ${op} — already in ${path.basename(destDir)}`;
    if (res.renamed.length) msg += ` (renamed: ${res.renamed.join(", ")})`;
    await closeMainWindow({ popToRootType: PopToRootType.Immediate });
    await showHUD(msg);
  } catch (e) {
    toast.style = Toast.Style.Failure;
    toast.title = `${VERB[op].label} failed`;
    toast.message = e instanceof Error ? e.message : String(e);
  }
}

/** Picker for where to move/copy `sources`: ↵ moves/copies straight into a folder, ⌘→ browses into it. */
export function DestinationPicker({ op, sources }: { op: Operation; sources: string[] }) {
  const verb = VERB[op];
  return (
    <FolderPicker
      config={{
        title: `${verb.label} ${describeItems(sources)} to…`,
        pickLabel: `${verb.label} Here`,
        pickIcon: verb.icon,
        pickOnEnter: true,
        run: (folder) => transfer(op, sources, folder),
      }}
    />
  );
}
