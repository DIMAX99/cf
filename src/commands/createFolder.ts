import * as vscode from "vscode";
import { createFolderContextTemplate, createAgentConfigTemplate } from "../utils/templates";
import { CFStateManager } from "../core/CFStateManager";
import { FileSystemService } from "../services/FileSystemService";
import { GlobalConfig, AgentConfig } from "../utils/types";

const createFolder = vscode.commands.registerCommand("cf.createFolder", async () => {
  const outputChannel = vscode.window.createOutputChannel("context-forge");

  try {
    await CFStateManager.guardInitialized();

    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) {
      vscode.window.showErrorMessage("No workspace folder found.");
      return;
    }

    // 1. Prompt for folder name
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
      }
    });

    if (!folderName) {
      vscode.window.showInformationMessage("Folder creation cancelled.");
      return;
    }

    // Check if real folder already exists
    const realFolderUri = vscode.Uri.joinPath(workspace.uri, folderName);
    const realFolderExists = await FileSystemService.exists(realFolderUri);
    if (realFolderExists) {
      vscode.window.showErrorMessage(`Folder "${folderName}" already exists in the workspace.`);
      return;
    }

    // 2. Load temp/global.json (source of truth for temp changes)
    const cfRoot = CFStateManager.getCFRoot();
    const tempGlobalUri = vscode.Uri.joinPath(cfRoot, "temp", "global.json");
    const tempGlobal = await FileSystemService.readJSON<GlobalConfig>(tempGlobalUri);

    // 3. Build agent QuickPick from temp/global.json
    const agentOptions = tempGlobal.folderAgents?.map((agent) => ({
      label: agent.agentName,
      description: `Folders: ${agent.folders?.join(", ") || "None"} | ${agent.description || ""}`
    })) || [];

    agentOptions.push({
      label: "Create New Agent",
      description: "Create and link a new agent"
    });

    const selectedAgent = await vscode.window.showQuickPick(agentOptions, {
      placeHolder: "Select an agent for this folder"
    });

    if (!selectedAgent) {
      vscode.window.showInformationMessage("Folder creation cancelled.");
      return;
    }

    let agentName = selectedAgent.label;
    let agentId = "";

    // 4. Handle new agent or existing agent
    if (agentName === "Create New Agent") {
      agentName = await vscode.window.showInputBox({
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
        }
      }) || "";

      if (!agentName) {
        vscode.window.showInformationMessage("Folder creation cancelled. No agent name provided.");
        return;
      }

      const desc = await vscode.window.showInputBox({
        prompt: "Enter agent description",
        placeHolder: "e.g. Responsible for handling authentication related tasks",
        validateInput: (value) => {
          if (!value || value.trim() === "") {
            return "Agent description cannot be empty.";
          }
          return null;
        }
      }) || "";

      if (!desc) {
        vscode.window.showInformationMessage("Folder creation cancelled. No agent description provided.");
        return;
      }

      // Build new agent and write to temp/agents/{agentName}.json FIRST
      const newAgent = createAgentConfigTemplate(agentName, "Folder Agent");
      agentId = newAgent.agentId;
      newAgent.description = desc;
      newAgent.folders = [folderName];

      // Write agent to temp/agents/{agentName}.json with extended properties
      const agentsFolder = vscode.Uri.joinPath(cfRoot, "temp", "agents");
      try {
        await FileSystemService.ensureDirectory(agentsFolder);
      } catch {
        // Directory might already exist
      }
      const agentFilePath = vscode.Uri.joinPath(cfRoot, "temp", "agents", `${agentName}.json`);
      const agentFileData = {
        ...newAgent,
        canRead: [realFolderUri.fsPath],
        canWrite: [realFolderUri.fsPath],
        responsibilities: [],
        techScope: [],
        provides: []
      };
      await FileSystemService.writeJSON(agentFilePath, agentFileData);
      outputChannel.appendLine(`✓ Wrote agent definition to agents/${agentName}.json`);

      // Now add to temp/global.json
      tempGlobal.folderAgents = tempGlobal.folderAgents || [];
      tempGlobal.folderAgents.push(newAgent);

      outputChannel.appendLine(`✓ Created new agent: ${agentName} (ID: ${agentId})`);
    } else {
      // Link existing agent to this folder
      const agent = tempGlobal.folderAgents.find((a) => a.agentName === agentName);
      if (agent) {
        agentId = agent.agentId;
        agent.folders = agent.folders || [];
        if (!agent.folders.includes(folderName)) {
          agent.folders.push(folderName);
        }

        // Read existing agent from temp/agents/{agentName}.json and update it
        const agentFilePath = vscode.Uri.joinPath(cfRoot, "temp", "agents", `${agentName}.json`);
        const agentFileExists = await FileSystemService.exists(agentFilePath);
        
        if (agentFileExists) {
          const existingAgent = await FileSystemService.readJSON<any>(agentFilePath);
          
          // Add folder path to canRead[] and canWrite[]
          if (!existingAgent.canRead) {
            existingAgent.canRead = [];
          }
          if (!existingAgent.canWrite) {
            existingAgent.canWrite = [];
          }
          
          if (!existingAgent.canRead.includes(realFolderUri.fsPath)) {
            existingAgent.canRead.push(realFolderUri.fsPath);
          }
          if (!existingAgent.canWrite.includes(realFolderUri.fsPath)) {
            existingAgent.canWrite.push(realFolderUri.fsPath);
          }
          
          // Update folders list in agent file
          if (!existingAgent.folders.includes(folderName)) {
            existingAgent.folders.push(folderName);
          }
          
          existingAgent.updatedAt = new Date().toISOString();
          
          // Write updated agent back
          await FileSystemService.writeJSON(agentFilePath, existingAgent);
          outputChannel.appendLine(`✓ Updated agents/${agentName}.json with folder access`);
        }

        outputChannel.appendLine(`✓ Linked folder "${folderName}" to agent: ${agentName}`);
      } else {
        vscode.window.showErrorMessage(`Agent "${agentName}" not found.`);
        return;
      }
    }

    // 5. Create the REAL folder in workspace
    await FileSystemService.ensureDirectory(realFolderUri);
    outputChannel.appendLine(`✓ Created real folder: ${realFolderUri.fsPath}`);

    // 6. Create context folder in .contextforge/temp/{folderName}/
    const tempFolderUri = vscode.Uri.joinPath(cfRoot, "temp", folderName);
    await FileSystemService.ensureDirectory(tempFolderUri);
    outputChannel.appendLine(`✓ Created temp context folder: ${tempFolderUri.fsPath}`);

    // 7. Write _folder.context.json to .contextforge/temp/{folderName}/
    const folderContext = createFolderContextTemplate(folderName, agentName, agentId);
    folderContext.folderPath = realFolderUri.fsPath; // points to REAL workspace folder

    const folderContextUri = vscode.Uri.joinPath(tempFolderUri, "_folder.context.json");
    await FileSystemService.writeJSON(folderContextUri, folderContext);
    outputChannel.appendLine(`✓ Created _folder.context.json in temp/${folderName}`);

    // 8. Write updated temp/global.json
    tempGlobal.updatedAt = new Date().toISOString();
    await FileSystemService.writeJSON(tempGlobalUri, tempGlobal);
    outputChannel.appendLine(`✓ Updated temp/global.json`);

    CFStateManager.invalidateCache();

    outputChannel.appendLine(`\n✓ Done! Created folder "${folderName}" linked to agent "${agentName}".`);
    outputChannel.show(true);

    vscode.window.showInformationMessage(
      `ContextForge: Created folder "${folderName}" linked to agent "${agentName}".`
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Failed to create folder: ${errorMessage}`);
    outputChannel.appendLine(`✗ Error: ${errorMessage}`);
    outputChannel.show(true);
  }
});

export { createFolder };