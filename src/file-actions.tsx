import { getSelectedFinderItems, Icon, List } from "@raycast/api";
import { runAppleScript } from "@raycast/utils";
import { useEffect, useState } from "react";
import { promises as fs } from "node:fs";
import path from "node:path";
import { ActionList } from "./actions";
import { isPackage, Item, recordVisit } from "./utils";

/** Folder of the front Finder window (or Desktop if none is open). */
async function finderCurrentFolder(): Promise<string> {
  return runAppleScript('tell application "Finder" to return POSIX path of (insertion location as alias)');
}

async function loadSelection(): Promise<Item[]> {
  let selected = await getSelectedFinderItems().catch(() => []);
  // Nothing selected → act on the folder currently open in Finder.
  if (selected.length === 0) selected = [{ path: await finderCurrentFolder() }];
  return Promise.all(
    selected.map(async ({ path: p }) => {
      const clean = p.length > 1 ? p.replace(/\/$/, "") : p;
      const stat = await fs.stat(clean).catch(() => undefined);
      // Treat app bundles / packages like files.
      return { path: clean, isDir: !!stat?.isDirectory() && !isPackage(clean) };
    }),
  );
}

export default function Command() {
  const [items, setItems] = useState<Item[]>();
  const [error, setError] = useState<string>();

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

  return <ActionList items={items} />;
}
