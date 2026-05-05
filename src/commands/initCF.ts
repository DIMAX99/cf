import * as vscode from "vscode";
import { FileSystemService } from "../services/FileSystemService";
import { CurrentConfig, GlobalConfig } from "../utils/types";
import { createGlobalConfigTemplate } from "../utils/templates";

const initCF = vscode.commands.registerCommand("cf.initCF", async () => {
  const workspace = vscode.workspace.workspaceFolders?.[0];
  const outputChannel = vscode.window.createOutputChannel("context-forge");

  try {
    if (!workspace) {
      vscode.window.showErrorMessage("Please open a project folder first.");
      return;
    }

    const cfRootUri = vscode.Uri.joinPath(workspace.uri, ".contextforge");
    const currentJsonUri = vscode.Uri.joinPath(cfRootUri, "current.json");

    if (await FileSystemService.exists(currentJsonUri)) {
      vscode.window.showInformationMessage("Context-Forge is already initialized.");
      return;
    }

    const projectName = await vscode.window.showInputBox({
      prompt: "Enter project name",
      placeHolder: "e.g. My Awesome Project",
      validateInput: (value) => {
        if (!value || value.trim() === "") {
          return "Project name cannot be empty.";
        }
        return null;
      },
    });
    if (!projectName) {
      vscode.window.showInformationMessage("Context-Forge initialization cancelled.");
      return;
    }

    const projectGoal = await vscode.window.showInputBox({
      prompt: "Enter project goal",
      placeHolder: "e.g. ecommerce platform for handmade products, or internal tool for data analysis",
      validateInput: (value) => {
        if (!value || value.trim() === "") {
          return "Project goal cannot be empty.";
        }
        return null;
      },
    });
    if (!projectGoal) {
      vscode.window.showInformationMessage("Context-Forge initialization cancelled.");
      return;
    }

    const now = new Date().toISOString();
    const tempUri = vscode.Uri.joinPath(cfRootUri, "temp");
    const tempGlobalJsonUri = vscode.Uri.joinPath(tempUri, "global.json");
    const tempChangelogUri = vscode.Uri.joinPath(tempUri, "changelog.json");
    const tempFoldersUri = vscode.Uri.joinPath(tempUri, "folders");
    const tempFilesUri = vscode.Uri.joinPath(tempUri, "files");
    const tempAgentsUri = vscode.Uri.joinPath(tempUri, "agents");

    await FileSystemService.ensureDirectory(cfRootUri);
    await FileSystemService.ensureDirectory(tempUri);
    await FileSystemService.ensureDirectory(tempFoldersUri);
    await FileSystemService.ensureDirectory(tempFilesUri);
    await FileSystemService.ensureDirectory(tempAgentsUri);

    const currentConfig: CurrentConfig = {
      activeVersion: null,
      latestVersion: 0,
      projectRoot: workspace.uri.fsPath,
      lastUpdatedAt: now,
    };
    const globalConfig: GlobalConfig = createGlobalConfigTemplate(
      projectName.trim(),
      projectGoal.trim()
    );

    await FileSystemService.writeJSON(currentJsonUri, currentConfig);
    await FileSystemService.writeJSON(tempGlobalJsonUri, globalConfig);
    await FileSystemService.writeJSON(tempChangelogUri, []);

    outputChannel.appendLine("Context-Forge initialized successfully.");
    outputChannel.appendLine(`Created: ${cfRootUri.fsPath}`);
    outputChannel.appendLine(`Created: ${tempUri.fsPath}`);
    outputChannel.appendLine(`Created: ${tempFoldersUri.fsPath}`);
    outputChannel.appendLine(`Created: ${tempFilesUri.fsPath}`);
    outputChannel.appendLine(`Created: ${tempAgentsUri.fsPath}`);
    outputChannel.appendLine(`Created: ${currentJsonUri.fsPath}`);
    outputChannel.appendLine(`Created: ${tempGlobalJsonUri.fsPath}`);
    outputChannel.appendLine(`Created: ${tempChangelogUri.fsPath}`);
    outputChannel.show(true);

    vscode.window.showInformationMessage(
      "Context-Forge initialized with typed staging memory. Save changes to create v1."
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    outputChannel.appendLine(`Context-Forge init failed: ${message}`);
    outputChannel.show(true);

    vscode.window.showErrorMessage(`Context-Forge init failed: ${message}`);
  }
});

export { initCF };
