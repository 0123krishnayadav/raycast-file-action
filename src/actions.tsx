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
import {
  DestinationPicker,
  FolderPicker,
  moreHint,
  NavigationActions,
  PickerConfig,
  useFolderSearch,
  usePathSearch,
} from "./folder-picker";
import { getCompatibleApps, OpenWithList, openWith } from "./open-with";
import { copyFilesToClipboard, describeItems, folderTitle, Item, prettyPath, recordVisit } from "./utils";

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
      id: "clipboard",
      title: "Copy to Clipboard",
      icon: Icon.Clipboard,
      keywords: ["paste", "clipboard"],
      run: async (paths) => {
        try {
          await copyFilesToClipboard(paths);
          await done(`Copied ${describeItems(paths)} to clipboard`);
        } catch (e) {
          await showToast({ style: Toast.Style.Failure, title: "Could not copy to clipboard", message: String(e) });
        }
      },
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

/**
 * Actions for `items` (undefined while loading). Typing also searches folders to act on instead;
 * ⇥ on a folder lists what is inside it ("Downloads/"), files included.
 */
export function ActionList({ items }: { items?: Item[] }) {
  const search = usePathSearch();
  const here = search.target?.dir;
  const folderSearch = useFolderSearch(search.target?.filter ?? search.text, here);
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

  // While typing: matching folders below the actions; ↵ shows the same action list for that folder.
  const q = search.text.trim().toLowerCase();
  const { pinned, frequent, recent, deep, files, more } = folderSearch.sections;
  const folders = q ? [...pinned, ...frequent, ...recent, ...deep] : [];
  // Actions can rank above the folders ("Mo" → Move To…, then Movies); ⇥ still goes into the first folder.
  const tabToFirstFolder = folders[0] && (
    <Action
      title={`Go into ${folderTitle(folders[0])}`}
      icon={Icon.ArrowRight}
      shortcut={{ modifiers: [], key: "tab" }}
      onAction={() => search.complete({ path: folders[0], isDir: true })}
    />
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
              {tabToFirstFolder}
              {common}
            </ActionPanel>
          }
        />
      ),
    }));

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
  if (here) {
    visible = []; // browsing a path: its contents replace the actions
  } else if (q) {
    visible = entries
      .map((e, idx) => ({ e, idx, s: score(e) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => a.s - b.s || a.idx - b.idx)
      .map((x) => x.e.el);
  }

  const row = (item: Item) => {
    const date = folderSearch.changed.get(item.path);
    return (
      <List.Item
        key={item.path}
        id={item.path}
        title={folderTitle(item.path)}
        subtitle={here && path.dirname(item.path) === here ? undefined : prettyPath(path.dirname(item.path))}
        icon={{ fileIcon: item.path }}
        quickLook={{ path: item.path, name: folderTitle(item.path) }}
        accessories={[
          ...(date ? [{ date, tooltip: `Added or changed ${date.toLocaleString()}` }] : []),
          ...(item.isDir ? [{ icon: Icon.ChevronRight }] : []),
        ]}
        actions={
          <ActionPanel>
            <Action.Push
              title="Show Actions"
              icon={Icon.List}
              target={<ActionList items={[item]} />}
              onPush={() => recordVisit([item.isDir ? item.path : path.dirname(item.path)])}
            />
            {/* Kept second so ⌘↵ still runs Open, as before. */}
            <ActionPanel.Section>
              {defs.filter((def) => item.isDir || !def.dirsOnly).map((def) => defAction(def, [item.path]))}
            </ActionPanel.Section>
            <NavigationActions search={search} item={item} />
            <ActionPanel.Section>
              <Action.ToggleQuickLook shortcut={Keyboard.Shortcut.Common.ToggleQuickLook} />
              <Action.ShowInFinder path={item.path} shortcut={{ modifiers: ["cmd"], key: "f" }} />
              <Action.CopyToClipboard
                title="Copy Path"
                content={item.path}
                shortcut={Keyboard.Shortcut.Common.CopyPath}
              />
            </ActionPanel.Section>
          </ActionPanel>
        }
      />
    );
  };

  // On top, or below the matches while filtering so ⇥ lands on the first match.
  const thisFolder = here && !folderSearch.error && (
    <List.Section title="This Folder">{row({ path: here, isDir: true })}</List.Section>
  );
  const filtering = !!search.target?.filter.trim();

  return (
    <List
      {...search.listProps}
      isLoading={!items || (!!q && folderSearch.isLoading)}
      navigationTitle={here ? prettyPath(here) : what}
      searchBarPlaceholder={`Actions for ${what}, or search folders… ⇥ goes into one`}
    >
      {folderSearch.error ? (
        <List.EmptyView
          icon={Icon.Warning}
          title={folderSearch.error}
          description={here && prettyPath(here)}
          actions={
            <ActionPanel>
              <NavigationActions search={search} />
            </ActionPanel>
          }
        />
      ) : (
        <List.EmptyView icon={Icon.MagnifyingGlass} title="No matching actions or folders" />
      )}
      {items && (
        <List.Section title={what} subtitle={subtitle}>
          {visible}
        </List.Section>
      )}
      {items && !filtering && thisFolder}
      {items && folders.length > 0 && (
        <List.Section
          title="Folders"
          subtitle={["↵ for actions · ⇥ to go in", moreHint(more.folders)].filter(Boolean).join(" · ")}
        >
          {folders.map((f) => row({ path: f, isDir: true }))}
        </List.Section>
      )}
      {items && files.length > 0 && (
        <List.Section title="Files" subtitle={["↵ for actions", moreHint(more.files)].filter(Boolean).join(" · ")}>
          {files.map((f) => row({ path: f, isDir: false }))}
        </List.Section>
      )}
      {items && filtering && thisFolder}
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
