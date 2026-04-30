import * as vscode from "vscode";
import { initCF } from "./commands/initCF";
import { createFolder } from "./commands/createFolder";

export function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel("context-forge");
  outputChannel.appendLine('ContextForge extension is active.');
  context.subscriptions.push(outputChannel);
  context.subscriptions.push(initCF);
  context.subscriptions.push(createFolder);
}

export function deactivate() {}