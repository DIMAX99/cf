import * as vscode from "vscode";
import { CFStateManager } from "../core/CFStateManager";
import { FileSystemService } from "../services/FileSystemService";
import { AgentConfig, GlobalConfig } from "../utils/types";

interface AgentDefinition extends AgentConfig {
  responsibilities: string[];
  techScope: string[];
  provides: string[];
  canRead: string[];
  canWrite: string[];
}

const createAgent = vscode.commands.registerCommand("cf.createAgent", async () => {
  const outputChannel = vscode.window.createOutputChannel("context-forge");

  try {
    await CFStateManager.guardInitialized();

    // Prompt for agent name
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
      }
    });

    if (!agentName) {
      vscode.window.showInformationMessage("Agent creation cancelled.");
      return;
    }

    // Prompt for description
    const description = await vscode.window.showInputBox({
      prompt: "Enter agent description",
      placeHolder: "e.g. Handles authentication and authorization",
      validateInput: (value) => {
        if (!value || value.trim() === "") {
          return "Description cannot be empty.";
        }
        return null;
      }
    });

    if (!description) {
      vscode.window.showInformationMessage("Agent creation cancelled.");
      return;
    }

    // Prompt for responsibilities (comma separated)
    const responsibilitiesInput = await vscode.window.showInputBox({
      prompt: "Enter responsibilities (comma separated)",
      placeHolder: "e.g. Authentication, Session Management, Password Reset",
      validateInput: (value) => {
        if (!value || value.trim() === "") {
          return "At least one responsibility is required.";
        }
        return null;
      }
    });

    if (!responsibilitiesInput) {
      vscode.window.showInformationMessage("Agent creation cancelled.");
      return;
    }

    // Prompt for tech scope (comma separated)
    const techScopeInput = await vscode.window.showInputBox({
      prompt: "Enter technology scope (comma separated)",
      placeHolder: "e.g. Node.js, Express, JWT, bcrypt",
      validateInput: (value) => {
        if (!value || value.trim() === "") {
          return "At least one technology is required.";
        }
        return null;
      }
    });

    if (!techScopeInput) {
      vscode.window.showInformationMessage("Agent creation cancelled.");
      return;
    }

    // Parse comma-separated values
    const responsibilities = responsibilitiesInput
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);

    const techScope = techScopeInput
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);

    // Generate agent ID
    const agentId = `${agentName.toLowerCase()}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();

    // Build agent object
    const agent: AgentDefinition = {
      agentId,
      agentName,
      role: "Custom Agent",
      description,
      folders: [],
      files: [],
      permissions: {
        canRead: true,
        canWrite: true,
        canCreateFiles: true,
        canDeleteFiles: true
      },
      createdAt: now,
      updatedAt: now,
      responsibilities,
      techScope,
      provides: [],
      canRead: [],
      canWrite: []
    };

    const cfRoot = CFStateManager.getCFRoot();

    // 1. Write agent JSON to temp/agents/{agentName}.json
    const tempAgentsFolderUri = vscode.Uri.joinPath(cfRoot, "temp", "agents");
    await FileSystemService.ensureDirectory(tempAgentsFolderUri);

    const agentFileUri = vscode.Uri.joinPath(tempAgentsFolderUri, `${agentName}.json`);
    await FileSystemService.writeJSON(agentFileUri, agent);
    outputChannel.appendLine(`✓ Created agent file: temp/agents/${agentName}.json`);

    // 2. Add agent to temp/global.json so createFolder can find it
    const tempGlobalUri = vscode.Uri.joinPath(cfRoot, "temp", "global.json");
    const tempGlobal = await FileSystemService.readJSON<GlobalConfig>(tempGlobalUri);

    tempGlobal.folderAgents = tempGlobal.folderAgents || [];

    const alreadyExists = tempGlobal.folderAgents.some((a) => a.agentName === agentName);
    if (!alreadyExists) {
      tempGlobal.folderAgents.push(agent);
    }

    tempGlobal.updatedAt = now;
    await FileSystemService.writeJSON(tempGlobalUri, tempGlobal);
    outputChannel.appendLine(`✓ Added agent "${agentName}" to temp/global.json`);

    CFStateManager.invalidateCache();

    outputChannel.appendLine(`\nAgent Summary:`);
    outputChannel.appendLine(`  Name: ${agentName}`);
    outputChannel.appendLine(`  ID: ${agentId}`);
    outputChannel.appendLine(`  Description: ${description}`);
    outputChannel.appendLine(`  Responsibilities: ${responsibilities.join(", ")}`);
    outputChannel.appendLine(`  Tech Scope: ${techScope.join(", ")}`);
    outputChannel.appendLine(`\n✓ Agent creation completed successfully!`);
    outputChannel.show(true);

    vscode.window.showInformationMessage(
      `ContextForge: Created agent "${agentName}" successfully.`
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Failed to create agent: ${errorMessage}`);
    outputChannel.appendLine(`✗ Error: ${errorMessage}`);
    outputChannel.show(true);
  }
});

export { createAgent };