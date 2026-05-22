from annotated_types import doc
from fastapi import APIRouter, UploadFile, File, HTTPException
from fastapi.responses import JSONResponse
from typing import List, Dict, Any
import pymupdf  # PyMuPDF
import asyncio
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
from .utils import rgb_to_hex

router = APIRouter()

executor = ThreadPoolExecutor(max_workers=2)

min_val = 0
max_val = 0
range_val = 0

@router.post("/pdf_extraction")
async def extract_pdf_lines(
    file: UploadFile = File(...)
):
    """
    Extract all line coordinates from a PDF file.
    Returns JSON with line segments ready for Three.js rendering.
    """
    try:
        # Validate file type
        if not file.filename.lower().endswith('.pdf'):
            raise HTTPException(
                status_code=400, 
                detail="Only PDF files are allowed"
            )
        
        # Read the uploaded file
        contents = await file.read()
        
        loop = asyncio.get_event_loop()
        lines = await loop.run_in_executor(
            executor, 
            extract_lines_sync, 
            contents
        )

        if lines:
            # Find all coordinate values
            all_values = []
            for line in lines:
                if(line['type'] in ['l', 'c', 're']):
                    all_values.extend([line['x1'], line['y1'], line['x2'], line['y2']])
            
            min_val = min(all_values)
            max_val = max(all_values)
            range_val = max_val - min_val
            
            # Scale to fit in -5 to 5
            scale = 10 / range_val if range_val > 0 else 1
            
            # Apply normalization
            for line in lines:
                if(line['type'] in ['l', 'c', 're']):
                    #The additional operation on the y coordinates flips the y-axis, so that the lines are rendered correctly in Three.js
                    line['x1'] = round((line['x1'] - min_val) * scale - 5, 2)
                    line['y1'] = round(((max_val - line['y1'])  - min_val) * scale - 5, 2)
                    line['x2'] = round((line['x2'] - min_val) * scale - 5, 2)
                    line['y2'] = round(((max_val - line['y2']) - min_val) * scale - 5, 2)
                    #If it's a curve, also normalize the additional points
                    if(line['type'] == 'c'):
                        line['x3'] = round((line['x3'] - min_val) * scale - 5, 2)
                        line['y3'] = round(((max_val - line['y3']) - min_val) * scale - 5, 2)
                        line['x4'] = round((line['x4'] - min_val) * scale - 5, 2)
                        line['y4'] = round(((max_val - line['y4']) - min_val) * scale - 5, 2)
        # Return standard JSON response
        return JSONResponse(
            content={
                "success": True,
                "message": f"Successfully extracted {len(lines)} line segments",
                "filename": file.filename,
                "line_count": len(lines),
                "lines": lines 
            },
            status_code=200
        )
        
    except HTTPException:
        raise
    except Exception as e:
        print(f"PDF extraction error: {str(e)}")
        raise HTTPException(
            status_code=500,
            detail=f"Failed to process PDF: {str(e)}"
        )

#TODO maybe make it so that min, max and normalization is done here already, so we don't need to process the data again
def extract_lines_sync(file_bytes: bytes) -> List[Dict[str, float]]:
    """Synchronous PDF extraction function (CPU-bound)"""
    all_lines = []
    
    # Open PDF from memory
    doc = pymupdf.open(stream=file_bytes, filetype="pdf")
    print("mediabox size:", doc[0].mediabox_size)
    
    try:
        try:
            if len(doc) > 0:
                page0 = doc[0]
                # Check if mediabox_size exists and has valid values
                if hasattr(page0, 'mediabox_size') and page0.mediabox_size:
                    size = page0.mediabox_size
                    all_lines.append({
                        "type": "mbox",
                        "w": float(size.x) if size.x is not None else 0,
                        "h": float(size.y) if size.y is not None else 0
                    })
                    print(f"Added mediabox: w={size.x}, h={size.y}")
                else:
                    print("mediabox_size not available")
        except Exception as e:
            print(f"Error adding mediabox info: {e}")   

        for page_num in range(len(doc)):
            page = doc[page_num]
            drawings = page.get_drawings()
            
            for drawing in drawings:
                line_color = rgb_to_hex(drawing['color'])
                # print(line_color)
                for item in drawing['items']:
                    #For now, we only process the line segments
                    if item[0] == 'l':  # Line segment
                        start, end = item[1], item[2]
                        
                        all_lines.append({
                            "type": "l",
                            "x1": float(start.x),
                            "y1": float(start.y),
                            "x2": float(end.x),
                            "y2": float(end.y),
                            "color": line_color
                        })
                    elif item[0] == 're':  # Rectangle -> 4 lines
                        rect = item[1]
                        x0, y0, x1, y1 = rect.x0, rect.y0, rect.x1, rect.y1
                        all_lines.extend([
                            {"type": "l", "x1": x0, "y1": y0, "x2": x1, "y2": y0, "color": line_color},
                            {"type": "l", "x1": x1, "y1": y0, "x2": x1, "y2": y1, "color": line_color},
                            {"type": "l", "x1": x1, "y1": y1, "x2": x0, "y2": y1, "color": line_color},
                            {"type": "l", "x1": x0, "y1": y1, "x2": x0, "y2": y0, "color": line_color},
                        ])
                    #cubic bezier curve
                    elif item[0] == 'c':
                        all_lines.append({
                            "type": "c",
                            "x1": float(item[1].x),
                            "y1": float(item[1].y),
                            "x2": float(item[2].x),
                            "y2": float(item[2].y),
                            "x3": float(item[3].x),
                            "y3": float(item[3].y),
                            "x4": float(item[4].x),
                            "y4": float(item[4].y),
                            "color": line_color
                        })                        
    finally:
        #Write the extracted lines to a JSON file for debugging
        file_path = Path("uploads")
        if(not file_path.exists()):
            file_path.mkdir(parents=True)
        #Write the extracted lines to a JSON file for debugging
        with open(f"./uploads/page_{page_num}_lines.json", "w") as f:
            json.dump(all_lines, f, indent=2)
        doc.close()
    
    return all_lines

