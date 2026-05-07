// Finding LoRA — UI extension for the LoraLoaderFindingLora node.
//
// Replaces the stock combo widgets with click-to-modal pickers (no more
// horrible left/right chevron dropdowns). Default modal view is alphabetical
// with the current selection highlighted; type to fuzzy-search.
//
// Widget stack:
//   📚 Bookmarks: <name>     ← click → bookmark picker
//   🎛 LoRA: <name>          ← click → LoRA picker (search built in)
//   📖 / 📕 button            ← bookmark toggle
//   ✏️ Edit Trigger Word      ← only visible when active LoRA is bookmarked
//   🔑 trigger preview line   ← only when a trigger is set
//   strength_model
//
// Bookmarks are stored server-side; this file talks to the Python pack via
// /finding-lora/list, /finding-lora/add, /finding-lora/remove.

import { app } from "/scripts/app.js";

const NODE_CLASS = "LoraLoaderFindingLora";
const ROUTE_BASE = "/finding-lora";

// =====================================================================
// Module-level bookmarks cache + broadcast
//
// One fetch per page load, shared across every Finding-LoRA node on the
// canvas. Mutations update the cache and broadcast to all live listeners,
// so adding a bookmark on node A immediately updates node B's dropdown
// without a restart.
// =====================================================================

let BOOKMARKS_CACHE = [];
let BOOKMARKS_LOADED = false;
let BOOKMARKS_LOAD_PROMISE = null;
const BOOKMARK_LISTENERS = new Set();

function broadcast() {
    for (const fn of BOOKMARK_LISTENERS) {
        try { fn(BOOKMARKS_CACHE); } catch (e) { console.warn(e); }
    }
}

function ensureLoaded() {
    // Memoised lazy fetch; safe to call from many node onCreated handlers
    // simultaneously — only the first triggers the network request.
    if (BOOKMARKS_LOADED) return Promise.resolve(BOOKMARKS_CACHE);
    if (BOOKMARKS_LOAD_PROMISE) return BOOKMARKS_LOAD_PROMISE;
    BOOKMARKS_LOAD_PROMISE = (async () => {
        try {
            const res = await fetch(`${ROUTE_BASE}/list`);
            if (res.ok) {
                const data = await res.json();
                BOOKMARKS_CACHE = Array.isArray(data.bookmarks) ? data.bookmarks : [];
            }
        } catch (e) {
            console.warn("[finding-lora] list failed:", e);
        } finally {
            BOOKMARKS_LOADED = true;
            BOOKMARKS_LOAD_PROMISE = null;
            broadcast();
        }
        return BOOKMARKS_CACHE;
    })();
    return BOOKMARKS_LOAD_PROMISE;
}

function subscribe(fn) {
    BOOKMARK_LISTENERS.add(fn);
    // Hand the subscriber the current cache immediately if we have one,
    // so newly-created nodes don't have to await anything for the common case.
    if (BOOKMARKS_LOADED) fn(BOOKMARKS_CACHE);
    return () => BOOKMARK_LISTENERS.delete(fn);
}

async function refetchBookmarks() {
    // Manual force-reload from disk. Useful if user edits bookmarks.json directly.
    try {
        const res = await fetch(`${ROUTE_BASE}/list`);
        if (res.ok) {
            const data = await res.json();
            BOOKMARKS_CACHE = Array.isArray(data.bookmarks) ? data.bookmarks : [];
            BOOKMARKS_LOADED = true;
            broadcast();
        }
    } catch (e) {
        console.warn("[finding-lora] refetch failed:", e);
    }
}

async function addBookmark(loraName, trigger) {
    try {
        const res = await fetch(`${ROUTE_BASE}/add`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ lora_name: loraName, trigger: trigger || "" }),
        });
        if (!res.ok) return false;
        const data = await res.json();
        if (Array.isArray(data.bookmarks)) {
            BOOKMARKS_CACHE = data.bookmarks;
            BOOKMARKS_LOADED = true;
            broadcast();
        }
        return true;
    } catch (e) {
        console.warn("[finding-lora] add failed:", e);
        return false;
    }
}

async function removeBookmark(loraName) {
    try {
        const res = await fetch(`${ROUTE_BASE}/remove`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ lora_name: loraName }),
        });
        if (!res.ok) return false;
        const data = await res.json();
        if (Array.isArray(data.bookmarks)) {
            BOOKMARKS_CACHE = data.bookmarks;
            BOOKMARKS_LOADED = true;
            broadcast();
        }
        return true;
    } catch (e) {
        console.warn("[finding-lora] remove failed:", e);
        return false;
    }
}

// =====================================================================
// Fuzzy search (fzf-style subsequence match with bonus scoring)
// =====================================================================

function fuzzyScore(query, target) {
    if (!query) return 0;
    const q = query.toLowerCase();
    const t = target.toLowerCase();

    // Tier 1 — contiguous substring match. Any target that literally contains
    // the query string scores in a band (1000+) that no scattered subsequence
    // match can reach, so a name with "snoys" always beats a name with
    // s…n…o…y…s scattered across the filename.
    const substrIdx = t.indexOf(q);
    if (substrIdx >= 0) {
        let score = 1000;
        // Earlier in the string is better.
        score -= substrIdx * 0.5;
        // Match at start of filename = strongest possible.
        if (substrIdx === 0) {
            score += 500;
        } else if (/[\s_\-./\\]/.test(t[substrIdx - 1])) {
            // Match at a word boundary inside the filename (after _, -, ., /, \).
            score += 200;
        }
        // Gentle length penalty so shorter filenames win on near-ties.
        score -= t.length * 0.1;
        return score;
    }

    // Tier 2 — scattered subsequence match (fzf-style). Caps well below 1000
    // even with maximum bonuses on every char.
    let qi = 0;
    let score = 0;
    let consecutive = 0;
    let prevMatch = -2;

    for (let ti = 0; ti < t.length && qi < q.length; ti++) {
        if (t[ti] === q[qi]) {
            let bonus = 10;
            if (ti === prevMatch + 1) {
                consecutive += 5;
                bonus += consecutive;
            } else {
                consecutive = 0;
            }
            const isWordStart = ti === 0 || /[\s_\-./\\]/.test(t[ti - 1]);
            if (isWordStart) bonus += 15;
            if (ti > 0 && /[a-z]/.test(t[ti - 1]) && /[A-Z]/.test(target[ti])) bonus += 10;
            score += bonus;
            prevMatch = ti;
            qi++;
        }
    }

    if (qi < q.length) return -1; // not all query chars matched
    score -= t.length * 0.1;
    return score;
}

function fuzzySearch(query, targets) {
    if (!query || !query.trim()) {
        return targets.map((t) => ({ target: t, score: 0 }));
    }
    return targets
        .map((t) => ({ target: t, score: fuzzyScore(query, t) }))
        .filter((r) => r.score > -1)
        .sort((a, b) => b.score - a.score);
}

// =====================================================================
// Picker modal (plain DOM)
//
// Replaces the stock ComfyUI combo's left/right chevrons with a real picker:
// - Empty query → alphabetical list, current selection highlighted + scrolled
//   into view. So clicking a long dropdown lands you near where you were.
// - Type → fuzzy-search via fuzzyScore. Top 200 results to keep the UI snappy.
// - ↑/↓ navigates, Enter selects, Esc cancels.
//
// Used by both the LoRA picker and the bookmark picker — same UX, different
// data source.
// =====================================================================

function showPickerModal(allItems, current, opts) {
    opts = opts || {};
    const title = opts.title || "🔍 Pick";
    const placeholder = opts.placeholder ||
        "Type to fuzzy-search (out-of-order chars OK), or browse by alphabet. ↑/↓ + Enter.";
    const onSelect = opts.onSelect;
    const emptyMsg = opts.emptyMsg || "No items";

    const backdrop = document.createElement("div");
    backdrop.style.cssText = `
        position: fixed; inset: 0; background: rgba(0,0,0,0.6);
        display: flex; align-items: center; justify-content: center;
        z-index: 10000; font-family: Arial, sans-serif;
    `;

    const modal = document.createElement("div");
    modal.style.cssText = `
        background: #2a2a2a; color: #ddd; border: 1px solid #555;
        border-radius: 8px; padding: 16px; width: 720px; max-width: 90vw;
        max-height: 80vh; display: flex; flex-direction: column; gap: 10px;
    `;

    const header = document.createElement("div");
    header.style.cssText = "font-size: 14px; font-weight: bold; color: #aaa;";
    header.textContent = title;

    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = placeholder;
    input.style.cssText = `
        background: #1a1a1a; color: #eee; border: 1px solid #555;
        padding: 8px 12px; font-size: 13px; border-radius: 4px;
    `;

    const results = document.createElement("div");
    results.style.cssText = `
        flex: 1; overflow-y: auto; background: #1a1a1a; border: 1px solid #444;
        border-radius: 4px; min-height: 220px; max-height: 50vh; font-size: 12px;
        font-family: monospace;
    `;

    const footer = document.createElement("div");
    footer.style.cssText = "display: flex; justify-content: space-between; gap: 8px; align-items: center;";

    const status = document.createElement("span");
    status.style.cssText = "color: #888; font-size: 11px;";

    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "Cancel";
    cancelBtn.style.cssText = `
        background: #444; color: #ddd; border: none; padding: 6px 14px;
        border-radius: 4px; cursor: pointer;
    `;

    footer.appendChild(status);
    footer.appendChild(cancelBtn);
    modal.appendChild(header);
    modal.appendChild(input);
    modal.appendChild(results);
    modal.appendChild(footer);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    let selectedIdx = 0;
    let currentResults = [];

    const close = () => {
        if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
    };

    const choose = (val) => {
        close();
        if (val !== null && val !== undefined && onSelect) onSelect(val);
    };

    const updateHighlight = () => {
        Array.from(results.children).forEach((row, i) => {
            row.style.background = i === selectedIdx ? "#3a3a3a" : "transparent";
        });
        const sel = results.children[selectedIdx];
        if (sel) sel.scrollIntoView({ block: "nearest" });
    };

    const renderResults = () => {
        const q = input.value;
        if (!q.trim()) {
            // Default view: alphabetical, scrolled to current.
            currentResults = [...allItems]
                .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
                .map((t) => ({ target: t, score: 0 }));
            const curIdx = currentResults.findIndex((r) => r.target === current);
            selectedIdx = curIdx >= 0 ? curIdx : 0;
        } else {
            currentResults = fuzzySearch(q, allItems).slice(0, 200);
            selectedIdx = 0;
        }
        results.innerHTML = "";

        if (currentResults.length === 0) {
            const empty = document.createElement("div");
            empty.style.cssText = "padding: 24px; color: #888; text-align: center;";
            empty.textContent = emptyMsg;
            results.appendChild(empty);
            status.textContent = "0 matches";
            return;
        }

        currentResults.forEach((r, i) => {
            const row = document.createElement("div");
            row.style.cssText = `
                padding: 6px 12px; cursor: pointer; user-select: none;
                ${r.target === current ? "color: #4af;" : ""}
            `;
            row.textContent = r.target;
            row.addEventListener("click", () => choose(r.target));
            row.addEventListener("mouseenter", () => {
                selectedIdx = i;
                updateHighlight();
            });
            results.appendChild(row);
        });

        const noun = q.trim() ? "match" : "item";
        const truncatedHint = (q.trim() && currentResults.length === 200)
            ? " (top 200 — refine query)"
            : "";
        status.textContent =
            `${currentResults.length} ${noun}${currentResults.length === 1 ? "" : (noun === "match" ? "es" : "s")}${truncatedHint}`;
        updateHighlight();
    };

    input.addEventListener("input", renderResults);
    input.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
            e.preventDefault();
            close();
        } else if (e.key === "ArrowDown") {
            e.preventDefault();
            selectedIdx = Math.min(selectedIdx + 1, currentResults.length - 1);
            updateHighlight();
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            selectedIdx = Math.max(selectedIdx - 1, 0);
            updateHighlight();
        } else if (e.key === "Enter") {
            e.preventDefault();
            const r = currentResults[selectedIdx];
            if (r) choose(r.target);
        }
    });

    cancelBtn.addEventListener("click", close);
    backdrop.addEventListener("click", (e) => {
        if (e.target === backdrop) close();
    });

    renderResults();
    setTimeout(() => input.focus(), 0);
}

// =====================================================================
// Per-node helpers
// =====================================================================

function getCurrentLoraName(node) {
    const w = node.widgets?.find((x) => x.name === "lora_name");
    return w ? w.value : "";
}

function setCurrentLoraName(node, value) {
    const w = node.widgets?.find((x) => x.name === "lora_name");
    if (!w) return;
    w.value = value;
    if (w.callback) w.callback(value);
    node.setDirtyCanvas(true, true);
}

function findActiveBookmark(node) {
    const bms = node._finding_bookmarks || [];
    const cur = getCurrentLoraName(node);
    return bms.find((b) => b && b.lora_name === cur) || null;
}

function refreshNodeUI(node) {
    const active = findActiveBookmark(node);

    // Bookmark picker display — show active bookmark name, or "(none)".
    const bmw = findFindingWidget(node, "bookmark_combo");
    if (bmw) {
        bmw.value = active ? active.lora_name : "(none)";
    }

    // Bookmark toggle button — flip 📖 / 📕 based on whether active LoRA is bookmarked.
    const btn = findFindingWidget(node, "bookmark_btn");
    if (btn) {
        btn.name = active ? "📕 Remove bookmark" : "📖 Bookmark this LoRA";
    }

    // Edit trigger button is always present — its click handler decides
    // what to do based on bookmark state. (We don't conditionally splice it
    // out; that would shift node.widgets length and cause widgets_values
    // misalignment when ComfyUI loads the saved workflow positionally.)
    const editBtn = findFindingWidget(node, "edit_btn");
    if (editBtn) {
        editBtn.name = active ? "✏️ Edit Trigger Word" : "✏️ Add trigger word (bookmarks first)";
    }

    // Trigger display.
    const tw = findFindingWidget(node, "trigger_display");
    if (tw) {
        tw.value = active && active.trigger ? active.trigger : "";
    }

    // Update height only — preserve current width so the user's resize
    // (or our initial 1.8× default) survives bookmark broadcasts and trigger
    // visibility changes.
    const computed = node.computeSize();
    const currentWidth = (node.size && node.size[0]) || computed[0];
    node.setSize([Math.max(currentWidth, computed[0]), computed[1]]);
    node.setDirtyCanvas(true, true);
}

// =====================================================================
// Custom widgets
// =====================================================================

// =====================================================================
// Widget builders
//
// Notes on the approach:
// - Modern ComfyUI frontends render button-type widgets via the framework
//   layer; custom `draw` / `mouse` overrides on those widgets don't always
//   fire. So we use the official `addWidget("button", label, null, cb)`
//   callback parameter for click handling — guaranteed to work.
// - The bookmark "dropdown" stays as a real combo widget; we expose its
//   label as the friendly displayed name "Bookmarks".
// - The trigger display is a hand-rolled widget object pushed directly to
//   `node.widgets` so it has no label rendered at all.
// =====================================================================

function createBookmarkWidget(node) {
    // Custom-type clickable widget (no native combo dropdown). Click opens
    // the picker modal listing all bookmarks; type to filter, Enter to apply.
    //
    // The widget serializes naturally (no serialize=false). Its value is
    // cosmetic — refreshNodeUI overrides it on every load based on actual
    // bookmark state. Keeping it serializable means widgets_values.length
    // matches node.widgets.length, which avoids positional drift on load.
    const widget = {
        type: "FINDING_LORA_BOOKMARK_PICKER",
        name: "Bookmarks",
        value: "(none)",
        options: {},
        _finding_role: "bookmark_combo",

        draw(ctx, n, ww, y, wh) {
            ctx.fillStyle = "#1f2630";
            ctx.fillRect(8, y + 2, ww - 16, wh - 4);
            ctx.strokeStyle = "#3a4a5a";
            ctx.lineWidth = 1;
            ctx.strokeRect(8.5, y + 2.5, ww - 17, wh - 5);

            const labelText = "📚 Bookmarks:";
            ctx.fillStyle = "#aab";
            ctx.font = "11px Arial";
            ctx.textBaseline = "middle";
            ctx.textAlign = "left";
            ctx.fillText(labelText, 14, y + wh / 2);

            const labelW = ctx.measureText(labelText).width + 8;
            const arrowW = 16;
            const valueX = 14 + labelW;
            const maxW = ww - 16 - labelW - arrowW - 12;
            const orig = this.value || "(none)";
            let display = orig;
            const isPlaceholder = orig === "(none)";
            ctx.fillStyle = isPlaceholder ? "#777" : "#dde";
            ctx.font = isPlaceholder ? "italic 12px Arial" : "12px Arial";
            while (ctx.measureText(display + "…").width > maxW && display.length > 4) {
                display = display.slice(0, -1);
            }
            if (display !== orig) display += "…";
            ctx.fillText(display, valueX, y + wh / 2);

            ctx.fillStyle = "#88a";
            ctx.font = "12px Arial";
            ctx.textAlign = "right";
            ctx.fillText("▾", ww - 14, y + wh / 2);
        },

        computeSize() {
            return [0, 30];
        },

        mouse(e, pos, n) {
            if (e.type !== "pointerdown" && e.type !== "mousedown") return false;
            const bms = node._finding_bookmarks || [];
            if (bms.length === 0) {
                alert("No bookmarks yet. Pick a LoRA and click 📖 to bookmark it.");
                return true;
            }
            const items = bms.map((b) => b.lora_name);
            const cur = getCurrentLoraName(node);
            showPickerModal(items, cur, {
                title: "📚 Pick a bookmark",
                placeholder: "Type to filter bookmarks (↑/↓ + Enter)…",
                emptyMsg: "No bookmarks match",
                onSelect: (selected) => {
                    if (!selected) return;
                    setCurrentLoraName(node, selected);
                    refreshNodeUI(node);
                },
            });
            return true;
        },
    };
    node.widgets.push(widget);
    return widget;
}

function createLoraPicker(node) {
    // Replaces the framework-rendered lora_name combo. Approach: yank the
    // combo entirely out of node.widgets and let our custom-type widget
    // adopt name="lora_name" so it takes over both rendering AND
    // serialization. The backend input still works because ComfyUI submits
    // by widget.name → widget.value, which we satisfy.
    //
    // Why the yank is needed (not just hide): a hidden-but-present combo
    // with computeSize [0, -4] still occupies a slot in LiteGraph's
    // y-coordinate stack that ComfyUI's Vue overlay uses to position
    // framework widgets (button, number) below. Result: their text
    // bottom-aligns inside their boxes. Removing the combo entirely
    // eliminates the layout displacement.
    const loraCombo = node.widgets?.find((w) => w.name === "lora_name");
    if (!loraCombo) return null;

    const allLoras = (loraCombo.options?.values || []).slice();
    const initialValue = loraCombo.value;
    const origCallback = loraCombo.callback;
    const comboIdx = node.widgets.indexOf(loraCombo);
    if (comboIdx >= 0) node.widgets.splice(comboIdx, 1);

    const widget = {
        type: "FINDING_LORA_LORA_PICKER",
        // name "lora_name" so it takes over backend submission AND
        // serialization slot from the removed combo.
        name: "lora_name",
        value: initialValue || "",
        // Keep options.values so anything that introspects the widget
        // (e.g. validation) still sees the LoRA list.
        options: { values: allLoras },
        _finding_role: "lora_picker",

        draw(ctx, n, ww, y, wh) {
            ctx.fillStyle = "#1f1f1f";
            ctx.fillRect(8, y + 2, ww - 16, wh - 4);
            ctx.strokeStyle = "#555";
            ctx.lineWidth = 1;
            ctx.strokeRect(8.5, y + 2.5, ww - 17, wh - 5);

            const labelText = "🎛 LoRA:";
            ctx.fillStyle = "#aaa";
            ctx.font = "11px Arial";
            ctx.textBaseline = "middle";
            ctx.textAlign = "left";
            ctx.fillText(labelText, 14, y + wh / 2);

            const labelW = ctx.measureText(labelText).width + 8;
            const arrowW = 16;
            const valueX = 14 + labelW;
            const maxW = ww - 16 - labelW - arrowW - 12;
            const orig = this.value || "(none)";
            let display = orig;
            ctx.fillStyle = "#ddd";
            ctx.font = "12px Arial";
            while (ctx.measureText(display + "…").width > maxW && display.length > 4) {
                display = display.slice(0, -1);
            }
            if (display !== orig) display += "…";
            ctx.fillText(display, valueX, y + wh / 2);

            ctx.fillStyle = "#aaa";
            ctx.font = "12px Arial";
            ctx.textAlign = "right";
            ctx.fillText("▾", ww - 14, y + wh / 2);
        },

        computeSize() {
            return [0, 30];
        },

        mouse(e, pos, n) {
            if (e.type !== "pointerdown" && e.type !== "mousedown") return false;
            showPickerModal(this.options?.values || [], this.value, {
                title: "🎛 Find a LoRA",
                placeholder: "Type to fuzzy-search, or browse alphabetically (↑/↓ + Enter)…",
                emptyMsg: "No LoRAs match",
                onSelect: (selected) => {
                    if (!selected) return;
                    this.value = selected;
                    if (origCallback) {
                        try { origCallback.call(this, selected); } catch (e) { /* noop */ }
                    }
                    refreshNodeUI(node);
                },
            });
            return true;
        },
    };

    // Reinsert at the original position so widgets_values ordering matches
    // exactly — saved workflows load without column drift.
    const insertAt = comboIdx >= 0 ? comboIdx : node.widgets.length;
    node.widgets.splice(insertAt, 0, widget);
    return widget;
}

function createCustomButton(node, role, label, onClick) {
    // Custom-type clickable widget. Replaces addWidget("button", …) — the
    // Vue-layer button widget bottom-aligns its text on this user's setup,
    // and we have no clean override for it. By going custom-typed we control
    // the entire render, so text is properly centred inside the button rect.
    const widget = {
        type: "FINDING_LORA_BUTTON",
        name: label,
        value: null,
        options: {},
        _finding_role: role,

        draw(ctx, n, ww, y, wh) {
            // Pill background with subtle border.
            ctx.fillStyle = "#363636";
            ctx.fillRect(8, y + 2, ww - 16, wh - 4);
            ctx.strokeStyle = "#555";
            ctx.lineWidth = 1;
            ctx.strokeRect(8.5, y + 2.5, ww - 17, wh - 5);

            // Centred label.
            ctx.fillStyle = "#ddd";
            ctx.font = "12px Arial";
            ctx.textBaseline = "middle";
            ctx.textAlign = "center";
            ctx.fillText(this.name || "", ww / 2, y + wh / 2);
        },

        computeSize() {
            return [0, 30];
        },

        mouse(e, pos, n) {
            if (e.type !== "pointerdown" && e.type !== "mousedown") return false;
            try { onClick(); } catch (err) { console.warn("[finding-lora]", err); }
            return true;
        },
    };
    node.widgets.push(widget);
    return widget;
}

function createBookmarkButton(node) {
    // 📖/📕 toggle — refreshNodeUI() updates `name` (displayed label) on
    // each state change.
    return createCustomButton(node, "bookmark_btn", "📖 Bookmark this LoRA", () => {
        const cur = getCurrentLoraName(node);
        const active = findActiveBookmark(node);
        if (active) {
            if (window.confirm(`Remove bookmark for "${cur}"?`)) {
                removeBookmark(cur);
            }
        } else {
            if (!cur || cur === "None") {
                alert("Pick a LoRA first.");
                return;
            }
            const trigger = window.prompt(
                `Bookmark "${cur}"\n\nOptional trigger word / phrase (leave blank if none):`,
                ""
            );
            if (trigger === null) return;
            addBookmark(cur, trigger.trim());
        }
    });
}

function createEditTriggerButton(node) {
    // Always present in node.widgets so widgets_values stays a stable length.
    // Click handler covers both bookmarked (edit) and not-yet-bookmarked
    // (offer to bookmark first) states.
    return createCustomButton(node, "edit_btn", "✏️ Edit Trigger Word", () => {
        const cur = getCurrentLoraName(node);
        if (!cur || cur === "None") {
            alert("Pick a LoRA first.");
            return;
        }
        const active = findActiveBookmark(node);
        if (!active) {
            if (!window.confirm(`"${cur}" isn't bookmarked yet. Add it now?`)) return;
        }
        const seed = active ? active.trigger || "" : "";
        const trigger = window.prompt(`Trigger word / phrase for "${cur}":`, seed);
        if (trigger === null) return;
        addBookmark(cur, trigger.trim());
    });
}

function createTriggerWidget(node) {
    // Hand-rolled widget pushed directly to node.widgets — gets no framework
    // label. Hides itself (computeSize → [0, -4]) when no trigger is set.
    // Serializes naturally (no serialize=false) so widgets_values stays a
    // stable length matching node.widgets across save/load.
    const widget = {
        type: "FINDING_LORA_TRIGGER_DISPLAY",
        name: "_finding_trigger",
        value: "",
        options: {},
        _finding_role: "trigger_display",

        draw(ctx, n, ww, y, wh) {
            const trigger = (this.value || "").trim();
            if (!trigger) return;
            ctx.fillStyle = "rgba(80, 130, 70, 0.18)";
            ctx.fillRect(8, y + 2, ww - 16, wh - 4);
            ctx.strokeStyle = "rgba(80, 130, 70, 0.45)";
            ctx.lineWidth = 1;
            ctx.strokeRect(8.5, y + 2.5, ww - 17, wh - 5);

            ctx.fillStyle = "#cce";
            ctx.font = "11px monospace";
            ctx.textBaseline = "middle";
            ctx.textAlign = "left";

            const prefix = "🔑  ";
            const maxWidth = ww - 16 - 12;
            let label = prefix + trigger;
            while (
                ctx.measureText(label + "…").width > maxWidth &&
                label.length > prefix.length + 4
            ) {
                label = label.slice(0, -1);
            }
            if (label !== prefix + trigger) label += "…";
            ctx.fillText(label, 14, y + wh / 2);
        },

        computeSize() {
            const trigger = (this.value || "").trim();
            return trigger ? [0, 22] : [0, -4];
        },

        mouse() { return false; },
    };
    node.widgets.push(widget);
    return widget;
}

function findFindingWidget(node, role) {
    return node.widgets?.find((w) => w._finding_role === role);
}

// =====================================================================
// Splice helpers
// =====================================================================

function moveWidgetBefore(node, widget, beforeName) {
    if (!widget) return;
    const cur = node.widgets.indexOf(widget);
    if (cur >= 0) node.widgets.splice(cur, 1);
    const targetIdx = node.widgets.findIndex((w) => w.name === beforeName);
    if (targetIdx < 0) {
        node.widgets.push(widget);
    } else {
        node.widgets.splice(targetIdx, 0, widget);
    }
}

function moveWidgetAfter(node, widget, afterName) {
    if (!widget) return;
    const cur = node.widgets.indexOf(widget);
    if (cur >= 0) node.widgets.splice(cur, 1);
    const targetIdx = node.widgets.findIndex((w) => w.name === afterName);
    if (targetIdx < 0) {
        node.widgets.push(widget);
    } else {
        node.widgets.splice(targetIdx + 1, 0, widget);
    }
}

// =====================================================================
// Extension registration
// =====================================================================

app.registerExtension({
    name: "FindingLora.UI",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_CLASS) return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = onNodeCreated?.apply(this, arguments);
            const node = this;

            const bookmarkWidget = createBookmarkWidget(node);
            const bookmarkBtn = createBookmarkButton(node);
            const editBtn = createEditTriggerButton(node);
            const triggerWidget = createTriggerWidget(node);
            const loraPicker = createLoraPicker(node);

            // Stash for show/hide based on bookmark state.
            node._finding_edit_btn = editBtn;

            // Force the framework strength_model widget to share the same
            // 30px slot height as our custom widgets. Without this, Vue's
            // strength widget reports its own (different) height and the
            // resulting layout-mismatch produces bottom-aligned text.
            const strengthW = node.widgets.find((w) => w.name === "strength_model");
            if (strengthW) {
                const origCompute = strengthW.computeSize?.bind(strengthW);
                strengthW.computeSize = function (width) {
                    const natural = origCompute ? origCompute(width) : [width, 26];
                    return [natural[0], 30];
                };
            }

            // Final order top-to-bottom:
            //   bookmark picker → lora picker → bookmark button → edit button
            //   → trigger display → strength_model
            //
            // The loraPicker has already taken lora_name's slot inside
            // createLoraPicker, so we anchor the rest of the moves off the
            // name "lora_name". Reverse-of-desired order — each new widget
            // pushes prior ones down by one position.
            moveWidgetBefore(node, bookmarkWidget, "lora_name");
            moveWidgetAfter(node, triggerWidget, "lora_name");
            moveWidgetAfter(node, editBtn, "lora_name");
            moveWidgetAfter(node, bookmarkBtn, "lora_name");

            // Hook the lora_name dropdown so any change refreshes derived UI.
            const lora = node.widgets.find((w) => w.name === "lora_name");
            if (lora) {
                const origCallback = lora.callback;
                lora.callback = function (value) {
                    if (origCallback) origCallback.call(this, value);
                    refreshNodeUI(node);
                };
            }

            // Subscribe to the shared bookmarks cache. Any change anywhere
            // (this node, another node, or a server-side edit) pushes here.
            const unsubscribe = subscribe((bms) => {
                node._finding_bookmarks = bms;
                refreshNodeUI(node);
            });
            // Clean up the subscription when the node is removed from the graph.
            const onRemoved = node.onRemoved;
            node.onRemoved = function () {
                try { unsubscribe(); } catch (e) {}
                if (onRemoved) onRemoved.apply(this, arguments);
            };

            // Kick the lazy load (memoised — only the first call hits the network).
            ensureLoaded();

            // Default to 1.8× the natural width — LoRA filenames are long and
            // the picker bars look cramped at stock width. Saved workflows
            // restore their stored size after onNodeCreated returns, so this
            // only affects newly-dropped nodes.
            const natural = node.computeSize();
            node.setSize([Math.round(natural[0] * 1.8), natural[1]]);
            return result;
        };

        // Migration: align widgets_values length to node.widgets length.
        //
        // Earlier versions of this extension saved a "compact" widgets_values
        // (only entries for serializing widgets — typically [lora_name,
        // strength_model] = length 2). When ComfyUI's load assigns positionally,
        // a 2-entry array against a 6-widget node lands strength_model's value
        // (1.0) on lora_name → backend then sees lora_name="1.0" and reports
        // "not in list". The fix is two-pronged:
        //   (1) all our widgets now serialize naturally so save count = widgets
        //       count, eliminating drift on any future save.
        //   (2) on load, if widgets_values is shorter than widgets, treat it as
        //       the old compact format and place its values onto the data-
        //       carrying widgets (lora_name, strength_model) by name.
        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            if (info && Array.isArray(info.widgets_values) && this.widgets) {
                const compact = info.widgets_values.filter((v) => v !== null);
                if (info.widgets_values.length < this.widgets.length) {
                    // Old compact format. Re-thread values onto named data widgets.
                    const aligned = new Array(this.widgets.length).fill(null);
                    const order = ["lora_name", "strength_model"];
                    order.forEach((name, i) => {
                        if (i >= compact.length) return;
                        const idx = this.widgets.findIndex((w) => w.name === name);
                        if (idx >= 0) aligned[idx] = compact[i];
                    });
                    info.widgets_values = aligned;
                } else {
                    // Already positional (new save). Just strip stray nulls
                    // from any future-frontend artifact.
                    info.widgets_values = info.widgets_values.slice();
                }
            }
            return onConfigure?.apply(this, arguments);
        };
    },
});
