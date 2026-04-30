import * as vscode from "vscode";
import { CurrentConfig, GlobalConfig } from "../utils/types";

const initCF = vscode.commands.registerCommand("cf.initCF", async () => {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    const outputChannel = vscode.window.createOutputChannel("context-forge");
    if (!workspace) {
      vscode.window.showErrorMessage("Please open a project folder first.");
      return;
    }

    const root = workspace.uri;
    const cfFolder = vscode.Uri.joinPath(root, ".contextforge");
    const ve1=await vscode.Uri.joinPath(cfFolder, "v1");
    await vscode.workspace.fs.createDirectory(cfFolder);
    await vscode.workspace.fs.createDirectory(ve1);
    const current ={
      activeVersion: "v1",
      latestVersion: 1,
      projectRoot: root.fsPath,
      lastUpdatedAt: new Date().toISOString()
    } as CurrentConfig;

    const global = {
      projectName: workspace.name,
      projectGoal: "",
      techStack: [],
      folderAgents: [],
      architectureDecisions: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    } as GlobalConfig;
    
    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(cfFolder, "current.json"),
      Buffer.from(JSON.stringify(current, null, 2))
    );

    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(cfFolder, "global.json"),
      Buffer.from(JSON.stringify(global, null, 2))
    );
    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(ve1, "global.json"),
      Buffer.from(JSON.stringify(global, null, 2))
    );
    outputChannel.appendLine("Created .contextforge/current.json");
    outputChannel.appendLine("Created .contextforge/global.json");
    outputChannel.appendLine("Created .contextforge/v1/global.json");
    vscode.window.showInformationMessage("ContextForge initialized.");
  });
export { initCF };