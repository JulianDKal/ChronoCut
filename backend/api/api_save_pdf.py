import base64
import pymupdf
from fastapi import APIRouter, Body, HTTPException
from fastapi.responses import FileResponse
from typing import List, Dict, Any
from pathlib import Path

from .api_pdf_extraction import MM_PER_PT

router = APIRouter()

# Default stroke width for cut/engrave lines (the extraction does not capture the
# original widths). Thin so the geometry stays faithful.
STROKE_WIDTH_PT = 0.5


# ── Coordinate helpers ────────────────────────────────────────────────────────
# Inverse of norm_x / norm_y in api_pdf_extraction: viewer mm (origin top-left,
# y negative downward) → PDF/MuPDF points (origin top-left, y positive downward).

def mm_to_pt_x(x_mm: float) -> float:
    return x_mm / MM_PER_PT

def mm_to_pt_y(y_mm: float) -> float:
    return -y_mm / MM_PER_PT

def hex_to_rgb(color: str):
    c = color or "#000000"
    return (int(c[1:3], 16) / 255.0, int(c[3:5], 16) / 255.0, int(c[5:7], 16) / 255.0)


# ── Endpoint ──────────────────────────────────────────────────────────────────

@router.post("/save_pdf")
async def create_pdf_from_json(objects: List[Dict[str, Any]] = Body(...)):
    """Rebuild a PDF from the CURRENT (edited) drawing objects sent by the viewer.

    The body is the same object list produced by /pdf_extraction (l / c / fp / img
    / mbox), but possibly after Fix Colors / Remove Doubles. The output PDF
    reproduces everything the source had — vectors, text outlines and images —
    just corrected.
    """
    if not objects:
        raise HTTPException(status_code=400, detail="No drawing objects provided")

    out_dir = Path("uploads")
    out_dir.mkdir(exist_ok=True)
    output_path = out_dir / "laser_drawing.pdf"

    try:
        build_pdf(objects, output_path)
    except Exception as e:
        print(f"[save_pdf] build failed: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to build PDF: {e}")
    
    response = FileResponse(
        path="your_file.pdf",
        media_type="application/pdf",
        filename="laser_drawing.pdf"
    )
    
    # Explicitly add CORS headers
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "POST, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"

    return response


# ── PDF builder ───────────────────────────────────────────────────────────────

def build_pdf(objects: List[Dict[str, Any]], output_path: Path) -> Path:
    # Page size from the mbox entry (mm → pt); fall back to A4 if absent.
    page_w_pt, page_h_pt = 595.0, 842.0
    for o in objects:
        if o.get("type") == "mbox":
            page_w_pt = mm_to_pt_x(o["w"])
            page_h_pt = mm_to_pt_x(o["h"])   # mbox dims are positive mm
            break

    doc = pymupdf.open()
    page = doc.new_page(width=page_w_pt, height=page_h_pt)

    # Images first (background), then vector geometry on top.
    for o in objects:
        if o.get("type") == "img":
            _insert_image(page, o)

    shape = page.new_shape()
    for o in objects:
        t = o.get("type")
        if t == "fp":
            _draw_fill(shape, o)
        elif t in ("l", "c"):
            _draw_stroke(shape, o)
    shape.commit()

    doc.save(output_path)
    doc.close()
    return output_path


def _draw_stroke(shape, o: Dict[str, Any]):
    color = hex_to_rgb(o.get("color", "#000000"))
    if o["type"] == "l":
        shape.draw_line(
            (mm_to_pt_x(o["x1"]), mm_to_pt_y(o["y1"])),
            (mm_to_pt_x(o["x2"]), mm_to_pt_y(o["y2"])),
        )
    else:  # cubic bezier
        shape.draw_bezier(
            (mm_to_pt_x(o["x1"]), mm_to_pt_y(o["y1"])),
            (mm_to_pt_x(o["x2"]), mm_to_pt_y(o["y2"])),
            (mm_to_pt_x(o["x3"]), mm_to_pt_y(o["y3"])),
            (mm_to_pt_x(o["x4"]), mm_to_pt_y(o["y4"])),
        )
    shape.finish(color=color, width=STROKE_WIDTH_PT, closePath=False)


def _draw_fill(shape, o: Dict[str, Any]):
    """Redraw a filled path (text/shape) from its M/L/C/Z commands and fill it.

    Sub-paths are drawn without connecting strokes (a new 'M' just moves the pen);
    even-odd fill makes holes (letter counters) render regardless of winding.
    """
    fill = hex_to_rgb(o.get("fill", "#000000"))
    cur = None
    drew = False
    for c in o.get("path", []):
        cmd = c.get("cmd")
        if cmd == "M":
            cur = (mm_to_pt_x(c["x"]), mm_to_pt_y(c["y"]))
        elif cmd == "L":
            p = (mm_to_pt_x(c["x"]), mm_to_pt_y(c["y"]))
            if cur is not None:
                shape.draw_line(cur, p)
                drew = True
            cur = p
        elif cmd == "C":
            if cur is not None:
                p = (mm_to_pt_x(c["x"]), mm_to_pt_y(c["y"]))
                shape.draw_bezier(
                    cur,
                    (mm_to_pt_x(c["x1"]), mm_to_pt_y(c["y1"])),
                    (mm_to_pt_x(c["x2"]), mm_to_pt_y(c["y2"])),
                    p,
                )
                drew = True
                cur = p
        # 'Z' is implicit: closePath=True in finish closes each sub-path.
    if drew:
        shape.finish(color=None, fill=fill, even_odd=True, closePath=True)


def _insert_image(page, o: Dict[str, Any]):
    data = o.get("data", "")
    if "," not in data:
        return
    try:
        raw = base64.b64decode(data.split(",", 1)[1])
    except Exception as e:
        print(f"[save_pdf] image decode failed: {e}")
        return
    left = mm_to_pt_x(o["x"])
    top = mm_to_pt_y(o["y"])               # top-left corner
    rect = pymupdf.Rect(left, top, left + mm_to_pt_x(o["w"]), top + mm_to_pt_x(o["h"]))
    try:
        page.insert_image(rect, stream=raw)
    except Exception as e:
        print(f"[save_pdf] insert_image failed: {e}")
