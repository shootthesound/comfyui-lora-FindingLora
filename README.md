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

- **📖 Bookmark button.** One click bookmarks the currently-selected LoRA. The icon flips to **📕** when the active LoRA is bookmarked, so a glance tells you whether you're on a favourite.
- **Bookmarks dropdown.** A second dropdown above the main one lists every bookmarked LoRA. Picking one *sets* the main dropdown — the bookmark and the main always agree, no override semantics to reason about.
- **✏️ Trigger word storage.** When you bookmark, you're optionally prompted for a trigger word or phrase. The trigger displays on a read-only line below the LoRA dropdown when a bookmarked LoRA is selected, *and* gets emitted as a `STRING` output you can wire into your prompt-encoding chain.
- **🔍 Real fuzzy search.** Click the magnifying glass to open a search popup that runs proper fzf-style fuzzy matching across every LoRA in your `loras/` folder. Out-of-order characters, case-insensitive, ranked by score with word-boundary and consecutive-match bonuses. ↑/↓/Enter to navigate without the mouse.
- **Bookmarks persist globally.** Stored at `<ComfyUI>/user/finding-lora/bookmarks.json`. They survive workflow saves/loads and pack upgrades.

---

### Quick start

1. Drop the `comfyui-lora-FindingLora` folder into `ComfyUI/custom_nodes/`.
2. Restart ComfyUI.
3. Add the **LoRA Loader (Finding LoRA)** node from the `loaders` category.
4. Wire it just like the stock `LoRA Loader` — `MODEL` and `CLIP` in, `MODEL` and `CLIP` out, plus a third **`trigger`** `STRING` output.

Then:

- Pick any LoRA in the main dropdown → click **📖** → optional trigger entry.
- Next time you want this LoRA, pick it from the **Bookmarks** dropdown — main updates immediately.
- Got 1000+ LoRAs? Click **🔍**, type `kase` and hit Enter, you've got `character_kasey_v3.safetensors` selected.

---

### Inputs and outputs

#### Required
- `model` (MODEL)
- `clip` (CLIP)
- `lora_name` (combo) — same dropdown as stock, but bookmark/search make it optional to actually scroll
- `strength_model` (FLOAT, default 1.0)
- `strength_clip` (FLOAT, default 1.0)

#### Outputs
- `model` (MODEL) — with the LoRA applied
- `clip` (CLIP) — with the LoRA applied
- `trigger` (STRING) — trigger word/phrase saved against the bookmarked LoRA, or empty string if not bookmarked. Wire into a `CLIPTextEncode` via a string-concat node to auto-prepend trigger words to your prompt.

---

### Toolbar reference

| Icon | What it does |
|---|---|
| 📖 | Bookmark the current LoRA. Prompts for an optional trigger word/phrase. |
| 📕 | Active LoRA is already bookmarked. Click to remove the bookmark (with confirmation). |
| ✏️ | Edit the trigger word for the active LoRA. (If not yet bookmarked, prompts to add it first.) |
| 🔍 | Open the fuzzy-search popup. Type, ↑/↓ to navigate, Enter to select, Esc to cancel. |

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
