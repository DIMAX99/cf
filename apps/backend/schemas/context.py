"""
Context-Forge  —  Rich Context Schemas
---------------------------------------
Every field here exists to give an LLM coding assistant genuine reasoning
material, not just file metadata. The guiding question for each field:

  "If an LLM were about to edit this file/folder, would knowing this field
   prevent a bug, a wrong assumption, or a wasted round-trip?"

If the answer is no, the field is noise and doesn't belong here.
"""

from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional
from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel


# ─────────────────────────────────────────────────────────────────────────────
# Shared primitives
# ─────────────────────────────────────────────────────────────────────────────

class CurrentConfig(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    active_version: str
    latest_version: int
    project_root: str
    last_updated_at: str


# ─────────────────────────────────────────────────────────────────────────────
# Function / class signatures  (the atoms of file context)
# ─────────────────────────────────────────────────────────────────────────────

class ParameterDoc(BaseModel):
    """One parameter of a function or method."""
    name: str
    type: str
    optional: bool = False
    description: str
    # If the param has known valid values, list them — saves the LLM from
    # having to scan the implementation to know what's acceptable.
    allowed_values: Optional[List[str]] = None
    # Flag params that must never be None/null — common source of runtime bugs.
    nullable: bool = True


class SideEffect(BaseModel):
    """
    An observable effect beyond the return value.
    Knowing side effects prevents the LLM from refactoring something "safe"
    that actually writes to disk, fires a network call, or mutates global state.
    """
    kind: Literal[
        "db_read", "db_write", "db_delete",
        "http_call", "file_read", "file_write",
        "cache_read", "cache_write", "cache_invalidate",
        "event_emit", "event_subscribe",
        "env_read", "global_state_mutate",
        "log_write", "metric_emit",
        "auth_check", "session_mutate",
    ]
    description: str
    # Is this side effect conditional (only happens sometimes)?
    conditional: bool = False


class FunctionSignature(BaseModel):
    """
    Rich description of a single callable unit in a file.
    Goes well beyond a type signature — the LLM needs to know the contract,
    not just the shape.
    """
    name: str
    kind: Literal["function", "method", "arrow_function", "class_method",
                  "constructor", "generator", "async_function", "hook",
                  "middleware", "decorator", "lambda"]

    # One sentence: what this callable guarantees to the caller.
    contract: str

    # Full signature as it appears in source (for copy-paste accuracy).
    signature: str

    parameters: List[ParameterDoc]
    return_type: str

    # What does the return value represent? e.g. "null means not found, never throws"
    return_description: str

    # Line range in the current version — lets the LLM jump straight to it.
    line_start: Optional[int] = None
    line_end: Optional[int] = None

    # Complexity score 1-5.  1=trivial, 5=high cognitive load.
    # Helps the LLM decide whether to inline or preserve a helper.
    complexity: int = 1

    # Observable effects this function produces beyond its return value.
    side_effects: List[SideEffect] = []

    # Other functions/modules this function calls.  Enables impact analysis.
    calls: List[str] = []

    # Under what conditions does this throw / reject?
    throws: Optional[str] = None

    # Concurrency notes: "not thread-safe", "idempotent", "must be called once", etc.
    concurrency_notes: Optional[str] = None

    # Known performance characteristics — helps the LLM avoid putting this
    # in a hot loop: "O(n²) on large sets", "cold-starts with 200ms latency", etc.
    performance_notes: Optional[str] = None

    # Is this part of the public API (exported) or internal only?
    visibility: Literal["public", "internal", "private"] = "internal"

    # Deprecated?  If so, what replaces it?
    deprecated: bool = False
    deprecated_use_instead: Optional[str] = None

    last_updated_at: str


class ClassSignature(BaseModel):
    """A class / interface / type alias worth indexing."""
    name: str
    kind: Literal["class", "abstract_class", "interface", "type_alias",
                  "enum", "dataclass", "pydantic_model", "zod_schema"]
    contract: str          # What invariant does this type enforce?
    properties: List[ParameterDoc] = []
    methods: List[FunctionSignature] = []
    extends: List[str] = []
    implements: List[str] = []
    line_start: Optional[int] = None
    line_end: Optional[int] = None
    visibility: Literal["public", "internal", "private"] = "public"


# ─────────────────────────────────────────────────────────────────────────────
# File context  —  the LLM's view of a single source file
# ─────────────────────────────────────────────────────────────────────────────

class FileContext(BaseModel):
    """
    Everything an LLM needs to know about a file before editing it.

    Design principle: the LLM should be able to answer these questions
    from this object alone, without reading the file:
      1. What is this file's job?
      2. What can I safely change vs. what will break callers?
      3. What side effects will my edit produce?
      4. Who else depends on this file?
      5. What patterns / conventions does this file follow?
    """

    # ── Identity ──────────────────────────────────────────────────────────
    file_path: str          # Relative to workspace root, forward slashes.
    file_name: str

    # ── Ownership ─────────────────────────────────────────────────────────
    assigned_agent_id: Optional[str] = None
    assigned_agent_name: Optional[str] = None

    # ── Purpose (the most important field) ───────────────────────────────
    # 2-3 sentences.  NOT a description of what the code does — a description
    # of the ROLE this file plays in the system and why it exists.
    purpose: str

    # Single-sentence module contract: "Given X, this module guarantees Y."
    # If the LLM keeps this contract intact, callers won't break.
    module_contract: Optional[str] = None

    # ── Technical metadata ────────────────────────────────────────────────
    language: str
    framework: Optional[str] = None
    runtime_context: Optional[Literal[
        "browser", "node", "edge", "worker",
        "serverless", "python_async", "python_sync",
    ]] = None

    # ── Public API surface ────────────────────────────────────────────────
    # What this file exports — the LLM must preserve these names/shapes
    # when refactoring, because callers use them.
    exports: List[str] = []

    # What this file imports from OTHER modules in this project.
    # Enables the LLM to understand coupling before it moves things around.
    internal_imports: List[str] = []

    # Third-party / stdlib imports (just the module names, not full paths).
    external_imports: List[str] = []

    # ── Callables ─────────────────────────────────────────────────────────
    functions: List[FunctionSignature] = []
    classes: List[ClassSignature] = []

    # ── Data flow ─────────────────────────────────────────────────────────
    # What data enters this module and from where?
    # e.g. ["req.body validated by Zod schema AuthPayload",
    #        "DB rows from UserRepository.findById"]
    consumes: List[str] = []

    # What data does this module produce and who receives it?
    # e.g. ["JWT string → returned to authController",
    #        "user_logged_in event → EventBus"]
    produces: List[str] = []

    # ── State & side-effect surface ───────────────────────────────────────
    # Aggregate of all side effects across all functions —
    # gives the LLM a quick "danger profile" for the whole file.
    aggregate_side_effects: List[SideEffect] = []

    # Does this file hold any module-level state (singletons, caches, maps)?
    # If yes, concurrency bugs live here.
    module_level_state: Optional[str] = None

    # ── Quality signals ───────────────────────────────────────────────────
    # Overall complexity 1-5.
    complexity_score: int = 1

    # Known issues the LLM should be aware of before editing.
    known_issues: List[str] = []

    # Technical debt that the LLM should not accidentally entrench.
    tech_debt: List[str] = []

    # Lines of code — context for whether a refactor is risky.
    loc: Optional[int] = None

    # Test coverage: "none", "partial", "full"
    test_coverage: Literal["none", "partial", "full"] = "none"

    # Path to the test file for this module (if any).
    test_file: Optional[str] = None

    # ── Change history (compressed) ───────────────────────────────────────
    # The REASON for the most recent change — not what changed, but WHY.
    # Prevents the LLM from re-introducing what was just removed.
    last_change_reason: Optional[str] = None

    # Brief summary of the last LLM-generated analysis.
    ai_summary: Optional[str] = None

    # ── Timestamps ────────────────────────────────────────────────────────
    created_at: str
    updated_at: str


# ─────────────────────────────────────────────────────────────────────────────
# Folder context  —  the LLM's view of a directory (bounded context)
# ─────────────────────────────────────────────────────────────────────────────

class FolderBoundaryRule(BaseModel):
    """
    An explicit rule about what this folder does and does NOT own.
    These are the rules that, when violated, cause architectural rot.
    """
    rule: str
    reason: str
    # "hard" = never violate.  "soft" = discuss before violating.
    strictness: Literal["hard", "soft"] = "hard"


class FolderContext(BaseModel):
    """
    The LLM's view of a directory as a bounded context.

    The key insight: a folder isn't just a grouping — it's a DOMAIN BOUNDARY.
    The LLM needs to know:
      1. What does this folder own?  What does it NOT own?
      2. How do files inside communicate with the outside world?
      3. What patterns are expected inside here?
      4. Who is responsible for changes here?
    """

    # ── Identity ──────────────────────────────────────────────────────────
    folder_path: str
    folder_name: str

    # ── Ownership ─────────────────────────────────────────────────────────
    assigned_agent_id: Optional[str] = None
    assigned_agent_name: Optional[str] = None

    # ── Domain responsibility ─────────────────────────────────────────────
    # 2-3 sentences on the DOMAIN PROBLEM this folder solves.
    # Not "this folder contains services" but "this folder owns the payment
    # processing domain: charging, refunding, and reconciling transactions".
    purpose: str

    # Explicit list of responsibilities.  The LLM will not add logic that
    # falls outside these without flagging it.
    responsibilities: List[str] = []

    # ── Boundary rules ────────────────────────────────────────────────────
    boundary_rules: List[FolderBoundaryRule] = []

    # ── Interface surface ─────────────────────────────────────────────────
    # The public entry points of this folder — what callers use.
    # Usually the index.ts / __init__.py exports.
    public_api: List[str] = []

    # What does this folder depend on from other folders?
    # Use folder paths, not file paths — keeps it readable.
    depends_on: List[str] = []

    # What other folders depend on THIS folder?
    depended_on_by: List[str] = []

    # ── Patterns & conventions ────────────────────────────────────────────
    # Design patterns used here: "repository", "factory", "observer", etc.
    # The LLM will follow these when generating new code in this folder.
    patterns_used: List[str] = []

    # Naming conventions specific to this folder.
    # e.g. ["Services are named *Service.ts",
    #        "DTOs are named *Request.ts / *Response.ts"]
    naming_conventions: List[str] = []

    # ── Files ─────────────────────────────────────────────────────────────
    files: List[FileContext] = []

    # ── Quality & risk ────────────────────────────────────────────────────
    # Files in this folder that are highest-risk to change.
    high_risk_files: List[str] = []

    # Known architectural smells in this folder.
    architectural_issues: List[str] = []

    # ── Summary ───────────────────────────────────────────────────────────
    summary: str

    created_at: str
    updated_at: str


# ─────────────────────────────────────────────────────────────────────────────
# Project-level global context
# ─────────────────────────────────────────────────────────────────────────────

class ArchitectureDecision(BaseModel):
    """
    An Architecture Decision Record (ADR) — compressed.
    These are the "why" behind structural choices.  Without them, an LLM
    will "fix" something that was intentionally built that way.
    """
    id: str                  # e.g. "ADR-001"
    title: str
    status: Literal["proposed", "accepted", "deprecated", "superseded"]
    decision: str            # What was decided, in one sentence.
    rationale: str           # Why. This is what prevents the LLM from undoing it.
    consequences: str        # What this decision constrains going forward.
    superseded_by: Optional[str] = None
    date: str


class DataFlowEdge(BaseModel):
    """One directed data-flow edge in the system."""
    from_module: str
    to_module: str
    data_description: str    # What flows: "user JWT", "order rows", "payment event"
    protocol: Optional[str] = None   # "HTTP", "WebSocket", "event-bus", "direct call"


class EnvVariable(BaseModel):
    """Catalogue of env vars — the LLM should never hardcode these."""
    name: str
    description: str
    required: bool
    example_value: Optional[str] = None
    used_in: List[str] = []   # File paths that consume this variable.


class GlobalConfig(BaseModel):
    """
    Project-level intelligence that every agent inherits.

    This is what makes the difference between an LLM that:
    (a) generates code consistent with the project's architecture, and
    (b) generates superficially correct code that breaks on review.

    Everything here answers: "What does an LLM need to know to behave
    like a senior engineer who has been on this team for 6 months?"
    """

    # ── Identity ──────────────────────────────────────────────────────────
    project_name: str
    project_goal: str        # One sentence: the product/system being built.
    tech_stack: List[str]

    # ── Architecture ──────────────────────────────────────────────────────
    # High-level architectural style: "layered", "hexagonal", "event-driven",
    # "micro-frontends", "modular monolith", "microservices", etc.
    architecture_style: Optional[str] = None

    # Where is the authoritative business logic?  Helps the LLM avoid
    # putting domain logic in the wrong layer.
    business_logic_location: Optional[str] = None

    # ── Invariants (the most important section) ───────────────────────────
    # Things that MUST ALWAYS be true, regardless of what the LLM is asked
    # to do.  Violating these causes security bugs, data corruption, etc.
    #
    # Examples:
    #   "All database writes go through the repository layer — never raw SQL
    #    in controllers."
    #   "Every HTTP handler must call authenticate() before accessing req.user."
    #   "The payments folder must never import from the users folder directly."
    invariants: List[str] = []

    # ── Cross-cutting rules ───────────────────────────────────────────────
    # Rules that span multiple files/folders.
    # Unlike invariants (which are constraints), these are guidelines.
    cross_cutting_rules: List[str] = []

    # ── Architecture decisions ─────────────────────────────────────────────
    architecture_decisions: List[ArchitectureDecision] = []

    # ── Data flow ─────────────────────────────────────────────────────────
    data_flow: List[DataFlowEdge] = []

    # ── Folder agents ─────────────────────────────────────────────────────
    folder_agents: List[AgentConfig] = []

    # ── Environment ───────────────────────────────────────────────────────
    env_variables: List[EnvVariable] = []

    # ── Conventions ───────────────────────────────────────────────────────
    # Global naming conventions.
    naming_conventions: List[str] = []

    # Error handling strategy: "never throw from services, use Result<T>",
    # "all async handlers wrapped in asyncWrapper()", etc.
    error_handling_strategy: Optional[str] = None

    # Logging strategy: "structured JSON via logger.info()", etc.
    logging_strategy: Optional[str] = None

    # ── Known footguns ────────────────────────────────────────────────────
    # Patterns that look reasonable but cause bugs in THIS codebase.
    # This is gold for preventing LLM mistakes.
    #
    # Examples:
    #   "Do not use Date.now() directly — use the injected ClockService.
    #    Date.now() breaks time-based tests."
    #   "Do not add indexes to the users table without a migration review —
    #    it locks the table on our Postgres version."
    known_footguns: List[str] = []

    # ── Security surface ──────────────────────────────────────────────────
    auth_mechanism: Optional[str] = None    # "JWT", "session cookie", "API key", etc.
    # Entry points where untrusted input enters the system.
    input_trust_boundaries: List[str] = []

    # ── Timestamps ────────────────────────────────────────────────────────
    created_at: str
    updated_at: str


# ─────────────────────────────────────────────────────────────────────────────
# Agent config
# ─────────────────────────────────────────────────────────────────────────────

class AgentConfig(BaseModel):
    """
    An agent is a specialised AI persona with clear ownership boundaries.
    The LLM uses this to know: "Am I the right agent for this task?"
    and "What am I NOT allowed to touch?"
    """
    agent_id: str
    agent_name: str
    role: str
    description: Optional[str] = None

    # What this agent is responsible for — in plain language.
    responsibilities: List[str] = []

    # Folders this agent owns (primary responsibility).
    folders: List[str] = []

    # Files this agent owns outside of its folder ownership.
    files: Optional[List[str]] = None

    # What this agent can and cannot do — makes boundary explicit.
    can_do: List[str] = []
    cannot_do: List[str] = []

    # Other agents this agent needs to coordinate with and why.
    coordinates_with: List[Dict[str, str]] = []   # [{agent, reason}]

    # Technical domains this agent understands deeply.
    tech_scope: List[str] = []

    permissions: Optional[Dict[str, bool]] = None

    created_at: str
    updated_at: str


# ─────────────────────────────────────────────────────────────────────────────
# Version metadata  —  the changelog that actually informs future changes
# ─────────────────────────────────────────────────────────────────────────────

class ChangelogEntry(BaseModel):
    """
    One entry in the version changelog.

    The critical field is `why` — not what changed, but the REASON.
    Without this, the LLM will re-introduce what was just refactored out.
    """
    id: str
    type: Literal[
        "feature_added", "bug_fixed", "refactor",
        "performance_improvement", "security_fix",
        "breaking_change", "dependency_update",
        "test_added", "documentation",
        "architecture_change", "agent_boundary_change",
    ]
    # One sentence: what changed.
    what: str

    # One or two sentences: WHY this change was made.
    # This is what prevents regressions.
    why: str

    # What does this change break for callers / agents?
    breaking_impact: Optional[str] = None

    # If breaking, what must callers do to adapt?
    migration_notes: Optional[str] = None

    files_added: List[str] = []
    files_modified: List[str] = []
    files_deleted: List[str] = []

    functions_added: List[str] = []
    functions_removed: List[str] = []
    functions_signature_changed: List[str] = []

    agent_id: Optional[str] = None
    agent_name: Optional[str] = None
    timestamp: str


class VersionMeta(BaseModel):
    """
    Per-version metadata.  An LLM reading this knows:
      - What the intent of this version was
      - What changed and why
      - Whether it can safely depend on this version's contracts
    """
    version: str
    version_number: int
    parent_version: Optional[str] = None

    # One sentence: the engineering intent of this version.
    # e.g. "Extract payment logic into dedicated service layer."
    intent: str

    # Was anything in the public API removed or changed in a way that
    # breaks callers?  If yes, what?
    breaking_changes: Optional[str] = None

    # For breaking changes: what must be done to migrate from parent_version.
    migration_notes: Optional[str] = None

    created_at: str
    updated_at: str
    created_by: Optional[str] = None

    summary: str
    changelog: List[ChangelogEntry] = []


# ─────────────────────────────────────────────────────────────────────────────
# Cross-cutting intelligence  —  the dependency/impact graph
# ─────────────────────────────────────────────────────────────────────────────

class DependencyEdge(BaseModel):
    """One directed dependency between two files."""
    from_file: str
    to_file: str
    import_names: List[str] = []   # Specific symbols imported, not just the module.
    is_circular_risk: bool = False  # Flag if this edge is part of a cycle.


class ImpactEntry(BaseModel):
    """
    Pre-computed: if file X changes, what else might break?
    Saves the LLM from having to trace the graph manually.
    """
    changed_file: str
    # Files that directly import from changed_file.
    direct_dependents: List[str] = []
    # Files that transitively depend (one more hop).
    transitive_dependents: List[str] = []
    # Functions that will definitely need review if changed_file changes.
    critical_call_sites: List[str] = []


class CrossCuttingIndex(BaseModel):
    """
    Project-wide indices that let the LLM reason about the whole codebase
    without reading every file.  Written by the save coordinator.
    """
    version: str

    # Full dependency graph.
    dependency_edges: List[DependencyEdge] = []

    # Files with circular imports.
    circular_import_risks: List[List[str]] = []

    # Pre-computed impact entries for high-traffic files.
    impact_map: List[ImpactEntry] = []

    # Files with no test coverage that contain business logic.
    untested_critical_files: List[str] = []

    # Files that have changed most frequently (churn signal).
    high_churn_files: List[str] = []

    updated_at: str


























# from typing import List, Optional, Literal, Dict, Any
# from pydantic import BaseModel, ConfigDict
# from pydantic.alias_generators import to_camel

# class CurrentConfig(BaseModel):
#     model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)
    
#     active_version: str
#     latest_version: int
#     project_root: str
#     last_updated_at: str

# class AgentConfig(BaseModel):
#     agent_id: str
#     agent_name: str
#     role: str
#     description: Optional[str] = None
#     folders: List[str]
#     files: Optional[List[str]] = None
#     permissions: Optional[Dict[str, bool]] = None
#     created_at: str
#     updated_at: str


# class GlobalConfig(BaseModel):
#     project_name: str
#     project_goal: str
#     tech_stack: List[str]
#     folder_agents: List[AgentConfig]
#     architecture_decisions: List[str]
#     created_at: str
#     updated_at: str


# class FunctionSignature(BaseModel):
#     function_name: str
#     type: Literal["function", "method", "arrow-function", "class-method", "constructor"]
#     signature: str
#     parameters: List[Dict[str, Any]]
#     line_start: Optional[int] = None
#     line_end: Optional[int] = None
#     return_type: str
#     description: str
#     start_line: Optional[int] = None
#     end_line: Optional[int] = None
#     dependencies: Optional[List[str]] = None
#     last_updated_at: str


# class FileContext(BaseModel):
#     file_path: str
#     file_name: str
#     assigned_agent_id: Optional[str] = None
#     assigned_agent_name: Optional[str] = None
#     purpose: str
#     language: Optional[str] = None
#     framework: Optional[str] = None
#     imports: Optional[List[str]] = None
#     exports: Optional[List[str]] = None
#     functions: Optional[List[FunctionSignature]] = None
#     summary: str
#     created_at: str
#     updated_at: str


# class FolderContext(BaseModel):
#     folder_path: str
#     folder_name: str
#     assigned_agent_id: Optional[str] = None
#     assigned_agent_name: Optional[str] = None
#     purpose: str
#     responsibilities: List[str]
#     files: List[FileContext]
#     dependencies: Optional[List[str]] = None
#     summary: str
#     created_at: str
#     updated_at: str


# class DependencyContext(BaseModel):
#     name: str
#     version: str
#     description: Optional[str] = None
#     path: str
#     created_at: str
#     updated_at: str


# class ChangelogEntry(BaseModel):
#     id: str
#     type: Literal[
#         "file_created",
#         "file_updated",
#         "file_deleted",
#         "folder_created",
#         "folder_updated",
#         "folder_deleted",
#         "function_added",
#         "function_updated",
#         "function_removed",
#         "dependency_added",
#         "dependency_removed",
#         "architecture_decision_added",
#         "agent_assigned",
#         "agent_updated",
#     ]
#     target_path: Optional[str] = None
#     target_name: Optional[str] = None
#     description: str
#     old_value: Optional[str] = None
#     new_value: Optional[str] = None
#     agent_id: Optional[str] = None
#     agent_name: Optional[str] = None
#     timestamp: str
#     added_files: List[str]
#     modified_files: List[str]
#     deleted_files: List[str]
#     new_functions: List[str]
#     changed_functions: List[str]


# class VersionMeta(BaseModel):
#     version: str
#     version_number: int
#     parent_version: Optional[str] = None
#     created_at: str
#     updated_at: str
#     created_by: Optional[str] = None
#     summary: str
#     folders: List[str]
#     files: List[str]
#     changelog: List[ChangelogEntry]
