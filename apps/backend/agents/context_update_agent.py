import json
import logging
import os
from typing import TypedDict, Optional, List, Any, Dict
from datetime import datetime

from langchain_core.language_models import BaseLanguageModel
from langchain_core.messages import HumanMessage, SystemMessage
from langchain_google_genai import ChatGoogleGenerativeAI
from langgraph.graph import StateGraph, END
from pydantic import BaseModel, ValidationError

from schemas.context import FileContext, FunctionSignature
from memory.context_writer import write_file_context, _append_changelog

logger = logging.getLogger(__name__)


class ContextUpdateState(TypedDict):
    """State object for the context update agent workflow"""
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


class FunctionChange(BaseModel):
    """Function change metadata"""
    name: str
    change_type: str  # "added", "removed", "modified"
    line_start: Optional[int] = None
    line_end: Optional[int] = None
    signature: str
    return_type: str
    parameters: List[Dict[str, Any]]
    description: str
    dependencies: Optional[List[str]] = None


class ClassChange(BaseModel):
    """Class change metadata"""
    name: str
    change_type: str  # "added", "removed", "modified"
    line_start: Optional[int] = None
    line_end: Optional[int] = None
    methods: List[FunctionChange]
    description: str


class AnalysisResult(BaseModel):
    """Structured output from LLM analysis"""
    purpose: str
    summary: str
    functions_added: List[FunctionChange]
    functions_removed: List[FunctionChange]
    functions_modified: List[FunctionChange]
    classes_added: List[ClassChange]
    classes_removed: List[ClassChange]
    classes_modified: List[ClassChange]
    new_imports: List[str]
    removed_imports: List[str]
    new_exports: List[str]
    removed_exports: List[str]


def create_llm() -> ChatGoogleGenerativeAI:
    """Create Gemini LLM instance via Google API with retry and structured output"""
    api_key = os.getenv("GOOGLE_API_KEY")
    if not api_key:
        raise ValueError("GOOGLE_API_KEY environment variable not set")
    
    return ChatGoogleGenerativeAI(
        model="gemini-1.5-pro",  # Use gemini-2.0-flash for faster responses
        api_key=api_key,
        temperature=0.3,  # Lower temperature for consistent structure
    ).with_retry(stop_after_attempt=2)  # Retry once on failure


async def analyze_changes_node(state: ContextUpdateState) -> ContextUpdateState:
    """
    Node 1: Analyze code changes using LLM
    Reads old code, new code, and old context, generates structured analysis
    Uses Pydantic structured output to guarantee schema compliance
    """
    logger.info(f"Analyzing changes for {state['file_path']}")
    
    # LLM with structured output and retry built-in
    llm = create_llm().with_structured_output(AnalysisResult)
    
    old_code_str = json.dumps(state["old_code"], indent=2) if state["old_code"] else "// No old code"
    new_code_str = json.dumps(state["new_code"], indent=2) if state["new_code"] else "// No new code"
    old_context_str = state["old_context"].model_dump_json(indent=2) if state["old_context"] else "No previous context"
    diff_str = state["diff_summary"]
    
    system_prompt = """You are a code analysis expert. Analyze the differences between old and new code versions.

Your task:
1. Identify all functions/classes that were added, removed, or modified
2. For each change, extract: line numbers, signature, parameters, return types, dependencies
3. Identify new/removed imports and exports
4. Summarize the overall purpose and impact of changes

Return your analysis as structured data."""
    
    user_message = f"""Analyze these code changes:

OLD CODE:
```
{old_code_str}
```

NEW CODE:
```
{new_code_str}
```

PREVIOUS CONTEXT:
{old_context_str}

DIFF SUMMARY:
{diff_str}

Provide structured analysis with all function/class changes, imports, exports, and a summary."""
    
    try:
        # ainvoke is async and returns parsed Pydantic model directly
        analysis_result: AnalysisResult = await llm.ainvoke([
            SystemMessage(content=system_prompt),
            HumanMessage(content=user_message)
        ])
        
        # Convert Pydantic model to dict for state storage
        state["analyzed_changes"] = analysis_result.model_dump(exclude_none=True)
        logger.info("Analysis completed successfully")
        
    except Exception as e:
        logger.error(f"Analysis failed: {str(e)}")
        state["validation_errors"].append(f"Analysis error: {str(e)}")
        # LangChain's with_retry will handle retries; no manual retry needed
    
    return state


async def generate_changelog_node(state: ContextUpdateState) -> ContextUpdateState:
    """
    Node 2: Generate human-readable changelog entry
    Reads diff summary and analysis, writes changelog
    """
    logger.info(f"Generating changelog for {state['file_path']}")
    
    if not state["analyzed_changes"]:
        logger.warning("Skipping changelog - no analysis available")
        state["changelog_entry"] = "Unable to generate changelog - analysis failed"
        return state
    
    llm = create_llm()  # No structured output needed for free text
    analysis = state["analyzed_changes"]
    
    system_prompt = """You are a technical writer. Write a concise, user-friendly changelog entry describing code changes.
Focus on: what was added, removed, modified, and why it matters for the codebase.
Keep it under 200 words. Be specific but readable."""
    
    user_message = f"""File: {state['file_path']}

Changes summary:
- Functions added: {len(analysis.get('functions_added', []))}
- Functions removed: {len(analysis.get('functions_removed', []))}
- Functions modified: {len(analysis.get('functions_modified', []))}
- Classes added: {len(analysis.get('classes_added', []))}
- Classes removed: {len(analysis.get('classes_removed', []))}
- New imports: {', '.join(analysis.get('new_imports', [])[:3])}
- Removed imports: {', '.join(analysis.get('removed_imports', [])[:3])}

Write a concise changelog entry summarizing these changes."""
    
    try:
        # Use ainvoke for async non-blocking call
        response = await llm.ainvoke([
            SystemMessage(content=system_prompt),
            HumanMessage(content=user_message)
        ])
        
        state["changelog_entry"] = response.content.strip()
        logger.info("Changelog generated successfully")
        
    except Exception as e:
        logger.error(f"Changelog generation failed: {str(e)}")
        state["changelog_entry"] = f"Error generating changelog: {str(e)}"
    
    return state


async def validate_output_node(state: ContextUpdateState) -> ContextUpdateState:
    """
    Node 3: Validate and convert LLM output into Pydantic FileContext
    Creates FileContext from validated LLM analysis
    """
    logger.info(f"Validating context for {state['file_path']}")
    
    if not state["analyzed_changes"]:
        logger.warning("Skipping validation - no analysis available")
        return state
    
    try:
        analysis = state["analyzed_changes"]
        
        # Build function signatures from analysis
        function_signatures: List[FunctionSignature] = []
        
        # Process added functions
        for func in analysis.get("functions_added", []):
            function_signatures.append(
                FunctionSignature(
                    function_name=func["name"],
                    type="function",
                    signature=func["signature"],
                    parameters=func.get("parameters", []),
                    line_start=func.get("line_start"),
                    line_end=func.get("line_end"),
                    return_type=func["return_type"],
                    description=func["description"],
                    dependencies=func.get("dependencies", []),
                    last_updated_at=datetime.utcnow().isoformat(),
                )
            )
        
        # Process modified functions
        for func in analysis.get("functions_modified", []):
            function_signatures.append(
                FunctionSignature(
                    function_name=func["name"],
                    type="function",
                    signature=func["signature"],
                    parameters=func.get("parameters", []),
                    line_start=func.get("line_start"),
                    line_end=func.get("line_end"),
                    return_type=func["return_type"],
                    description=func["description"],
                    dependencies=func.get("dependencies", []),
                    last_updated_at=datetime.utcnow().isoformat(),
                )
            )
        
        # Create or update FileContext
        file_context = FileContext(
            file_path=state["file_path"],
            file_name=state["file_path"].split("/")[-1],
            purpose=analysis["purpose"],
            language="python",  # Detect from file extension
            imports=analysis.get("new_imports", []),
            exports=analysis.get("new_exports", []),
            functions=function_signatures if function_signatures else None,
            summary=analysis["summary"],
            created_at=state["old_context"].created_at if state["old_context"] else datetime.utcnow().isoformat(),
            updated_at=datetime.utcnow().isoformat(),
        )
        
        state["updated_context"] = file_context
        logger.info("Context validation successful")
        
    except ValidationError as e:
        logger.error(f"Validation error: {e}")
        state["validation_errors"].append(f"Pydantic validation error: {str(e)}")
        
        # Create minimal context as fallback (no recursive retry)
        logger.info("Creating fallback context...")
        state["updated_context"] = FileContext(
            file_path=state["file_path"],
            file_name=state["file_path"].split("/")[-1],
            purpose="See changelog for details",
            summary=state.get("changelog_entry", "Code updated"),
            created_at=state["old_context"].created_at if state["old_context"] else datetime.utcnow().isoformat(),
            updated_at=datetime.utcnow().isoformat(),
        )
    except Exception as e:
        logger.error(f"Validation failed: {str(e)}")
        state["validation_errors"].append(f"Validation exception: {str(e)}")
    
    return state


async def write_context_node(state: ContextUpdateState) -> ContextUpdateState:
    """
    Node 4: Persist updated context to disk
    Writes FileContext to .contextforge and updates changelog
    """
    logger.info(f"Writing context for {state['file_path']}")
    
    if not state["updated_context"]:
        logger.warning("Skipping write - no updated context available")
        return state
    
    try:
        cf_root = ".contextforge"  # Would come from config
        target_dir = "v1"  # Would come from current version
        folder_name = "code"
        
        # Write the file context
        write_file_context(
            cf_root=cf_root,
            target_dir=target_dir,
            folder_name=folder_name,
            context=state["updated_context"]
        )
        
        # Write changelog entry
        if state["changelog_entry"]:
            _append_changelog(
                cf_root=cf_root,
                entry_type="file_updated",
                target_path=state["file_path"],
                description=state["changelog_entry"]
            )
        
        logger.info(f"Context written successfully for {state['file_path']}")
        
    except Exception as e:
        logger.error(f"Failed to write context: {str(e)}")
        state["validation_errors"].append(f"Write error: {str(e)}")
    
    return state


def create_graph():
    """
    Create and compile the LangGraph workflow
    Wires all nodes together with proper edges
    """
    workflow = StateGraph(ContextUpdateState)
    
    # Add nodes
    workflow.add_node("analyze_changes", analyze_changes_node)
    workflow.add_node("generate_changelog", generate_changelog_node)
    workflow.add_node("validate_output", validate_output_node)
    workflow.add_node("write_context", write_context_node)
    
    # Add edges
    workflow.set_entry_point("analyze_changes")
    workflow.add_edge("analyze_changes", "generate_changelog")
    workflow.add_edge("generate_changelog", "validate_output")
    workflow.add_edge("validate_output", "write_context")
    workflow.add_edge("write_context", END)
    
    # Compile
    return workflow.compile()


# Initialize the graph
context_update_graph = create_graph()


async def run_context_update(
    file_path: str,
    old_code: Dict[str, Any],
    new_code: Dict[str, Any],
    old_context: Optional[FileContext],
    diff_summary: str,
) -> ContextUpdateState:
    """
    Execute the context update agent workflow
    
    Args:
        file_path: Path to the file being updated
        old_code: Previous code content
        new_code: New code content
        old_context: Previous FileContext object (if exists)
        diff_summary: Human-readable diff summary from frontend
    
    Returns:
        Updated ContextUpdateState with results
    """
    
    initial_state: ContextUpdateState = {
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
    
    # Run the graph
    result = await context_update_graph.ainvoke(initial_state)
    
    logger.info(f"Context update completed for {file_path}")
    logger.info(f"Validation errors: {result['validation_errors']}")
    
    return result
