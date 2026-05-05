import json
import os
import shutil
import uuid
import base64
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

from schemas.context import (
    AgentConfig, FolderContext, FileContext, ChangelogEntry, VersionMeta
)


def _get_iso_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


def _atomic_write_json(target_path: Path, data: dict):
    target_path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = target_path.with_name(target_path.name + ".tmp")
    try:
        with open(temp_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, default=str)
        os.replace(temp_path, target_path)
    except Exception as e:
        if temp_path.exists():
            os.remove(temp_path)
        raise e


def _encode_context_path(context_path: str) -> str:
    encoded = base64.urlsafe_b64encode(context_path.encode()).decode()
    return encoded.rstrip("=")


def _append_changelog(
    cf_root: str,
    entry_type: str,
    what: str,
    why: str,
    files_added: Optional[List[str]] = None,
    files_modified: Optional[List[str]] = None,
    files_deleted: Optional[List[str]] = None,
    functions_added: Optional[List[str]] = None,
    functions_removed: Optional[List[str]] = None,
    functions_signature_changed: Optional[List[str]] = None,
    breaking_impact: Optional[str] = None,
    migration_notes: Optional[str] = None,
    agent_id: Optional[str] = None,
    agent_name: Optional[str] = None,
):
    """
    Appends a changelog entry to temp/changelog.json using the new rich schema.
    The 'why' field is the most important — it prevents future regressions.
    """
    valid_types = [
        "feature_added", "bug_fixed", "refactor",
        "performance_improvement", "security_fix",
        "breaking_change", "dependency_update",
        "test_added", "documentation",
        "architecture_change", "agent_boundary_change",
    ]
    if entry_type not in valid_types:
        raise ValueError(f"Invalid entry_type '{entry_type}'. Must be one of: {valid_types}")

    changelog_path = Path(cf_root) / "temp" / "changelog.json"
    changelog_data = []

    if changelog_path.exists():
        try:
            with open(changelog_path, "r", encoding="utf-8") as f:
                changelog_data = json.load(f)
        except json.JSONDecodeError:
            pass

    entry = ChangelogEntry(
        id=f"log_{uuid.uuid4().hex[:8]}",
        type=entry_type,
        what=what,
        why=why,
        breaking_impact=breaking_impact,
        migration_notes=migration_notes,
        files_added=files_added or [],
        files_modified=files_modified or [],
        files_deleted=files_deleted or [],
        functions_added=functions_added or [],
        functions_removed=functions_removed or [],
        functions_signature_changed=functions_signature_changed or [],
        agent_id=agent_id,
        agent_name=agent_name,
        timestamp=_get_iso_timestamp(),
    )

    changelog_data.append(entry.model_dump(exclude_none=True))
    _atomic_write_json(changelog_path, changelog_data)


def write_file_context(cf_root: str, target_dir: str, folder_name: str, context: FileContext):
    """Atomically writes a file context JSON and appends a changelog entry."""
    try:
        encoded_path = _encode_context_path(context.file_path)
        target_path = Path(cf_root) / target_dir / "files" / f"{encoded_path}.context.json"
        data = context.model_dump(exclude_none=True)
        _atomic_write_json(target_path, data)

        _append_changelog(
            cf_root=cf_root,
            entry_type="refactor",
            what=f"Updated file context for {context.file_name}",
            why=context.last_change_reason or "File context updated via ContextForge",
            files_modified=[context.file_path],
        )
    except Exception as e:
        raise Exception(f"Failed to write file context for {context.file_name}: {str(e)}")


def write_folder_context(cf_root: str, target_dir: str, folder_name: str, context: FolderContext):
    """Atomically writes a folder context JSON and appends a changelog entry."""
    try:
        encoded_path = _encode_context_path(context.folder_path)
        target_path = Path(cf_root) / target_dir / "folders" / f"{encoded_path}.context.json"
        data = context.model_dump(exclude_none=True)
        _atomic_write_json(target_path, data)

        _append_changelog(
            cf_root=cf_root,
            entry_type="refactor",
            what=f"Updated folder context for {context.folder_name}",
            why="Folder structure or ownership updated via ContextForge",
            files_modified=[context.folder_path],
        )
    except Exception as e:
        raise Exception(f"Failed to write folder context for {folder_name}: {str(e)}")


def write_agent_context(cf_root: str, target_dir: str, agent_name: str, context: AgentConfig):
    """Atomically writes an agent JSON and appends a changelog entry."""
    try:
        target_path = Path(cf_root) / target_dir / "agents" / f"{context.agent_id}.json"
        data = context.model_dump(exclude_none=True)
        _atomic_write_json(target_path, data)

        _append_changelog(
            cf_root=cf_root,
            entry_type="agent_boundary_change",
            what=f"Updated agent configuration for {agent_name}",
            why="Agent responsibilities or boundaries updated via ContextForge",
            agent_id=context.agent_id,
            agent_name=context.agent_name,
        )
    except Exception as e:
        raise Exception(f"Failed to write agent context for {agent_name}: {str(e)}")


def write_version_changelog(
    cf_root: str,
    version: str,
    entries: List[ChangelogEntry],
    intent: str,
    summary: str,
    breaking_changes: Optional[str] = None,
    migration_notes: Optional[str] = None,
    parent_version: Optional[str] = None,
    created_by: Optional[str] = None,
):
    """
    Writes a complete VersionMeta with changelog to {version}/meta.json.
    Called by save_coordinator after all file contexts have been updated.
    This is the authoritative changelog for a version.
    """
    version_path = Path(cf_root) / version
    version_path.mkdir(parents=True, exist_ok=True)
    meta_path = version_path / "meta.json"

    now = _get_iso_timestamp()
    version_number = int(version.lstrip("v")) if version.startswith("v") else 0

    meta = VersionMeta(
        version=version,
        version_number=version_number,
        parent_version=parent_version,
        intent=intent,
        breaking_changes=breaking_changes,
        migration_notes=migration_notes,
        created_at=now,
        updated_at=now,
        created_by=created_by,
        summary=summary,
        changelog=entries,
    )

    _atomic_write_json(meta_path, meta.model_dump(exclude_none=True))


def copy_temp_to_version(cf_root: str, active_version: str, new_version: str):
    """
    Creates a new version by deep copying the active version and overlaying temp/ changes.
    Merges staged changelog.json into the new version's meta.json using the new schema.
    """
    try:
        root_path = Path(cf_root)
        active_path = root_path / active_version if active_version else None
        new_path = root_path / new_version
        temp_path = root_path / "temp"

        if active_path and active_path.exists():
            shutil.copytree(active_path, new_path, dirs_exist_ok=True)
        else:
            new_path.mkdir(parents=True, exist_ok=True)

        if temp_path.exists():
            shutil.copytree(temp_path, new_path, dirs_exist_ok=True)

        temp_changelog = temp_path / "changelog.json"
        if temp_changelog.exists():
            meta_path = new_path / "meta.json"

            meta_data: dict = {}
            if meta_path.exists():
                try:
                    with open(meta_path, "r", encoding="utf-8") as f:
                        meta_data = json.load(f)
                except Exception:
                    pass

            with open(temp_changelog, "r", encoding="utf-8") as f:
                staged_logs = json.load(f)

            if "changelog" not in meta_data:
                meta_data["changelog"] = []
            meta_data["changelog"].extend(staged_logs)

            # Ensure required VersionMeta fields exist
            if not meta_data.get("intent"):
                meta_data["intent"] = f"Changes committed to {new_version}"
            if not meta_data.get("summary"):
                entry_count = len(staged_logs)
                meta_data["summary"] = f"{entry_count} change(s) committed in {new_version}"
            if not meta_data.get("version"):
                meta_data["version"] = new_version
            if not meta_data.get("version_number"):
                meta_data["version_number"] = int(new_version.lstrip("v")) if new_version.startswith("v") else 0
            if not meta_data.get("created_at"):
                meta_data["created_at"] = _get_iso_timestamp()
            meta_data["updated_at"] = _get_iso_timestamp()

            _atomic_write_json(meta_path, meta_data)
            os.remove(temp_changelog)

    except Exception as e:
        raise Exception(f"Failed to commit version {new_version} from {active_version}: {str(e)}")



























# import json
# import os
# import shutil
# import uuid
# from datetime import datetime, timezone
# from pathlib import Path
# from typing import Any, Dict, Optional, Union

# from schemas.context import (
#     AgentConfig, FolderContext, FileContext, ChangelogEntry, VersionMeta
# )

# def _get_iso_timestamp() -> str:
#     """Returns standard ISO 8601 timestamp for JSON."""
#     return datetime.now(timezone.utc).isoformat()

# def _atomic_write_json(target_path: Path, data: dict):
#     """
#     Writes data to a .tmp file first, then atomically replaces the target file.
#     This prevents corruption if the process crashes mid-write.
#     """
#     target_path.parent.mkdir(parents=True, exist_ok=True)
#     temp_path = target_path.with_name(target_path.name + ".tmp")
    
#     try:
#         with open(temp_path, "w", encoding="utf-8") as f:
#             json.dump(data, f, indent=2)
        
#         # os.replace is atomic on POSIX and Windows
#         os.replace(temp_path, target_path)
#     except Exception as e:
#         # Clean up the dangling tmp file if serialization fails
#         if temp_path.exists():
#             os.remove(temp_path)
#         raise e

# def _append_changelog(cf_root: str, entry_type: str, target_path: str, description: str):
#     """
#     Appends a local change to temp/changelog.json. 
#     This acts as a staging area for the changelog before a version commit.
#     """
#     # Validate entry_type is one of the allowed literal values
#     valid_types = [
#         "file_created", "file_updated", "file_deleted",
#         "folder_created", "folder_updated", "folder_deleted",
#         "function_added", "function_updated", "function_removed",
#         "dependency_added", "dependency_removed",
#         "architecture_decision_added", "agent_assigned", "agent_updated"
#     ]
#     if entry_type not in valid_types:
#         raise ValueError(f"Invalid entry_type '{entry_type}'. Must be one of: {valid_types}")
    
#     changelog_path = Path(cf_root) / "temp" / "changelog.json"
#     changelog_data = []
    
#     if changelog_path.exists():
#         try:
#             with open(changelog_path, "r", encoding="utf-8") as f:
#                 changelog_data = json.load(f)
#         except json.JSONDecodeError:
#             pass # Start fresh if corrupted
            
#     entry = ChangelogEntry(
#         id=f"log_{uuid.uuid4().hex[:8]}",
#         type=entry_type,  # type: ignore (Pydantic will validate the literal)
#         target_path=target_path,
#         description=description,
#         timestamp=_get_iso_timestamp(),
#         added_files=[],
#         modified_files=[],
#         deleted_files=[],
#         new_functions=[],
#         changed_functions=[]
#     )
    
#     changelog_data.append(entry.model_dump(by_alias=True, exclude_none=True))
#     _atomic_write_json(changelog_path, changelog_data)


# def write_file_context(cf_root: str, target_dir: str, folder_name: str, context: FileContext):
#     """Atomically writes a {filename}.context.json file and logs the change."""
#     try:
#         target_path = Path(cf_root) / target_dir / folder_name / f"{context.file_name}.context.json"
        
#         data = context.model_dump(by_alias=True, exclude_none=True)
#         _atomic_write_json(target_path, data)
        
#         _append_changelog(
#             cf_root, 
#             entry_type="file_updated", 
#             target_path=context.file_path,
#             description=f"Updated file context for {context.file_name}"
#         )
#     except Exception as e:
#         raise Exception(f"Failed to write file context for {context.file_name}: {str(e)}")


# def write_folder_context(cf_root: str, target_dir: str, folder_name: str, context: FolderContext):
#     """Atomically writes a _folder.context.json file and logs the change."""
#     try:
#         target_path = Path(cf_root) / target_dir / folder_name / "_folder.context.json"
        
#         data = context.model_dump(by_alias=True, exclude_none=True)
#         _atomic_write_json(target_path, data)
        
#         _append_changelog(
#             cf_root, 
#             entry_type="folder_updated", 
#             target_path=context.folder_path,
#             description=f"Updated folder context for {context.folder_name}"
#         )
#     except Exception as e:
#         raise Exception(f"Failed to write folder context for {folder_name}: {str(e)}")


# def write_agent_context(cf_root: str, target_dir: str, agent_name: str, context: AgentConfig):
#     """Atomically writes an agent JSON file and logs the change."""
#     try:
#         target_path = Path(cf_root) / target_dir / "agents" / f"{agent_name}.json"
        
#         data = context.model_dump(by_alias=True, exclude_none=True)
#         _atomic_write_json(target_path, data)
        
#         _append_changelog(
#             cf_root, 
#             entry_type="agent_updated", 
#             target_name=agent_name,
#             target_path=f"agents/{agent_name}.json",
#             description=f"Updated agent configuration for {agent_name}"
#         )
#     except Exception as e:
#         raise Exception(f"Failed to write agent context for {agent_name}: {str(e)}")


# def copy_temp_to_version(cf_root: str, active_version: str, new_version: str):
#     """
#     Creates a new version by deep copying the active version and overlaying temp/ changes.
#     Effectively commits the active delta into a hard snapshot.
#     """
#     try:
#         root_path = Path(cf_root)
#         active_path = root_path / active_version
#         new_path = root_path / new_version
#         temp_path = root_path / "temp"

#         # 1. Start by copying the entire base version to the new version folder
#         if active_path.exists():
#             shutil.copytree(active_path, new_path, dirs_exist_ok=True)
#         else:
#             new_path.mkdir(parents=True, exist_ok=True)

#         # 2. Overlay the temp/ directory directly on top of the new version
#         # dirs_exist_ok=True handles the deep merging of files at the OS level
#         if temp_path.exists():
#             shutil.copytree(temp_path, new_path, dirs_exist_ok=True)

#         # 3. Clean up staging changelog by merging it into the new version's meta.json
#         temp_changelog = temp_path / "changelog.json"
#         if temp_changelog.exists():
#             meta_path = new_path / "meta.json"
            
#             meta_data = {}
#             if meta_path.exists():
#                 try:
#                     with open(meta_path, "r", encoding="utf-8") as f:
#                         meta_data = json.load(f)
#                 except Exception:
#                     pass
                    
#             # Grab staged logs
#             with open(temp_changelog, "r", encoding="utf-8") as f:
#                 staged_logs = json.load(f)

#             # Append to meta.changelog
#             if "changelog" not in meta_data:
#                 meta_data["changelog"] = []
#             meta_data["changelog"].extend(staged_logs)
            
#             # Write merged meta file and delete the staging log
#             _atomic_write_json(meta_path, meta_data)
#             os.remove(temp_changelog)
            
#         # Optional: Clear out temp/ directory here if you want to reset the workspace state
#         # after a successful commit.
#     except Exception as e:
#         raise Exception(f"Failed to commit version {new_version} from {active_version}: {str(e)}")
