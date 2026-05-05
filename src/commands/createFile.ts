import * as vscode from "vscode";
import { createFileContextTemplate } from "../utils/templates";
import { CFStateManager } from "../core/CFStateManager";
import { FileSystemService } from "../services/FileSystemService";
import { AgentConfig, FolderContext } from "../utils/types";
import { getTypedContextUri, toWorkspaceRelativePath } from "../utils/contextPaths";

const createFile = vscode.commands.registerCommand("cf.createFile", async () => {
  const outputChannel = vscode.window.createOutputChannel("context-forge");

  try {
    await CFStateManager.guardInitialized();

    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) {
      vscode.window.showErrorMessage("No workspace folder found.");
      return;
    }

    const fileName = await vscode.window.showInputBox({
      prompt: "Enter file name (with extension)",
      placeHolder: "e.g. utils.ts",
      validateInput: (value) => {
        if (!value || value.trim() === "") {
          return "File name cannot be empty.";
        }
        if (/[<>:"/\\|?*]/.test(value.replace(/\./g, ""))) {
          return "File name contains invalid characters.";
        }
        return null;
      },
    });

    if (!fileName) {
      vscode.window.showInformationMessage("File creation cancelled.");
      return;
    }

    const globalConfig = await CFStateManager.getGlobal();
    const folderOptions = (globalConfig.folderAgents || []).flatMap((agent) =>
      (agent.folders || []).map((folderPath) => ({
        label: folderPath,
        description: `Agent: ${agent.agentName}`,
        folderPath,
        agent,
      }))
    );

    if (folderOptions.length === 0) {
      vscode.window.showErrorMessage(
        "No tracked folders found. Please create a folder first using 'ContextForge: Create Folder'."
      );
      return;
    }

    const selectedFolder = await vscode.window.showQuickPick(folderOptions, {
      placeHolder: "Select a folder for this file",
    });

    if (!selectedFolder) {
      vscode.window.showInformationMessage("File creation cancelled.");
      return;
    }

    const realFolderUri = vscode.Uri.joinPath(workspace.uri, selectedFolder.folderPath);
    await FileSystemService.ensureDirectory(realFolderUri);

    const realFileUri = vscode.Uri.joinPath(realFolderUri, fileName.trim());
    const realFileExists = await FileSystemService.exists(realFileUri);
    if (realFileExists) {
      vscode.window.showErrorMessage(
        `File "${fileName}" already exists in "${selectedFolder.folderPath}".`
      );
      return;
    }

    await vscode.workspace.fs.writeFile(realFileUri, new Uint8Array());
    outputChannel.appendLine(`Created workspace file: ${realFileUri.fsPath}`);

    const cfRoot = CFStateManager.getCFRoot();
    const filesFolderUri = vscode.Uri.joinPath(cfRoot, "temp", "files");
    const foldersFolderUri = vscode.Uri.joinPath(cfRoot, "temp", "folders");
    const agentsFolderUri = vscode.Uri.joinPath(cfRoot, "temp", "agents");
    await FileSystemService.ensureDirectory(filesFolderUri);
    await FileSystemService.ensureDirectory(foldersFolderUri);
    await FileSystemService.ensureDirectory(agentsFolderUri);

    const fileRelativePath = toWorkspaceRelativePath(realFileUri);
    const fileContext = createFileContextTemplate(
      fileName.trim(),
      selectedFolder.agent.agentName,
      selectedFolder.agent.agentId
    );
    fileContext.filePath = fileRelativePath;

    const fileContextUri = getTypedContextUri(cfRoot, "temp", "files", fileRelativePath);
    await FileSystemService.writeJSON(fileContextUri, fileContext);
    outputChannel.appendLine(`Created file context: ${fileContextUri.fsPath}`);

    const folderContextUri = getTypedContextUri(
      cfRoot,
      "temp",
      "folders",
      selectedFolder.folderPath
    );
    if (await FileSystemService.exists(folderContextUri)) {
      const folderContext = await FileSystemService.readJSON<FolderContext>(folderContextUri);
      const alreadyTracked = (folderContext.files || []).some(
        (existingFile) => existingFile.filePath === fileRelativePath
      );
      if (!alreadyTracked) {
        folderContext.files = folderContext.files || [];
        folderContext.files.push(fileContext);
      }
      folderContext.updatedAt = new Date().toISOString();
      await FileSystemService.writeJSON(folderContextUri, folderContext);
      outputChannel.appendLine(`Updated folder context for ${selectedFolder.folderPath}`);
    } else {
      outputChannel.appendLine(
        `Warning: folder context not found for "${selectedFolder.folderPath}".`
      );
    }

    const agent = selectedFolder.agent as AgentConfig;
    agent.files = agent.files || [];
    if (!agent.files.includes(fileRelativePath)) {
      agent.files.push(fileRelativePath);
    }
    const agentFileUri = vscode.Uri.joinPath(agentsFolderUri, `${agent.agentId}.json`);
    await FileSystemService.writeJSON(agentFileUri, agent);
    outputChannel.appendLine(`Updated agent context: temp/agents/${agent.agentId}.json`);

    const globalAgent = globalConfig.folderAgents.find(
      (existingAgent) => existingAgent.agentId === agent.agentId
    );
    if (globalAgent) {
      globalAgent.files = globalAgent.files || [];
      if (!globalAgent.files.includes(fileRelativePath)) {
        globalAgent.files.push(fileRelativePath);
      }
      await CFStateManager.updateGlobal({ folderAgents: globalConfig.folderAgents });
      outputChannel.appendLine("Updated temp/global.json agent files list");
    }

    CFStateManager.invalidateCache();

    outputChannel.appendLine(
      `\nDone. Created "${fileRelativePath}" for agent "${agent.agentName}".`
    );
    outputChannel.show(true);

    vscode.window.showInformationMessage(
      `ContextForge: Created "${fileRelativePath}" successfully.`
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Failed to create file: ${errorMessage}`);
    outputChannel.appendLine(`Error: ${errorMessage}`);
    outputChannel.show(true);
  }
});

export { createFile };
