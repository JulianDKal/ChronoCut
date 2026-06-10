import base64
from fastapi import APIRouter, UploadFile, File, HTTPException
from fastapi.responses import JSONResponse
from typing import List, Dict
import pymupdf
import asyncio
from concurrent.futures import ThreadPoolExecutor
import functools
import json
from pathlib import Path
from .utils import rgb_to_hex

router = APIRouter()
executor = ThreadPoolExecutor(max_workers=2)

# 1 PDF/MuPDF point = 25.4/72 mm
MM_PER_PT = 25.4 / 72


# ── Coordinate helpers ────────────────────────────────────────────────────────
# Origin (0,0) = TOP-LEFT corner of the page.
# X → right (positive), Y → down (negative in Three.js y-up space).

def norm_x(x: float) -> float:
    return round(x * MM_PER_PT, 3)

def norm_y(y: float) -> float:
    # MuPDF y=0 at top, increases downward. Negate so Three.js y=0 is top, down = negative.
    return round(-y * MM_PER_PT, 3)

def pt2mm(v: float) -> float:
    return round(v * MM_PER_PT, 3)


# ── Endpoint ──────────────────────────────────────────────────────────────────

@router.post("/pdf_extraction")
async def extract_pdf_lines(file: UploadFile = File(...)):
    """Extract paths and images from a PDF or SVG. Coords in mm, origin top-left.

    Text is converted to filled vector paths automatically (via MuPDF's
    text_as_path SVG export), preserving the original fill colour.
    """
    name = file.filename.lower()
    if name.endswith(".pdf"):
        filetype = "pdf"
    elif name.endswith(".svg"):
        filetype = "svg"
    else:
        raise HTTPException(status_code=400, detail="Only PDF and SVG files are allowed")

    contents = await file.read()
    try:
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(
            executor,
            functools.partial(extract_sync, filetype=filetype),
            contents,
        )
    except Exception as e:
        print(f"Extraction error: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to process file: {e}")

    return JSONResponse(content=result, status_code=200)


# ── Sync extraction (runs in thread pool) ────────────────────────────────────

def extract_sync(file_bytes: bytes, filetype: str = "pdf") -> dict:
    doc = pymupdf.open(stream=file_bytes, filetype=filetype)
    objects: List[Dict] = []
    page_num = 0

    try:
        if not doc:
            return {"success": False, "lines": [], "line_count": 0}

        size = doc[0].mediabox_size
        page_w_pt = size.x or 0.0
        page_h_pt = size.y or 0.0
        objects.append({"type": "mbox", "w": pt2mm(page_w_pt), "h": pt2mm(page_h_pt)})
        print(f"[extract] {filetype} page0 = {page_w_pt:.1f}x{page_h_pt:.1f} pt "
              f"= {pt2mm(page_w_pt):.1f}x{pt2mm(page_h_pt):.1f} mm")

        for page_num in range(len(doc)):
            page = doc[page_num]

            # Vectors + text → convert text to paths via SVG round-trip, then
            # extract all drawings from the SVG (glyphs become filled paths).
            try:
                svg = page.get_svg_image(text_as_path=True)
                svg_page = pymupdf.open(stream=svg.encode("utf-8"), filetype="svg")[0]
                drawings = svg_page.get_drawings()
            except Exception as e:
                print(f"[extract] SVG round-trip failed ({e}); using raw drawings")
                drawings = page.get_drawings()

            print(f"[extract] page {page_num}: {len(drawings)} drawings")
            for drw in drawings:
                if drw.get("fill") is not None:
                    fp = _build_fp(drw)
                    if fp:
                        objects.append(fp)
                if drw.get("color") is not None:
                    _append_strokes(objects, drw)

            # Raster images (engraving bitmaps) — from the ORIGINAL page.
            try:
                for info in page.get_image_info(xrefs=True):
                    entry = _extract_image(page.parent, info)
                    if entry:
                        objects.append(entry)
            except Exception as e:
                print(f"[extract] image extraction failed: {e}")

    finally:
        _save_debug(objects, page_num)
        doc.close()

    fp_count  = sum(1 for o in objects if o["type"] == "fp")
    img_count = sum(1 for o in objects if o["type"] == "img")
    print(f"[extract] total={len(objects)} filled={fp_count} images={img_count}")
    return {"success": True, "line_count": len(objects), "lines": objects}


# ── Filled-path builder ───────────────────────────────────────────────────────

def _build_fp(drw: dict) -> Dict | None:
    """Convert a filled drawing into a 'fp' entry with SVG-style path commands.

    A 'Z' is emitted before every new sub-path so the frontend's ShapePath can
    detect holes (e.g. the counter of 'O', 'g', 'B').
    """
    fill_color = rgb_to_hex(drw.get("fill"))
    if not fill_color:
        return None

    path: List[Dict] = []
    last = None       # (x, y) of last point, raw pt
    open_sub = False

    def move_if_gap(sx: float, sy: float):
        nonlocal last, open_sub
        if last is None or abs(sx - last[0]) > 0.01 or abs(sy - last[1]) > 0.01:
            if open_sub:
                path.append({"cmd": "Z"})
            path.append({"cmd": "M", "x": norm_x(sx), "y": norm_y(sy)})
            open_sub = True

    for item in drw["items"]:
        kind = item[0]
        if kind == "l":
            sx, sy = float(item[1].x), float(item[1].y)
            ex, ey = float(item[2].x), float(item[2].y)
            move_if_gap(sx, sy)
            path.append({"cmd": "L", "x": norm_x(ex), "y": norm_y(ey)})
            last = (ex, ey)
        elif kind == "c":
            sx, sy = float(item[1].x), float(item[1].y)
            move_if_gap(sx, sy)
            path.append({
                "cmd": "C",
                "x1": norm_x(float(item[2].x)), "y1": norm_y(float(item[2].y)),
                "x2": norm_x(float(item[3].x)), "y2": norm_y(float(item[3].y)),
                "x":  norm_x(float(item[4].x)), "y":  norm_y(float(item[4].y)),
            })
            last = (float(item[4].x), float(item[4].y))
        elif kind == "re":
            r = item[1]
            x0, y0, x1, y1 = float(r.x0), float(r.y0), float(r.x1), float(r.y1)
            if open_sub:
                path.append({"cmd": "Z"})
            path.append({"cmd": "M", "x": norm_x(x0), "y": norm_y(y0)})
            path.append({"cmd": "L", "x": norm_x(x1), "y": norm_y(y0)})
            path.append({"cmd": "L", "x": norm_x(x1), "y": norm_y(y1)})
            path.append({"cmd": "L", "x": norm_x(x0), "y": norm_y(y1)})
            path.append({"cmd": "Z"})
            open_sub = False
            last = (x0, y0)

    if open_sub:
        path.append({"cmd": "Z"})
    if not path:
        return None
    return {"type": "fp", "fill": fill_color, "path": path}


# ── Stroke items ──────────────────────────────────────────────────────────────

def _append_strokes(objects: list, drw: dict):
    color = rgb_to_hex(drw["color"])
    for item in drw["items"]:
        kind = item[0]
        if kind == "l":
            s, e = item[1], item[2]
            objects.append({"type": "l",
                            "x1": norm_x(s.x), "y1": norm_y(s.y),
                            "x2": norm_x(e.x), "y2": norm_y(e.y), "color": color})
        elif kind == "re":
            r = item[1]
            x0, y0, x1, y1 = r.x0, r.y0, r.x1, r.y1
            for sx, sy, ex, ey in [(x0,y0,x1,y0),(x1,y0,x1,y1),(x1,y1,x0,y1),(x0,y1,x0,y0)]:
                objects.append({"type": "l",
                                "x1": norm_x(sx), "y1": norm_y(sy),
                                "x2": norm_x(ex), "y2": norm_y(ey), "color": color})
        elif kind == "c":
            objects.append({"type": "c",
                            "x1": norm_x(item[1].x), "y1": norm_y(item[1].y),
                            "x2": norm_x(item[2].x), "y2": norm_y(item[2].y),
                            "x3": norm_x(item[3].x), "y3": norm_y(item[3].y),
                            "x4": norm_x(item[4].x), "y4": norm_y(item[4].y), "color": color})


# ── Embedded image extraction ─────────────────────────────────────────────────

def _extract_image(doc, info: dict) -> Dict | None:
    xref = info.get("xref", 0)
    if not xref:
        return None
    try:
        img = doc.extract_image(xref)
        if not img:
            return None
        x0, y0, x1, y1 = info["bbox"]
        w_mm = abs(x1 - x0) * MM_PER_PT
        h_mm = abs(y1 - y0) * MM_PER_PT
        if w_mm < 0.5 or h_mm < 0.5:
            return None

        ext  = img["ext"]
        mime = {"png": "image/png", "jpeg": "image/jpeg", "jpg": "image/jpeg"}.get(ext, "image/png")
        b64  = base64.b64encode(img["image"]).decode("ascii")
        return {
            "type": "img",
            "x": norm_x(min(x0, x1)),
            "y": norm_y(min(y0, y1)),      # top-left corner
            "w": round(w_mm, 3),
            "h": round(h_mm, 3),
            "colorspace": img.get("colorspace", 3),   # 1 = grayscale, 3 = rgb
            "data": f"data:{mime};base64,{b64}",
        }
    except Exception as e:
        print(f"[extract] image xref={xref} failed: {e}")
        return None


# ── Debug dump (omits base64 image data) ──────────────────────────────────────

def _save_debug(objects: list, page_num: int):
    try:
        p = Path("uploads")
        p.mkdir(exist_ok=True)
        slim = [
            {k: v for k, v in o.items() if k != "data"} if o.get("type") == "img" else o
            for o in objects
        ]
        with open(p / f"page_{page_num}_lines.json", "w") as f:
            json.dump(slim, f, indent=2)
    except Exception as e:
        print(f"[extract] debug dump failed: {e}")
