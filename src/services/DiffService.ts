import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { minimatch } from "minimatch";
import { SnapshotService, SnapshotFile, SnapshotDiff } from "./SnapShotService";
import { FileSystemService } from "./FileSystemService";

/**
 * Represents a file with its full content
 */
export interface FileWithContent {
  path: string;
  content: string;
  size: number;
  language?: string;
  hash?: string;
}

/**
 * Enhanced snapshot diff with file content
 */
export interface EnhancedSnapshotDiff extends SnapshotDiff {
  contentLoaded: boolean;
  contentWarning?: string;
}

/**
 * Summary statistics for snapshot differences
 */
export interface DiffSummary {
  addedCount: number;
  removedCount: number;
  modifiedCount: number;
  unchangedCount: number;
  totalSize: number;
  totalSizeRemoved: number;
}

/**
 * Change statistics with formatted sizes
 */
export interface ChangeStatistics {
  summary: DiffSummary;
  addedSizeFormatted: string;
  removedSizeFormatted: string;
  netChangeFormatted: string;
}

/**
 * Service for computing and analyzing differences between snapshots
 * Provides higher-level diffing capabilities and content reading
 */
export class DiffService {
  private static readonly MAX_FILES_TO_READ = 50;
  private static readonly CONTENT_READ_TIMEOUT = 30000; // 30 seconds

  /**
   * Compute differences between two snapshots
   * @param oldSnapshot Previous snapshot
   * @param newSnapshot Current snapshot
   * @returns SnapshotDiff with categorized file changes
   */
  static diffSnapshots(
    oldSnapshot: SnapshotFile[],
    newSnapshot: SnapshotFile[]
  ): SnapshotDiff {
    // Use SnapshotService's compare logic which uses hash-based comparison
    return SnapshotService.compareSnapshots(oldSnapshot, newSnapshot);
  }

  /**
   * Compute diffs using size/modification time as secondary indicators
   * Useful for detecting changes without full hash comparison
   * @param oldSnapshot Previous snapshot
   * @param newSnapshot Current snapshot
   * @returns SnapshotDiff based on metadata changes
   */
  static diffSnapshotsByMetadata(
    oldSnapshot: SnapshotFile[],
    newSnapshot: SnapshotFile[]
  ): SnapshotDiff {
    const oldMap = new Map(oldSnapshot.map((f) => [f.path, f]));
    const newMap = new Map(newSnapshot.map((f) => [f.path, f]));

    const added: SnapshotFile[] = [];
    const removed: SnapshotFile[] = [];
    const modified: Array<{ file: SnapshotFile; previousHash: string }> = [];
    const unchanged: SnapshotFile[] = [];

    // Check for added and modified files
    for (const [path, newFile] of newMap) {
      const oldFile = oldMap.get(path);

      if (!oldFile) {
        added.push(newFile);
      } else if (
        oldFile.size !== newFile.size ||
        oldFile.lastModified !== newFile.lastModified
      ) {
        // Treat as modified if size or modification time changed
        modified.push({
          file: newFile,
          previousHash: oldFile.hash,
        });
      } else {
        unchanged.push(newFile);
      }
    }

    // Check for removed files
    for (const [path, oldFile] of oldMap) {
      if (!newMap.has(path)) {
        removed.push(oldFile);
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
   * Summarize differences between snapshots
   * @param diff Snapshot diff
   * @returns Summary statistics
   */
  static summarizeDiff(diff: SnapshotDiff): DiffSummary {
    return {
      addedCount: diff.added.length,
      removedCount: diff.removed.length,
      modifiedCount: diff.modified.length,
      unchangedCount: diff.unchanged.length,
      totalSize: diff.added.reduce((sum, f) => sum + f.size, 0),
      totalSizeRemoved: diff.removed.reduce((sum, f) => sum + f.size, 0),
    };
  }

  /**
   * Read file content for changed files
   * Caps at 50 files max to avoid memory issues
   * @param files Array of snapshot files
   * @param label Optional label for logging purposes
   * @returns Array of files with content, or null if aborted
   */
  static async readFilesContent(
    files: SnapshotFile[],
    label: string = "files"
  ): Promise<FileWithContent[] | null> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      throw new Error("No workspace folder found");
    }

    // Warn if exceeding file limit
    if (files.length > this.MAX_FILES_TO_READ) {
      const message = `Attempting to read ${files.length} ${label}. Only the first ${this.MAX_FILES_TO_READ} will be processed. Continue?`;
      const result = await vscode.window.showWarningMessage(
        message,
        "Continue",
        "Cancel"
      );

      if (result !== "Continue") {
        vscode.window.showInformationMessage("Content reading cancelled");
        return null;
      }
    }

    const filesToRead = files.slice(0, this.MAX_FILES_TO_READ);
    const filesWithContent: FileWithContent[] = [];
    let successCount = 0;
    let failCount = 0;

    // Progress notification
    const progressPromise = vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Reading ${label}...`,
        cancellable: true,
      },
      async (progress, token) => {
        for (let i = 0; i < filesToRead.length; i++) {
          if (token.isCancellationRequested) {
            vscode.window.showInformationMessage(
              `Content reading cancelled. Read ${successCount} of ${filesToRead.length} files`
            );
            return;
          }

          const file = filesToRead[i];
          progress.report({
            increment: (100 / filesToRead.length),
            message: `${i + 1}/${filesToRead.length}: ${file.path}`,
          });

          try {
            const filePath = path.join(workspaceFolder.uri.fsPath, file.path);
            const content = await this.readFileWithTimeout(filePath);

            filesWithContent.push({
              path: file.path,
              content,
              size: file.size,
              language: file.language,
              hash: file.hash,
            });

            successCount++;
          } catch (error) {
            failCount++;
            console.warn(
              `Failed to read content for ${file.path}:`,
              error
            );
          }
        }
      }
    );

    await progressPromise;

    // Log summary
    if (failCount > 0) {
      vscode.window.showWarningMessage(
        `Read ${successCount}/${filesToRead.length} ${label} successfully (${failCount} failed)`
      );
    } else {
      vscode.window.showInformationMessage(
        `Successfully read ${successCount} ${label}`
      );
    }

    return filesWithContent;
  }

  /**
   * Read file content with timeout to prevent hanging on large files
   * Properly clears timeout to avoid dangling timer memory leaks
   * @param filePath Absolute file path
   * @returns File content
   */
  private static async readFileWithTimeout(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Read timeout for ${filePath}`)),
        this.CONTENT_READ_TIMEOUT
      );

      fs.promises
        .readFile(filePath, "utf-8")
        .then((content) => {
          clearTimeout(timer); // Clean up the timer on success
          resolve(content);
        })
        .catch((error) => {
          clearTimeout(timer); // Clean up the timer on error
          reject(error);
        });
    });
  }

  /**
   * Filter files by language
   * @param files Files with content
   * @param languages Array of language identifiers to include
   * @returns Filtered files
   */
  static filterByLanguage(
    files: FileWithContent[],
    languages: string[]
  ): FileWithContent[] {
    return files.filter(
      (f) => f.language && languages.includes(f.language)
    );
  }

  /**
   * Filter files by path pattern
   * @param files Files to filter
   * @param patterns Array of glob patterns to include
   * @returns Filtered files matching any pattern
   */
  static filterByPathPattern(
    files: FileWithContent[],
    patterns: string[]
  ): FileWithContent[] {
    return files.filter((f) =>
      patterns.some((pattern) => minimatch(f.path, pattern))
    );
  }

  /**
   * Get total size of files
   * @param files Files to measure
   * @returns Total size in bytes
   */
  static getTotalSize(files: FileWithContent[]): number {
    return files.reduce((sum, f) => sum + f.size, 0);
  }

  /**
   * Format file size for display
   * @param bytes Size in bytes
   * @returns Human-readable size string
   */
  static formatFileSize(bytes: number): string {
    const units = ["B", "KB", "MB", "GB"];
    let size = bytes;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }

    return `${size.toFixed(2)} ${units[unitIndex]}`;
  }

  /**
   * Get statistics about changed files
   * @param diff Snapshot diff
   * @returns Statistics object
   */
  static getChangeStatistics(diff: SnapshotDiff): ChangeStatistics {
    const summary = this.summarizeDiff(diff);
    const netChange = summary.totalSize - summary.totalSizeRemoved;

    return {
      summary,
      addedSizeFormatted: this.formatFileSize(summary.totalSize),
      removedSizeFormatted: this.formatFileSize(summary.totalSizeRemoved),
      netChangeFormatted: this.formatFileSize(Math.abs(netChange)),
    };
  }
}
