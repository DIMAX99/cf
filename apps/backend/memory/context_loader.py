import json
import os
from pathlib import Path
from typing import Optional, Dict, Any
from schemas.context import (
    AgentConfig, FolderContext, FileContext, GlobalConfig, CurrentConfig, VersionMeta
)

def _read_json(path: Path) -> Optional[dict]:
    """Read JSON file, return None if missing or corrupt"""
    try:
        if not path.exists():
            return None
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None

def _deep_merge_dicts(base: dict, update: dict) -> dict:
    """
    Recursively merges the 'update' dictionary into the 'base' dictionary.
    This applies the temp/ changes cleanly on top of the current version.
    """
    if not base: return update or {}
    if not update: return base or {}

    merged = base.copy()
    for key, value in update.items():
        if isinstance(value, dict) and key in merged and isinstance(merged[key], dict):
            merged[key] = _deep_merge_dicts(merged[key], value)
        else:
            merged[key] = value
    return merged

def get_current_config(cf_root: str) -> Optional[CurrentConfig]:
    """Reads current.json to determine active version and project root."""
    path = Path(cf_root) / "current.json"
    data = _read_json(path)
    if not data: return None
    try:
        return CurrentConfig.model_validate(data)
    except Exception:
        return None

def load_merged_json(cf_root: str, active_version: str, relative_path: str) -> Optional[dict]:
    """
    Loads JSON from the active version, then overlays the temp/ version on top.
    """
    version_file = Path(cf_root) / active_version / relative_path
    temp_file = Path(cf_root) / "temp" / relative_path

    base_data = _read_json(version_file)
    temp_data = _read_json(temp_file)

    if base_data is None and temp_data is None:
        return None

    return _deep_merge_dicts(base_data, temp_data)

def load_version_meta(cf_root: str, active_version: str) -> Optional[VersionMeta]:
    """Loads the version metadata, including the changelog."""
    # Assuming you save the VersionMeta in the active version folder (e.g., v1/meta.json)
    data = _read_json(Path(cf_root) / active_version / "meta.json")
    if data is None:
        return None
    try:
        return VersionMeta.model_validate(data)
    except Exception:
        return None

def load_global_context(cf_root: str, active_version: str) -> Optional[GlobalConfig]:
    """Loads global JSON by combining current version + temp changes"""
    data = load_merged_json(cf_root, active_version, "global.json")
    if data is None: return None
    try:
        return GlobalConfig.model_validate(data)
    except Exception:
        return None

def load_agent_context(cf_root: str, active_version: str, agent_name: str) -> Optional[AgentConfig]:
    """Loads agent JSON by combining current version + temp changes"""
    data = load_merged_json(cf_root, active_version, f"agents/{agent_name}.json")
    if data is None: return None
    try:
        return AgentConfig.model_validate(data)
    except Exception:
        return None

def load_folder_context(cf_root: str, active_version: str, folder_name: str) -> Optional[FolderContext]:
    """
    Merges _folder.context.json from {activeVersion} and temp/.
    Then scans BOTH directories for file contexts, merges them, and builds the file list.
    """
    # 1. Merge the main folder context
    data = load_merged_json(cf_root, active_version, f"{folder_name}/_folder.context.json")
    if data is None:
        return None

    # 2. Collect and merge file contexts individually
    version_folder = Path(cf_root) / active_version / folder_name
    temp_folder = Path(cf_root) / "temp" / folder_name
    
    merged_file_contexts = {}

    # Read base files
    if version_folder.exists():
        for file in version_folder.iterdir():
            if file.name.endswith(".context.json") and file.name != "_folder.context.json":
                if file_data := _read_json(file):
                    merged_file_contexts[file.name] = file_data

    # Overlay with temp modifications/new files
    if temp_folder.exists():
        for file in temp_folder.iterdir():
            if file.name.endswith(".context.json") and file.name != "_folder.context.json":
                if temp_file_data := _read_json(file):
                    base_file_data = merged_file_contexts.get(file.name, {})
                    merged_file_contexts[file.name] = _deep_merge_dicts(base_file_data, temp_file_data)

    # 3. Validate and append merged files
    validated_files = []
    for file_data in merged_file_contexts.values():
        try:
            fc = FileContext.model_validate(file_data)
            # Dump to dict so it can be ingested by the FolderContext model later
            validated_files.append(fc.model_dump(by_alias=True))
        except Exception:
            pass 

    data["files"] = validated_files

    try:
        return FolderContext.model_validate(data)
    except Exception:
        return None

def load_full_project_context(cf_root: str) -> dict:
    """
    The Master Loader: 
    Returns the complete structured state of the workspace by loading the 
    active version, layering the temp/ edits seamlessly over the top, 
    and including the changelog/meta history.
    """
    current_config = get_current_config(cf_root)
    active_version = current_config.active_version if current_config else "v1"

    result = {
        "current_config": current_config,
        "version_meta": load_version_meta(cf_root, active_version),
        "global": None,
        "agents": {},
        "folders": {}
    }

    global_config = load_global_context(cf_root, active_version)
    result["global"] = global_config

    if global_config is None:
        return result

    # Load each agent
    for agent in global_config.folder_agents:
        agent_data = load_agent_context(cf_root, active_version, agent.agent_name)
        if agent_data:
            result["agents"][agent.agent_name] = agent_data

            # Load each folder owned by this agent
            for folder_name in agent.folders:
                # To prevent loading the same folder twice if shared by multiple agents
                if folder_name not in result["folders"]: 
                    folder_data = load_folder_context(cf_root, active_version, folder_name)
                    if folder_data:
                        result["folders"][folder_name] = folder_data

    return result


#Previoud version of the context loader , kept for reference until the new one is tested and stable.
# import json
# import os
# from pathlib import Path
# from typing import Optional
# from schemas.context import (
#     AgentConfig, FolderContext, FileContext, GlobalConfig
# )


# def _read_json(path: Path) -> Optional[dict]:
#     """Read JSON file, return None if missing or corrupt"""
#     try:
#         if not path.exists():
#             return None
#         with open(path, "r", encoding="utf-8") as f:
#             return json.load(f)
#     except Exception:
#         return None


# def load_agent_context(cf_root: str, agent_name: str) -> Optional[AgentConfig]:
#     """
#     Reads agent JSON from temp/agents/{agentName}.json
#     Returns None if not found
#     """
#     agent_path = Path(cf_root) / "temp" / "agents" / f"{agent_name}.json"
#     data = _read_json(agent_path)
#     if data is None:
#         return None
#     try:
#         return AgentConfig.model_validate(data)
#     except Exception:
#         return None


# def load_folder_context(cf_root: str, folder_name: str) -> Optional[FolderContext]:
#     """
#     Reads _folder.context.json from temp/{folderName}/
#     Also reads all {filename}.context.json files inside that folder
#     and populates the files[] list
#     """
#     folder_path = Path(cf_root) / "temp" / folder_name
#     folder_context_path = folder_path / "_folder.context.json"

#     data = _read_json(folder_context_path)
#     if data is None:
#         return None

#     # Read all file context files in this folder
#     file_contexts = []
#     if folder_path.exists():
#         for file in folder_path.iterdir():
#             if file.name.endswith(".context.json") and file.name != "_folder.context.json":
#                 file_data = _read_json(file)
#                 if file_data:
#                     try:
#                         file_contexts.append(FileContext.model_validate(file_data))
#                     except Exception:
#                         pass  # skip corrupt file contexts

#     # Override files[] with what we actually found on disk
#     data["files"] = [fc.model_dump(by_alias=True) for fc in file_contexts]

#     try:
#         return FolderContext.model_validate(data)
#     except Exception:
#         return None


# def load_global_context(cf_root: str) -> Optional[GlobalConfig]:
#     """
#     Reads temp/global.json
#     """
#     global_path = Path(cf_root) / "temp" / "global.json"
#     data = _read_json(global_path)
#     if data is None:
#         return None
#     try:
#         return GlobalConfig.model_validate(data)
#     except Exception:
#         return None


# def load_temp_context(cf_root: str) -> dict:
#     """
#     Loads everything from temp/ — global config + all agents + all folders
#     Returns a structured dict for the save_coordinator to use
#     """
#     result = {
#         "global": None,
#         "agents": {},
#         "folders": {}
#     }

#     global_config = load_global_context(cf_root)
#     result["global"] = global_config

#     if global_config is None:
#         return result

#     # Load each agent
#     for agent in global_config.folder_agents:
#         agent_data = load_agent_context(cf_root, agent.agent_name)
#         if agent_data:
#             result["agents"][agent.agent_name] = agent_data

#         # Load each folder owned by this agent
#         for folder_name in agent.folders:
#             folder_data = load_folder_context(cf_root, folder_name)
#             if folder_data:
#                 result["folders"][folder_name] = folder_data

#     return result

