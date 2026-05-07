<h1 align="center">Finding LoRA — for ComfyUI</h1>

<p align="center">
  A LoRA loader with <strong>bookmarks</strong>, <strong>trigger words</strong>, and <strong>fuzzy search</strong>.<br>
  Stop scrolling a thousand-LoRA dropdown.
</p>

<p align="center">
  <a href="https://buymeacoffee.com/lorasandlenses"><img src="https://img.shields.io/badge/Buy%20me%20a%20coffee-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black" alt="Buy Me A Coffee"></a>
</p>

---

### Why I built this

I have over a thousand LoRAs. ComfyUI's stock LoRA Loader makes me scroll a giant dropdown to find any of them. The wins from a node like this are obvious in hindsight, but I haven't seen another LoRA loader pack do this combination — bookmarks + trigger storage + actual fuzzy search — so here it is.

---

### What's new vs the stock LoRA Loader

- **No more horrible left/right chevron dropdowns.** Both the LoRA picker and the bookmark picker open a proper modal on click. Default view is alphabetical with the current selection highlighted and scrolled into view, so a thousand-LoRA list lands you near where you were. Start typing to fuzzy-search — same picker, no separate search button.
- **📖 Bookmark button.** One click bookmarks the currently-selected LoRA. The button label flips to **📕 Remove bookmark** when the active LoRA is bookmarked.
- **📚 Bookmarks picker.** A second clickable bar above the LoRA picker lists every bookmarked LoRA. Picking one *sets* the LoRA picker — the bookmark and the active LoRA always agree.
- **✏️ Trigger word storage.** When you bookmark, you're optionally prompted for a trigger word or phrase. The trigger displays on a read-only line when a bookmarked LoRA is selected, *and* gets emitted as a `STRING` output you can wire into your prompt-encoding chain.
- **🔍 Real fuzzy search built into the picker.** Type in the picker modal to fzf-style fuzzy match across every LoRA in your `loras/` folder. Out-of-order characters, case-insensitive, ranked by score with word-boundary and consecutive-match bonuses. ↑/↓/Enter to navigate without the mouse.
- **Bookmarks persist globally.** Stored at `<ComfyUI>/user/finding-lora/bookmarks.json`. They survive workflow saves/loads and pack upgrades.

---

### Quick start

1. Drop the `comfyui-lora-FindingLora` folder into `ComfyUI/custom_nodes/`.
2. Restart ComfyUI.
3. Add the **LoRA Loader (Finding LoRA)** node from the `loaders` category.
4. Wire it just like the stock `LoRA Loader (Model Only)` — `MODEL` in, `MODEL` out, plus a second **`trigger`** `STRING` output.

Then:

- Click the **🎛 LoRA:** bar → modal opens at your current selection alphabetically. Click any name, or type `kase` and hit Enter, you've got `character_kasey_v3.safetensors` selected.
- Click **📖 Bookmark this LoRA** → optional trigger word entry.
- Next time, click **📚 Bookmarks:** to pick straight from your favourites.

---

### Inputs and outputs

#### Required
- `model` (MODEL)
- `lora_name` (combo) — same dropdown as stock, but bookmark/search make it optional to actually scroll
- `strength_model` (FLOAT, default 1.0)

#### Outputs
- `model` (MODEL) — with the LoRA applied
- `trigger` (STRING) — trigger word/phrase saved against the bookmarked LoRA, or empty string if not bookmarked. Wire into your prompt encoder via a string-concat node to auto-prepend trigger words to your prompt.

---

### UI reference

| Element | What it does |
|---|---|
| 📚 Bookmarks: | Click → picker modal listing all bookmarks. Type to filter. |
| 🎛 LoRA: | Click → picker modal listing every LoRA. Default view is alphabetical scrolled to current. Type to fuzzy-search. ↑/↓ navigate, Enter selects, Esc cancels. |
| 📖 Bookmark this LoRA | Bookmark the current LoRA. Prompts for an optional trigger word/phrase. |
| 📕 Remove bookmark | Active LoRA is already bookmarked. Click to remove (with confirmation). |
| ✏️ Edit Trigger Word | (Only visible when the active LoRA is bookmarked.) Edit the trigger word/phrase. |

---

### Search / fuzzy details

The search algorithm is a simplified fzf:

- All characters in your query must appear in the target filename **in order** (out-of-order doesn't match — that'd be too lossy).
- Score is base + bonuses:
  - Consecutive characters get an accumulating bonus (so contiguous substrings rank above scattered ones).
  - Match at a word boundary (start, or after `_` `-` `.` `/` `\` or whitespace) gets a +15 bonus.
  - camelCase boundary bonus (lower→upper transition).
  - Mild length penalty so shorter filenames win on score ties.

Top 200 results are shown to keep the UI fast even on huge libraries.

---

### Storage

Bookmarks are stored as a single JSON file at `<ComfyUI>/user/finding-lora/bookmarks.json`. Format:

```json
{
  "version": 1,
  "bookmarks": [
    { "lora_name": "character_kasey_v3.safetensors", "trigger": "kasey, blue eyes, freckles" },
    { "lora_name": "style_arcane_concept.safetensors", "trigger": "arcane style" }
  ]
}
```

Live editable on disk if you want to bulk-import or back up. Restart ComfyUI to pick up changes you make to the file directly.

---

### Routes (for the curious)

The pack registers three HTTP routes on ComfyUI's server, namespaced under `/finding-lora/` so they don't clash with anything else:

- `GET  /finding-lora/list` — returns all bookmarks
- `POST /finding-lora/add` — `{ lora_name, trigger }` adds or updates a bookmark
- `POST /finding-lora/remove` — `{ lora_name }` removes a bookmark

Frontend talks to those, file storage stays server-side.

---

### Support

If this saves you scroll-time, consider supporting development:

<a href="https://buymeacoffee.com/lorasandlenses"><img src="https://img.shields.io/badge/Buy%20me%20a%20coffee-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black" alt="Buy Me A Coffee"></a>
