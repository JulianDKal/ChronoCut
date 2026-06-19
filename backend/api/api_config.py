"""Serve printer/material profiles.

Printer profiles live as self-contained XML files in backend/printers/ (specs +
material presets). This lists every *.xml there and returns their contents, so
adding a printer is just dropping a new file in that folder — no index needed.
"""

from pathlib import Path
from fastapi import APIRouter

router = APIRouter()

PRINTERS_DIR = Path(__file__).resolve().parent.parent / "printers"


@router.get("/printers")
async def list_printers():
    out = []
    if PRINTERS_DIR.is_dir():
        for f in sorted(PRINTERS_DIR.glob("*.xml")):
            try:
                out.append(f.read_text(encoding="utf-8"))
            except Exception as e:
                print(f"[printers] read {f.name} failed: {e}")
    return {"printers": out}
