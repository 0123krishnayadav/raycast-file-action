import {
  Action,
  ActionPanel,
  Application,
  closeMainWindow,
  getApplications,
  getDefaultApplication,
  Icon,
  List,
  open,
  PopToRootType,
  showToast,
  Toast,
} from "@raycast/api";
import { useEffect, useState } from "react";
import { describeItems } from "./utils";

/** Apps that can open every selected item (default app first). */
export async function getCompatibleApps(paths: string[]): Promise<{ apps: Application[]; defaultApp?: Application }> {
  const lists = await Promise.all(paths.map((p) => getApplications(p)));
  const common = lists.reduce((acc, list) => acc.filter((a) => list.some((b) => b.path === a.path)));
  const defaultApp = await getDefaultApplication(paths[0]).catch(() => undefined);
  const seen = new Set<string>();
  const apps = common
    .filter((a) => (seen.has(a.path) ? false : (seen.add(a.path), true)))
    .sort((a, b) =>
      a.path === defaultApp?.path ? -1 : b.path === defaultApp?.path ? 1 : a.name.localeCompare(b.name),
    );
  return { apps, defaultApp };
}

export async function openWith(paths: string[], app: Application | string) {
  try {
    for (const p of paths) await open(p, app);
    await closeMainWindow({ popToRootType: PopToRootType.Immediate });
  } catch (e) {
    await showToast({ style: Toast.Style.Failure, title: "Could not open", message: String(e) });
  }
}

export function OpenWithList({ paths }: { paths: string[] }) {
  const [state, setState] = useState<{ apps: Application[]; defaultApp?: Application }>({ apps: [] });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getCompatibleApps(paths)
      .then(setState)
      .finally(() => setLoading(false));
  }, []);

  return (
    <List
      isLoading={loading}
      navigationTitle={`Open ${describeItems(paths)} With…`}
      searchBarPlaceholder="Search apps…"
    >
      {state.apps.map((app) => (
        <List.Item
          key={app.path}
          title={app.localizedName ?? app.name}
          icon={{ fileIcon: app.path }}
          accessories={app.path === state.defaultApp?.path ? [{ tag: "Default" }] : []}
          actions={
            <ActionPanel>
              <Action title={`Open with ${app.name}`} icon={Icon.Window} onAction={() => openWith(paths, app)} />
              <Action.ShowInFinder title="Show App in Finder" path={app.path} />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
