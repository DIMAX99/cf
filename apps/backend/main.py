import os
from dotenv import load_dotenv
import uvicorn

load_dotenv()
# Import the actual app from api/server.py
from api.server import app

if __name__ == "__main__":
    port = int(os.getenv("PORT", 8000))
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=port,
        reload=True,
    )
