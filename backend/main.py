from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from api import api_pdf_extraction, api_save_pdf, api_config
from contextlib import asynccontextmanager

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: Initialize services, database connections
    print("Starting up...")
    yield
    # Shutdown: Clean up resources
    print("Shutting down...")

app = FastAPI(
    title="Your API",
    description="API for Vue + Three.js app",
    version="1.0.0",
    lifespan=lifespan
)

# Configure CORS for local development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:8000", "https://www.chronoslicer.com/", "https://chronoslicerfrontend.vercel.app/"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api_pdf_extraction.router, prefix="/api")
app.include_router(api_save_pdf.router, prefix="/api")
app.include_router(api_config.router, prefix="/api")

@app.get("/")
async def root():
    return {"message": "Welcome to the API"}