// ─────────────────────────────────────────────────────────────────────────────
// Context-Forge  —  Rich Context Types  (TypeScript)
// ─────────────────────────────────────────────────────────────────────────────
// Every field here answers the question an LLM has BEFORE editing code:
//   "What do I need to know to not break something?"
//
// Design rule: if a field doesn't help the LLM reason about correctness,
// it doesn't belong here.
// ─────────────────────────────────────────────────────────────────────────────

export interface CurrentConfig {
  activeVersion: string;
  latestVersion: number;
  projectRoot: string;
  lastUpdatedAt: string;
}

// ─── Parameter / return types ─────────────────────────────────────────────

export interface ParameterDoc {
  name: string;
  type: string;
  optional: boolean;
  description: string;
  /** Enumerate valid values so the LLM doesn't guess */
  allowedValues?: string[];
  /** True if the caller can pass null/undefined */
  nullable?: boolean;
}

export type SideEffectKind =
  | "db_read" | "db_write" | "db_delete"
  | "http_call" | "file_read" | "file_write"
  | "cache_read" | "cache_write" | "cache_invalidate"
  | "event_emit" | "event_subscribe"
  | "env_read" | "global_state_mutate"
  | "log_write" | "metric_emit"
  | "auth_check" | "session_mutate";

export interface SideEffect {
  kind: SideEffectKind;
  /** Plain-English description: "writes the user row to the users table" */
  description: string;
  /** True if the effect only happens under certain conditions */
  conditional?: boolean;
}

// ─── Function & class signatures ──────────────────────────────────────────

export type FunctionKind =
  | "function" | "method" | "arrow_function" | "class_method"
  | "constructor" | "generator" | "async_function"
  | "hook" | "middleware" | "decorator";

export interface FunctionSignature {
  name: string;
  kind: FunctionKind;

  /**
   * One sentence: what this callable GUARANTEES to its caller.
   * Not a description of implementation — a contract.
   * e.g. "Returns the user record or throws NotFoundError. Never returns null."
   */
  contract: string;

  /** Full signature as it appears in source for copy-paste accuracy */
  signature: string;

  parameters: ParameterDoc[];
  returnType: string;

  /**
   * What does the return value represent?
   * e.g. "null means record not found, never throws on missing"
   */
  returnDescription: string;

  lineStart?: number;
  lineEnd?: number;

  /**
   * Complexity 1-5.
   * 1 = trivial getter, 5 = high cognitive load, risky to edit.
   * The LLM uses this to decide how careful to be.
   */
  complexity: number;

  /** Observable effects beyond the return value */
  sideEffects: SideEffect[];

  /** Other functions/symbols this function calls — for impact analysis */
  calls: string[];

  /** Under what conditions does this throw / reject? */
  throws?: string;

  /**
   * Concurrency and idempotency notes.
   * e.g. "not thread-safe", "idempotent — safe to retry", "must be called once per request"
   */
  concurrencyNotes?: string;

  /**
   * Performance characteristics.
   * e.g. "O(n²) on large arrays", "adds ~200ms cold-start latency on Lambda"
   */
  performanceNotes?: string;

  visibility: "public" | "internal" | "private";

  deprecated?: boolean;
  /** If deprecated, what should callers use instead? */
  deprecatedUseInstead?: string;

  lastUpdatedAt: string;
}

export interface ClassSignature {
  name: string;
  kind: "class" | "abstract_class" | "interface" | "type_alias"
    | "enum" | "dataclass" | "pydantic_model" | "zod_schema";

  /** What invariant does this type enforce? */
  contract: string;

  properties: ParameterDoc[];
  methods: FunctionSignature[];
  extends: string[];
  implements: string[];
  lineStart?: number;
  lineEnd?: number;
  visibility: "public" | "internal" | "private";
}

// ─── File context ──────────────────────────────────────────────────────────

export interface FileContext {
  // ── Identity ──────────────────────────────────────────────────────────
  filePath: string;   // Relative to workspace root, forward slashes
  fileName: string;

  // ── Ownership ─────────────────────────────────────────────────────────
  assignedAgentId?: string;
  assignedAgentName?: string;

  // ── Purpose ───────────────────────────────────────────────────────────
  /**
   * 2-3 sentences on WHY this file exists — its role in the system,
   * not a description of what the code does line by line.
   */
  purpose: string;

  /**
   * "Given X, this module guarantees Y."
   * The LLM preserves this contract when refactoring.
   */
  moduleContract?: string;

  // ── Technical metadata ────────────────────────────────────────────────
  language: string;
  framework?: string;
  runtimeContext?: "browser" | "node" | "edge" | "worker"
    | "serverless" | "python_async" | "python_sync";

  // ── Public API surface ────────────────────────────────────────────────
  /**
   * Exported symbols — the LLM must not rename/remove these
   * without checking all call sites.
   */
  exports: string[];

  /**
   * Imports from OTHER modules in this project.
   * Tells the LLM about coupling before it moves things.
   */
  internalImports: string[];

  /** Third-party / stdlib imports (module names only) */
  externalImports: string[];

  // ── Callables ─────────────────────────────────────────────────────────
  functions: FunctionSignature[];
  classes: ClassSignature[];

  // ── Data flow ─────────────────────────────────────────────────────────
  /**
   * What data enters this module and from where?
   * e.g. ["req.body validated by Zod AuthPayload", "rows from UserRepo.findById"]
   */
  consumes: string[];

  /**
   * What does this module produce and who receives it?
   * e.g. ["JWT string → returned to authController", "user_logged_in → EventBus"]
   */
  produces: string[];

  // ── State & side effects ──────────────────────────────────────────────
  /** Aggregate of all side effects across all functions in this file */
  aggregateSideEffects: SideEffect[];

  /**
   * Module-level state (singletons, caches, module-scoped maps).
   * If present, concurrency bugs live here.
   */
  moduleLevelState?: string;

  // ── Quality signals ───────────────────────────────────────────────────
  /** 1=trivial, 5=very high cognitive load */
  complexityScore: number;

  /** Known issues the LLM must be aware of before editing */
  knownIssues: string[];

  /** Technical debt the LLM should not accidentally entrench */
  techDebt: string[];

  loc?: number;
  testCoverage: "none" | "partial" | "full";
  testFile?: string;

  // ── Change history ────────────────────────────────────────────────────
  /**
   * WHY the most recent change was made — not what changed.
   * This is the single most powerful field for preventing regressions.
   * e.g. "Removed caching layer because it was returning stale auth tokens."
   */
  lastChangeReason?: string;

  /** LLM-generated plain-English summary of the file's current state */
  aiSummary?: string;

  // ── Timestamps ────────────────────────────────────────────────────────
  createdAt: string;
  updatedAt: string;
}

// ─── Folder context ────────────────────────────────────────────────────────

export interface FolderBoundaryRule {
  rule: string;
  reason: string;
  /** "hard" = never violate.  "soft" = discuss before violating */
  strictness: "hard" | "soft";
}

export interface FolderContext {
  // ── Identity ──────────────────────────────────────────────────────────
  folderPath: string;
  folderName: string;

  // ── Ownership ─────────────────────────────────────────────────────────
  assignedAgentId?: string;
  assignedAgentName?: string;

  // ── Domain responsibility ─────────────────────────────────────────────
  /**
   * 2-3 sentences on the DOMAIN PROBLEM this folder solves.
   * Not "this folder contains services" — "this folder owns the payment
   * domain: charging, refunding, and reconciling transactions."
   */
  purpose: string;

  /** Explicit list of responsibilities — what ONLY this folder does */
  responsibilities: string[];

  // ── Boundary rules ────────────────────────────────────────────────────
  /**
   * Explicit rules about what this folder owns and does NOT own.
   * When these are violated, architectural rot begins.
   */
  boundaryRules: FolderBoundaryRule[];

  // ── Interface surface ─────────────────────────────────────────────────
  /**
   * The public entry points — what callers from other folders use.
   * Usually the index.ts / __init__.py exports.
   */
  publicApi: string[];

  /** Other folders this folder imports from */
  dependsOn: string[];

  /** Other folders that import from this folder */
  dependedOnBy: string[];

  // ── Patterns & conventions ────────────────────────────────────────────
  /**
   * Design patterns used here.
   * The LLM will follow these when generating new code in this folder.
   */
  patternsUsed: string[];

  /**
   * Naming conventions specific to this folder.
   * e.g. ["Services are *Service.ts", "DTOs are *Request.ts / *Response.ts"]
   */
  namingConventions: string[];

  // ── Files ─────────────────────────────────────────────────────────────
  files: FileContext[];

  // ── Quality & risk ────────────────────────────────────────────────────
  highRiskFiles: string[];
  architecturalIssues: string[];

  summary: string;
  createdAt: string;
  updatedAt: string;
}

// ─── Project-level global context ─────────────────────────────────────────

export interface ArchitectureDecision {
  id: string;         // "ADR-001"
  title: string;
  status: "proposed" | "accepted" | "deprecated" | "superseded";
  /** What was decided, in one sentence */
  decision: string;
  /** Why — this prevents the LLM from undoing it */
  rationale: string;
  /** What this constrains going forward */
  consequences: string;
  supersededBy?: string;
  date: string;
}

export interface DataFlowEdge {
  fromModule: string;
  toModule: string;
  /** What flows: "user JWT", "order rows", "payment event" */
  dataDescription: string;
  protocol?: string;   // "HTTP", "WebSocket", "event-bus", "direct call"
}

export interface EnvVariable {
  name: string;
  description: string;
  required: boolean;
  exampleValue?: string;
  usedIn: string[];
}

export interface GlobalConfig {
  // ── Identity ──────────────────────────────────────────────────────────
  projectName: string;
  projectGoal: string;
  techStack: string[];

  // ── Architecture ──────────────────────────────────────────────────────
  architectureStyle?: string;
  businessLogicLocation?: string;

  // ── Invariants (most important) ───────────────────────────────────────
  /**
   * Things that MUST ALWAYS be true regardless of what the LLM is editing.
   * Violating these causes security bugs or data corruption.
   *
   * Examples:
   *   "All DB writes go through the repository layer — never raw queries in controllers."
   *   "Every HTTP handler must call authenticate() before accessing req.user."
   */
  invariants: string[];

  /** Cross-cutting guidelines (softer than invariants) */
  crossCuttingRules: string[];

  // ── Architecture decisions ─────────────────────────────────────────────
  architectureDecisions: ArchitectureDecision[];

  // ── Data flow ─────────────────────────────────────────────────────────
  dataFlow: DataFlowEdge[];

  // ── Agents ────────────────────────────────────────────────────────────
  folderAgents: AgentConfig[];

  // ── Environment ───────────────────────────────────────────────────────
  envVariables: EnvVariable[];

  // ── Conventions ───────────────────────────────────────────────────────
  namingConventions: string[];
  errorHandlingStrategy?: string;
  loggingStrategy?: string;

  // ── Known footguns ────────────────────────────────────────────────────
  /**
   * Patterns that look reasonable but cause bugs in THIS codebase.
   * These are the single most valuable lines of context for an LLM.
   *
   * Examples:
   *   "Do not use Date.now() — use injected ClockService. Breaks time tests."
   *   "Do not add DB indexes without a migration review — table-locks on our PG version."
   */
  knownFootguns: string[];

  // ── Security ──────────────────────────────────────────────────────────
  authMechanism?: string;
  inputTrustBoundaries: string[];

  createdAt: string;
  updatedAt: string;
}

// ─── Agent config ──────────────────────────────────────────────────────────

export interface AgentCoordination {
  agent: string;
  reason: string;
}

export interface AgentConfig {
  agentId: string;
  agentName: string;
  role: string;
  description?: string;

  responsibilities: string[];
  folders: string[];
  files?: string[];

  /** What this agent is explicitly allowed to do */
  canDo: string[];
  /** What this agent must NOT do — prevents boundary violations */
  cannotDo: string[];

  /** Other agents this agent should coordinate with and why */
  coordinatesWith: AgentCoordination[];

  techScope: string[];

  permissions?: {
    canRead: boolean;
    canWrite: boolean;
    canCreateFiles: boolean;
    canDeleteFiles: boolean;
  };

  createdAt: string;
  updatedAt: string;
}

// ─── Changelog & version meta ─────────────────────────────────────────────

export type ChangeType =
  | "feature_added" | "bug_fixed" | "refactor"
  | "performance_improvement" | "security_fix"
  | "breaking_change" | "dependency_update"
  | "test_added" | "documentation"
  | "architecture_change" | "agent_boundary_change";

export interface ChangelogEntry {
  id: string;
  type: ChangeType;

  /** One sentence: what changed */
  what: string;

  /**
   * One or two sentences: WHY this change was made.
   * This is what prevents the LLM from re-introducing regressions.
   * e.g. "Removed Redis caching because it was returning stale auth tokens
   *       after password resets — bug report #247."
   */
  why: string;

  /** What does this break for callers? */
  breakingImpact?: string;

  /** If breaking, what must callers do to adapt? */
  migrationNotes?: string;

  filesAdded: string[];
  filesModified: string[];
  filesDeleted: string[];

  functionsAdded: string[];
  functionsRemoved: string[];
  functionsSignatureChanged: string[];

  agentId?: string;
  agentName?: string;
  timestamp: string;
}

export interface VersionMeta {
  version: string;
  versionNumber: number;
  parentVersion?: string;

  /**
   * One sentence: the engineering INTENT of this version.
   * e.g. "Extract payment processing into a dedicated service layer."
   */
  intent: string;

  /** Were any public APIs removed or broken? If yes, describe. */
  breakingChanges?: string;

  /** What must be done to migrate from parentVersion? */
  migrationNotes?: string;

  createdAt: string;
  updatedAt: string;
  createdBy?: string;

  summary: string;
  changelog: ChangelogEntry[];
}

// ─── Cross-cutting index ───────────────────────────────────────────────────

export interface DependencyEdge {
  fromFile: string;
  toFile: string;
  /** Specific symbols imported — not just the module */
  importNames: string[];
  isCircularRisk?: boolean;
}

export interface ImpactEntry {
  changedFile: string;
  directDependents: string[];
  transitiveDependents: string[];
  criticalCallSites: string[];
}

export interface CrossCuttingIndex {
  version: string;
  dependencyEdges: DependencyEdge[];
  circularImportRisks: string[][];
  impactMap: ImpactEntry[];
  untestedCriticalFiles: string[];
  highChurnFiles: string[];
  updatedAt: string;
}

// ─── Dependency context ────────────────────────────────────────────────────

export interface DependencyContext {
  name: string;
  version: string;
  description?: string;
  path: string;
  createdAt: string;
  updatedAt: string;
}



























// export interface CurrentConfig {
//   activeVersion: string;
//   latestVersion: number;
//   projectRoot: string;
//   lastUpdatedAt: string;
// }

// export interface GlobalConfig {
//   projectName: string;
//   projectGoal: string;
//   techStack: string[];

//   folderAgents: AgentConfig[];

//   architectureDecisions: string[];

//   createdAt: string;
//   updatedAt: string;
// }

// export interface AgentConfig {
//   agentId: string;
//   agentName: string;

//   role: string;
//   description?: string;

//   folders: string[];
//   files?: string[];

//   permissions?: {
//     canRead: boolean;
//     canWrite: boolean;
//     canCreateFiles: boolean;
//     canDeleteFiles: boolean;
//   };

//   createdAt: string;
//   updatedAt: string;
// }

// export interface FolderContext {
//   folderPath: string;
//   folderName: string;

//   assignedAgentId?: string;
//   assignedAgentName?: string;

//   purpose: string;
//   responsibilities: string[];

//   files: FileContext[];

//   dependencies?: string[];

//   summary: string;

//   createdAt: string;
//   updatedAt: string;
// }

// export interface FileContext {
//   filePath: string;
//   fileName: string;

//   assignedAgentId?: string;
//   assignedAgentName?: string;

//   purpose: string;

//   language?: string;
//   framework?: string;

//   imports?: string[];
//   exports?: string[];

//   functions?: FunctionSignature[];

//   summary: string;

//   createdAt: string;
//   updatedAt: string;
// }

// export interface FunctionSignature {
//   functionName: string;

//   type: "function" | "method" | "arrow-function" | "class-method" | "constructor";

//   signature: string;

//   parameters: {
//     name: string;
//     type: string;
//     optional?: boolean;
//     description?: string;
//   }[];
//   lineStart?: number;
//   lineEnd?: number;
//   returnType: string;

//   description: string;

//   startLine?: number;
//   endLine?: number;

//   dependencies?: string[];

//   lastUpdatedAt: string;
// }
// export interface DependencyContext {
//     name: string;
//     version: string;
//     description?: string;
//     path:string;
//     createdAt: string;
//     updatedAt: string;
// }
// export interface VersionMeta {
//   version: string;
//   versionNumber: number;

//   parentVersion?: string;

//   createdAt: string;
//   updatedAt: string;

//   createdBy?: string;

//   summary: string;

//   folders: string[];
//   files: string[];

//   changelog: ChangelogEntry[];
// }

// export interface ChangelogEntry {
//   id: string;

//   type:
//     | "file_created"
//     | "file_updated"
//     | "file_deleted"
//     | "folder_created"
//     | "folder_updated"
//     | "folder_deleted"
//     | "function_added"
//     | "function_updated"
//     | "function_removed"
//     | "dependency_added"
//     | "dependency_removed"
//     | "architecture_decision_added"
//     | "agent_assigned"
//     | "agent_updated";

//   targetPath?: string;
//   targetName?: string;

//   description: string;

//   oldValue?: string;
//   newValue?: string;

//   agentId?: string;
//   agentName?: string;

//   timestamp: string;

//   addedFiles: string[];
//   modifiedFiles: string[];
//   deletedFiles: string[];
//   newFunctions: string[];
//   changedFunctions: string[];
// }