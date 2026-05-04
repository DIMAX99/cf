import * as vscode from "vscode";
import { initCF } from "./commands/initCF";
import { createFolder } from "./commands/createFolder";
import { createFile } from "./commands/createFile";
import { createAgent } from "./commands/createAgent";
import { saveChanges } from "./commands/saveChanges";

export function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel("context-forge");
  outputChannel.appendLine('ContextForge extension is active.');
  context.subscriptions.push(outputChannel);
  context.subscriptions.push(initCF);
  context.subscriptions.push(createFolder);
  context.subscriptions.push(createFile);
  context.subscriptions.push(createAgent);
  
  // Register saveChanges command
  context.subscriptions.push(
    vscode.commands.registerCommand("cf.saveChanges", () =>
      saveChanges(context)
    )
  );

  // Register refreshVersionHistory command (placeholder for sidebar refresh)
  context.subscriptions.push(
    vscode.commands.registerCommand("cf.refreshVersionHistory", async () => {
      // This can be extended to refresh the version history sidebar view
      vscode.window.showInformationMessage("Version history refreshed");
    })
  );
}

export function deactivate() {}