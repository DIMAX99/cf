import * as path from "path";
import * as vscode from "vscode";

export function toWorkspaceRelativePath(uri: vscode.Uri): string {
  const workspace = vscode.workspace.workspaceFolders?.[0];
  if (!workspace) {
    return uri.fsPath.replace(/\\/g, "/");
  }

  return path.relative(workspace.uri.fsPath, uri.fsPath).replace(/\\/g, "/");
}

export function encodeContextPath(relativePath: string): string {
  return Buffer.from(relativePath).toString("base64url");
}

export function getTypedContextUri(
  cfRoot: vscode.Uri,
  targetDir: string,
  kind: "folders" | "files",
  relativePath: string
): vscode.Uri {
  return vscode.Uri.joinPath(
    cfRoot,
    targetDir,
    kind,
    `${encodeContextPath(relativePath)}.context.json`
  );
}
