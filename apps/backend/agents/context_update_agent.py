"""
Context Update Agent  —  Rich Analysis Edition
------------------------------------------------
This agent replaces the basic "summarise what changed" approach with a
genuine code intelligence pass.  The goal: produce context that makes
an LLM coding assistant meaningfully better, not just aware that a file
exists.

Key changes from the original:
  1.  AnalysisResult is much richer — contracts, side effects, data flow,
      footguns, complexity scores.
  2.  The system prompt gives the LLM an explicit mental model of what
      "useful context" means.
  3.  The changelog now captures WHY a change was made, not just what.
  4.  The validate_output_node builds a full FileContext with all the
      new fields populated.
"""

import json
import logging
import os
from typing import Any, Dict, List, Literal, Optional
from datetime import datetime

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_google_genai import ChatGoogleGenerativeAI
from langgraph.graph import StateGraph, END
from pydantic import BaseModel, ValidationError
from typing_extensions import TypedDict

from schemas.context import (
    FileContext,
    FunctionSignature,
    ClassSignature,
    ParameterDoc,
    SideEffect,
    ChangelogEntry,
)

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# State
# ─────────────────────────────────────────────────────────────────────────────

class ContextUpdateState(TypedDict):
    cf_root: str
    version: str
    agent_name: str
    file_path: str
    old_code: Dict[str, Any]
    new_code: Dict[str, Any]
    old_context: Optional[FileContext]
    diff_summary: str
    analyzed_changes: Optional[Dict[str, Any]]
    changelog_entry: Optional[str]
    updated_context: Optional[FileContext]
    validation_errors: List[str]
    retry_count: int


# ─────────────────────────────────────────────────────────────────────────────
# LLM output schema  —  what the analysis node extracts
# ─────────────────────────────────────────────────────────────────────────────

class AnalyzedParameter(BaseModel):
    name: str
    type: str
    optional: bool = False
    description: str
    allowedValues: List[str] = []
    nullable: bool = True


class AnalyzedSideEffect(BaseModel):
    kind: str
    description: str
    conditional: bool = False


class AnalyzedFunction(BaseModel):
    name: str
    kind: str
    # The contract is the single most important field —
    # it tells the LLM what callers depend on.
    contract: str
    signature: str
    parameters: List[AnalyzedParameter] = []
    returnType: str
    returnDescription: str
    lineStart: Optional[int] = None
    lineEnd: Optional[int] = None
    # 1-5 complexity score so the LLM knows how careful to be.
    complexity: int = 1
    sideEffects: List[AnalyzedSideEffect] = []
    # Other functions this calls — enables impact analysis.
    calls: List[str] = []
    throws: Optional[str] = None
    concurrencyNotes: Optional[str] = None
    performanceNotes: Optional[str] = None
    visibility: str = "internal"
    deprecated: bool = False
    deprecatedUseInstead: Optional[str] = None
    changeType: Literal["added", "removed", "modified", "unchanged"]


class AnalyzedClass(BaseModel):
    name: str
    kind: str
    contract: str
    properties: List[AnalyzedParameter] = []
    methods: List[AnalyzedFunction] = []
    extends: List[str] = []
    implements: List[str] = []
    lineStart: Optional[int] = None
    lineEnd: Optional[int] = None
    visibility: str = "public"
    changeType: Literal["added", "removed", "modified", "unchanged"]


class AnalysisResult(BaseModel):
    # ── The most important fields ────────────────────────────────────────
    # WHY this file exists — not what it does line by line.
    purpose: str

    # "Given X, this module guarantees Y."
    # Callers depend on this contract.  Preserve it.
    moduleContract: str

    # ── Runtime context ──────────────────────────────────────────────────
    runtimeContext: Optional[str] = None

    # ── API surface ───────────────────────────────────────────────────────
    exports: List[str] = []
    internalImports: List[str] = []
    externalImports: List[str] = []

    # ── Callables ─────────────────────────────────────────────────────────
    functions: List[AnalyzedFunction] = []
    classes: List[AnalyzedClass] = []

    # ── Data flow ─────────────────────────────────────────────────────────
    # What enters this module?
    consumes: List[str] = []
    # What does this module produce?
    produces: List[str] = []

    # ── State ─────────────────────────────────────────────────────────────
    # Module-level state (singletons, caches) — concurrency risk lives here.
    moduleLevelState: Optional[str] = None

    # ── Quality signals ───────────────────────────────────────────────────
    # Overall file complexity 1-5.
    complexityScore: int = 1

    # Things the LLM must know before editing this file.
    knownIssues: List[str] = []

    # Technical debt that must not be accidentally entrenched.
    techDebt: List[str] = []

    testCoverage: Literal["none", "partial", "full"] = "none"

    # ── Change metadata ───────────────────────────────────────────────────
    # WHY the code changed — not what.  This is the key regression-prevention field.
    changeReason: str

    # One sentence summary of the file's current state.
    aiSummary: str


# ─────────────────────────────────────────────────────────────────────────────
# LLM setup
# ─────────────────────────────────────────────────────────────────────────────

def create_llm() -> ChatGoogleGenerativeAI:
    api_key = os.getenv("GOOGLE_API_KEY")
    if not api_key:
        raise ValueError("GOOGLE_API_KEY environment variable not set")
    return ChatGoogleGenerativeAI(model="gemini-2.5-flash")


# ─────────────────────────────────────────────────────────────────────────────
# Node 1: Analyze changes
# ─────────────────────────────────────────────────────────────────────────────

ANALYSIS_SYSTEM_PROMPT = """\
You are a senior software engineer building a code intelligence index.
Your job is NOT to describe what the code does line-by-line.
Your job is to extract the information an LLM coding assistant needs
to edit this file correctly WITHOUT reading the source.

Think like the engineer who will be asked:
  "Can I safely rename this function?"
  "What breaks if I change this parameter type?"
  "Is it safe to call this in a loop?"
  "Will this function work in a browser environment?"

For EVERY function / class, ask yourself:
  1. What does the CALLER depend on?  (That's the contract.)
  2. What invisible effects does this produce?  (Those are side effects.)
  3. What would silently break if this were changed?  (That's the risk.)

Fields that matter most:
  - purpose / moduleContract: WHY this file exists in the system.
  - contract (per function): what callers can rely on.
  - sideEffects: db writes, HTTP calls, cache mutations, event emissions.
  - calls: which other functions/modules this calls — enables impact analysis.
  - changeReason: WHY the code changed (not what) — prevents regressions.
  - knownIssues: things an editor must know to avoid making things worse.
  - techDebt: patterns that should not be copied or entrenched.

Complexity scoring (1-5):
  1 = trivial getter/setter, 5 = high cognitive load, risky to change.

Be precise and terse.  Prose waists tokens.  Every word must earn its place.
"""


async def analyze_changes_node(state: ContextUpdateState) -> ContextUpdateState:
    logger.info(f"Analyzing changes for {state['file_path']}")

    base_llm = create_llm()
    llm = base_llm.with_structured_output(AnalysisResult).with_retry(stop_after_attempt=2)

    old_code_str = json.dumps(state["old_code"], indent=2) if state["old_code"] else "// No previous version"
    new_code_str = json.dumps(state["new_code"], indent=2) if state["new_code"] else "// File deleted"
    old_context_str = state["old_context"].model_dump_json(indent=2) if state["old_context"] else "No previous context"
    diff_str = state["diff_summary"]

    user_message = f"""Analyze this file change and produce rich context for a coding assistant.

FILE PATH: {state['file_path']}

PREVIOUS CODE:
```
{old_code_str}
```

NEW CODE:
```
{new_code_str}
```

PREVIOUS CONTEXT (if any):
{old_context_str}

DIFF SUMMARY:
{diff_str}

Extract the full analysis.  Pay special attention to:
- The module's CONTRACT (what callers rely on)
- Side effects of each function (db, http, cache, events, file I/O)
- WHY this change was made (infer from the diff if not obvious)
- Any known issues or tech debt introduced
- Complexity scores for each function"""

    try:
        result: AnalysisResult = await llm.ainvoke([
            SystemMessage(content=ANALYSIS_SYSTEM_PROMPT),
            HumanMessage(content=user_message),
        ])
        state["analyzed_changes"] = result.model_dump(exclude_none=True)
        logger.info("Analysis completed successfully")
    except Exception as e:
        logger.error(f"Analysis failed: {e}")
        state["validation_errors"].append(f"Analysis error: {str(e)}")

    return state


# ─────────────────────────────────────────────────────────────────────────────
# Node 2: Generate changelog entry
# ─────────────────────────────────────────────────────────────────────────────

CHANGELOG_SYSTEM_PROMPT = """\
You are writing a changelog entry for a code change.

The MOST IMPORTANT field is "why" — not what changed, but WHY.
The "why" field prevents future engineers (and LLMs) from re-introducing
what was just removed or from undoing a deliberate decision.

Bad why:  "Updated the authentication function."
Good why: "Removed in-memory token cache because it was returning stale tokens
          after password resets.  Tokens are now verified against the DB on
          every request.  Performance hit is acceptable (<5ms) given the bug severity."

Format your response as a JSON object with these fields:
  type:           one of: feature_added | bug_fixed | refactor |
                          performance_improvement | security_fix |
                          breaking_change | dependency_update |
                          test_added | documentation | architecture_change
  what:           one sentence — what changed
  why:            1-2 sentences — why it changed
  breakingImpact: (optional) what this breaks for callers
  migrationNotes: (optional) what callers must do to adapt

Return ONLY the JSON, no markdown fences.
"""


async def generate_changelog_node(state: ContextUpdateState) -> ContextUpdateState:
    logger.info(f"Generating changelog for {state['file_path']}")

    if not state["analyzed_changes"]:
        state["changelog_entry"] = json.dumps({
            "type": "refactor",
            "what": "File updated",
            "why": "Unable to determine reason — analysis failed",
        })
        return state

    llm = create_llm().with_retry(stop_after_attempt=2)
    analysis = state["analyzed_changes"]

    user_message = f"""Generate a changelog entry for this file change.

File: {state['file_path']}
Change reason from analysis: {analysis.get('changeReason', 'unknown')}

Functions added:   {[f['name'] for f in analysis.get('functions', []) if f.get('changeType') == 'added']}
Functions removed: {[f['name'] for f in analysis.get('functions', []) if f.get('changeType') == 'removed']}
Functions changed: {[f['name'] for f in analysis.get('functions', []) if f.get('changeType') == 'modified']}

Known issues introduced: {analysis.get('knownIssues', [])}
Tech debt introduced:    {analysis.get('techDebt', [])}

Previous module contract: {state['old_context'].module_contract if state.get('old_context') else 'N/A'}
New module contract:      {analysis.get('moduleContract', 'N/A')}

Diff summary: {state['diff_summary']}"""

    try:
        response = await llm.ainvoke([
            SystemMessage(content=CHANGELOG_SYSTEM_PROMPT),
            HumanMessage(content=user_message),
        ])
        state["changelog_entry"] = response.content.strip()
    except Exception as e:
        logger.error(f"Changelog generation failed: {e}")
        state["changelog_entry"] = json.dumps({
            "type": "refactor",
            "what": f"File {state['file_path']} updated",
            "why": f"Changelog generation failed: {str(e)}",
        })

    return state


# ─────────────────────────────────────────────────────────────────────────────
# Node 3: Validate & build FileContext
# ─────────────────────────────────────────────────────────────────────────────

def _detect_language(file_path: str) -> str:
    ext_map = {
        ".ts": "typescript", ".tsx": "typescriptreact",
        ".js": "javascript", ".jsx": "javascriptreact",
        ".py": "python", ".go": "go", ".rs": "rust",
        ".java": "java", ".cs": "csharp", ".rb": "ruby",
        ".php": "php", ".swift": "swift", ".kt": "kotlin",
        ".cpp": "cpp", ".c": "c",
    }
    ext = "." + file_path.rsplit(".", 1)[-1] if "." in file_path else ""
    return ext_map.get(ext.lower(), "unknown")


def _build_function_signature(f: Dict[str, Any]) -> FunctionSignature:
    """Convert analysis dict → rich FunctionSignature."""
    now = datetime.utcnow().isoformat()
    return FunctionSignature(
        name=f["name"],
        kind=f.get("kind", "function"),
        contract=f.get("contract", ""),
        signature=f.get("signature", ""),
        parameters=[
            ParameterDoc(
                name=p["name"],
                type=p["type"],
                optional=p.get("optional", False),
                description=p.get("description", ""),
                allowed_values=p.get("allowedValues"),
                nullable=p.get("nullable", True),
            )
            for p in f.get("parameters", [])
        ],
        return_type=f.get("returnType", "void"),
        return_description=f.get("returnDescription", ""),
        line_start=f.get("lineStart"),
        line_end=f.get("lineEnd"),
        complexity=f.get("complexity", 1),
        side_effects=[
            SideEffect(kind=se["kind"], description=se["description"],
                       conditional=se.get("conditional", False))
            for se in f.get("sideEffects", [])
        ],
        calls=f.get("calls", []),
        throws=f.get("throws"),
        concurrency_notes=f.get("concurrencyNotes"),
        performance_notes=f.get("performanceNotes"),
        visibility=f.get("visibility", "internal"),
        deprecated=f.get("deprecated", False),
        deprecated_use_instead=f.get("deprecatedUseInstead"),
        last_updated_at=now,
    )


def _build_class_signature(c: Dict[str, Any]) -> ClassSignature:
    return ClassSignature(
        name=c["name"],
        kind=c.get("kind", "class"),
        contract=c.get("contract", ""),
        properties=[
            ParameterDoc(
                name=p["name"],
                type=p["type"],
                optional=p.get("optional", False),
                description=p.get("description", ""),
            )
            for p in c.get("properties", [])
        ],
        methods=[_build_function_signature(m) for m in c.get("methods", [])],
        extends=c.get("extends", []),
        implements=c.get("implements", []),
        line_start=c.get("lineStart"),
        line_end=c.get("lineEnd"),
        visibility=c.get("visibility", "public"),
    )


async def validate_output_node(state: ContextUpdateState) -> ContextUpdateState:
    logger.info(f"Building FileContext for {state['file_path']}")

    if not state["analyzed_changes"]:
        logger.warning("Skipping validation — no analysis available")
        return state

    try:
        a = state["analyzed_changes"]
        now = datetime.utcnow().isoformat()

        # Build aggregate side effects from all functions.
        all_side_effects: List[SideEffect] = []
        for f in a.get("functions", []):
            for se in f.get("sideEffects", []):
                se_obj = SideEffect(
                    kind=se["kind"],
                    description=se["description"],
                    conditional=se.get("conditional", False),
                )
                if not any(x.kind == se_obj.kind and x.description == se_obj.description
                           for x in all_side_effects):
                    all_side_effects.append(se_obj)

        file_context = FileContext(
            file_path=state["file_path"],
            file_name=state["file_path"].split("/")[-1],

            purpose=a.get("purpose", ""),
            module_contract=a.get("moduleContract"),

            language=_detect_language(state["file_path"]),
            runtime_context=a.get("runtimeContext"),

            exports=a.get("exports", []),
            internal_imports=a.get("internalImports", []),
            external_imports=a.get("externalImports", []),

            functions=[
                _build_function_signature(f)
                for f in a.get("functions", [])
                if f.get("changeType") != "removed"
            ],
            classes=[
                _build_class_signature(c)
                for c in a.get("classes", [])
                if c.get("changeType") != "removed"
            ],

            consumes=a.get("consumes", []),
            produces=a.get("produces", []),

            aggregate_side_effects=all_side_effects,
            module_level_state=a.get("moduleLevelState"),

            complexity_score=a.get("complexityScore", 1),
            known_issues=a.get("knownIssues", []),
            tech_debt=a.get("techDebt", []),

            test_coverage=a.get("testCoverage", "none"),

            last_change_reason=a.get("changeReason"),
            ai_summary=a.get("aiSummary"),

            created_at=(
                state["old_context"].created_at
                if state["old_context"]
                else now
            ),
            updated_at=now,
        )

        state["updated_context"] = file_context
        logger.info("FileContext built successfully")

    except ValidationError as e:
        logger.error(f"Validation error: {e}")
        state["validation_errors"].append(f"Pydantic validation: {str(e)}")
        # Fallback: minimal context so we don't lose the file entirely.
        state["updated_context"] = FileContext(
            file_path=state["file_path"],
            file_name=state["file_path"].split("/")[-1],
            purpose="Context generation failed — see changelog",
            language=_detect_language(state["file_path"]),
            exports=[],
            internal_imports=[],
            external_imports=[],
            functions=[],
            classes=[],
            consumes=[],
            produces=[],
            aggregate_side_effects=[],
            known_issues=["Context generation failed"],
            tech_debt=[],
            test_coverage="none",
            ai_summary=f"Analysis failed: {str(e)}",
            created_at=(state["old_context"].created_at if state["old_context"]
                        else datetime.utcnow().isoformat()),
            updated_at=datetime.utcnow().isoformat(),
        )

    return state


# ─────────────────────────────────────────────────────────────────────────────
# Node 4: Write context (delegated to save_coordinator)
# ─────────────────────────────────────────────────────────────────────────────

async def write_context_node(state: ContextUpdateState) -> ContextUpdateState:
    """
    No-op — save_coordinator handles persistence to avoid path confusion.
    Keeping this node for graph completeness and future hooks.
    """
    logger.info(f"Context update complete for {state['file_path']} — save_coordinator will persist")
    return state


# ─────────────────────────────────────────────────────────────────────────────
# Graph
# ─────────────────────────────────────────────────────────────────────────────

def create_graph():
    workflow = StateGraph(ContextUpdateState)
    workflow.add_node("analyze_changes", analyze_changes_node)
    workflow.add_node("generate_changelog", generate_changelog_node)
    workflow.add_node("validate_output", validate_output_node)
    workflow.add_node("write_context", write_context_node)

    workflow.set_entry_point("analyze_changes")
    workflow.add_edge("analyze_changes", "generate_changelog")
    workflow.add_edge("generate_changelog", "validate_output")
    workflow.add_edge("validate_output", "write_context")
    workflow.add_edge("write_context", END)

    return workflow.compile()


context_update_graph = create_graph()


async def run_context_update(
    cf_root: str,
    version: str,
    file_path: str,
    old_code: Dict[str, Any],
    new_code: Dict[str, Any],
    old_context: Optional[FileContext],
    diff_summary: str,
) -> ContextUpdateState:
    initial_state: ContextUpdateState = {
        "cf_root": cf_root,
        "version": version,
        "agent_name": "context_update_agent",
        "file_path": file_path,
        "old_code": old_code,
        "new_code": new_code,
        "old_context": old_context,
        "diff_summary": diff_summary,
        "analyzed_changes": None,
        "changelog_entry": None,
        "updated_context": None,
        "validation_errors": [],
        "retry_count": 0,
    }

    result = await context_update_graph.ainvoke(initial_state)
    logger.info(f"Context update completed for {file_path}")
    if result["validation_errors"]:
        logger.warning(f"Validation errors: {result['validation_errors']}")

    return result









































# import json
# import logging
# import os
# from typing import TypedDict, Optional, List, Any, Dict
# from datetime import datetime

# from langchain_core.language_models import BaseLanguageModel
# from langchain_core.messages import HumanMessage, SystemMessage
# from langchain_google_genai import ChatGoogleGenerativeAI
# from langgraph.graph import StateGraph, END
# from pydantic import BaseModel, ValidationError

# from schemas.context import FileContext, FunctionSignature

# logger = logging.getLogger(__name__)


# class ContextUpdateState(TypedDict):
#     """State object for the context update agent workflow"""
#     cf_root: str  # Path to .contextforge from user's workspace
#     version: str  # Current version (e.g., "v2")
#     agent_name: str
#     file_path: str
#     old_code: Dict[str, Any]
#     new_code: Dict[str, Any]
#     old_context: Optional[FileContext]
#     diff_summary: str
#     analyzed_changes: Optional[Dict[str, Any]]
#     changelog_entry: Optional[str]
#     updated_context: Optional[FileContext]
#     validation_errors: List[str]
#     retry_count: int


# class FunctionChange(BaseModel):
#     """Function change metadata"""
#     name: str
#     change_type: str  # "added", "removed", "modified"
#     line_start: Optional[int] = None
#     line_end: Optional[int] = None
#     signature: str
#     return_type: str
#     parameters: List[Dict[str, Any]]
#     description: str
#     dependencies: Optional[List[str]] = None


# class ClassChange(BaseModel):
#     """Class change metadata"""
#     name: str
#     change_type: str  # "added", "removed", "modified"
#     line_start: Optional[int] = None
#     line_end: Optional[int] = None
#     methods: List[FunctionChange]
#     description: str


# class AnalysisResult(BaseModel):
#     """Structured output from LLM analysis"""
#     purpose: str
#     summary: str
#     functions_added: List[FunctionChange]
#     functions_removed: List[FunctionChange]
#     functions_modified: List[FunctionChange]
#     classes_added: List[ClassChange]
#     classes_removed: List[ClassChange]
#     classes_modified: List[ClassChange]
#     new_imports: List[str]
#     removed_imports: List[str]
#     new_exports: List[str]
#     removed_exports: List[str]


# def create_llm() -> ChatGoogleGenerativeAI:
#     """Create Gemini LLM instance via Google API"""
#     api_key = os.getenv("GOOGLE_API_KEY")
#     if not api_key:
#         raise ValueError("GOOGLE_API_KEY environment variable not set")
    
#     return ChatGoogleGenerativeAI(
#         model="gemini-2.5-flash"
#     )


# async def analyze_changes_node(state: ContextUpdateState) -> ContextUpdateState:
#     """
#     Node 1: Analyze code changes using LLM
#     Reads old code, new code, and old context, generates structured analysis
#     Uses Pydantic structured output to guarantee schema compliance
#     """
#     logger.info(f"Analyzing changes for {state['file_path']}")
    
#     # Create LLM, apply structured output, then retry
#     base_llm = create_llm()
#     llm = base_llm.with_structured_output(AnalysisResult).with_retry(stop_after_attempt=2)
    
#     old_code_str = json.dumps(state["old_code"], indent=2) if state["old_code"] else "// No old code"
#     new_code_str = json.dumps(state["new_code"], indent=2) if state["new_code"] else "// No new code"
#     old_context_str = state["old_context"].model_dump_json(indent=2) if state["old_context"] else "No previous context"
#     diff_str = state["diff_summary"]
    
#     system_prompt = """You are a code analysis expert. Analyze the differences between old and new code versions.

# Your task:
# 1. Identify all functions/classes that were added, removed, or modified
# 2. For each change, extract: line numbers, signature, parameters, return types, dependencies
# 3. Identify new/removed imports and exports
# 4. Summarize the overall purpose and impact of changes

# Return your analysis as structured data."""
    
#     user_message = f"""Analyze these code changes:

# OLD CODE:
# ```
# {old_code_str}
# ```

# NEW CODE:
# ```
# {new_code_str}
# ```

# PREVIOUS CONTEXT:
# {old_context_str}

# DIFF SUMMARY:
# {diff_str}

# Provide structured analysis with all function/class changes, imports, exports, and a summary."""
    
#     try:
#         # ainvoke is async and returns parsed Pydantic model directly
#         analysis_result: AnalysisResult = await llm.ainvoke([
#             SystemMessage(content=system_prompt),
#             HumanMessage(content=user_message)
#         ])
        
#         # Convert Pydantic model to dict for state storage
#         state["analyzed_changes"] = analysis_result.model_dump(exclude_none=True)
#         logger.info("Analysis completed successfully")
        
#     except Exception as e:
#         logger.error(f"Analysis failed: {str(e)}")
#         state["validation_errors"].append(f"Analysis error: {str(e)}")
#         # LangChain's with_retry will handle retries; no manual retry needed
    
#     return state


# async def generate_changelog_node(state: ContextUpdateState) -> ContextUpdateState:
#     """
#     Node 2: Generate human-readable changelog entry
#     Reads diff summary and analysis, writes changelog
#     """
#     logger.info(f"Generating changelog for {state['file_path']}")
    
#     if not state["analyzed_changes"]:
#         logger.warning("Skipping changelog - no analysis available")
#         state["changelog_entry"] = "Unable to generate changelog - analysis failed"
#         return state
    
#     llm = create_llm().with_retry(stop_after_attempt=2)  # Retry on failure
#     analysis = state["analyzed_changes"]
    
#     system_prompt = """You are a technical writer. Write a concise, user-friendly changelog entry describing code changes.
# Focus on: what was added, removed, modified, and why it matters for the codebase.
# Keep it under 200 words. Be specific but readable."""
    
#     user_message = f"""File: {state['file_path']}

# Changes summary:
# - Functions added: {len(analysis.get('functions_added', []))}
# - Functions removed: {len(analysis.get('functions_removed', []))}
# - Functions modified: {len(analysis.get('functions_modified', []))}
# - Classes added: {len(analysis.get('classes_added', []))}
# - Classes removed: {len(analysis.get('classes_removed', []))}
# - New imports: {', '.join(analysis.get('new_imports', [])[:3])}
# - Removed imports: {', '.join(analysis.get('removed_imports', [])[:3])}

# Write a concise changelog entry summarizing these changes."""
    
#     try:
#         # Use ainvoke for async non-blocking call
#         response = await llm.ainvoke([
#             SystemMessage(content=system_prompt),
#             HumanMessage(content=user_message)
#         ])
        
#         state["changelog_entry"] = response.content.strip()
#         logger.info("Changelog generated successfully")
        
#     except Exception as e:
#         logger.error(f"Changelog generation failed: {str(e)}")
#         state["changelog_entry"] = f"Error generating changelog: {str(e)}"
    
#     return state


# async def validate_output_node(state: ContextUpdateState) -> ContextUpdateState:
#     """
#     Node 3: Validate and convert LLM output into Pydantic FileContext
#     Creates FileContext from validated LLM analysis
#     """
#     logger.info(f"Validating context for {state['file_path']}")
    
#     if not state["analyzed_changes"]:
#         logger.warning("Skipping validation - no analysis available")
#         return state
    
#     try:
#         analysis = state["analyzed_changes"]
        
#         # Build function signatures from analysis
#         function_signatures: List[FunctionSignature] = []
        
#         # Process added functions
#         for func in analysis.get("functions_added", []):
#             function_signatures.append(
#                 FunctionSignature(
#                     function_name=func["name"],
#                     type="function",
#                     signature=func["signature"],
#                     parameters=func.get("parameters", []),
#                     line_start=func.get("line_start"),
#                     line_end=func.get("line_end"),
#                     return_type=func["return_type"],
#                     description=func["description"],
#                     dependencies=func.get("dependencies", []),
#                     last_updated_at=datetime.utcnow().isoformat(),
#                 )
#             )
        
#         # Process modified functions
#         for func in analysis.get("functions_modified", []):
#             function_signatures.append(
#                 FunctionSignature(
#                     function_name=func["name"],
#                     type="function",
#                     signature=func["signature"],
#                     parameters=func.get("parameters", []),
#                     line_start=func.get("line_start"),
#                     line_end=func.get("line_end"),
#                     return_type=func["return_type"],
#                     description=func["description"],
#                     dependencies=func.get("dependencies", []),
#                     last_updated_at=datetime.utcnow().isoformat(),
#                 )
#             )
        
#         # Create or update FileContext
#         file_context = FileContext(
#             file_path=state["file_path"],
#             file_name=state["file_path"].split("/")[-1],
#             purpose=analysis["purpose"],
#             language="python",  # Detect from file extension
#             imports=analysis.get("new_imports", []),
#             exports=analysis.get("new_exports", []),
#             functions=function_signatures if function_signatures else None,
#             summary=analysis["summary"],
#             created_at=state["old_context"].created_at if state["old_context"] else datetime.utcnow().isoformat(),
#             updated_at=datetime.utcnow().isoformat(),
#         )
        
#         state["updated_context"] = file_context
#         logger.info("Context validation successful")
        
#     except ValidationError as e:
#         logger.error(f"Validation error: {e}")
#         state["validation_errors"].append(f"Pydantic validation error: {str(e)}")
        
#         # Create minimal context as fallback (no recursive retry)
#         logger.info("Creating fallback context...")
#         state["updated_context"] = FileContext(
#             file_path=state["file_path"],
#             file_name=state["file_path"].split("/")[-1],
#             purpose="See changelog for details",
#             summary=state.get("changelog_entry", "Code updated"),
#             created_at=state["old_context"].created_at if state["old_context"] else datetime.utcnow().isoformat(),
#             updated_at=datetime.utcnow().isoformat(),
#         )
#     except Exception as e:
#         logger.error(f"Validation failed: {str(e)}")
#         state["validation_errors"].append(f"Validation exception: {str(e)}")
    
#     return state


# async def write_context_node(state: ContextUpdateState) -> ContextUpdateState:
#     """
#     Node 4: Persist updated context to disk
#     Writes FileContext to .contextforge and updates changelog
#     """
#     logger.info(f"Writing context for {state['file_path']}")
    
#     if not state["updated_context"]:
#         logger.warning("Skipping write - no updated context available")
#         return state
    
#     try:
#         # NOTE: save_coordinator will write the FileContext to disk
#         # We don't write here to avoid duplication and path confusion
#         logger.info(f"Context update complete - save_coordinator will persist to disk")
        
#         # DEPRECATED: These writes are now handled by save_coordinator
#         # which writes to cfRoot/version/global/contexts/ with base64-encoded filenames
#         # write_file_context(...)
#         # _append_changelog(...)
        
#         logger.info(f"Context written successfully for {state['file_path']}")
        
#     except Exception as e:
#         logger.error(f"Failed to write context: {str(e)}")
#         state["validation_errors"].append(f"Write error: {str(e)}")
    
#     return state


# def create_graph():
#     """
#     Create and compile the LangGraph workflow
#     Wires all nodes together with proper edges
#     """
#     workflow = StateGraph(ContextUpdateState)
    
#     # Add nodes
#     workflow.add_node("analyze_changes", analyze_changes_node)
#     workflow.add_node("generate_changelog", generate_changelog_node)
#     workflow.add_node("validate_output", validate_output_node)
#     workflow.add_node("write_context", write_context_node)
    
#     # Add edges
#     workflow.set_entry_point("analyze_changes")
#     workflow.add_edge("analyze_changes", "generate_changelog")
#     workflow.add_edge("generate_changelog", "validate_output")
#     workflow.add_edge("validate_output", "write_context")
#     workflow.add_edge("write_context", END)
    
#     # Compile
#     return workflow.compile()


# # Initialize the graph
# context_update_graph = create_graph()


# async def run_context_update(
#     cf_root: str,
#     version: str,
#     file_path: str,
#     old_code: Dict[str, Any],
#     new_code: Dict[str, Any],
#     old_context: Optional[FileContext],
#     diff_summary: str,
# ) -> ContextUpdateState:
#     """
#     Execute the context update agent workflow
    
#     Args:
#         cf_root: Path to .contextforge from user's workspace
#         version: Current version (e.g., "v2")
#         file_path: Path to the file being updated
#         old_code: Previous code content
#         new_code: New code content
#         old_context: Previous FileContext object (if exists)
#         diff_summary: Human-readable diff summary from frontend
    
#     Returns:
#         Updated ContextUpdateState with results
#     """
    
#     initial_state: ContextUpdateState = {
#         "cf_root": cf_root,
#         "version": version,
#         "agent_name": "context_update_agent",
#         "file_path": file_path,
#         "old_code": old_code,
#         "new_code": new_code,
#         "old_context": old_context,
#         "diff_summary": diff_summary,
#         "analyzed_changes": None,
#         "changelog_entry": None,
#         "updated_context": None,
#         "validation_errors": [],
#         "retry_count": 0,
#     }
    
#     # Run the graph
#     result = await context_update_graph.ainvoke(initial_state)
    
#     logger.info(f"Context update completed for {file_path}")
#     logger.info(f"Validation errors: {result['validation_errors']}")
    
#     return result
