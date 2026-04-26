<div align="center">

# **Context-Forge**

</div>

## Description

Context-Forge is a VS Code extension designed to make projects context-aware for AI-assisted development.

Instead of forcing AI tools to repeatedly scan and understand an entire codebase, Context-Forge creates a structured memory system inside the project that stores architecture decisions, folder ownership, agent responsibilities, version snapshots, and project evolution over time.

It acts like a persistent intelligence layer for the codebase — allowing AI agents to work with precision, reduced token usage, stronger reasoning, and better long-term understanding of the project.

---

## Current Capabilities

### Project Initialization

Initializes a `.contextforge` workspace inside the project root and creates the foundational project structure for versioned context management.

This includes:

- Active version tracking
- Project metadata
- Architecture memory
- Agent mapping support
- Version-based project snapshots

---

### File Creation

Allows users to create tracked files inside the active project version.

Instead of loose file generation, files are created under the currently active Context-Forge version so the system can maintain structured historical understanding of project evolution.

This helps preserve:

- Feature progression
- Implementation history
- Design intent
- AI-readable development context

---

### Folder Creation + Agent Linking

Allows users to create folders and directly assign them to specific agents.

Each folder can be mapped to an existing agent or a newly created one, helping establish clear ownership boundaries inside the codebase.

This enables:

- Backend agent ownership
- Frontend agent ownership
- Infra/DevOps agent ownership
- Testing agent ownership
- Domain-based folder intelligence

This makes AI agents work with responsibility-aware architecture instead of blind repository access.

---

### Agent Management Foundation

Stores and manages reusable agents for the project.

Agents represent specialized responsibilities inside the codebase rather than generic assistants.

Examples:

- backend-agent
- frontend-agent
- database-agent
- deployment-agent
- security-agent

This creates a scalable multi-agent engineering workflow inside VS Code.

---

### Version-Based Project Memory

Every important action is tied to a project version (`v1`, `v2`, `v3`...).

This allows future support for:

- Architectural rollback
- Project evolution tracking
- Decision history
- Version-aware agent execution
- Snapshot-based reasoning

Instead of treating code as static, Context-Forge treats software development as an evolving system.

---

## Goal

The long-term goal of Context-Forge is to transform VS Code from a simple editor into an AI-native engineering environment where agents understand structure, ownership, reasoning, and history before making changes.

The objective is not autocomplete.

The objective is engineering intelligence.
