import * as vscode from "vscode";
import { createFolderContextTemplate, createAgentConfigTemplate } from "../utils/templates";
import { CFStateManager } from "../core/CFStateManager";
import { FileSystemService } from "../services/FileSystemService";
import { AgentConfig } from "../utils/types";
import { getTypedContextUri, toWorkspaceRelativePath } from "../utils/contextPaths";

const createFolder = vscode.commands.registerCommand("cf.createFolder", async () => {
  const outputChannel = vscode.window.createOutputChannel("context-forge");

  try {
    await CFStateManager.guardInitialized();

    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) {
      vscode.window.showErrorMessage("No workspace folder found.");
      return;
    }

    const folderName = await vscode.window.showInputBox({
      prompt: "Enter folder name",
      placeHolder: "e.g. src",
      validateInput: (value) => {
        if (!value || value.trim() === "") {
          return "Folder name cannot be empty.";
        }
        if (/[<>:"/\\|?*]/.test(value)) {
          return "Folder name contains invalid characters.";
        }
        return null;
      },
    });

    if (!folderName) {
      vscode.window.showInformationMessage("Folder creation cancelled.");
      return;
    }

    const realFolderUri = vscode.Uri.joinPath(workspace.uri, folderName.trim());
    const realFolderExists = await FileSystemService.exists(realFolderUri);
    if (realFolderExists) {
      vscode.window.showErrorMessage(`Folder "${folderName}" already exists in the workspace.`);
      return;
    }

    const cfRoot = CFStateManager.getCFRoot();
    const globalConfig = await CFStateManager.getGlobal();

    const agentOptions: Array<{
      label: string;
      description: string;
      agent: AgentConfig | undefined;
    }> = (globalConfig.folderAgents || []).map((agent) => ({
      label: agent.agentName,
      description: `Folders: ${agent.folders?.join(", ") || "None"} | ${agent.description || ""}`,
      agent,
    }));

    agentOptions.push({
      label: "Create New Agent",
      description: "Create and link a new agent",
      agent: undefined,
    });

    const selectedAgent = await vscode.window.showQuickPick(agentOptions, {
      placeHolder: "Select an agent for this folder",
    });

    if (!selectedAgent) {
      vscode.window.showInformationMessage("Folder creation cancelled.");
      return;
    }

    const folderRelativePath = toWorkspaceRelativePath(realFolderUri);
    let agent: AgentConfig | undefined = selectedAgent.agent;

    if (!agent) {
      const agentName = await vscode.window.showInputBox({
        prompt: "Enter new agent name",
        placeHolder: "e.g. AuthAgent, ComponentAgent",
        validateInput: (value) => {
          if (!value || value.trim() === "") {
            return "Agent name cannot be empty.";
          }
          if (/[<>:"/\\|?*]/.test(value)) {
            return "Agent name contains invalid characters.";
          }
          return null;
        },
      });

      if (!agentName) {
        vscode.window.showInformationMessage("Folder creation cancelled. No agent name provided.");
        return;
      }

      const description = await vscode.window.showInputBox({
        prompt: "Enter agent description",
        placeHolder: "e.g. Responsible for handling authentication related tasks",
        validateInput: (value) => {
          if (!value || value.trim() === "") {
            return "Agent description cannot be empty.";
          }
          return null;
        },
      });

      if (!description) {
        vscode.window.showInformationMessage("Folder creation cancelled. No agent description provided.");
        return;
      }

      agent = createAgentConfigTemplate(agentName.trim(), "Folder Agent");
      agent.description = description.trim();
      agent.folders = [folderRelativePath];
      globalConfig.folderAgents = globalConfig.folderAgents || [];
      globalConfig.folderAgents.push(agent);
    } else {
      agent.folders = agent.folders || [];
      if (!agent.folders.includes(folderRelativePath)) {
        agent.folders.push(folderRelativePath);
      }
    }

    await FileSystemService.ensureDirectory(realFolderUri);
    outputChannel.appendLine(`Created workspace folder: ${realFolderUri.fsPath}`);

    const agentsFolderUri = vscode.Uri.joinPath(cfRoot, "temp", "agents");
    const foldersFolderUri = vscode.Uri.joinPath(cfRoot, "temp", "folders");
    await FileSystemService.ensureDirectory(agentsFolderUri);
    await FileSystemService.ensureDirectory(foldersFolderUri);

    const agentFileUri = vscode.Uri.joinPath(agentsFolderUri, `${agent.agentId}.json`);
    await FileSystemService.writeJSON(agentFileUri, agent);
    outputChannel.appendLine(`Updated agent context: temp/agents/${agent.agentId}.json`);

    const folderContext = createFolderContextTemplate(
      folderName.trim(),
      agent.agentName,
      agent.agentId
    );
    folderContext.folderPath = folderRelativePath;

    const folderContextUri = getTypedContextUri(cfRoot, "temp", "folders", folderRelativePath);
    await FileSystemService.writeJSON(folderContextUri, folderContext);
    outputChannel.appendLine(`Created folder context: ${folderContextUri.fsPath}`);

    await CFStateManager.updateGlobal({ folderAgents: globalConfig.folderAgents });
    CFStateManager.invalidateCache();

    outputChannel.appendLine(
      `\nDone. Created folder "${folderRelativePath}" linked to agent "${agent.agentName}".`
    );
    outputChannel.show(true);

    vscode.window.showInformationMessage(
      `ContextForge: Created folder "${folderRelativePath}" linked to agent "${agent.agentName}".`
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Failed to create folder: ${errorMessage}`);
    outputChannel.appendLine(`Error: ${errorMessage}`);
    outputChannel.show(true);
  }
});

export { createFolder };
