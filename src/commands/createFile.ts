import * as vscode from "vscode";
import { createFileContextTemplate } from "../utils/templates";
import { CFStateManager } from "../core/CFStateManager";
import { FileSystemService } from "../services/FileSystemService";
import { FolderContext } from "../utils/types";

const createFile = vscode.commands.registerCommand("cf.createFile", async () => {
  const outputChannel = vscode.window.createOutputChannel("context-forge");

  try {
    await CFStateManager.guardInitialized();

    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) {
      vscode.window.showErrorMessage("No workspace folder found.");
      return;
    }

    // Prompt for file name
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
      }
    });

    if (!fileName) {
      vscode.window.showInformationMessage("File creation cancelled.");
      return;
    }

    // Get global config and build QuickPick of tracked folders
    const globalConfig = await CFStateManager.getGlobal();

    const folderOptions = globalConfig.folderAgents.flatMap((agent) =>
      agent.folders.map((folderName) => ({
        label: folderName,
        description: `Agent: ${agent.agentName}`,
        folderName,
        agentName: agent.agentName,
        agentId: agent.agentId
      }))
    );

    if (folderOptions.length === 0) {
      vscode.window.showErrorMessage(
        "No tracked folders found. Please create a folder first using 'ContextForge: Create Folder'."
      );
      return;
    }

    const selectedFolder = await vscode.window.showQuickPick(folderOptions, {
      placeHolder: "Select a folder for this file"
    });

    if (!selectedFolder) {
      vscode.window.showInformationMessage("File creation cancelled.");
      return;
    }

    // 1. Create the REAL file in the workspace folder
    const realFileUri = vscode.Uri.joinPath(
      workspace.uri,
      selectedFolder.folderName,
      fileName
    );

    // Ensure the real folder exists in workspace
    const realFolderUri = vscode.Uri.joinPath(workspace.uri, selectedFolder.folderName);
    await FileSystemService.ensureDirectory(realFolderUri);

    // Only create if it doesn't already exist
    const realFileExists = await FileSystemService.exists(realFileUri);
    if (realFileExists) {
      vscode.window.showErrorMessage(
        `File "${fileName}" already exists in "${selectedFolder.folderName}".`
      );
      return;
    }

    await vscode.workspace.fs.writeFile(realFileUri, new Uint8Array());
    outputChannel.appendLine(`✓ Created real file: ${realFileUri.fsPath}`);

    // 2. Create context file in .contextforge/temp/{folderName}/
    const cfRoot = CFStateManager.getCFRoot();
    const tempFolderUri = vscode.Uri.joinPath(cfRoot, "temp", selectedFolder.folderName);
    await FileSystemService.ensureDirectory(tempFolderUri);

    const fileContext = createFileContextTemplate(
      fileName,
      selectedFolder.agentName,
      selectedFolder.agentId
    );

    // filePath points to the REAL file, not the context file
    fileContext.filePath = realFileUri.fsPath;

    const fileContextUri = vscode.Uri.joinPath(tempFolderUri, `${fileName}.context.json`);
    await FileSystemService.writeJSON(fileContextUri, fileContext);
    outputChannel.appendLine(`✓ Created context file: ${fileContextUri.fsPath}`);

    // 3. Update _folder.context.json in temp/{folderName}/
    const folderContextUri = vscode.Uri.joinPath(tempFolderUri, "_folder.context.json");
    const folderContextExists = await FileSystemService.exists(folderContextUri);

    if (folderContextExists) {
      const folderContext = await FileSystemService.readJSON<FolderContext>(folderContextUri);

      if (!folderContext.files) {
        folderContext.files = [];
      }

      // Only add if not already tracked
      const alreadyTracked = folderContext.files.some((f) => f.fileName === fileName);
      if (!alreadyTracked) {
        folderContext.files.push({
          filePath: realFileUri.fsPath,
          fileName,
          assignedAgentId: selectedFolder.agentId,
          assignedAgentName: selectedFolder.agentName,
          purpose: "",
          summary: "",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
      }

      folderContext.updatedAt = new Date().toISOString();
      await FileSystemService.writeJSON(folderContextUri, folderContext);
      outputChannel.appendLine(`✓ Updated _folder.context.json: added ${fileName}`);
    } else {
      outputChannel.appendLine(
        `⚠ Warning: _folder.context.json not found in temp/${selectedFolder.folderName}. ` +
        `Run 'ContextForge: Create Folder' to initialize it.`
      );
    }

    CFStateManager.invalidateCache();

    outputChannel.appendLine(`\n✓ Done! Created "${fileName}" in "${selectedFolder.folderName}".`);
    outputChannel.show(true);

    vscode.window.showInformationMessage(
      `ContextForge: Created "${fileName}" in "${selectedFolder.folderName}".`
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Failed to create file: ${errorMessage}`);
    outputChannel.appendLine(`✗ Error: ${errorMessage}`);
    outputChannel.show(true);
  }
});

export { createFile };