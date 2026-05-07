import * as vscode from "vscode";
import { CFStateManager } from "../core/CFStateManager";
import { FileSystemService } from "../services/FileSystemService";
import { AgentConfig } from "../utils/types";
import { createAgentConfigTemplate } from "../utils/templates";

const createAgent = vscode.commands.registerCommand("cf.createAgent", async () => {
  const outputChannel = vscode.window.createOutputChannel("context-forge");

  try {
    await CFStateManager.guardInitialized();

    const agentName = await vscode.window.showInputBox({
      prompt: "Enter agent name",
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
      vscode.window.showInformationMessage("Agent creation cancelled.");
      return;
    }

    const description = await vscode.window.showInputBox({
      prompt: "Enter agent description",
      placeHolder: "e.g. Handles authentication and authorization",
      validateInput: (value) => {
        if (!value || value.trim() === "") {
          return "Description cannot be empty.";
        }
        return null;
      },
    });

    if (!description) {
      vscode.window.showInformationMessage("Agent creation cancelled.");
      return;
    }

    const responsibilitiesInput = await vscode.window.showInputBox({
      prompt: "Enter responsibilities (comma separated)",
      placeHolder: "e.g. Authentication, Session Management, Password Reset",
      validateInput: (value) => {
        if (!value || value.trim() === "") {
          return "At least one responsibility is required.";
        }
        return null;
      },
    });

    if (!responsibilitiesInput) {
      vscode.window.showInformationMessage("Agent creation cancelled.");
      return;
    }

    const techScopeInput = await vscode.window.showInputBox({
      prompt: "Enter technology scope (comma separated)",
      placeHolder: "e.g. Node.js, Express, JWT, bcrypt",
      validateInput: (value) => {
        if (!value || value.trim() === "") {
          return "At least one technology is required.";
        }
        return null;
      },
    });

    if (!techScopeInput) {
      vscode.window.showInformationMessage("Agent creation cancelled.");
      return;
    }

    const now = new Date().toISOString();
    const responsibilities = responsibilitiesInput
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    const techScope = techScopeInput
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);

    const agent: AgentConfig = createAgentConfigTemplate(agentName.trim(), "Project Agent");
    agent.description = description.trim();
    agent.responsibilities = responsibilities;
    agent.techScope = techScope;
    agent.createdAt = now;
    agent.updatedAt = now;

    const cfRoot = CFStateManager.getCFRoot();
    const tempAgentsFolderUri = vscode.Uri.joinPath(cfRoot, "temp", "agents");
    await FileSystemService.ensureDirectory(tempAgentsFolderUri);

    const agentFileUri = vscode.Uri.joinPath(tempAgentsFolderUri, `${agent.agentId}.json`);
    await FileSystemService.writeJSON(agentFileUri, agent);
    outputChannel.appendLine(`Created agent file: temp/agents/${agent.agentId}.json`);

    const globalConfig = await CFStateManager.getGlobal();
    globalConfig.folderAgents = globalConfig.folderAgents || [];

    const alreadyExists = globalConfig.folderAgents.some(
      (existingAgent) => existingAgent.agentName === agent.agentName
    );
    if (!alreadyExists) {
      globalConfig.folderAgents.push(agent);
    }

    await CFStateManager.updateGlobal({ folderAgents: globalConfig.folderAgents });
    CFStateManager.invalidateCache();

    outputChannel.appendLine(`Added agent "${agent.agentName}" to temp/global.json`);
    outputChannel.appendLine("\nAgent Summary:");
    outputChannel.appendLine(`  Name: ${agent.agentName}`);
    outputChannel.appendLine(`  ID: ${agent.agentId}`);
    outputChannel.appendLine(`  Description: ${agent.description}`);
    outputChannel.appendLine(`  Responsibilities: ${responsibilities.join(", ")}`);
    outputChannel.appendLine(`  Tech Scope: ${techScope.join(", ")}`);
    outputChannel.appendLine("\nAgent creation completed successfully!");
    outputChannel.show(true);

    vscode.window.showInformationMessage(
      `ContextForge: Created agent "${agent.agentName}" successfully.`
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Failed to create agent: ${errorMessage}`);
    outputChannel.appendLine(`Error: ${errorMessage}`);
    outputChannel.show(true);
  }
});

export { createAgent };
