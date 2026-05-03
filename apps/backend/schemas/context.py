from typing import List, Optional, Literal, Dict, Any
from pydantic import BaseModel


class CurrentConfig(BaseModel):
    active_version: str
    latest_version: int
    project_root: str
    last_updated_at: str


class AgentConfig(BaseModel):
    agent_id: str
    agent_name: str
    role: str
    description: Optional[str] = None
    folders: List[str]
    files: Optional[List[str]] = None
    permissions: Optional[Dict[str, bool]] = None
    created_at: str
    updated_at: str


class GlobalConfig(BaseModel):
    project_name: str
    project_goal: str
    tech_stack: List[str]
    folder_agents: List[AgentConfig]
    architecture_decisions: List[str]
    created_at: str
    updated_at: str


class FunctionSignature(BaseModel):
    function_name: str
    type: Literal["function", "method", "arrow-function", "class-method", "constructor"]
    signature: str
    parameters: List[Dict[str, Any]]
    linestart: Optional[int] = None
    lineend: Optional[int] = None
    return_type: str
    description: str
    start_line: Optional[int] = None
    end_line: Optional[int] = None
    dependencies: Optional[List[str]] = None
    last_updated_at: str


class FileContext(BaseModel):
    file_path: str
    file_name: str
    assigned_agent_id: Optional[str] = None
    assigned_agent_name: Optional[str] = None
    purpose: str
    language: Optional[str] = None
    framework: Optional[str] = None
    imports: Optional[List[str]] = None
    exports: Optional[List[str]] = None
    functions: Optional[List[FunctionSignature]] = None
    summary: str
    created_at: str
    updated_at: str


class FolderContext(BaseModel):
    folder_path: str
    folder_name: str
    assigned_agent_id: Optional[str] = None
    assigned_agent_name: Optional[str] = None
    purpose: str
    responsibilities: List[str]
    files: List[FileContext]
    dependencies: Optional[List[str]] = None
    summary: str
    created_at: str
    updated_at: str


class DependencyContext(BaseModel):
    name: str
    version: str
    description: Optional[str] = None
    path: str
    created_at: str
    updated_at: str


class ChangelogEntry(BaseModel):
    id: str
    type: Literal[
        "file_created",
        "file_updated",
        "file_deleted",
        "folder_created",
        "folder_updated",
        "folder_deleted",
        "function_added",
        "function_updated",
        "function_removed",
        "dependency_added",
        "dependency_removed",
        "architecture_decision_added",
        "agent_assigned",
        "agent_updated",
    ]
    target_path: Optional[str] = None
    target_name: Optional[str] = None
    description: str
    old_value: Optional[str] = None
    new_value: Optional[str] = None
    agent_id: Optional[str] = None
    agent_name: Optional[str] = None
    timestamp: str
    added_files: List[str]
    modified_files: List[str]
    deleted_files: List[str]
    new_functions: List[str]
    changed_functions: List[str]


class VersionMeta(BaseModel):
    version: str
    version_number: int
    parent_version: Optional[str] = None
    created_at: str
    updated_at: str
    created_by: Optional[str] = None
    summary: str
    folders: List[str]
    files: List[str]
    changelog: List[ChangelogEntry]
