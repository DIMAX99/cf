import asyncio
import os
import uuid
from typing import Optional, Dict, Any, Literal, List
from fastapi import FastAPI, Depends, HTTPException, Security, WebSocket, WebSocketDisconnect, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security.api_key import APIKeyHeader
from pydantic import BaseModel, ConfigDict, ValidationError
from pydantic.alias_generators import to_camel

# Import your loaders and writers
from memory.context_loader import load_full_project_context, get_current_config
from memory.context_writer import (
    write_file_context, 
    write_folder_context, 
    write_agent_context, 
    copy_temp_to_version
)
from schemas.context import FileContext, FolderContext, AgentConfig

# --- Configuration & Security ---
# In production, set this via environment variables. For local VS Code dev, a static key is fine.
EXPECTED_API_KEY = os.getenv("CF_API_KEY", "cf-dev-key-123")
API_KEY_NAME = "x-api-key"

api_key_header = APIKeyHeader(name=API_KEY_NAME, auto_error=False)

async def verify_api_key(api_key: str = Security(api_key_header)):
    if api_key != EXPECTED_API_KEY:
        raise HTTPException(status_code=403, detail="Invalid or missing API Key")
    return api_key

# --- API Models ---
class APIBaseModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

class LoadContextRequest(APIBaseModel):
    cf_root: str
    agent_name: Optional[str] = None
    folder_path: Optional[str] = None

class UpdateContextRequest(APIBaseModel):
    cf_root: str
    target_dir: str  # Usually "temp"
    update_type: Literal["file", "folder", "agent", "commit"]
    folder_name: Optional[str] = None  # Needed for file/folder updates
    agent_name: Optional[str] = None   # Needed for agent updates
    new_version: Optional[str] = None  # Needed for commit
    data: Optional[Dict[str, Any]] = None # The actual context payload

class TaskCreateRequest(APIBaseModel):
    cf_root: str
    goal: str
    target_agent: Optional[str] = None

# --- In-Memory Task Database ---
# Maps task_id -> {"status": "pending|running|completed|failed", "result": None, "logs": []}
tasks_db: Dict[str, Dict[str, Any]] = {}
# Maps task_id -> List of active WebSocket connections
task_subscribers: Dict[str, List[WebSocket]] = {}

# --- App Initialization ---
app = FastAPI(title="Context-Forge Backend")

# Allow localhost origins for the VS Code Extension Webview / Node runtime
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], # In strict prod, restrict to specific vs-code webview URIs if needed
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Routes ---

@app.get("/health")
async def health_check():
    """Basic health check to ensure the server is alive."""
    return {"status": "ok", "version": "0.1.0"}


@app.post("/context/load", dependencies=[Depends(verify_api_key)])
async def load_context(req: LoadContextRequest):
    """Loads the merged project context."""
    try:
        # Currently returns the full project context. 
        # You can filter this down using req.agent_name or req.folder_path if needed.
        context = load_full_project_context(req.cf_root)
        if context is None:
            raise HTTPException(status_code=404, detail="Failed to load project context")
        return {"status": "success", "data": context}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/context/update", dependencies=[Depends(verify_api_key)])
async def update_context(req: UpdateContextRequest):
    """Multiplexes context updates to the appropriate writer function."""
    try:
        if req.update_type == "file":
            context_obj = FileContext.model_validate(req.data)
            write_file_context(req.cf_root, req.target_dir, req.folder_name, context_obj)
            
        elif req.update_type == "folder":
            context_obj = FolderContext.model_validate(req.data)
            write_folder_context(req.cf_root, req.target_dir, req.folder_name, context_obj)
            
        elif req.update_type == "agent":
            context_obj = AgentConfig.model_validate(req.data)
            write_agent_context(req.cf_root, req.target_dir, req.agent_name, context_obj)
            
        elif req.update_type == "commit":
            # Uses current.json active version as base, rolls temp/ into new_version
            if not req.new_version:
                raise HTTPException(status_code=400, detail="new_version is required for commit updates")
            current_config = get_current_config(req.cf_root)
            if not current_config:
                raise HTTPException(status_code=400, detail="current.json not found or invalid")
            copy_temp_to_version(req.cf_root, current_config.active_version, req.new_version)
            
        return {"status": "success", "message": f"{req.update_type} context updated"}
    
    except ValidationError as e:
        raise HTTPException(status_code=422, detail=f"Validation error: {str(e)}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# --- Task Coordinator Mock ---

async def run_task_coordinator(task_id: str, goal: str):
    """Background runner that simulates the AI Agent Coordinator."""
    tasks_db[task_id]["status"] = "running"
    
    # Helper to broadcast to all connected WebSockets
    async def broadcast(message: str):
        tasks_db[task_id]["logs"].append(message)
        subs = task_subscribers.get(task_id, [])
        for ws in subs:
            try:
                await ws.send_json({"taskId": task_id, "status": tasks_db[task_id]["status"], "log": message})
            except Exception:
                pass # Client disconnected

    await broadcast(f"Starting analysis for goal: {goal}")
    await asyncio.sleep(1) # Simulate LLM thinking
    
    await broadcast("Loaded context for target files.")
    await asyncio.sleep(2) # Simulate writing/editing
    
    await broadcast("Applying changes to workspace.")
    
    tasks_db[task_id]["status"] = "completed"
    tasks_db[task_id]["result"] = {"files_changed": 2, "summary": "Task finished successfully."}
    await broadcast("Task completed.")


@app.post("/tasks", dependencies=[Depends(verify_api_key)])
async def create_task(req: TaskCreateRequest, background_tasks: BackgroundTasks):
    """Creates a task and kicks off the coordinator in the background."""
    task_id = f"task_{uuid.uuid4().hex[:8]}"
    
    tasks_db[task_id] = {
        "status": "pending",
        "result": None,
        "logs": ["Task created."]
    }
    
    # Run the AI logic in the background so the API responds immediately
    background_tasks.add_task(run_task_coordinator, task_id, req.goal)
    
    return {"taskId": task_id, "status": "pending"}


@app.get("/tasks/{task_id}", dependencies=[Depends(verify_api_key)])
async def get_task(task_id: str):
    """Poll for task status."""
    if task_id not in tasks_db:
        raise HTTPException(status_code=404, detail="Task not found")
    return tasks_db[task_id]


@app.websocket("/tasks/{task_id}/stream")
async def websocket_task_stream(websocket: WebSocket, task_id: str):
    """Streams real-time updates from the running task coordinator."""
    await websocket.accept()
    
    # Basic WebSocket Auth: Expect the first message to be the API key
    auth_msg = await websocket.receive_text()
    if auth_msg != EXPECTED_API_KEY:
        await websocket.close(code=1008, reason="Invalid API Key")
        return

    if task_id not in tasks_db:
        await websocket.close(code=1008, reason="Task not found")
        return

    # Register subscriber
    if task_id not in task_subscribers:
        task_subscribers[task_id] = []
    task_subscribers[task_id].append(websocket)

    try:
        # Catch them up on existing logs
        for log in tasks_db[task_id]["logs"]:
            await websocket.send_json({"taskId": task_id, "status": tasks_db[task_id]["status"], "log": log})
            
        # Keep connection open until client disconnects or task finishes
        while True:
            # We use receive_text to block and keep the connection alive.
            # If the client drops, this raises WebSocketDisconnect
            data = await websocket.receive_text() 
            if data == "ping":
                await websocket.send_text("pong")
                
    except WebSocketDisconnect:
        task_subscribers[task_id].remove(websocket)