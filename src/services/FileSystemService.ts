import * as vscode from "vscode";
import * as path from "path";

export class FileSystemService {
  private static encoder = new TextEncoder();
  private static decoder = new TextDecoder("utf-8");

  static async readJSON<T>(uri: vscode.Uri): Promise<T> {
    try {
      const fileBuffer = await vscode.workspace.fs.readFile(uri);
      const content = this.decoder.decode(fileBuffer);

      return JSON.parse(content) as T;
    } catch (error) {
      throw new Error(
        `Failed to read JSON from "${uri.fsPath}". ${this.getErrorMessage(error)}`
      );
    }
  }

  static async writeJSON<T>(uri: vscode.Uri, data: T): Promise<void> {
    const tempUri = this.getTempUri(uri);

    try {
      const content = JSON.stringify(data, null, 2);
      const fileBuffer = this.encoder.encode(content);

      await vscode.workspace.fs.writeFile(tempUri, fileBuffer);

      await vscode.workspace.fs.rename(tempUri, uri, {
        overwrite: true,
      });
    } catch (error) {
      try {
        if (await this.exists(tempUri)) {
          await vscode.workspace.fs.delete(tempUri);
        }
      } catch {
        // Ignore temp cleanup errors
      }

      throw new Error(
        `Failed to write JSON atomically to "${uri.fsPath}". ${this.getErrorMessage(error)}`
      );
    }
  }

  static async ensureDirectory(uri: vscode.Uri): Promise<void> {
    try {
      const directoryExists = await this.exists(uri);

      if (!directoryExists) {
        await vscode.workspace.fs.createDirectory(uri);
      }
    } catch (error) {
      throw new Error(
        `Failed to create or verify directory "${uri.fsPath}". ${this.getErrorMessage(error)}`
      );
    }
  }

  static async exists(uri: vscode.Uri): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(uri);
      return true;
    } catch {
      return false;
    }
  }

  private static getTempUri(uri: vscode.Uri): vscode.Uri {
    const directoryPath = path.dirname(uri.fsPath);
    const fileName = path.basename(uri.fsPath);
    const tempFileName = `.${fileName}.${Date.now()}.tmp`;

    return vscode.Uri.file(path.join(directoryPath, tempFileName));
  }

  private static getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }
}