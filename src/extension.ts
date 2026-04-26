import * as vscode from "vscode";

export function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel("context-forge");
  outputChannel.appendLine('ContextForge extension is active.');
  context.subscriptions.push(outputChannel);

  const initCF = vscode.commands.registerCommand("cf.initCF", async () => {
    const workspace = vscode.workspace.workspaceFolders?.[0];

    if (!workspace) {
      vscode.window.showErrorMessage("Please open a project folder first.");
      return;
    }

    const root = workspace.uri;
    const cfFolder = vscode.Uri.joinPath(root, ".contextforge");
    const ve1=await vscode.Uri.joinPath(cfFolder, "v1");
    await vscode.workspace.fs.createDirectory(cfFolder);
    await vscode.workspace.fs.createDirectory(ve1);
    const current = {
      activeVersion: "v1",
      latestVersion: 1
    };

    const global = {
      projectName: workspace.name,
      projectGoal: "",
      techStack: [],
      folderAgents: [],
      architectureDecisions: [],
      createdAt: new Date().toISOString()
    };

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






  const createFolder=vscode.commands.registerCommand("cf.createFolder", async () => {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    
    if (!workspace) {
      vscode.window.showErrorMessage("Couldnt find workspace.");
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
      }
    });
    if (!folderName) {
      vscode.window.showErrorMessage("Folder creation cancelled. No folder name provided.");
      return;
    }
    const root = workspace.uri;
    const cfFolder = vscode.Uri.joinPath(root, ".contextforge");
    const currentUri = vscode.Uri.joinPath(cfFolder, "current.json");
    const currentData = await vscode.workspace.fs.readFile(currentUri);
    const current = JSON.parse(currentData.toString());
    const versionFolderUri = vscode.Uri.joinPath(cfFolder, `${current.activeVersion}`);
    const globalData = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(versionFolderUri, "global.json"));
    const global = JSON.parse(globalData.toString());
    const agentOptions = global.folderAgents?.map((agent: { agentName: string; folders: string[] ,desc: string}) => ({
      label: agent.agentName,
      description: `Folders: ${agent.folders?.join(", ") || "None"} \n Description:\n ${agent.desc || ""}`
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
    let agentName = selectedAgent.label || "";
    if (agentName === "Create New Agent") {
      agentName = await vscode.window.showInputBox({
        prompt: "Enter new agent name",
        placeHolder: "e.g. AuthAgent , ComponentAgent",
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
      const desc=await vscode.window.showInputBox({
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
      global.folderAgents = global.folderAgents || [];
      global.folderAgents.push({ agentName, folders: [folderName], desc });
    } else {
      const agent = global.folderAgents.find((a: { agentName: string; folders: string[]; desc: string
       }) => a.agentName === agentName);
      if (agent) {
        agent.folders = agent.folders || [];
      }
    }
    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(versionFolderUri, "global.json"),
      Buffer.from(JSON.stringify(global, null, 2))
    );
    const newFolderUri = vscode.Uri.joinPath(cfFolder, `${current.activeVersion}`, folderName);
    await vscode.workspace.fs.createDirectory(newFolderUri);
    outputChannel.appendLine(`Created folder: ${newFolderUri.fsPath}`);
  });






  const createFile=vscode.commands.registerCommand("cf.createFile", async () => {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    
    if (!workspace) {
      vscode.window.showErrorMessage("Couldnt find workspace.");
      return;
    }
    const fileName = await vscode.window.showInputBox({ 
      prompt: "Enter file name only no extension" ,
      placeHolder: "e.g. main",
      validateInput: (value) => {
        if (!value || value.trim() === "") {
          return "File name cannot be empty.";
        }
        if (/[<>:"/\\|?*]/.test(value)) {
        return "File name contains invalid characters.";
      }
        return null;
      }
    });
    if (!fileName) {
      vscode.window.showErrorMessage("File creation cancelled. No file name provided.");
      return;
    }
    const root = workspace.uri;
    const cfFolder = vscode.Uri.joinPath(root, ".contextforge");
    const currentUri = vscode.Uri.joinPath(cfFolder, "current.json");
    const currentData = await vscode.workspace.fs.readFile(currentUri);
    const current = JSON.parse(currentData.toString());
    const newFileUri = vscode.Uri.joinPath(cfFolder, `${current.activeVersion}`, `${fileName}.json`);
    await vscode.workspace.fs.writeFile(newFileUri, Buffer.from(""));
    outputChannel.appendLine(`Created file: ${newFileUri.fsPath}`);    
  });
  context.subscriptions.push(initCF);
  context.subscriptions.push(createFile);
  context.subscriptions.push(createFolder);
}

export function deactivate() {}