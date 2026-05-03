import os
from dotenv import load_dotenv
import uvicorn
from fastapi import FastAPI

load_dotenv()

app = FastAPI()


@app.get("/")
def read_root():
    """Root endpoint."""
    return {"message": "Welcome to Context Forge API"}


@app.get("/health")
def health_check():
    """Health check endpoint."""
    return {"status": "healthy"}


if __name__ == "__main__":
    port = int(os.getenv("PORT", 8000))
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=port,
        reload=True,
    )
