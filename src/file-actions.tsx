import {
  Action,
  ActionPanel,
  Application,
  Alert,
  closeMainWindow,
  confirmAlert,
  getPreferenceValues,
  getSelectedFinderItems,
  Icon,
  Keyboard,
  List,
  open,
  openExtensionPreferences,
  PopToRootType,
  showHUD,
  showToast,
  Toast,
  trash,
} from "@raycast/api";
import { ReactElement, useEffect, useState } from "react";

type Entry = ReactElement<{ title: string; keywords?: string[] }>;
import { promises as fs } from "node:fs";
import path from "node:path";
import { FolderPicker } from "./folder-picker";
import { getCompatibleApps, OpenWithList, openWith } from "./open-with";
import { describeItems, prettyPath, recordVisit } from "./utils";

type Item = { path: string; isDir: boolean };

async function loadSelection(): Promise<Item[]> {
  const selected = await getSelectedFinderItems();
  return Promise.all(
    selected.map(async ({ path: p }) => {
      const clean = p.length > 1 ? p.replace(/\/$/, "") : p;
      const stat = await fs.stat(clean).catch(() => undefined);
      // Treat app bundles / packages like files.
      return { path: clean, isDir: !!stat?.isDirectory() && !/\.(app|bundle|pkg)$/.test(clean) };
    }),
  );
}

async function done(hud?: string) {
  await closeMainWindow({ popToRootType: PopToRootType.Immediate });
  if (hud) await showHUD(hud);
}

export default function Command() {
  const [items, setItems] = useState<Item[]>();
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState("");
  const prefs = getPreferenceValues<Preferences>();

  useEffect(() => {
    loadSelection()
      .then((sel) => {
        setItems(sel);
        recordVisit([...new Set(sel.map((i) => path.dirname(i.path)))]);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  if (error || (items && items.length === 0)) {
    return (
      <List>
        <List.EmptyView
          icon={Icon.Finder}
          title="No Finder selection"
          description="Select a file or folder in Finder, then run this command again."
        />
      </List>
    );
  }

  const paths = items?.map((i) => i.path) ?? [];
  const allDirs = !!items && items.every((i) => i.isDir);
  const what = describeItems(paths);
  const subtitle =
    paths.length === 1 ? prettyPath(path.dirname(paths[0])) : paths.map((p) => path.basename(p)).join(", ");

  const common = (
    <ActionPanel.Section>
      <Action.ShowInFinder path={paths[0] ?? "/"} shortcut={{ modifiers: ["cmd"], key: "f" }} />
      <Action.CopyToClipboard
        title="Copy Path"
        content={paths.join("\n")}
        shortcut={Keyboard.Shortcut.Common.CopyPath}
      />
    </ActionPanel.Section>
  );

  const openInTerminal = async () => {
    const term: Application | string | undefined = prefs.terminalApp?.path ? prefs.terminalApp : undefined;
    try {
      for (const p of paths) await open(p, term ?? "com.googlecode.iterm2");
      await done();
    } catch {
      // iTerm missing → fall back to Terminal.app
      for (const p of paths) await open(p, "Terminal");
      await done();
    }
  };

  const moveToBin = async () => {
    if (
      prefs.confirmTrash &&
      !(await confirmAlert({
        title: `Move ${what} to Bin?`,
        icon: Icon.Trash,
        primaryAction: { title: "Move to Bin", style: Alert.ActionStyle.Destructive },
      }))
    )
      return;
    try {
      await trash(paths);
      await done(`Moved ${what} to Bin`);
    } catch (e) {
      await showToast({ style: Toast.Style.Failure, title: "Could not move to Bin", message: String(e) });
    }
  };

  const entries = [
    <List.Item
      key="open"
      title="Open"
      icon={Icon.ArrowNe}
      keywords={["default"]}
      actions={
        <ActionPanel>
          <Action
            title="Open"
            icon={Icon.ArrowNe}
            onAction={async () => {
              for (const p of paths) await open(p);
              await done();
            }}
          />
          {common}
        </ActionPanel>
      }
    />,
    <List.Item
      key="open-with"
      title="Open With…"
      icon={Icon.AppWindowGrid3x3}
      accessories={[{ icon: Icon.ChevronRight }]}
      actions={
        <ActionPanel>
          <Action.Push title="Choose App" icon={Icon.AppWindowGrid3x3} target={<OpenWithList paths={paths} />} />
          <OpenWithSubmenu paths={paths} />
          {common}
        </ActionPanel>
      }
    />,
    allDirs && (
      <List.Item
        key="terminal"
        title="Open in Terminal"
        subtitle={prefs.terminalApp?.name ?? "iTerm2"}
        icon={Icon.Terminal}
        keywords={["iterm", "shell", "cd"]}
        actions={
          <ActionPanel>
            <Action title="Open in Terminal" icon={Icon.Terminal} onAction={openInTerminal} />
            <Action title="Change Terminal App…" icon={Icon.Gear} onAction={openExtensionPreferences} />
            {common}
          </ActionPanel>
        }
      />
    ),
    <List.Item
      key="move"
      title="Move To…"
      icon={Icon.ArrowRight}
      accessories={[{ icon: Icon.ChevronRight }]}
      actions={
        <ActionPanel>
          <Action.Push title="Choose Folder" icon={Icon.Folder} target={<FolderPicker op="move" sources={paths} />} />
          {common}
        </ActionPanel>
      }
    />,
    <List.Item
      key="copy"
      title="Copy To…"
      icon={Icon.CopyClipboard}
      accessories={[{ icon: Icon.ChevronRight }]}
      actions={
        <ActionPanel>
          <Action.Push title="Choose Folder" icon={Icon.Folder} target={<FolderPicker op="copy" sources={paths} />} />
          {common}
        </ActionPanel>
      }
    />,
    <List.Item
      key="bin"
      title="Move to Bin"
      icon={{ source: Icon.Trash, tintColor: "red" }}
      keywords={["delete", "trash", "remove"]}
      actions={
        <ActionPanel>
          <Action title="Move to Bin" icon={Icon.Trash} style={Action.Style.Destructive} onAction={moveToBin} />
          {common}
        </ActionPanel>
      }
    />,
    <List.Item
      key="reveal"
      title="Reveal in Finder"
      icon={Icon.Finder}
      actions={
        <ActionPanel>
          <Action.ShowInFinder path={paths[0] ?? "/"} />
          {common}
        </ActionPanel>
      }
    />,
  ].filter((e): e is Entry => !!e);

  const q = query.trim().toLowerCase();
  // Rank by title match first, keywords last; ties keep the fixed order above.
  const score = (e: Entry) => {
    const title = String(e.props.title).toLowerCase();
    const keywords: string[] = e.props.keywords ?? [];
    if (title.startsWith(q)) return 0;
    if (title.split(/\s+/).some((w) => w.startsWith(q))) return 1;
    if (title.includes(q)) return 2;
    if (keywords.some((k) => k.startsWith(q))) return 3;
    return -1;
  };
  const visible = q
    ? entries
        .map((e, idx) => ({ e, idx, s: score(e) }))
        .filter((x) => x.s >= 0)
        .sort((a, b) => a.s - b.s || a.idx - b.idx)
        .map((x) => x.e)
    : entries;

  return (
    <List
      isLoading={!items}
      navigationTitle={what}
      searchBarPlaceholder={`Actions for ${what}…`}
      filtering={false}
      onSearchTextChange={setQuery}
    >
      {items && (
        <List.Section title={what} subtitle={subtitle}>
          {visible}
        </List.Section>
      )}
    </List>
  );
}

/** ⌘K dropdown of compatible apps (loaded when opened). */
function OpenWithSubmenu({ paths }: { paths: string[] }) {
  const [apps, setApps] = useState<Application[]>();
  return (
    <ActionPanel.Submenu
      title="Open with"
      icon={Icon.AppWindowGrid3x3}
      shortcut={Keyboard.Shortcut.Common.OpenWith}
      isLoading={!apps}
      onOpen={() => {
        if (!apps) getCompatibleApps(paths).then((r) => setApps(r.apps));
      }}
    >
      {apps?.map((app) => (
        <Action
          key={app.path}
          title={app.localizedName ?? app.name}
          icon={{ fileIcon: app.path }}
          onAction={() => openWith(paths, app)}
        />
      ))}
    </ActionPanel.Submenu>
  );
}
