# File Actions

Alfred-style file/folder actions for the current Finder selection.

| Action | Notes |
| --- | --- |
| Open | Default app |
| Open With… | Only apps that can open the selection (default app tagged). Also ⌘K → Open With (⌘⇧O) |
| Open in Terminal | Folders only. App set in preferences (default iTerm, falls back to Terminal) |
| Move To… / Copy To… | Pinned + recently visited folders. ↵ goes into a folder, ⌘↵ moves/copies straight into it, "Move/Copy Here" at the top of each folder. Typing filters subfolders and also searches deeper (Spotlight) |
| Move to Bin | Optional confirmation |

Name clashes are never overwritten — the item becomes `name 2.ext`, like Finder.

## Setup
```
npm install
npm run dev     # loads it into Raycast
```
Then Raycast Settings → Extensions → File Actions → set the hotkey (e.g. ⌘O).
