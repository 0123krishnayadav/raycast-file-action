# File Actions

Alfred-style file/folder actions for the current Finder selection.

| Action | Notes |
| --- | --- |
| Open | Default app |
| Open With… | Only apps that can open the selection (default app tagged). Also ⌘K → Open With (⌘⇧O) |
| Open in Terminal | Folders only. App set in preferences (default iTerm, falls back to Terminal) |
| Move To… / Copy To… | Pinned + frequent + recently visited folders. ↵ moves/copies straight into a folder; ⇥ goes into it ("Move/Copy Here" at the top). The confirmation shows the full destination path |
| Copy to Clipboard | The files themselves — ⌘V pastes them in Finder, Mail, Slack… |
| Move to Bin | Optional confirmation |

**Act on another folder:** just type — matching folders show up below the actions. ↵ on a folder gives the same action list for it (or ⌘K to run one directly). Or, on any action press **⌘G** (Apply to Another Folder…), pick a folder, and that action runs on it — e.g. highlight *Open in Terminal*, ⌘G, pick `trade-bot`. In the picker, ⌘↵ shows all actions for the folder instead.

**Browse into folders** (shell / Alfred style, everywhere you search folders):

| Key | Does |
| --- | --- |
| ⇥ | Autocomplete: `Dow` → `Downloads/` lists what is inside; `Downloads/fir` → `Downloads/first/`. On a file it completes the name |
| ⌘→ | Same as ⇥ on a folder |
| ⌘← | Up a level, with the folder you came from highlighted |
| ⌫ | Edit the path like text — `Downloads/first` lists Downloads filtered by "first" |
| ↵ | Main list: actions for that file/folder. Pickers: use that folder |
| ⌘Y | Quick Look the highlighted file/folder (main list) |

Folder contents are newest first (most recently added or changed — like Finder's Date Added), with folders and files in separate sections (files only in the main list). Typed paths work too: `~/Desk`, `/Applications/`, `../`. Start the filter with `.` to see hidden items. Big folders show 200 rows per section until you type to narrow.

**Folder suggestions** (all pickers): Pinned → Frequent ([zoxide](https://github.com/ajeetdsouza/zoxide), if installed) → Recently visited (this extension + Spotlight). Search is zoxide-style: `raycast file` matches `~/Desktop/raycast-extension/file-actions` — the last word must be in the folder name, the rest anywhere in the path. It also searches your whole home folder via Spotlight.

Name clashes are never overwritten — the item becomes `name 2.ext`, like Finder.

## Setup
```
npm install
npm run dev     # loads it into Raycast
```
Then Raycast Settings → Extensions → File Actions → set the hotkey (e.g. ⌘O).
