# File Actions

Alfred-style file/folder actions for the current Finder selection.

| Action | Notes |
| --- | --- |
| Open | Default app |
| Open With… | Only apps that can open the selection (default app tagged). Also ⌘K → Open With (⌘⇧O) |
| Open in Terminal | Folders only. App set in preferences (default iTerm, falls back to Terminal) |
| Move To… / Copy To… | Pinned + recently visited folders. ↵ moves/copies straight into a folder, ⌘→ goes into it ("Move/Copy Here" at the top). Typing filters subfolders and also searches deeper (Spotlight) |
| Move to Bin | Optional confirmation |

**Act on another folder:** just type — matching folders show up below the actions. ↵ on a folder gives the same action list for it (or ⌘K to run one directly). Or, on any action press **⌘G** (Apply to Another Folder…), pick a folder, and that action runs on it — e.g. highlight *Open in Terminal*, ⌘G, pick `trade-bot`. In the picker, ⌘↵ shows all actions for the folder instead, ⌘→ browses into it.

**Folder suggestions** (all pickers): Pinned → Frequent ([zoxide](https://github.com/ajeetdsouza/zoxide), if installed) → Recently visited (this extension + Spotlight). Search is zoxide-style: `raycast file` matches `~/Desktop/raycast-extension/file-actions` — the last word must be in the folder name, the rest anywhere in the path. It also searches your whole home folder via Spotlight.

Name clashes are never overwritten — the item becomes `name 2.ext`, like Finder.

## Setup
```
npm install
npm run dev     # loads it into Raycast
```
Then Raycast Settings → Extensions → File Actions → set the hotkey (e.g. ⌘O).
