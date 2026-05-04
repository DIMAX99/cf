import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";
import { FileSystemService } from "./FileSystemService";

/**
 * Represents a snapshot of a file in the workspace
 */
export interface SnapshotFile {
  path: string;
  size: number;
  lastModified: number;
  language?: string;
  hash: string;
}

/**
 * Represents changes between two snapshots
 */
export interface SnapshotDiff {
  added: SnapshotFile[];
  removed: SnapshotFile[];
  modified: Array<{
    file: SnapshotFile;
    previousHash: string;
  }>;
  unchanged: SnapshotFile[];
}

/**
 * Represents detailed code changes for a file
 */
export interface CodeChange {
  filePath: string;
  language?: string;
  previousContent: string;
  currentContent: string;
  added: string[];
  removed: string[];
  modified: Array<{
    lineNumber: number;
    oldLine: string;
    newLine: string;
  }>;
}

/**
 * Service for managing workspace snapshots
 * Captures file metadata and versioned snapshots for change tracking
 */
export class SnapshotService {
  private static readonly IGNORE_LIST = [
    "node_modules",
    "dist",
    ".git",
    ".contextforge",
    "out",
  ];

  /**
   * Language mapping for file extensions
   */
  private static readonly LANGUAGE_MAP: Record<string, string> = {
    ".ts": "typescript",
    ".tsx": "typescriptreact",
    ".js": "javascript",
    ".jsx": "javascriptreact",
    ".py": "python",
    ".java": "java",
    ".cpp": "cpp",
    ".c": "c",
    ".h": "c",
    ".hpp": "cpp",
    ".cs": "csharp",
    ".go": "go",
    ".rs": "rust",
    ".rb": "ruby",
    ".php": "php",
    ".swift": "swift",
    ".kt": "kotlin",
    ".json": "json",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".xml": "xml",
    ".html": "html",
    ".css": "css",
    ".scss": "scss",
    ".sass": "sass",
    ".less": "less",
    ".md": "markdown",
    ".sql": "sql",
    ".sh": "shellscript",
    ".bash": "shellscript",
  };

  /**
   * Take a snapshot of the workspace by walking the file tree
   * @returns Promise<SnapshotFile[]> Array of files with metadata
   */
  static async takeSnapshot(): Promise<SnapshotFile[]> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      throw new Error("No workspace folder found");
    }

    const snapshot: SnapshotFile[] = [];
    await this.walkDirectory(workspaceFolder.uri.fsPath, snapshot);

    return snapshot.sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * Recursively walk through directory and collect file metadata
   * @param dirPath Directory path to walk
   * @param snapshot Array to accumulate snapshot files
   */
  private static async walkDirectory(
    dirPath: string,
    snapshot: SnapshotFile[]
  ): Promise<void> {
    try {
      const entries = await fs.promises.readdir(dirPath, {
        withFileTypes: true,
      });

      for (const entry of entries) {
        // Check if entry should be ignored
        if (this.IGNORE_LIST.includes(entry.name)) {
          continue;
        }

        const fullPath = path.join(dirPath, entry.name);

        if (entry.isDirectory()) {
          await this.walkDirectory(fullPath, snapshot);
        } else if (entry.isFile()) {
          try {
            const stats = await fs.promises.stat(fullPath);
            const relativePath = this.getRelativePath(fullPath);
            const content = await fs.promises.readFile(fullPath, "utf-8");
            const hash = this.computeHash(content);

            snapshot.push({
              path: relativePath,
              size: stats.size,
              lastModified: stats.mtimeMs,
              language: this.getLanguageFromExtension(fullPath),
              hash,
            });
          } catch (error) {
            console.warn(`Failed to get stats for ${fullPath}:`, error);
          }
        }
      }
    } catch (error) {
      console.warn(`Failed to read directory ${dirPath}:`, error);
    }
  }

  /**
   * Get relative path from workspace root
   * @param filePath Absolute file path
   * @returns Relative path using forward slashes
   */
  private static getRelativePath(filePath: string): string {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return filePath;
    }

    const relative = path.relative(workspaceFolder.uri.fsPath, filePath);
    return relative.replace(/\\/g, "/");
  }

  /**
   * Determine language from file extension
   * @param filePath File path
   * @returns Language identifier or undefined
   */
  private static getLanguageFromExtension(filePath: string): string | undefined {
    const ext = path.extname(filePath).toLowerCase();
    return this.LANGUAGE_MAP[ext];
  }

  /**
   * Compute SHA256 hash of file content
   * @param content File content
   * @returns Hash string
   */
  private static computeHash(content: string): string {
    return crypto.createHash("sha256").update(content).digest("hex");
  }

  /**
   * Compare two snapshots and identify changes
   * @param previousSnapshot Previous snapshot
   * @param currentSnapshot Current snapshot
   * @returns Diff object with added, removed, modified, and unchanged files
   */
  static compareSnapshots(
    previousSnapshot: SnapshotFile[] | [],
    currentSnapshot: SnapshotFile[] | []
  ): SnapshotDiff {
    const safePrev = Array.isArray(previousSnapshot) ? previousSnapshot : [];
    const safeCurr = Array.isArray(currentSnapshot) ? currentSnapshot : [];
    const previousMap = new Map(safePrev.map((f) => [f.path, f]));
    const currentMap = new Map(safeCurr.map((f) => [f.path, f]));

    const added: SnapshotFile[] = [];
    const removed: SnapshotFile[] = [];
    const modified: Array<{ file: SnapshotFile; previousHash: string }> = [];
    const unchanged: SnapshotFile[] = [];

    // Check for added and modified files
    for (const [path, currentFile] of currentMap) {
      const previousFile = previousMap.get(path);

      if (!previousFile) {
        added.push(currentFile);
      } else if (previousFile.hash !== currentFile.hash) {
        modified.push({
          file: currentFile,
          previousHash: previousFile.hash,
        });
      } else {
        unchanged.push(currentFile);
      }
    }

    // Check for removed files
    for (const [path, previousFile] of previousMap) {
      if (!currentMap.has(path)) {
        removed.push(previousFile);
      }
    }

    return {
      added,
      removed,
      modified,
      unchanged,
    };
  }

  /**
   * Compute Longest Common Subsequence for accurate diffing
   * Prevents the diff cascade problem where adding one line shows all lines as modified
   * @param arr1 Previous lines
   * @param arr2 Current lines
   * @returns Mapping of matching line indices
   */
  private static computeLCS(
    arr1: string[],
    arr2: string[]
  ): Array<[number, number]> {
    const matches: Array<[number, number]> = [];
    const m = arr1.length;
    const n = arr2.length;

    // Create DP table for LCS
    const dp: number[][] = Array(m + 1)
      .fill(null)
      .map(() => Array(n + 1).fill(0));

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (arr1[i - 1] === arr2[j - 1]) {
          dp[i][j] = dp[i - 1][j - 1] + 1;
        } else {
          dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
      }
    }

    // Backtrack to find matching lines
    let i = m;
    let j = n;
    while (i > 0 && j > 0) {
      if (arr1[i - 1] === arr2[j - 1]) {
        matches.unshift([i - 1, j - 1]);
        i--;
        j--;
      } else if (dp[i - 1][j] > dp[i][j - 1]) {
        i--;
      } else {
        j--;
      }
    }

    return matches;
  }

  /**
   * Get detailed code changes for a file between versions
   * @param filePath File path
   * @param previousContent Previous file content
   * @param currentContent Current file content
   * @returns Code change details
   */
  static getCodeChanges(
    filePath: string,
    previousContent: string,
    currentContent: string,
    language?: string
  ): CodeChange {
    const previousLines = previousContent.split("\n");
    const currentLines = currentContent.split("\n");

    const added: string[] = [];
    const removed: string[] = [];
    const modified: Array<{ lineNumber: number; oldLine: string; newLine: string }> = [];

    // Use LCS (Longest Common Subsequence) to find actual matching lines
    // This prevents the "diff cascade" problem where adding one import at the top
    // would show all subsequent lines as modified
    const matches = this.computeLCS(previousLines, currentLines);
    const matchedOldLines = new Set(matches.map((m) => m[0]));
    const matchedNewLines = new Set(matches.map((m) => m[1]));

    // Find removed lines
    for (let i = 0; i < previousLines.length; i++) {
      if (!matchedOldLines.has(i)) {
        removed.push(previousLines[i]);
      }
    }

    // Find added lines
    for (let i = 0; i < currentLines.length; i++) {
      if (!matchedNewLines.has(i)) {
        added.push(currentLines[i]);
      }
    }

    // Detect modified lines from matches
    for (const [oldIdx, newIdx] of matches) {
      if (previousLines[oldIdx] !== currentLines[newIdx]) {
        modified.push({
          lineNumber: newIdx + 1,
          oldLine: previousLines[oldIdx],
          newLine: currentLines[newIdx],
        });
      }
    }

    return {
      filePath,
      language,
      previousContent,
      currentContent,
      added,
      removed,
      modified,
    };
  }

  /**
   * Write snapshot to disk at version path
   * @param version Version string
   * @param snapshot Array of snapshot files
   */
  static async writeSnapshot(
    version: string,
    snapshot: SnapshotFile[]
  ): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      throw new Error("No workspace folder found");
    }

    const snapshotDir = path.join(
      workspaceFolder.uri.fsPath,
      ".contextforge",
      version
    );
    const snapshotPath = path.join(snapshotDir, "snapshot.json");

    // Ensure directory exists
    await FileSystemService.ensureDirectory(
      vscode.Uri.file(snapshotDir)
    );

    // Write snapshot file
    await FileSystemService.writeJSON(
      vscode.Uri.file(snapshotPath),
      snapshot
    );
  }

  /**
   * Read existing snapshot from disk
   * @param version Version string
   * @returns Snapshot data or null if not found
   */
  static async readSnapshot(version: string): Promise<SnapshotFile[] | null> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      throw new Error("No workspace folder found");
    }

    const snapshotPath = path.join(
      workspaceFolder.uri.fsPath,
      ".contextforge",
      version,
      "snapshot.json"
    );
    const snapshotUri = vscode.Uri.file(snapshotPath);

    const exists = await FileSystemService.exists(snapshotUri);
    if (!exists) {
      return null;
    }

    try {
      const snapshot = await FileSystemService.readJSON<SnapshotFile[]>(
        snapshotUri
      );
      return snapshot;
    } catch (error) {
      console.warn(`Failed to read snapshot for version ${version}:`, error);
      return null;
    }
  }

  /**
   * Encode file path to safe filename using base64
   * Prevents naming collisions where different paths encode to the same filename
   * Example: src/app.ts and src_app.ts would both become src_app_ts.json (collision!)
   * With base64: unique encodings prevent overwrites
   * @param filePath File path
   * @returns Safe filename
   */
  private static encodePathToFilename(filePath: string): string {
    const encoded = Buffer.from(filePath).toString("base64").replace(/[/+=]/g, "-");
    return encoded + ".json";
  }

  /**
   * Store code changes for modified files
   * @param version Version string
   * @param changes Array of code changes
   */
  static async storeCodeChanges(
    version: string,
    changes: CodeChange[]
  ): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      throw new Error("No workspace folder found");
    }

    const changesDir = path.join(
      workspaceFolder.uri.fsPath,
      ".contextforge",
      version,
      "changes"
    );

    await FileSystemService.ensureDirectory(vscode.Uri.file(changesDir));

    // Store each change as a separate JSON file for easier access
    // Use base64 encoding to avoid naming collisions (e.g., src/app.ts and src_app.ts)
    for (const change of changes) {
      const fileName = this.encodePathToFilename(change.filePath);
      const changePath = path.join(changesDir, fileName);

      await FileSystemService.writeJSON(vscode.Uri.file(changePath), change);
    }
  }

  /**
   * Retrieve stored code changes for a version
   * @param version Version string
   * @returns Array of code changes or empty array if none found
   */
  static async retrieveCodeChanges(version: string): Promise<CodeChange[]> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      throw new Error("No workspace folder found");
    }

    const changesDir = path.join(
      workspaceFolder.uri.fsPath,
      ".contextforge",
      version,
      "changes"
    );
    const changesDirUri = vscode.Uri.file(changesDir);

    const exists = await FileSystemService.exists(changesDirUri);
    if (!exists) {
      return [];
    }

    try {
      const files = await fs.promises.readdir(changesDir);
      const changes: CodeChange[] = [];

      for (const file of files) {
        if (file.endsWith(".json")) {
          try {
            const changePath = path.join(changesDir, file);
            const change = await FileSystemService.readJSON<CodeChange>(
              vscode.Uri.file(changePath)
            );
            changes.push(change);
          } catch (error) {
            console.warn(`Failed to read change file ${file}:`, error);
          }
        }
      }

      return changes;
    } catch (error) {
      console.warn(`Failed to read changes directory for ${version}:`, error);
      return [];
    }
  }
}

