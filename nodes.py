"""Finding LoRA — a LoRA loader with bookmarks, trigger words, and fuzzy search.

Solves the "I have 1000 LoRAs and the dropdown is unusable" problem:

- 📖 / 📕 button next to the main dropdown bookmarks the active LoRA. Optionally
  prompts for a trigger word / phrase to associate with it.
- A "Bookmarks" dropdown above the main one lists every bookmarked LoRA.
  Selecting one *sets* the main dropdown. The bookmark and main always agree.
- A 🔍 button opens a fuzzy-search modal across every LoRA in your folder.
- The trigger word for the active bookmark renders on a read-only line below
  the LoRA dropdown and is also emitted as a STRING output for prompt wiring.

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


def _trigger_for(lora_name: str) -> str:
    """Look up the trigger word for ``lora_name``. Empty string if not bookmarked
    or no trigger saved."""
    if not lora_name or lora_name == "None":
        return ""
    with _LOCK:
        bms = _load_bookmarks()
    b = _find_bookmark(bms, lora_name)
    if not b:
        return ""
    return str(b.get("trigger") or "").strip()


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
                "clip": ("CLIP", {"tooltip": "The CLIP model the LoRA will be applied to."}),
                "lora_name": (folder_paths.get_filename_list("loras"), {
                    "tooltip": "The name of the LoRA to load.",
                }),
                "strength_model": ("FLOAT", {
                    "default": 1.0, "min": -100.0, "max": 100.0, "step": 0.01,
                    "tooltip": "How strongly to modify the diffusion model.",
                }),
                "strength_clip": ("FLOAT", {
                    "default": 1.0, "min": -100.0, "max": 100.0, "step": 0.01,
                    "tooltip": "How strongly to modify the CLIP model.",
                }),
            }
        }

    RETURN_TYPES = ("MODEL", "CLIP", "STRING")
    RETURN_NAMES = ("model", "clip", "trigger")
    OUTPUT_TOOLTIPS = (
        "The model with the LoRA applied.",
        "The CLIP model with the LoRA applied.",
        "Trigger word/phrase saved against this LoRA's bookmark, or empty if not bookmarked.",
    )
    FUNCTION = "load_lora"
    CATEGORY = "loaders"
    DESCRIPTION = (
        "LoRA loader with bookmarks, trigger-word storage, and fuzzy search. "
        "Bookmark your favourite LoRAs (📖), recall them via a secondary dropdown, "
        "associate trigger words / phrases that get emitted as a STRING output, "
        "and fuzzy-search across thousands of LoRAs (🔍). Bookmarks persist globally."
    )

    def __init__(self):
        self.loaded_lora = None  # cache last-loaded LoRA state dict (filename, sd)

    def load_lora(self, model, clip, lora_name, strength_model, strength_clip):
        # No-op fast path: zero strengths and no LoRA name → nothing to do.
        if strength_model == 0 and strength_clip == 0:
            return (model, clip, _trigger_for(lora_name))

        lora_path = folder_paths.get_full_path_or_raise("loras", lora_name)
        lora = None
        # Reuse cached state dict if same file.
        if self.loaded_lora is not None:
            cached_name, cached_sd = self.loaded_lora
            if cached_name == lora_path:
                lora = cached_sd
            else:
                self.loaded_lora = None
        if lora is None:
            lora = comfy.utils.load_torch_file(lora_path, safe_load=True)
            self.loaded_lora = (lora_path, lora)

        model_lora, clip_lora = comfy.sd.load_lora_for_models(
            model, clip, lora, strength_model, strength_clip,
        )
        return (model_lora, clip_lora, _trigger_for(lora_name))


NODE_CLASS_MAPPINGS = {
    "LoraLoaderFindingLora": LoraLoaderFindingLora,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "LoraLoaderFindingLora": "LoRA Loader (Finding LoRA)",
}
