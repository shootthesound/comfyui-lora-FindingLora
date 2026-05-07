// Finding LoRA — UI extension for the LoraLoaderFindingLora node.
//
// Adds:
// - Bookmark dropdown (above lora_name) — selecting a bookmark sets lora_name.
// - Toolbar row (📖 / ✏️ / 🔍) — bookmark toggle, edit trigger, fuzzy search.
// - Trigger word display (below toolbar) — shows active bookmark's trigger.
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
    let qi = 0;
    let score = 0;
    let consecutive = 0;
    let prevMatch = -2;

    for (let ti = 0; ti < t.length && qi < q.length; ti++) {
        if (t[ti] === q[qi]) {
            let bonus = 10;
            // Consecutive-match bonus accumulates (fzf "gap penalty / consecutive bonus" idea).
            if (ti === prevMatch + 1) {
                consecutive += 5;
                bonus += consecutive;
            } else {
                consecutive = 0;
            }
            // Word-boundary bonus: match at start of a token (after _, -, ., /, \, space).
            const isWordStart = ti === 0 || /[\s_\-./\\]/.test(t[ti - 1]);
            if (isWordStart) bonus += 15;
            // Camel-case word-start bonus.
            if (ti > 0 && /[a-z]/.test(t[ti - 1]) && /[A-Z]/.test(target[ti])) bonus += 10;
            score += bonus;
            prevMatch = ti;
            qi++;
        }
    }

    if (qi < q.length) return -1; // not all query chars matched
    score -= t.length * 0.1; // gentle length penalty so shorter wins on ties
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
// Search modal (plain DOM)
// =====================================================================

function showSearchModal(allLoras, currentLora, onSelect) {
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
    header.textContent = "🔍  Find a LoRA";

    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Type to fuzzy-search… (out-of-order chars OK, case-insensitive, ↑/↓ + Enter)";
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

    const choose = (loraName) => {
        close();
        if (loraName) onSelect(loraName);
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
        currentResults = fuzzySearch(q, allLoras).slice(0, 200);
        selectedIdx = 0;
        results.innerHTML = "";

        if (currentResults.length === 0) {
            const empty = document.createElement("div");
            empty.style.cssText = "padding: 24px; color: #888; text-align: center;";
            empty.textContent = "No matches";
            results.appendChild(empty);
            status.textContent = "0 matches";
            return;
        }

        currentResults.forEach((r, i) => {
            const row = document.createElement("div");
            row.style.cssText = `
                padding: 6px 12px; cursor: pointer; user-select: none;
                ${r.target === currentLora ? "color: #4af;" : ""}
            `;
            row.textContent = r.target;
            row.addEventListener("click", () => choose(r.target));
            row.addEventListener("mouseenter", () => {
                selectedIdx = i;
                updateHighlight();
            });
            results.appendChild(row);
        });

        status.textContent =
            `${currentResults.length} match${currentResults.length === 1 ? "" : "es"}` +
            (currentResults.length === 200 ? " (top 200 shown — refine query)" : "");
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

function setEditButtonVisibility(node) {
    // Splice the ✏️ button in/out of node.widgets based on whether the active
    // LoRA is bookmarked. Safe wrt serialization because the button widget is
    // non-serializing — saved workflows only carry lora_name + strength_model
    // regardless of the button's current presence.
    const btn = node._finding_edit_btn;
    if (!btn) return;
    const active = findActiveBookmark(node);
    const idx = node.widgets.indexOf(btn);

    if (active && idx < 0) {
        const bookmarkBtnIdx = node.widgets.findIndex((w) => w._finding_role === "bookmark_btn");
        const insertAt = bookmarkBtnIdx >= 0 ? bookmarkBtnIdx + 1 : node.widgets.length;
        node.widgets.splice(insertAt, 0, btn);
    } else if (!active && idx >= 0) {
        node.widgets.splice(idx, 1);
    }
}

function refreshNodeUI(node) {
    const active = findActiveBookmark(node);

    // Bookmark dropdown — values + selected. Looked up by role so a future
    // rename of the displayed label doesn't break this.
    const bmw = findFindingWidget(node, "bookmark_combo")
        || node.widgets?.find((w) => w.name === "Bookmarks");
    if (bmw) {
        const names = ["(none)", ...((node._finding_bookmarks || []).map((b) => b.lora_name))];
        bmw.options = bmw.options || {};
        bmw.options.values = names;
        bmw.value = active ? active.lora_name : "(none)";
    }

    // Bookmark toggle button — flip 📖 / 📕 based on whether active LoRA is bookmarked.
    const btn = findFindingWidget(node, "bookmark_btn");
    if (btn) {
        btn.name = active ? "📕 Remove bookmark" : "📖 Bookmark this LoRA";
    }

    // Edit trigger button — only visible when the active LoRA is bookmarked.
    setEditButtonVisibility(node);

    // Trigger display.
    const tw = findFindingWidget(node, "trigger_display");
    if (tw) {
        tw.value = active && active.trigger ? active.trigger : "";
    }

    node.setSize(node.computeSize());
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
    // Friendly display name — ComfyUI renders this as the dropdown label.
    const w = node.addWidget(
        "combo",
        "Bookmarks",
        "(none)",
        (value) => {
            if (value && value !== "(none)") {
                setCurrentLoraName(node, value);
                refreshNodeUI(node);
            }
        },
        { values: ["(none)"] }
    );
    w._finding_role = "bookmark_combo";
    w.serialize = false;
    w.options = w.options || { values: ["(none)"] };
    w.options.serialize = false;
    w.serializeValue = () => undefined;
    return w;
}

function createBookmarkButton(node) {
    // 📖/📕 toggle — relabels itself based on whether the active LoRA is
    // bookmarked. refreshNodeUI() updates `widget.name` (displayed label) on
    // each state change.
    const w = node.addWidget("button", "📖 Bookmark this LoRA", null, () => {
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
    // Stable internal property so refreshNodeUI can find this widget even
    // after we've relabeled `name`.
    w._finding_role = "bookmark_btn";
    w.serialize = false;
    w.options = w.options || {};
    w.options.serialize = false;
    w.serializeValue = () => undefined;
    return w;
}

function createEditTriggerButton(node) {
    // Only visible when the active LoRA is bookmarked — see
    // setEditButtonVisibility(). So we can assume an active bookmark on click.
    const w = node.addWidget("button", "✏️ Edit Trigger Word", null, () => {
        const cur = getCurrentLoraName(node);
        const active = findActiveBookmark(node);
        if (!active) return; // belt-and-braces; UI shouldn't allow this
        const seed = active.trigger || "";
        const trigger = window.prompt(`Trigger word / phrase for "${cur}":`, seed);
        if (trigger === null) return;
        addBookmark(cur, trigger.trim());
    });
    w._finding_role = "edit_btn";
    w.serialize = false;
    w.options = w.options || {};
    w.options.serialize = false;
    w.serializeValue = () => undefined;
    return w;
}

function createSearchButton(node) {
    const w = node.addWidget("button", "🔍 Find a LoRA…", null, () => {
        const cur = getCurrentLoraName(node);
        const loraWidget = node.widgets.find((x) => x.name === "lora_name");
        const allLoras = (loraWidget?.options?.values) || [];
        showSearchModal(allLoras, cur, (selected) => {
            setCurrentLoraName(node, selected);
            refreshNodeUI(node);
        });
    });
    w._finding_role = "search_btn";
    w.serialize = false;
    w.options = w.options || {};
    w.options.serialize = false;
    w.serializeValue = () => undefined;
    return w;
}

function createTriggerWidget(node) {
    // Hand-rolled widget pushed directly to node.widgets — gets no framework
    // label. Hides itself (computeSize → [0, -4]) when no trigger is set.
    const widget = {
        type: "FINDING_LORA_TRIGGER_DISPLAY",
        name: "_finding_trigger",
        value: "",
        options: { serialize: false },
        serialize: false,
        serializeValue: () => undefined,
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
            const searchBtn = createSearchButton(node);
            const triggerWidget = createTriggerWidget(node);

            // Stash for show/hide based on bookmark state.
            node._finding_edit_btn = editBtn;

            // Order: bookmarks combo → lora_name → bookmark btn → edit btn →
            // search btn → trigger display → strength widgets.
            moveWidgetBefore(node, bookmarkWidget, "lora_name");
            // Splice in reverse-of-desired order using "moveWidgetAfter lora_name"
            // so each new widget pushes prior ones down by one slot.
            moveWidgetAfter(node, triggerWidget, "lora_name");
            moveWidgetAfter(node, searchBtn, "lora_name");
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

            node.setSize(node.computeSize());
            return result;
        };

        // Defensive: strip any null entries from widgets_values during workflow load.
        // None of our injected widgets serialize, but workflows from ancient versions
        // of this code (none yet, but for future-proofing) might include them.
        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            if (info && Array.isArray(info.widgets_values)) {
                info.widgets_values = info.widgets_values.filter((v) => v !== null);
            }
            return onConfigure?.apply(this, arguments);
        };
    },
});
