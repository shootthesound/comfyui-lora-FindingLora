"""Finding LoRA — a model-only LoRA loader with bookmarks, trigger words, and fuzzy search.

Solves the "I have 1000 LoRAs and the dropdown is unusable" problem:

- 📖 / 📕 button next to the main dropdown bookmarks the active LoRA. Optionally
  prompts for a trigger word / phrase to associate with it.
- A "Bookmarks" dropdown above the main one lists every bookmarked LoRA.
  Selecting one *sets* the main dropdown. The bookmark and main always agree.
- A 🔍 button opens a fuzzy-search modal across every LoRA in your folder.
- The trigger word for the active bookmark renders on a read-only line below
  the LoRA dropdown and is also emitted as a STRING output for prompt wiring.
- A LoRA stack: up to 10 additional LoRAs, each with its own strength and
  picker, applied on top of the main one. Serialised as a single JSON string
  in the ``lora_stack`` input.

Bookmarks persist globally in ``<ComfyUI>/user/finding-lora/bookmarks.json`` —
shared across every workflow you ever open. Routes are namespaced under
``/finding-lora/`` to avoid clashing with other custom-node packs.
"""

from __future__ import annotations

import json
import os
import threading
from typing import Optional

import folder_paths

import comfy.sd
import comfy.utils

try:
    from server import PromptServer
    _HAS_SERVER = True
except ImportError:
    _HAS_SERVER = False


# --- Bookmark storage ------------------------------------------------

_LOCK = threading.Lock()


def _bookmarks_path() -> str:
    """Path to the global bookmarks JSON. Created on demand."""
    base = os.path.join(folder_paths.get_user_directory(), "finding-lora")
    os.makedirs(base, exist_ok=True)
    return os.path.join(base, "bookmarks.json")


def _load_bookmarks() -> list:
    """Return a list of bookmark records: ``[{lora_name, trigger}, ...]``."""
    path = _bookmarks_path()
    if not os.path.exists(path):
        return []
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError):
        return []
    if isinstance(data, dict) and "bookmarks" in data:
        return list(data["bookmarks"])
    if isinstance(data, list):
        return data
    return []


def _save_bookmarks(bookmarks: list) -> None:
    path = _bookmarks_path()
    payload = {"bookmarks": bookmarks, "version": 1}
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
    os.replace(tmp, path)


def _find_bookmark(bookmarks: list, lora_name: str) -> Optional[dict]:
    for b in bookmarks:
        if isinstance(b, dict) and b.get("lora_name") == lora_name:
            return b
    return None


def _triggers_for(lora_names: list) -> str:
    """Collect trigger words for every name in ``lora_names`` (in order),
    joined with ", ". Names that aren't bookmarked or have no trigger are
    skipped; duplicates are emitted once."""
    with _LOCK:
        bms = _load_bookmarks()
    parts = []
    for name in lora_names:
        if not name or name == "None":
            continue
        b = _find_bookmark(bms, name)
        trigger = str((b or {}).get("trigger") or "").strip()
        if trigger and trigger not in parts:
            parts.append(trigger)
    return ", ".join(parts)


MAX_STACK = 10


def _parse_stack(raw) -> list:
    """Parse the ``lora_stack`` JSON string into ``[(lora_name, strength), ...]``.

    The frontend serialises the stack widget as a JSON array of
    ``{lora_name, strength}`` records. Anything malformed (old workflows
    load ``null`` into the slot, hand-edited JSON, etc.) degrades to an
    empty stack rather than erroring the run.
    """
    if not raw or not isinstance(raw, str):
        return []
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return []
    if not isinstance(data, list):
        return []
    out = []
    for entry in data[:MAX_STACK]:
        if not isinstance(entry, dict):
            continue
        name = entry.get("lora_name")
        if not name or not isinstance(name, str):
            continue
        try:
            strength = float(entry.get("strength", 1.0))
        except (TypeError, ValueError):
            strength = 1.0
        out.append((name, strength))
    return out


# --- LoRA set storage ------------------------------------------------
#
# A "set" is a saved snapshot of a node's full LoRA config: the main
# lora_name + strength_model plus the whole stack. Stored beside the
# bookmarks so users can back up / bulk-edit the same way.


def _sets_path() -> str:
    base = os.path.join(folder_paths.get_user_directory(), "finding-lora")
    os.makedirs(base, exist_ok=True)
    return os.path.join(base, "lora-sets.json")


def _load_sets() -> list:
    """Return a list of set records:
    ``[{name, lora_name, strength_model, stack: [{lora_name, strength}, ...]}, ...]``."""
    path = _sets_path()
    if not os.path.exists(path):
        return []
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError):
        return []
    if isinstance(data, dict) and "sets" in data:
        return list(data["sets"])
    return []


def _save_sets(sets: list) -> None:
    path = _sets_path()
    payload = {"sets": sets, "version": 1}
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
    os.replace(tmp, path)


def _sanitize_stack_records(raw) -> list:
    """Coerce a client-supplied stack array into well-formed records."""
    out = []
    if isinstance(raw, list):
        for entry in raw[:MAX_STACK]:
            if not isinstance(entry, dict):
                continue
            name = entry.get("lora_name")
            if not name or not isinstance(name, str):
                continue
            try:
                strength = float(entry.get("strength", 1.0))
            except (TypeError, ValueError):
                strength = 1.0
            out.append({"lora_name": name, "strength": strength})
    return out


# --- HTTP routes -----------------------------------------------------

if _HAS_SERVER:
    from aiohttp import web

    routes = PromptServer.instance.routes

    @routes.get("/finding-lora/list")
    async def _list_bookmarks(request):
        with _LOCK:
            bms = _load_bookmarks()
        return web.json_response({"bookmarks": bms})

    @routes.post("/finding-lora/add")
    async def _add_bookmark(request):
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "invalid JSON"}, status=400)
        lora_name = (data or {}).get("lora_name", "").strip()
        trigger = (data or {}).get("trigger", "")
        if not lora_name:
            return web.json_response({"error": "lora_name required"}, status=400)
        with _LOCK:
            bms = _load_bookmarks()
            existing = _find_bookmark(bms, lora_name)
            if existing:
                existing["trigger"] = str(trigger or "")
            else:
                bms.append({"lora_name": lora_name, "trigger": str(trigger or "")})
            _save_bookmarks(bms)
        return web.json_response({"ok": True, "bookmarks": bms})

    @routes.post("/finding-lora/remove")
    async def _remove_bookmark(request):
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "invalid JSON"}, status=400)
        lora_name = (data or {}).get("lora_name", "").strip()
        if not lora_name:
            return web.json_response({"error": "lora_name required"}, status=400)
        with _LOCK:
            bms = _load_bookmarks()
            bms = [b for b in bms if not (isinstance(b, dict) and b.get("lora_name") == lora_name)]
            _save_bookmarks(bms)
        return web.json_response({"ok": True, "bookmarks": bms})

    @routes.get("/finding-lora/sets/list")
    async def _list_sets(request):
        with _LOCK:
            sets = _load_sets()
        return web.json_response({"sets": sets})

    @routes.post("/finding-lora/sets/save")
    async def _save_set(request):
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "invalid JSON"}, status=400)
        data = data or {}
        name = str(data.get("name") or "").strip()
        if not name:
            return web.json_response({"error": "name required"}, status=400)
        try:
            strength = float(data.get("strength_model", 1.0))
        except (TypeError, ValueError):
            strength = 1.0
        record = {
            "name": name,
            "lora_name": str(data.get("lora_name") or ""),
            "strength_model": strength,
            "stack": _sanitize_stack_records(data.get("stack")),
        }
        with _LOCK:
            sets = _load_sets()
            # Upsert by name — saving under an existing name overwrites it.
            sets = [s for s in sets if not (isinstance(s, dict) and s.get("name") == name)]
            sets.append(record)
            _save_sets(sets)
        return web.json_response({"ok": True, "sets": sets})

    @routes.post("/finding-lora/sets/remove")
    async def _remove_set(request):
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "invalid JSON"}, status=400)
        name = str((data or {}).get("name") or "").strip()
        if not name:
            return web.json_response({"error": "name required"}, status=400)
        with _LOCK:
            sets = _load_sets()
            sets = [s for s in sets if not (isinstance(s, dict) and s.get("name") == name)]
            _save_sets(sets)
        return web.json_response({"ok": True, "sets": sets})


# --- The node --------------------------------------------------------

class LoraLoaderFindingLora:
    """LoRA loader with bookmarks, trigger words, and fuzzy search.

    Drop-in replacement for the stock LoraLoader — same MODEL/CLIP loading
    semantics — plus a STRING output that emits the trigger word saved against
    the active bookmark (or empty string if none).
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL", {"tooltip": "The diffusion model the LoRA will be applied to."}),
                "lora_name": (folder_paths.get_filename_list("loras"), {
                    "tooltip": "The name of the LoRA to load.",
                }),
                "strength_model": ("FLOAT", {
                    "default": 1.0, "min": -100.0, "max": 100.0, "step": 0.01,
                    "tooltip": "How strongly to modify the diffusion model.",
                }),
            },
            "optional": {
                "lora_stack": ("STRING", {
                    "default": "[]",
                    "tooltip": "Up to 10 additional LoRAs applied on top of the main one, "
                               "each with its own strength. Managed by the stack rows on the "
                               "node face; stored as JSON.",
                }),
            },
        }

    RETURN_TYPES = ("MODEL", "STRING")
    RETURN_NAMES = ("model", "trigger")
    OUTPUT_TOOLTIPS = (
        "The model with all LoRAs (main + stack) applied.",
        "Trigger words/phrases saved against the bookmarks of the applied LoRAs "
        "(main + stack), comma-joined. Empty if none are bookmarked.",
    )
    FUNCTION = "load_lora"
    CATEGORY = "loaders"
    DESCRIPTION = (
        "Model-only LoRA loader with bookmarks, trigger-word storage, and fuzzy search. "
        "Bookmark your favourite LoRAs (📖), recall them via a secondary dropdown, "
        "associate trigger words / phrases that get emitted as a STRING output, "
        "fuzzy-search across thousands of LoRAs (🔍), and stack up to 10 more LoRAs "
        "with per-LoRA strengths (➕). Bookmarks persist globally."
    )

    def __init__(self):
        self._lora_cache = {}  # path -> loaded state dict, for every LoRA this node applies

    def load_lora(self, model, lora_name, strength_model, lora_stack="[]"):
        stack = _parse_stack(lora_stack)
        all_names = [lora_name] + [name for name, _ in stack]

        used_paths = set()
        for name, strength in [(lora_name, strength_model)] + stack:
            if strength == 0 or not name or name == "None":
                continue
            lora_path = folder_paths.get_full_path_or_raise("loras", name)
            used_paths.add(lora_path)
            lora = self._lora_cache.get(lora_path)
            if lora is None:
                lora = comfy.utils.load_torch_file(lora_path, safe_load=True)
                self._lora_cache[lora_path] = lora
            model, _ = comfy.sd.load_lora_for_models(
                model, None, lora, strength, 0,
            )

        # Evict cached state dicts this node no longer references.
        self._lora_cache = {p: sd for p, sd in self._lora_cache.items() if p in used_paths}

        return (model, _triggers_for(all_names))


NODE_CLASS_MAPPINGS = {
    "LoraLoaderFindingLora": LoraLoaderFindingLora,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "LoraLoaderFindingLora": "LoRA Loader (Finding LoRA)",
}
