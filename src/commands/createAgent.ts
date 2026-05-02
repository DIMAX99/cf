import * as vscode from "vscode";
import { CFStateManager } from "../core/CFStateManager";
import { FileSystemService } from "../services/FileSystemService";
import { AgentConfig } from "../utils/types";

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
      vscode.window.showErrorMessage("Agent creation cancelled. No agent name provided.");
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
      vscode.window.showErrorMessage("Agent creation cancelled. No description provided.");
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
      vscode.window.showErrorMessage("Agent creation cancelled. No responsibilities provided.");
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
      vscode.window.showErrorMessage("Agent creation cancelled. No tech scope provided.");
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

    // Create agent object
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

    // Write agent JSON to temp/agents/{agentName}.json
    const cfRoot = CFStateManager.getCFRoot();
    const agentsFolder = vscode.Uri.joinPath(cfRoot, "agents");
    
    // Ensure agents folder exists
    try {
      await vscode.workspace.fs.createDirectory(agentsFolder);
    } catch {
      // Directory might already exist, continue
    }

    const agentFilePath = vscode.Uri.joinPath(agentsFolder, `${agentName}.json`);

    await FileSystemService.writeJSON(agentFilePath, agent);
    outputChannel.appendLine(`✓ Created agent: ${agentName}`);
    outputChannel.appendLine(`  Description: ${description}`);
    outputChannel.appendLine(`  Responsibilities: ${responsibilities.join(", ")}`);
    outputChannel.appendLine(`  Tech Scope: ${techScope.join(", ")}`);
    outputChannel.appendLine(`✓ Agent definition saved to: agents/${agentName}.json`);

    outputChannel.appendLine(`✓ Agent creation completed successfully!`);
    outputChannel.show();

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Failed to create agent: ${errorMessage}`);
    outputChannel.appendLine(`✗ Error: ${errorMessage}`);
    outputChannel.show();
  }
});

export { createAgent };
