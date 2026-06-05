"""XHS search service - FastAPI wrapper around Spider_XHS."""

import os
import sys
from typing import List, Optional, Dict, Any
from pathlib import Path
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import xhs_client

app = FastAPI(title="XHS Search Service", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class SearchRequest(BaseModel):
    query: str
    limit: int = 5


class NoteRequest(BaseModel):
    url: str


class SearchResponse(BaseModel):
    success: bool
    notes: List[Dict[str, Any]]
    error: Optional[str] = None


class NoteDetailResponse(BaseModel):
    success: bool
    note: Optional[Dict[str, Any]] = None
    error: Optional[str] = None


class HealthResponse(BaseModel):
    status: str
    cookie_valid: bool


@app.get("/xhs/health")
async def health():
    cookie = os.environ.get("XHS_COOKIE", "")
    return HealthResponse(status="ok", cookie_valid=bool(cookie.strip()))


@app.post("/xhs/search")
async def search(req: SearchRequest):
    try:
        notes = xhs_client.search_notes(req.query, req.limit)
        return SearchResponse(success=True, notes=notes)
    except ConnectionError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except RuntimeError as e:
        if "429" in str(e) or "rate" in str(e).lower():
            raise HTTPException(status_code=429, detail=str(e))
        raise HTTPException(status_code=500, detail=str(e))
    except Exception as e:
        return SearchResponse(success=False, notes=[], error=str(e))


@app.post("/xhs/note")
async def get_note(req: NoteRequest):
    try:
        note = xhs_client.get_note_detail(req.url)
        return NoteDetailResponse(success=True, note=note)
    except Exception as e:
        return NoteDetailResponse(success=False, note=None, error=str(e))


if __name__ == "__main__":
    os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), "spider_xhs"))
    import uvicorn
    port = int(os.environ.get("XHS_PORT", "3220"))
    uvicorn.run(app, host="0.0.0.0", port=port)
