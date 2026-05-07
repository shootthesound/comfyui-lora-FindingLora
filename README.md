<h1 align="center">Finding LoRA — for ComfyUI</h1>

<p align="center">
  A LoRA loader with <strong>bookmarks</strong>, <strong>trigger-word storage and click-to-copy</strong>, <strong>fuzzy search</strong>, and a <strong>one-click button to drop another loader inline beside this one and wire it into the model chain automatically</strong>.<br>
  Stop scrolling a thousand-LoRA dropdown. Stop manually re-wiring whenever you want to stack another LoRA.
</p>

<p align="center">
  <a href="https://buymeacoffee.com/lorasandlenses"><img src="https://img.shields.io/badge/Buy%20me%20a%20coffee-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black" alt="Buy Me A Coffee"></a>
</p>

---

### Why I built this

I have over a thousand LoRAs. ComfyUI's stock LoRA Loader makes me scroll a giant dropdown to find any of them, then if I want to stack another I have to drag out a second loader, wire its `MODEL` in, wire its `MODEL` out, and remember the trigger words. Every part of that workflow is friction I've felt hundreds of times.

This pack is what I wished the stock loader was: bookmark the LoRAs you actually use; type a few characters to find any LoRA in the folder; store the trigger words once and copy them with a click; chain another loader with a single button that wires itself into the model line for you. Each feature is small in isolation; together they make the most-used node in my workflow feel sharp instead of clumsy.

I haven't seen another LoRA-loader pack do this combination — bookmarks + trigger storage + click-to-copy + fuzzy search + auto-chaining — so here it is.

---

### What's new vs the stock LoRA Loader

- **No more horrible left/right chevron dropdowns.** Both the LoRA picker and the bookmark picker open a proper modal on click. Default view is alphabetical with the current selection highlighted and scrolled into view, so a thousand-LoRA list lands you near where you were. Start typing to fuzzy-search — same picker, no separate search button.
- **📖 Bookmark button.** One click bookmarks the currently-selected LoRA. The button label flips to **📕 Remove bookmark** when the active LoRA is bookmarked.
- **📚 Bookmarks picker.** A second clickable bar above the LoRA picker lists every bookmarked LoRA. Picking one *sets* the LoRA picker — the bookmark and the active LoRA always agree.
- **✏️ Trigger word storage.** When you bookmark, you're optionally prompted for a trigger word or phrase. The trigger displays on a read-only line when a bookmarked LoRA is selected, *and* gets emitted as a `STRING` output you can wire into your prompt-encoding chain.
- **📋 Click-to-copy trigger.** Click the displayed trigger row to copy the phrase straight to your clipboard — paste it directly into a `CLIPTextEncode`. Shows a quick toast confirming the copy.
- **🔗 Chain another LoRA Loader.** A button at the bottom spawns a fresh copy of the node beside the current one and splices it into the model chain. Any downstream `MODEL` connections get re-routed through the new node — `(upstream) → this node → new node → (former downstream)`. Stack as many LoRAs as you want without manual rewiring.
- **🔍 Real fuzzy search built into the picker.** Type in the picker modal to fzf-style fuzzy match across every LoRA in your `loras/` folder. Substring matches always rank above scattered ones — typing `snoys` puts every name containing `snoys` at the top, before scattered subsequence matches sneak past on bonus points.
- **Bookmarks persist globally + sync live across nodes.** Stored at `<ComfyUI>/user/finding-lora/bookmarks.json`. Add a bookmark on one node and every other Finding LoRA node on the canvas updates immediately — no restart, no refresh.
- **All-canvas custom rendering.** Every widget on the node — pickers, buttons, the strength slider — is canvas-drawn so text alignment is consistent and the node escapes the Vue-button-quirks that other custom-node packs run into. The strength widget keeps the standard interactions: click `◀ ▶` to step, drag the body to scrub, double-click for direct entry.

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
- Click the trigger row to copy the trigger phrase to your clipboard.
- Click **🔗 Chain another LoRA Loader** to drop another copy of the node beside this one and weave it into the model chain automatically.

---

### Inputs and outputs

#### Required
- `model` (MODEL)
- `lora_name` (selected via the picker bar, but stored as a string)
- `strength_model` (FLOAT, default 1.0) — labelled **LoRA Strength** on the node face

#### Outputs
- `model` (MODEL) — with the LoRA applied
- `trigger` (STRING) — trigger word/phrase saved against the bookmarked LoRA, or empty string if not bookmarked. Wire into your prompt encoder via a string-concat node to auto-prepend trigger words to your prompt.

This is a **model-only** loader — no `clip` input or output, matching ComfyUI's stock `LoraLoaderModelOnly` for Klein 9B / Flux 2 / Wan / Z-image and any pipeline where CLIP isn't part of the LoRA chain.

---

### UI reference

| Element | What it does |
|---|---|
| 📚 Bookmarks: | Click → picker modal listing all bookmarks. Type to filter. |
| 🎛 LoRA: | Click → picker modal listing every LoRA. Default view is alphabetical scrolled to current. Type to fuzzy-search. ↑/↓ navigate, Enter selects, Esc cancels. |
| 📖 Bookmark this LoRA | Bookmark the current LoRA. Prompts for an optional trigger word/phrase. |
| 📕 Remove bookmark | Active LoRA is already bookmarked. Click to remove (with confirmation). |
| ✏️ Edit Trigger Word | Edit the trigger word/phrase for the active bookmark. (When the active LoRA isn't bookmarked yet, the same button reads "Add trigger word (bookmark first)" and offers to bookmark on the spot.) |
| 🔑 trigger row | Visible only when the active LoRA is bookmarked AND has a trigger saved. Click it to copy the trigger to your clipboard — a small 📋 hint icon sits at the right of the row. |
| LoRA Strength | Click `◀ / ▶` to step ±0.01, drag the middle to scrub, double-click for direct entry. |
| 🔗 Chain another LoRA Loader | Spawn another copy of the node beside this one and splice it into the model chain. Existing downstream `MODEL` connections are re-routed through the new node automatically. |

---

### Search / fuzzy details

The search algorithm is a simplified fzf with a hard tier for substring matches:

- **Tier 1 — substring match.** Any filename literally containing the query as a contiguous substring scores in a band that no scattered match can reach. So if you type `snoys`, every filename containing `snoys` ranks above every filename where `s/n/o/y/s` is just scattered. Earlier-in-the-name and word-boundary substring matches get extra bonuses; gentle length penalty as the tie-breaker.
- **Tier 2 — scattered subsequence (fzf-style).** All characters in the query must appear in the target **in order**. Bonuses for consecutive chars, word-boundary starts (after `_` `-` `.` `/` `\` or whitespace) and camelCase boundaries. Length penalty as tie-breaker.

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
