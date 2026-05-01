import * as vscode from "vscode";
import { FileSystemService } from "../services/FileSystemService";
import { CurrentConfig, GlobalConfig } from "../utils/types";

type SnapshotEntry = {
  path: string;
  type: "file" | "directory";
  size?: number;
  createdAt?: number;
  updatedAt?: number;
};

type SnapshotConfig = {
  version: string;
  createdAt: string;
  workspaceName: string;
  workspaceRoot: string;
  entries: SnapshotEntry[];
};

const initCF = vscode.commands.registerCommand("cf.initCF", async () => {
  const workspace = vscode.workspace.workspaceFolders?.[0];
  const outputChannel = vscode.window.createOutputChannel("context-forge");

  try {
    if (!workspace) {
      vscode.window.showErrorMessage("Please open a project folder first.");
      return;
    }

    const now = new Date().toISOString();

    const cfRootUri = vscode.Uri.joinPath(workspace.uri, ".contextforge");
    const tempUri = vscode.Uri.joinPath(cfRootUri, "temp");
    const v1Uri = vscode.Uri.joinPath(cfRootUri, "v1");

    const currentJsonUri = vscode.Uri.joinPath(cfRootUri, "current.json");

    const tempGlobalJsonUri = vscode.Uri.joinPath(tempUri, "global.json");
    const v1GlobalJsonUri = vscode.Uri.joinPath(v1Uri, "global.json");

    const snapshotJsonUri = vscode.Uri.joinPath(v1Uri, "snapshot.json");

    await FileSystemService.ensureDirectory(cfRootUri);
    await FileSystemService.ensureDirectory(tempUri);
    await FileSystemService.ensureDirectory(v1Uri);

    const currentConfig: CurrentConfig = {
      activeVersion: "v1",
      latestVersion: 1,

      // Keep these only if your CurrentConfig type has them.
      // If your type only has activeVersion and latestVersion, remove these 2 lines.
      projectRoot: workspace.uri.fsPath,
      lastUpdatedAt: now,
    };

    const globalConfig: GlobalConfig = {
      projectName: workspace.name,
      projectGoal: "",
      techStack: [],

      folderAgents: [],
      architectureDecisions: [],

      createdAt: now,
      updatedAt: now,
    };

    const snapshot = await createWorkspaceSnapshot(workspace, now);

    await FileSystemService.writeJSON(currentJsonUri, currentConfig);

    await FileSystemService.writeJSON(tempGlobalJsonUri, globalConfig);
    await FileSystemService.writeJSON(v1GlobalJsonUri, globalConfig);

    await FileSystemService.writeJSON(snapshotJsonUri, snapshot);

    outputChannel.appendLine("Context-Forge initialized successfully.");
    outputChannel.appendLine(`Created: ${cfRootUri.fsPath}`);
    outputChannel.appendLine(`Created: ${tempUri.fsPath}`);
    outputChannel.appendLine(`Created: ${v1Uri.fsPath}`);
    outputChannel.appendLine(`Created: ${currentJsonUri.fsPath}`);
    outputChannel.appendLine(`Created: ${tempGlobalJsonUri.fsPath}`);
    outputChannel.appendLine(`Created: ${v1GlobalJsonUri.fsPath}`);
    outputChannel.appendLine(`Created: ${snapshotJsonUri.fsPath}`);
    outputChannel.show(true);

    vscode.window.showInformationMessage(
      "Context-Forge initialized: .contextforge/temp, .contextforge/v1, current.json, global.json, and snapshot.json created."
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    outputChannel.appendLine(`Context-Forge init failed: ${message}`);
    outputChannel.show(true);

    vscode.window.showErrorMessage(`Context-Forge init failed: ${message}`);
  }
});

async function createWorkspaceSnapshot(
  workspace: vscode.WorkspaceFolder,
  createdAt: string
): Promise<SnapshotConfig> {
  const files = await vscode.workspace.findFiles(
    new vscode.RelativePattern(workspace, "**/*"),
    "{**/.contextforge/**,**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**}"
  );

  const entries: SnapshotEntry[] = [];
  const directorySet = new Set<string>();

  for (const fileUri of files) {
    const relativePath = vscode.workspace.asRelativePath(fileUri, false);

    const parts = relativePath.split("/");
    let currentPath = "";

    for (let i = 0; i < parts.length - 1; i++) {
      currentPath = currentPath ? `${currentPath}/${parts[i]}` : parts[i];
      directorySet.add(currentPath);
    }

    const stat = await vscode.workspace.fs.stat(fileUri);

    entries.push({
      path: relativePath,
      type: "file",
      size: stat.size,
      createdAt: stat.ctime,
      updatedAt: stat.mtime,
    });
  }

  for (const directoryPath of directorySet) {
    entries.push({
      path: directoryPath,
      type: "directory",
    });
  }

  entries.sort((a, b) => a.path.localeCompare(b.path));

  return {
    version: "v1",
    createdAt,
    workspaceName: workspace.name,
    workspaceRoot: workspace.uri.fsPath,
    entries,
  };
}

export { initCF };