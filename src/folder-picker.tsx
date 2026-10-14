import {
  Action,
  ActionPanel,
  closeMainWindow,
  Icon,
  Keyboard,
  List,
  PopToRootType,
  showHUD,
  showToast,
  Toast,
} from "@raycast/api";
import { useEffect, useMemo, useState } from "react";
import path from "node:path";
import {
  describeItems,
  getVisitedFolders,
  listSubfolders,
  matches,
  Operation,
  performOperation,
  prettyPath,
  recordVisit,
  searchFolders,
} from "./utils";

type Props = { op: Operation; sources: string[]; dir?: string };

const VERB: Record<Operation, { label: string; ing: string; past: string; icon: Icon }> = {
  move: { label: "Move", ing: "Moving", past: "Moved", icon: Icon.ArrowRight },
  copy: { label: "Copy", ing: "Copying", past: "Copied", icon: Icon.CopyClipboard },
};

async function run(op: Operation, sources: string[], destDir: string) {
  const toast = await showToast({ style: Toast.Style.Animated, title: `${VERB[op].ing}…` });
  try {
    const res = await performOperation(op, sources, destDir);
    await recordVisit([destDir]);
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

/** Root: visited folders. With `dir`: browse that folder's subfolders. */
export function FolderPicker({ op, sources, dir }: Props) {
  const [query, setQuery] = useState("");
  const [folders, setFolders] = useState<{ pinned: string[]; recent: string[] }>({ pinned: [], recent: [] });
  const [deep, setDeep] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    (async () => {
      try {
        if (dir) {
          setFolders({ pinned: [], recent: await listSubfolders(dir) });
          recordVisit([dir]);
        } else {
          setFolders(await getVisitedFolders());
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
    if (!query.trim()) return;
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
  const pinned = useMemo(() => folders.pinned.filter((p) => !q || matches(p, q)), [folders, q]);
  const recent = useMemo(() => folders.recent.filter((p) => !q || matches(p, q)), [folders, q]);
  const deepOnly = useMemo(() => {
    const shown = new Set([...pinned, ...recent]);
    return deep.filter((p) => !shown.has(p));
  }, [deep, pinned, recent]);

  const verb = VERB[op];
  const title = dir ? path.basename(dir) || dir : `${verb.label} ${describeItems(sources)} to…`;

  const folderItem = (p: string, keyPrefix: string) => (
    <List.Item
      key={keyPrefix + p}
      title={path.basename(p) || p}
      subtitle={dir && path.dirname(p) === dir ? undefined : prettyPath(path.dirname(p))}
      icon={{ fileIcon: p }}
      accessories={[{ icon: Icon.ChevronRight }]}
      actions={
        <ActionPanel>
          <Action.Push
            title="Open Folder"
            icon={Icon.ArrowRight}
            target={<FolderPicker op={op} sources={sources} dir={p} />}
          />
          <Action
            title={`${verb.label} Here`}
            icon={verb.icon}
            shortcut={{ modifiers: ["cmd"], key: "return" }}
            onAction={() => run(op, sources, p)}
          />
          <Action.ShowInFinder path={p} shortcut={{ modifiers: ["cmd"], key: "f" }} />
          <Action.CopyToClipboard title="Copy Path" content={p} shortcut={Keyboard.Shortcut.Common.CopyPath} />
        </ActionPanel>
      }
    />
  );

  return (
    <List
      isLoading={loading || searching}
      filtering={false}
      onSearchTextChange={setQuery}
      navigationTitle={title}
      searchBarPlaceholder={dir ? `Search in ${prettyPath(dir)}…` : "Search visited folders, or any folder by name…"}
    >
      {error ? (
        <List.EmptyView icon={Icon.Warning} title="Cannot read folder" description={error} />
      ) : (
        <List.EmptyView icon={Icon.Folder} title={q ? "No matching folders" : "No subfolders"} />
      )}
      {dir && !error && (
        <List.Section title="Destination">
          <List.Item
            title={`${verb.label} Here`}
            subtitle={prettyPath(dir)}
            icon={verb.icon}
            actions={
              <ActionPanel>
                <Action title={`${verb.label} Here`} icon={verb.icon} onAction={() => run(op, sources, dir)} />
                <Action.ShowInFinder path={dir} />
              </ActionPanel>
            }
          />
        </List.Section>
      )}
      {pinned.length > 0 && <List.Section title="Pinned">{pinned.map((p) => folderItem(p, "pin:"))}</List.Section>}
      {recent.length > 0 && (
        <List.Section title={dir ? "Subfolders" : "Recently Visited"}>
          {recent.map((p) => folderItem(p, "rec:"))}
        </List.Section>
      )}
      {deepOnly.length > 0 && (
        <List.Section title={dir ? "Deeper Matches" : "Other Matching Folders"}>
          {deepOnly.map((p) => folderItem(p, "deep:"))}
        </List.Section>
      )}
    </List>
  );
}
