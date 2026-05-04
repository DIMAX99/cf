import json
import logging
import os
import shutil
import asyncio
from typing import TypedDict, Optional, List, Dict, Any
from datetime import datetime
from pathlib import Path

from langgraph.graph import StateGraph, END
from pydantic import BaseModel

from schemas.context import FileContext, FunctionSignature
from context_update_agent import run_context_update
from memory.context_writer import write_file_context, write_snapshot_metadata

logger = logging.getLogger(__name__)


class SaveCoordinatorState(TypedDict):
    """State for the save workflow coordinator"""
    cf_root: str  # Path to .contextforge root
    version: str  # New version being created (e.g., "v2")
    previous_version: str  # Previous version (e.g., "v1")
    diff: Dict[str, Any]  # {added[], removed[], modified[]} from DiffService
    changed_file_contents: Dict[str, str]  # {filepath: content} of changed files
    agent_contexts: Dict[str, Optional[FileContext]]  # Current contexts for each file
    updated_contexts: Dict[str, FileContext]  # LLM-updated contexts
    new_version_path: str  # Full path to new version directory
    status: str  # "pending" | "running" | "completed" | "failed"
    summary: Optional[Dict[str, Any]]  # User-facing summary
    errors: List[str]  # Accumulated errors


def _get_version_number(version_str: str) -> int:
    """Extract version number from 'vN' format"""
    return int(version_str.lstrip('v'))


def _increment_version(current_version: str) -> str:
    """Increment version: v1 -> v2"""
    num = _get_version_number(current_version)
    return f"v{num + 1}"


async def load_relevant_agents(state: SaveCoordinatorState) -> SaveCoordinatorState:
    """
    Node 1: Load current context for all changed files
    Maps changed files to their FileContext objects from previous version
    """
    logger.info(f"Loading agent contexts for {state['version']}")
    
    try:
        cf_root = state["cf_root"]
        prev_version = state["previous_version"]
        diff = state["diff"]
        
        # Collect all changed files
        changed_files = set()
        changed_files.update(diff.get("added", []))
        changed_files.update(diff.get("removed", []))
        changed_files.update(diff.get("modified", []))
        
        # Load existing context for each file
        agent_contexts = {}
        for file_path in changed_files:
            try:
                context_path = Path(cf_root) / prev_version / "code" / f"{file_path}.json"
                if context_path.exists():
                    with open(context_path, "r") as f:
                        data = json.load(f)
                        agent_contexts[file_path] = FileContext(**data)
                        logger.info(f"Loaded context for {file_path}")
                else:
                    agent_contexts[file_path] = None
                    logger.info(f"No previous context for {file_path} (new file)")
            except Exception as e:
                logger.warning(f"Failed to load context for {file_path}: {str(e)}")
                agent_contexts[file_path] = None
        
        state["agent_contexts"] = agent_contexts
        state["status"] = "running"
        
    except Exception as e:
        logger.error(f"Failed to load agent contexts: {str(e)}")
        state["errors"].append(f"Load contexts error: {str(e)}")
        state["status"] = "failed"
    
    return state


async def run_context_updates(state: SaveCoordinatorState) -> SaveCoordinatorState:
    """
    Node 2: Run context update agent for each changed file in parallel
    Uses asyncio.gather to run multiple context_update_agent calls concurrently
    """
    logger.info(f"Running context updates for {state['version']}")
    
    try:
        cf_root = state["cf_root"]
        prev_version = state["previous_version"]
        agent_contexts = state["agent_contexts"]
        changed_file_contents = state["changed_file_contents"]
        diff = state["diff"]
        
        # Prepare tasks for each changed file
        tasks = []
        file_paths = list(agent_contexts.keys())
        
        for file_path in file_paths:
            # Get new code content
            new_code = changed_file_contents.get(file_path, "")
            
            # Get old context
            old_context = agent_contexts.get(file_path)
            
            # Build diff summary for this file
            diff_summary = ""
            if file_path in diff.get("added", []):
                diff_summary = f"{file_path}: FILE ADDED"
            elif file_path in diff.get("removed", []):
                diff_summary = f"{file_path}: FILE REMOVED"
            elif file_path in diff.get("modified", []):
                diff_summary = f"{file_path}: FILE MODIFIED"
            
            # Create task for this file
            task = run_context_update(
                file_path=file_path,
                old_code={"content": old_context.summary if old_context else "No previous content"},
                new_code={"content": new_code},
                old_context=old_context,
                diff_summary=diff_summary,
            )
            tasks.append((file_path, task))
        
        # Run all tasks in parallel
        logger.info(f"Running {len(tasks)} context update tasks in parallel")
        results = await asyncio.gather(*[task for _, task in tasks], return_exceptions=True)
        
        # Process results
        updated_contexts = {}
        for (file_path, _), result in zip(tasks, results):
            if isinstance(result, Exception):
                logger.error(f"Context update failed for {file_path}: {str(result)}")
                state["errors"].append(f"Update failed for {file_path}: {str(result)}")
            else:
                if result.get("updated_context"):
                    updated_contexts[file_path] = result["updated_context"]
                    logger.info(f"Context updated for {file_path}")
                if result.get("validation_errors"):
                    state["errors"].extend(result["validation_errors"])
        
        state["updated_contexts"] = updated_contexts
        
    except Exception as e:
        logger.error(f"Failed to run context updates: {str(e)}")
        state["errors"].append(f"Context updates error: {str(e)}")
        state["status"] = "failed"
    
    return state


async def create_new_version(state: SaveCoordinatorState) -> SaveCoordinatorState:
    """
    Node 3: Create new version directory and write updated contexts
    Copies temp snapshot to new version and writes all FileContext objects
    """
    logger.info(f"Creating new version {state['version']}")
    
    try:
        cf_root = state["cf_root"]
        version = state["version"]
        updated_contexts = state["updated_contexts"]
        
        # Create version directory structure
        version_path = Path(cf_root) / version
        code_dir = version_path / "code"
        code_dir.mkdir(parents=True, exist_ok=True)
        
        # Copy snapshot from temp
        temp_snapshot = Path(cf_root) / "temp" / "snapshot.json"
        version_snapshot = version_path / "snapshot.json"
        if temp_snapshot.exists():
            shutil.copy2(temp_snapshot, version_snapshot)
            logger.info(f"Copied snapshot to {version}")
        
        # Write all updated contexts
        for file_path, file_context in updated_contexts.items():
            try:
                context_file = code_dir / f"{file_path}.json"
                context_file.parent.mkdir(parents=True, exist_ok=True)
                
                with open(context_file, "w") as f:
                    json.dump(file_context.model_dump(), f, indent=2, default=str)
                logger.info(f"Wrote context for {file_path}")
            except Exception as e:
                logger.error(f"Failed to write context for {file_path}: {str(e)}")
                state["errors"].append(f"Write context error for {file_path}: {str(e)}")
        
        state["new_version_path"] = str(version_path)
        
    except Exception as e:
        logger.error(f"Failed to create new version: {str(e)}")
        state["errors"].append(f"Create version error: {str(e)}")
        state["status"] = "failed"
    
    return state


async def update_current_json(state: SaveCoordinatorState) -> SaveCoordinatorState:
    """
    Node 4: Update current.json with new version number
    Increments version and persists to disk
    """
    logger.info(f"Updating current.json to {state['version']}")
    
    try:
        cf_root = state["cf_root"]
        new_version = state["version"]
        
        current_file = Path(cf_root) / "current.json"
        
        # Read current config
        current_config = {}
        if current_file.exists():
            with open(current_file, "r") as f:
                current_config = json.load(f)
        
        # Update version
        current_config["version"] = new_version
        current_config["last_updated"] = datetime.utcnow().isoformat()
        
        # Write back
        with open(current_file, "w") as f:
            json.dump(current_config, f, indent=2)
        
        logger.info(f"Updated current.json to {new_version}")
        
    except Exception as e:
        logger.error(f"Failed to update current.json: {str(e)}")
        state["errors"].append(f"Update current.json error: {str(e)}")
        state["status"] = "failed"
    
    return state


async def sync_temp(state: SaveCoordinatorState) -> SaveCoordinatorState:
    """
    Node 5: Reset temp/ to match new version for next session
    This allows the temp workspace to start fresh from the committed version
    """
    logger.info(f"Syncing temp/ to match {state['version']}")
    
    try:
        cf_root = state["cf_root"]
        version = state["version"]
        
        temp_dir = Path(cf_root) / "temp"
        version_dir = Path(cf_root) / version
        
        # Clear temp
        if temp_dir.exists():
            shutil.rmtree(temp_dir)
        
        # Copy version to temp
        temp_dir.mkdir(parents=True, exist_ok=True)
        for item in version_dir.iterdir():
            if item.is_file():
                shutil.copy2(item, temp_dir / item.name)
            elif item.is_dir():
                shutil.copytree(item, temp_dir / item.name, dirs_exist_ok=True)
        
        logger.info(f"Synced temp/ to {version}")
        
    except Exception as e:
        logger.error(f"Failed to sync temp: {str(e)}")
        state["errors"].append(f"Sync temp error: {str(e)}")
        # Don't fail the whole operation if sync fails
    
    return state


async def build_summary(state: SaveCoordinatorState) -> SaveCoordinatorState:
    """
    Node 6: Build user-facing summary of the save operation
    Compiles statistics and key changes across all affected files
    """
    logger.info(f"Building summary for {state['version']}")
    
    try:
        diff = state["diff"]
        updated_contexts = state["updated_contexts"]
        errors = state["errors"]
        
        # Compile statistics
        added_count = len(diff.get("added", []))
        removed_count = len(diff.get("removed", []))
        modified_count = len(diff.get("modified", []))
        
        updated_count = len(updated_contexts)
        error_count = len(errors)
        
        # Build summary message
        summary_parts = [
            f"✅ Saved {state['version']}",
            f"📝 Changes: {added_count} added, {removed_count} removed, {modified_count} modified",
            f"🔄 Updated {updated_count} file contexts",
        ]
        
        if error_count > 0:
            summary_parts.append(f"⚠️ {error_count} errors encountered")
        
        # Collect key changes from updated contexts
        key_changes = []
        for file_path, context in updated_contexts.items():
            if context.summary:
                key_changes.append(f"• {file_path}: {context.summary[:100]}...")
        
        summary_text = "\n".join(summary_parts)
        if key_changes:
            summary_text += "\n\nKey changes:\n" + "\n".join(key_changes[:5])  # Top 5
        
        state["summary"] = {
            "version": state["version"],
            "status": "completed" if error_count == 0 else "completed_with_errors",
            "message": summary_text,
            "statistics": {
                "added": added_count,
                "removed": removed_count,
                "modified": modified_count,
                "contexts_updated": updated_count,
                "errors": error_count,
            },
        }
        
        state["status"] = "completed"
        
    except Exception as e:
        logger.error(f"Failed to build summary: {str(e)}")
        state["summary"] = {
            "version": state["version"],
            "status": "failed",
            "message": f"Save operation failed: {str(e)}",
            "statistics": None,
        }
        state["status"] = "failed"
    
    return state


def create_graph():
    """
    Create and compile the save coordinator workflow
    Sequential nodes: load → update → create → current → sync → summary
    """
    workflow = StateGraph(SaveCoordinatorState)
    
    # Add nodes
    workflow.add_node("load_relevant_agents", load_relevant_agents)
    workflow.add_node("run_context_updates", run_context_updates)
    workflow.add_node("create_new_version", create_new_version)
    workflow.add_node("update_current_json", update_current_json)
    workflow.add_node("sync_temp", sync_temp)
    workflow.add_node("build_summary", build_summary)
    
    # Add edges (sequential flow)
    workflow.set_entry_point("load_relevant_agents")
    workflow.add_edge("load_relevant_agents", "run_context_updates")
    workflow.add_edge("run_context_updates", "create_new_version")
    workflow.add_edge("create_new_version", "update_current_json")
    workflow.add_edge("update_current_json", "sync_temp")
    workflow.add_edge("sync_temp", "build_summary")
    workflow.add_edge("build_summary", END)
    
    return workflow.compile()


# Initialize the graph
save_coordinator_graph = create_graph()


async def run_save_coordinator(
    cf_root: str,
    version: str,
    previous_version: str,
    diff: Dict[str, Any],
    changed_file_contents: Dict[str, str],
) -> Dict[str, Any]:
    """
    Execute the save coordinator workflow
    
    Args:
        cf_root: Path to .contextforge root
        version: New version (e.g., "v2")
        previous_version: Previous version (e.g., "v1")
        diff: {added[], removed[], modified[]} from frontend
        changed_file_contents: {filepath: content} of changed files
    
    Returns:
        Complete SaveCoordinatorState with results and summary
    """
    
    initial_state: SaveCoordinatorState = {
        "cf_root": cf_root,
        "version": version,
        "previous_version": previous_version,
        "diff": diff,
        "changed_file_contents": changed_file_contents,
        "agent_contexts": {},
        "updated_contexts": {},
        "new_version_path": "",
        "status": "pending",
        "summary": None,
        "errors": [],
    }
    
    # Run the graph
    result = await save_coordinator_graph.ainvoke(initial_state)
    
    logger.info(f"Save coordinator completed with status: {result['status']}")
    if result["errors"]:
        logger.info(f"Errors encountered: {result['errors']}")
    
    return result
