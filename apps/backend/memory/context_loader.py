import base64
import json
import re
from pathlib import Path
from typing import Optional

from schemas.context import (
    AgentConfig, FolderContext, FileContext, GlobalConfig, CurrentConfig, VersionMeta
)


def _camel_to_snake(name: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()


def _normalize_keys(value):
    if isinstance(value, list):
        return [_normalize_keys(item) for item in value]
    if isinstance(value, dict):
        return {_camel_to_snake(key): _normalize_keys(item) for key, item in value.items()}
    return value


def _read_json(path: Path) -> Optional[dict]:
    try:
        if not path.exists():
            return None
        with open(path, "r", encoding="utf-8") as f:
            return _normalize_keys(json.load(f))
    except Exception:
        return None


def _deep_merge_dicts(base: Optional[dict], update: Optional[dict]) -> dict:
    if not base:
        return update or {}
    if not update:
        return base or {}

    merged = base.copy()
    for key, value in update.items():
        if isinstance(value, dict) and key in merged and isinstance(merged[key], dict):
            merged[key] = _deep_merge_dicts(merged[key], value)
        else:
            merged[key] = value
    return merged


def _encode_context_path(context_path: str) -> str:
    encoded = base64.urlsafe_b64encode(context_path.encode()).decode()
    return encoded.rstrip("=")


def get_current_config(cf_root: str) -> Optional[CurrentConfig]:
    data = _read_json(Path(cf_root) / "current.json")
    if not data:
        return None
    try:
        return CurrentConfig.model_validate(data)
    except Exception:
        return None


def load_merged_json(
    cf_root: str,
    active_version: Optional[str],
    relative_path: str
) -> Optional[dict]:
    base_data = None
    if active_version:
        base_data = _read_json(Path(cf_root) / active_version / relative_path)
    temp_data = _read_json(Path(cf_root) / "temp" / relative_path)

    if base_data is None and temp_data is None:
        return None

    return _deep_merge_dicts(base_data, temp_data)


def load_version_meta(cf_root: str, active_version: Optional[str]) -> Optional[VersionMeta]:
    if not active_version:
        return None

    data = _read_json(Path(cf_root) / active_version / "meta.json")
    if data is None:
        return None
    try:
        return VersionMeta.model_validate(data)
    except Exception:
        return None


def load_global_context(cf_root: str, active_version: Optional[str]) -> Optional[GlobalConfig]:
    data = load_merged_json(cf_root, active_version, "global.json")
    if data is None:
        return None
    try:
        return GlobalConfig.model_validate(data)
    except Exception:
        return None


def load_agent_context(
    cf_root: str,
    active_version: Optional[str],
    agent: AgentConfig
) -> Optional[AgentConfig]:
    data = load_merged_json(cf_root, active_version, f"agents/{agent.agent_id}.json")
    if data is None:
        return agent
    try:
        return AgentConfig.model_validate(data)
    except Exception:
        return agent


def _load_all_file_contexts(cf_root: str, active_version: Optional[str]) -> list[FileContext]:
    merged: dict[str, dict] = {}
    roots = []
    if active_version:
        roots.append(Path(cf_root) / active_version / "files")
    roots.append(Path(cf_root) / "temp" / "files")

    for root in roots:
        if not root.exists():
            continue
        for file in root.glob("*.context.json"):
            data = _read_json(file)
            if data:
                merged[file.name] = data

    contexts: list[FileContext] = []
    for data in merged.values():
        try:
            contexts.append(FileContext.model_validate(data))
        except Exception:
            pass
    return contexts


def load_folder_context(
    cf_root: str,
    active_version: Optional[str],
    folder_path: str
) -> Optional[FolderContext]:
    encoded_path = _encode_context_path(folder_path)
    data = load_merged_json(
        cf_root,
        active_version,
        f"folders/{encoded_path}.context.json",
    )
    if data is None:
        return None

    prefix = f"{folder_path.rstrip('/')}/"
    files = [
        file_context.model_dump(by_alias=True)
        for file_context in _load_all_file_contexts(cf_root, active_version)
        if file_context.file_path.startswith(prefix)
    ]
    data["files"] = files

    try:
        return FolderContext.model_validate(data)
    except Exception:
        return None


def load_full_project_context(cf_root: str) -> dict:
    current_config = get_current_config(cf_root)
    active_version = current_config.active_version if current_config else None

    result = {
        "current_config": current_config,
        "version_meta": load_version_meta(cf_root, active_version),
        "global": None,
        "agents": {},
        "folders": {},
    }

    global_config = load_global_context(cf_root, active_version)
    result["global"] = global_config

    if global_config is None:
        return result

    for agent in global_config.folder_agents:
        agent_data = load_agent_context(cf_root, active_version, agent)
        if agent_data:
            result["agents"][agent.agent_name] = agent_data
            for folder_path in agent_data.folders:
                if folder_path not in result["folders"]:
                    folder_data = load_folder_context(cf_root, active_version, folder_path)
                    if folder_data:
                        result["folders"][folder_path] = folder_data

    return result
