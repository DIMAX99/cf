import {
    AgentConfig,
    AgentCoordination,
    ArchitectureDecision,
    ClassSignature,
    CrossCuttingIndex,
    ChangelogEntry,
    DataFlowEdge,
    DependencyContext,
    DependencyEdge,
    EnvVariable,
    FileContext,
    FolderBoundaryRule,
    FolderContext,
    FunctionKind,
    FunctionSignature,
    GlobalConfig,
    ImpactEntry,
    ParameterDoc,
    SideEffect,
    VersionMeta,
} from "./types/index";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function generateId(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function now(): string {
    return new Date().toISOString();
}

// ─────────────────────────────────────────────────────────────────────────────
// ParameterDoc
// ─────────────────────────────────────────────────────────────────────────────

export function createParameterDocTemplate(
    name: string,
    type: string
): ParameterDoc {
    return {
        name,
        type,
        optional: false,
        description: "",
        allowedValues: undefined,
        nullable: undefined,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// SideEffect
// ─────────────────────────────────────────────────────────────────────────────

export function createSideEffectTemplate(): SideEffect {
    return {
        kind: "db_read",
        description: "",
        conditional: undefined,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// FunctionSignature
// ─────────────────────────────────────────────────────────────────────────────

export function createFunctionSignatureTemplate(
    name: string,
    kind: FunctionKind
): FunctionSignature {
    return {
        name,
        kind,
        contract: "",
        signature: "",
        parameters: [],
        returnType: "",
        returnDescription: "",
        lineStart: undefined,
        lineEnd: undefined,
        complexity: 1,
        sideEffects: [],
        calls: [],
        throws: undefined,
        concurrencyNotes: undefined,
        performanceNotes: undefined,
        visibility: "internal",
        deprecated: false,
        deprecatedUseInstead: undefined,
        lastUpdatedAt: now(),
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// ClassSignature
// ─────────────────────────────────────────────────────────────────────────────

export function createClassSignatureTemplate(
    name: string
): ClassSignature {
    return {
        name,
        kind: "class",
        contract: "",
        properties: [],
        methods: [],
        extends: [],
        implements: [],
        lineStart: undefined,
        lineEnd: undefined,
        visibility: "internal",
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// FolderBoundaryRule
// ─────────────────────────────────────────────────────────────────────────────

export function createFolderBoundaryRuleTemplate(): FolderBoundaryRule {
    return {
        rule: "",
        reason: "",
        strictness: "soft",
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// FileContext
// ─────────────────────────────────────────────────────────────────────────────

export function createFileContextTemplate(
    fileName: string,
    agentName?: string,
    agentId?: string
): FileContext {
    return {
        filePath: "",
        fileName,
        assignedAgentId: agentId,
        assignedAgentName: agentName,
        purpose: "",
        moduleContract: undefined,
        language: "",
        framework: undefined,
        runtimeContext: "node",
        exports: [],
        internalImports: [],
        externalImports: [],
        functions: [],
        classes: [],
        consumes: [],
        produces: [],
        aggregateSideEffects: [],
        moduleLevelState: undefined,
        complexityScore: 1,
        knownIssues: [],
        techDebt: [],
        loc: undefined,
        testCoverage: "none",
        testFile: undefined,
        lastChangeReason: undefined,
        aiSummary: undefined,
        createdAt: now(),
        updatedAt: now(),
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// FolderContext
// ─────────────────────────────────────────────────────────────────────────────

export function createFolderContextTemplate(
    folderName: string,
    agentName?: string,
    agentId?: string
): FolderContext {
    return {
        folderPath: "",
        folderName,
        assignedAgentId: agentId,
        assignedAgentName: agentName,
        purpose: "",
        responsibilities: [],
        boundaryRules: [],
        publicApi: [],
        dependsOn: [],
        dependedOnBy: [],
        patternsUsed: [],
        namingConventions: [],
        files: [],
        highRiskFiles: [],
        architecturalIssues: [],
        summary: "",
        createdAt: now(),
        updatedAt: now(),
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// AgentCoordination
// ─────────────────────────────────────────────────────────────────────────────

export function createAgentCoordinationTemplate(
    agent: string
): AgentCoordination {
    return {
        agent,
        reason: "",
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// AgentConfig
// ─────────────────────────────────────────────────────────────────────────────

export function createAgentConfigTemplate(
    agentName: string,
    role: string
): AgentConfig {
    return {
        agentId: generateId(agentName.toLowerCase()),
        agentName,
        role,
        description: undefined,
        responsibilities: [],
        folders: [],
        files: undefined,
        canDo: [],
        cannotDo: [],
        coordinatesWith: [],
        techScope: [],
        permissions: {
            canRead: true,
            canWrite: true,
            canCreateFiles: true,
            canDeleteFiles: true,
        },
        createdAt: now(),
        updatedAt: now(),
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// ArchitectureDecision
// ─────────────────────────────────────────────────────────────────────────────

export function createArchitectureDecisionTemplate(
    id: string,
    title: string
): ArchitectureDecision {
    return {
        id,
        title,
        status: "proposed",
        decision: "",
        rationale: "",
        consequences: "",
        supersededBy: undefined,
        date: now(),
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// DataFlowEdge
// ─────────────────────────────────────────────────────────────────────────────

export function createDataFlowEdgeTemplate(
    fromModule: string,
    toModule: string
): DataFlowEdge {
    return {
        fromModule,
        toModule,
        dataDescription: "",
        protocol: undefined,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// EnvVariable
// ─────────────────────────────────────────────────────────────────────────────

export function createEnvVariableTemplate(name: string): EnvVariable {
    return {
        name,
        description: "",
        required: true,
        exampleValue: undefined,
        usedIn: [],
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// GlobalConfig
// ─────────────────────────────────────────────────────────────────────────────

export function createGlobalConfigTemplate(
    projectName: string,
    projectGoal: string
): GlobalConfig {
    return {
        projectName,
        projectGoal,
        techStack: [],
        architectureStyle: undefined,
        businessLogicLocation: undefined,
        invariants: [],
        crossCuttingRules: [],
        architectureDecisions: [],
        dataFlow: [],
        folderAgents: [],
        envVariables: [],
        namingConventions: [],
        errorHandlingStrategy: undefined,
        loggingStrategy: undefined,
        knownFootguns: [],
        authMechanism: undefined,
        inputTrustBoundaries: [],
        createdAt: now(),
        updatedAt: now(),
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// ChangelogEntry
// ─────────────────────────────────────────────────────────────────────────────

export function createChangelogEntryTemplate(
    agentId?: string,
    agentName?: string
): ChangelogEntry {
    return {
        id: generateId("change"),
        type: "feature_added",
        what: "",
        why: "",
        breakingImpact: undefined,
        migrationNotes: undefined,
        filesAdded: [],
        filesModified: [],
        filesDeleted: [],
        functionsAdded: [],
        functionsRemoved: [],
        functionsSignatureChanged: [],
        agentId,
        agentName,
        timestamp: now(),
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// VersionMeta
// ─────────────────────────────────────────────────────────────────────────────

export function createVersionMetaTemplate(
    version: string,
    versionNumber: number,
    createdBy?: string
): VersionMeta {
    return {
        version,
        versionNumber,
        parentVersion: undefined,
        intent: "",
        breakingChanges: undefined,
        migrationNotes: undefined,
        createdAt: now(),
        updatedAt: now(),
        createdBy,
        summary: "",
        changelog: [],
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// DependencyEdge
// ─────────────────────────────────────────────────────────────────────────────

export function createDependencyEdgeTemplate(
    fromFile: string,
    toFile: string
): DependencyEdge {
    return {
        fromFile,
        toFile,
        importNames: [],
        isCircularRisk: undefined,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// ImpactEntry
// ─────────────────────────────────────────────────────────────────────────────

export function createImpactEntryTemplate(changedFile: string): ImpactEntry {
    return {
        changedFile,
        directDependents: [],
        transitiveDependents: [],
        criticalCallSites: [],
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// CrossCuttingIndex
// ─────────────────────────────────────────────────────────────────────────────

export function createCrossCuttingIndexTemplate(version: string): CrossCuttingIndex {
    return {
        version,
        dependencyEdges: [],
        circularImportRisks: [],
        impactMap: [],
        untestedCriticalFiles: [],
        highChurnFiles: [],
        updatedAt: now(),
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// DependencyContext
// ─────────────────────────────────────────────────────────────────────────────

export function createDependencyContextTemplate(
    name: string,
    version: string,
    path: string
): DependencyContext {
    return {
        name,
        version,
        description: undefined,
        path,
        createdAt: now(),
        updatedAt: now(),
    };
}