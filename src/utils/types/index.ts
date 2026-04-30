export interface CurrentConfig {
  activeVersion: string;
  latestVersion: number;
  projectRoot: string;
  lastUpdatedAt: string;
}

export interface GlobalConfig {
  projectName: string;
  projectGoal: string;
  techStack: string[];

  folderAgents: AgentConfig[];

  architectureDecisions: string[];

  createdAt: string;
  updatedAt: string;
}

export interface AgentConfig {
  agentId: string;
  agentName: string;

  role: string;
  description?: string;

  folders: string[];
  files?: string[];

  permissions?: {
    canRead: boolean;
    canWrite: boolean;
    canCreateFiles: boolean;
    canDeleteFiles: boolean;
  };

  createdAt: string;
  updatedAt: string;
}

export interface FolderContext {
  folderPath: string;
  folderName: string;

  assignedAgentId?: string;
  assignedAgentName?: string;

  purpose: string;
  responsibilities: string[];

  files: FileContext[];

  dependencies?: string[];

  summary: string;

  createdAt: string;
  updatedAt: string;
}

export interface FileContext {
  filePath: string;
  fileName: string;

  assignedAgentId?: string;
  assignedAgentName?: string;

  purpose: string;

  language?: string;
  framework?: string;

  imports?: string[];
  exports?: string[];

  functions?: FunctionSignature[];

  summary: string;

  createdAt: string;
  updatedAt: string;
}

export interface FunctionSignature {
  functionName: string;

  type: "function" | "method" | "arrow-function" | "class-method" | "constructor";

  signature: string;

  parameters: {
    name: string;
    type: string;
    optional?: boolean;
    description?: string;
  }[];

  returnType: string;

  description: string;

  startLine?: number;
  endLine?: number;

  dependencies?: string[];

  lastUpdatedAt: string;
}
export interface DependencyContext {
    name: string;
    version: string;
    description?: string;
    path:string;
    createdAt: string;
    updatedAt: string;
}
export interface VersionMeta {
  version: string;
  versionNumber: number;

  parentVersion?: string;

  createdAt: string;
  updatedAt: string;

  createdBy?: string;

  summary: string;

  folders: string[];
  files: string[];

  changelog: ChangelogEntry[];
}

export interface ChangelogEntry {
  id: string;

  type:
    | "file_created"
    | "file_updated"
    | "file_deleted"
    | "folder_created"
    | "folder_updated"
    | "folder_deleted"
    | "function_added"
    | "function_updated"
    | "function_removed"
    | "dependency_added"
    | "dependency_removed"
    | "architecture_decision_added"
    | "agent_assigned"
    | "agent_updated";

  targetPath?: string;
  targetName?: string;

  description: string;

  oldValue?: string;
  newValue?: string;

  agentId?: string;
  agentName?: string;

  timestamp: string;
}