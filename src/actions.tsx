import {
  Action,
  ActionPanel,
  Alert,
  Application,
  closeMainWindow,
  confirmAlert,
  getPreferenceValues,
  Icon,
  Image,
  Keyboard,
  List,
  open,
  openExtensionPreferences,
  PopToRootType,
  showHUD,
  showInFinder,
  showToast,
  Toast,
  trash,
} from "@raycast/api";
import { ReactElement, ReactNode, useState } from "react";
import path from "node:path";
import { DestinationPicker, FolderPicker, PickerConfig, useFolderSearch } from "./folder-picker";
import { getCompatibleApps, OpenWithList, openWith } from "./open-with";
import { describeItems, folderTitle, prettyPath, recordVisit } from "./utils";

export type Item = { path: string; isDir: boolean };

/** One row of the action list. It runs on any paths, so it can be re-targeted at another folder. */
type ActionDef = {
  id: string;
  title: string;
  icon: Image.ImageLike;
  subtitle?: string;
  keywords?: string[];
  dirsOnly?: boolean;
  /** Extra actions under the primary one. */
  extra?: (paths: string[]) => ReactNode;
} & (
  | { push: (paths: string[]) => ReactElement; pushTitle: string }
  | { run: (paths: string[]) => Promise<void>; style?: Action.Style }
);

async function done(hud?: string) {
  await closeMainWindow({ popToRootType: PopToRootType.Immediate });
  if (hud) await showHUD(hud);
}

function getActionDefs(): ActionDef[] {
  const prefs = getPreferenceValues<Preferences>();
  return [
    {
      id: "open",
      title: "Open",
      icon: Icon.ArrowNe,
      keywords: ["default"],
      run: async (paths) => {
        for (const p of paths) await open(p);
        await done();
      },
    },
    {
      id: "open-with",
      title: "Open With…",
      icon: Icon.AppWindowGrid3x3,
      pushTitle: "Choose App",
      push: (paths) => <OpenWithList paths={paths} />,
      extra: (paths) => <OpenWithSubmenu paths={paths} />,
    },
    {
      id: "terminal",
      title: "Open in Terminal",
      subtitle: prefs.terminalApp?.name ?? "iTerm2",
      icon: Icon.Terminal,
      keywords: ["iterm", "shell", "cd"],
      dirsOnly: true,
      run: async (paths) => {
        const term: Application | string = prefs.terminalApp?.path ? prefs.terminalApp : "com.googlecode.iterm2";
        try {
          for (const p of paths) await open(p, term);
        } catch {
          // iTerm missing → fall back to Terminal.app
          for (const p of paths) await open(p, "Terminal");
        }
        await done();
      },
      extra: () => <Action title="Change Terminal App…" icon={Icon.Gear} onAction={openExtensionPreferences} />,
    },
    {
      id: "move",
      title: "Move To…",
      icon: Icon.ArrowRight,
      pushTitle: "Choose Folder",
      push: (paths) => <DestinationPicker op="move" sources={paths} />,
    },
    {
      id: "copy",
      title: "Copy To…",
      icon: Icon.CopyClipboard,
      pushTitle: "Choose Folder",
      push: (paths) => <DestinationPicker op="copy" sources={paths} />,
    },
    {
      id: "bin",
      title: "Move to Bin",
      icon: { source: Icon.Trash, tintColor: "red" },
      keywords: ["delete", "trash", "remove"],
      style: Action.Style.Destructive,
      run: async (paths) => {
        const what = describeItems(paths);
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
      },
    },
    {
      id: "reveal",
      title: "Reveal in Finder",
      icon: Icon.Finder,
      run: async (paths) => {
        await showInFinder(paths[0]);
        await done();
      },
    },
  ];
}

/** `def` as a single action on `paths`. */
function defAction(def: ActionDef, paths: string[], title = def.title) {
  return "push" in def ? (
    <Action.Push key={def.id} title={title} icon={def.icon} target={def.push(paths)} />
  ) : (
    <Action key={def.id} title={title} icon={def.icon} style={def.style} onAction={() => def.run(paths)} />
  );
}

const showActionsFor = (folder: string) => <ActionList items={[{ path: folder, isDir: true }]} />;

/** Pick a folder, then run `def` on it. */
function TargetPicker({ def }: { def: ActionDef }) {
  const config: PickerConfig = {
    title: `${def.title.replace(/…$/, "")} — Choose Folder`,
    pickLabel: def.title,
    pickIcon: def.icon,
    pickOnEnter: true,
    ...("push" in def
      ? { push: (f: string) => def.push([f]) }
      : { run: (f: string) => def.run([f]), pickStyle: def.style }),
    extra: (f) => (
      <Action.Push
        title="Show All Actions"
        icon={Icon.List}
        shortcut={{ modifiers: ["cmd"], key: "return" }}
        target={showActionsFor(f)}
      />
    ),
  };
  return <FolderPicker config={config} />;
}

/** Actions for `items` (undefined while loading). Typing also searches folders to act on instead. */
export function ActionList({ items }: { items?: Item[] }) {
  const [query, setQuery] = useState("");
  const folderSearch = useFolderSearch(query);
  const defs = getActionDefs();

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

  type Entry = { key: string; title: string; keywords: string[]; el: ReactElement };

  const entries: Entry[] = defs
    .filter((def) => allDirs || !def.dirsOnly)
    .map((def) => ({
      key: def.id,
      title: def.title,
      keywords: def.keywords ?? [],
      el: (
        <List.Item
          key={def.id}
          title={def.title}
          subtitle={def.subtitle}
          icon={def.icon}
          keywords={def.keywords}
          accessories={"push" in def ? [{ icon: Icon.ChevronRight }] : undefined}
          actions={
            <ActionPanel>
              {defAction(def, paths, "push" in def ? def.pushTitle : def.title)}
              {def.extra?.(paths)}
              <Action.Push
                title="Apply to Another Folder…"
                icon={Icon.MagnifyingGlass}
                shortcut={{ modifiers: ["cmd"], key: "g" }}
                target={<TargetPicker def={def} />}
              />
              {common}
            </ActionPanel>
          }
        />
      ),
    }));

  const q = query.trim().toLowerCase();
  // Rank by title match first, keywords last; ties keep the fixed order above.
  const score = (e: Entry) => {
    const title = e.title.toLowerCase();
    if (title.startsWith(q)) return 0;
    if (title.split(/\s+/).some((w) => w.startsWith(q))) return 1;
    if (title.includes(q)) return 2;
    if (e.keywords.some((k) => k.startsWith(q))) return 3;
    return -1;
  };
  let visible = entries.map((e) => e.el);
  if (q) {
    visible = entries
      .map((e, idx) => ({ e, idx, s: score(e) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => a.s - b.s || a.idx - b.idx)
      .map((x) => x.e.el);
  }

  // While typing: matching folders below the actions; ↵ shows the same action list for that folder.
  const { pinned, frequent, recent, deep } = folderSearch.sections;
  const folders = q ? [...pinned, ...frequent, ...recent, ...deep] : [];

  return (
    <List
      isLoading={!items || (!!q && folderSearch.isLoading)}
      navigationTitle={what}
      searchBarPlaceholder={`Actions for ${what}, or search folders…`}
      filtering={false}
      onSearchTextChange={setQuery}
    >
      <List.EmptyView icon={Icon.MagnifyingGlass} title="No matching actions or folders" />
      {items && (
        <List.Section title={what} subtitle={subtitle}>
          {visible}
        </List.Section>
      )}
      {items && folders.length > 0 && (
        <List.Section title="Folders" subtitle="↵ for actions">
          {folders.map((f) => (
            <List.Item
              key={f}
              title={folderTitle(f)}
              subtitle={prettyPath(path.dirname(f))}
              icon={{ fileIcon: f }}
              accessories={[{ icon: Icon.ChevronRight }]}
              actions={
                <ActionPanel>
                  <Action.Push
                    title="Show Actions"
                    icon={Icon.List}
                    target={showActionsFor(f)}
                    onPush={() => recordVisit([f])}
                  />
                  <ActionPanel.Section>{defs.map((def) => defAction(def, [f]))}</ActionPanel.Section>
                  <ActionPanel.Section>
                    <Action.ShowInFinder path={f} shortcut={{ modifiers: ["cmd"], key: "f" }} />
                    <Action.CopyToClipboard
                      title="Copy Path"
                      content={f}
                      shortcut={Keyboard.Shortcut.Common.CopyPath}
                    />
                  </ActionPanel.Section>
                </ActionPanel>
              }
            />
          ))}
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
