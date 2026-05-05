import asyncio
import os
import uuid
import logging
from typing import Optional, Dict, Any, Literal, List
from collections import defaultdict
from fastapi import FastAPI, Depends, HTTPException, Security, WebSocket, WebSocketDisconnect, BackgroundTasks, Query
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
from agents.save_coordinator import run_save_coordinator

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)

# --- Configuration & Security ---
# In production, set this via environment variables. For local VS Code dev, a static key is fine.
EXPECTED_API_KEY = os.getenv("CF_API_KEY", "EWvril6fTbdIJNaVcvgraOK8bT3qBgJ7")
API_KEY_NAME = "X-API-Key"

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


class SaveChangesPayload(APIBaseModel):
    """Payload for save changes request from frontend"""
    type: str  # "save_changes"
    cfRoot: str  # Absolute path to .contextforge from user's workspace
    version: str
    previousVersion: str
    changes: Dict[str, Any]  # {added[], removed[], modified[]}
    files: list  # [{path, content, language, size}]

# --- In-Memory Task Database ---
# Maps task_id -> {"status": "pending|running|completed|failed", "result": None, "logs": [], "error": None}
tasks_db: Dict[str, Dict[str, Any]] = {}
# Maps task_id -> List of asyncio queues for WebSocket subscribers
task_subscribers: Dict[str, List[asyncio.Queue]] = {}

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

# --- Task Coordinator ---

async def run_save_task(task_id: str, payload: SaveChangesPayload):
    """Background runner that executes the save coordinator workflow"""
    
    def broadcast_message(step: str, message: str, status: str = "progress"):
        """Add message to task logs"""
        log_entry = {
            "step": step,
            "message": message,
            "status": status,
        }
        tasks_db[task_id]["logs"].append(log_entry)
        logger.info(f"[{task_id}] {step}: {message}")
        
        # Broadcast to WebSocket subscribers
        subs = task_subscribers.get(task_id, [])
        for ws_queue in subs:
            try:
                ws_queue.put_nowait(log_entry)
            except:
                pass  # Queue full or closed
    
    try:
        tasks_db[task_id]["status"] = "running"
        broadcast_message("init", "Starting save operation")
        
        # Build diff from payload
        diff = {
            "added": payload.changes.get("added", []),
            "removed": payload.changes.get("removed", []),
            "modified": payload.changes.get("modified", []),
        }
        
        # Build file contents dict
        file_contents = {}
        for file_obj in payload.files:
            file_contents[file_obj["path"]] = file_obj["content"]
        
        broadcast_message("setup", f"Prepared {len(file_contents)} files")
        
        # Get CF root from payload (sent by frontend from user's workspace)
        cf_root = payload.cfRoot
        if not cf_root:
            raise ValueError("cfRoot not provided in payload")
        
        logger.info(f"Using CF root: {cf_root}")
        
        # Run save coordinator
        logger.info(f"Starting save_coordinator for task {task_id}")
        broadcast_message("coordinator", "Running save coordinator")
        
        result = await run_save_coordinator(
            cf_root=cf_root,
            version=payload.version,
            previous_version=payload.previousVersion,
            diff=diff,
            changed_file_contents=file_contents,
        )
        
        # Store result
        tasks_db[task_id]["result"] = result.get("summary")
        tasks_db[task_id]["status"] = result.get("status", "completed")
        
        if result.get("errors"):
            broadcast_message(
                "summary",
                f"Completed with {len(result['errors'])} errors",
                "warning"
            )
        else:
            broadcast_message(
                "summary",
                f"✨ Successfully saved {payload.version}",
                "success"
            )
        
        logger.info(f"Task {task_id} completed with status: {tasks_db[task_id]['status']}")
    
    except Exception as e:
        logger.error(f"Task {task_id} failed: {str(e)}", exc_info=True)
        tasks_db[task_id]["status"] = "failed"
        tasks_db[task_id]["error"] = str(e)
        broadcast_message("error", str(e), "error")


@app.post("/tasks")
async def create_task(payload: SaveChangesPayload):
    """
    Create a new save task
    
    Expected payload:
    {
      "type": "save_changes",
      "cfRoot": "/absolute/path/to/.contextforge",
      "version": "v2",
      "previousVersion": "v1",
      "changes": {"added": [...], "removed": [...], "modified": [...]},
      "files": [{"path": "...", "content": "...", "language": "...", "size": ...}]
    }
    """
    try:
        logger.info(f"Received save_changes request: {payload.version}")
        
        # Create task
        task_id = f"task_{uuid.uuid4().hex[:12]}"
        tasks_db[task_id] = {
            "status": "pending",
            "result": None,
            "logs": [],
            "error": None
        }
        task_subscribers[task_id] = []
        
        # Start background task
        asyncio.create_task(run_save_task(task_id, payload))
        
        return {
            "taskId": task_id,
            "status": "pending"
        }
    
    except Exception as e:
        logger.error(f"Error creating task: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/tasks/{task_id}", dependencies=[Depends(verify_api_key)])
async def get_task(task_id: str):
    """Poll for task status."""
    if task_id not in tasks_db:
        raise HTTPException(status_code=404, detail="Task not found")
    return tasks_db[task_id]


@app.websocket("/ws/tasks/{task_id}")
async def websocket_task_stream(websocket: WebSocket, task_id: str, api_key: str = Query(...)):
    """
    WebSocket endpoint to stream task progress
    
    Client connects: ws://localhost:8000/ws/tasks/{taskId}?api_key={key}
    Receives: {step, message, status} messages in real-time
    """
    # Verify API key
    if api_key != EXPECTED_API_KEY:
        await websocket.close(code=4001, reason="Unauthorized")
        return
    
    # Check task exists
    if task_id not in tasks_db:
        await websocket.close(code=4004, reason="Task not found")
        return
    
    try:
        await websocket.accept()
        logger.info(f"WebSocket connected for task {task_id}")
        
        # Send existing messages
        for msg in tasks_db[task_id]["logs"]:
            await websocket.send_json(msg)
        
        # Create message queue for this connection
        message_queue: asyncio.Queue = asyncio.Queue()
        task_subscribers[task_id].append(message_queue)
        
        try:
            # Stream new messages as they arrive
            while tasks_db[task_id]["status"] in ["pending", "running"]:
                try:
                    msg = message_queue.get_nowait()
                    await websocket.send_json(msg)
                except asyncio.QueueEmpty:
                    await asyncio.sleep(0.1)
            
            # Send final status
            await websocket.send_json({
                "step": "completed",
                "message": f"Task {tasks_db[task_id]['status']}",
                "status": tasks_db[task_id]["status"],
            })
        
        finally:
            # Clean up subscription
            if message_queue in task_subscribers[task_id]:
                task_subscribers[task_id].remove(message_queue)
    
    except WebSocketDisconnect:
        logger.info(f"WebSocket disconnected for task {task_id}")
    except Exception as e:
        logger.error(f"WebSocket error for task {task_id}: {str(e)}")
        try:
            await websocket.close(code=1011, reason=str(e))
        except:
            pass