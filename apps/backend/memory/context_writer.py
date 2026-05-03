import json
import os
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional, Union

from schemas.context import (
    AgentConfig, FolderContext, FileContext, ChangelogEntry, VersionMeta
)

def _get_iso_timestamp() -> str:
    """Returns standard ISO 8601 timestamp for JSON."""
    return datetime.now(timezone.utc).isoformat()

def _atomic_write_json(target_path: Path, data: dict):
    """
    Writes data to a .tmp file first, then atomically replaces the target file.
    This prevents corruption if the process crashes mid-write.
    """
    target_path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = target_path.with_name(target_path.name + ".tmp")
    
    try:
        with open(temp_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        
        # os.replace is atomic on POSIX and Windows
        os.replace(temp_path, target_path)
    except Exception as e:
        # Clean up the dangling tmp file if serialization fails
        if temp_path.exists():
            os.remove(temp_path)
        raise e

def _append_changelog(cf_root: str, entry_type: str, target_path: str, description: str):
    """
    Appends a local change to temp/changelog.json. 
    This acts as a staging area for the changelog before a version commit.
    """
    changelog_path = Path(cf_root) / "temp" / "changelog.json"
    changelog_data = []
    
    if changelog_path.exists():
        try:
            with open(changelog_path, "r", encoding="utf-8") as f:
                changelog_data = json.load(f)
        except json.JSONDecodeError:
            pass # Start fresh if corrupted
            
    entry = ChangelogEntry(
        id=f"log_{uuid.uuid4().hex[:8]}",
        type=entry_type,  # type: ignore (Pydantic will validate the literal)
        target_path=target_path,
        description=description,
        timestamp=_get_iso_timestamp(),
        added_files=[],
        modified_files=[],
        deleted_files=[],
        new_functions=[],
        changed_functions=[]
    )
    
    changelog_data.append(entry.model_dump(by_alias=True, exclude_none=True))
    _atomic_write_json(changelog_path, changelog_data)


def write_file_context(cf_root: str, target_dir: str, folder_name: str, context: FileContext):
    """Atomically writes a {filename}.context.json file and logs the change."""
    target_path = Path(cf_root) / target_dir / folder_name / f"{context.file_name}.context.json"
    
    data = context.model_dump(by_alias=True, exclude_none=True)
    _atomic_write_json(target_path, data)
    
    _append_changelog(
        cf_root, 
        entry_type="file_updated", 
        target_path=context.file_path,
        description=f"Updated file context for {context.file_name}"
    )


def write_folder_context(cf_root: str, target_dir: str, folder_name: str, context: FolderContext):
    """Atomically writes a _folder.context.json file and logs the change."""
    target_path = Path(cf_root) / target_dir / folder_name / "_folder.context.json"
    
    data = context.model_dump(by_alias=True, exclude_none=True)
    _atomic_write_json(target_path, data)
    
    _append_changelog(
        cf_root, 
        entry_type="folder_updated", 
        target_path=context.folder_path,
        description=f"Updated folder context for {context.folder_name}"
    )


def write_agent_context(cf_root: str, target_dir: str, agent_name: str, context: AgentConfig):
    """Atomically writes an agent JSON file and logs the change."""
    target_path = Path(cf_root) / target_dir / "agents" / f"{agent_name}.json"
    
    data = context.model_dump(by_alias=True, exclude_none=True)
    _atomic_write_json(target_path, data)
    
    _append_changelog(
        cf_root, 
        entry_type="agent_updated", 
        target_name=agent_name,
        target_path=f"agents/{agent_name}.json",
        description=f"Updated agent configuration for {agent_name}"
    )


def copy_temp_to_version(cf_root: str, active_version: str, new_version: str):
    """
    Creates a new version by deep copying the active version and overlaying temp/ changes.
    Effectively commits the active delta into a hard snapshot.
    """
    root_path = Path(cf_root)
    active_path = root_path / active_version
    new_path = root_path / new_version
    temp_path = root_path / "temp"

    # 1. Start by copying the entire base version to the new version folder
    if active_path.exists():
        shutil.copytree(active_path, new_path, dirs_exist_ok=True)
    else:
        new_path.mkdir(parents=True, exist_ok=True)

    # 2. Overlay the temp/ directory directly on top of the new version
    # dirs_exist_ok=True handles the deep merging of files at the OS level
    if temp_path.exists():
        shutil.copytree(temp_path, new_path, dirs_exist_ok=True)

    # 3. Clean up staging changelog by merging it into the new version's meta.json
    temp_changelog = temp_path / "changelog.json"
    if temp_changelog.exists():
        meta_path = new_path / "meta.json"
        
        meta_data = {}
        if meta_path.exists():
            try:
                with open(meta_path, "r", encoding="utf-8") as f:
                    meta_data = json.load(f)
            except Exception:
                pass
                
        # Grab staged logs
        with open(temp_changelog, "r", encoding="utf-8") as f:
            staged_logs = json.load(f)

        # Append to meta.changelog
        if "changelog" not in meta_data:
            meta_data["changelog"] = []
        meta_data["changelog"].extend(staged_logs)
        
        # Write merged meta file and delete the staging log
        _atomic_write_json(meta_path, meta_data)
        os.remove(temp_changelog)
        
    # Optional: Clear out temp/ directory here if you want to reset the workspace state
    # after a successful commit.