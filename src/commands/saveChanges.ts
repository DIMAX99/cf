import * as vscode from "vscode";
import { CFStateManager } from "../core/CFStateManager";
import { SnapshotService, SnapshotFile } from "../services/SnapShotService";
import { DiffService } from "../services/DiffService";
import { FileSystemService } from "../services/FileSystemService";
import { BackendService } from "../services/backendService";

/**
 * Command to save workspace changes as a new version
 * Compares temp snapshot (working changes) against active version snapshot
 */
export async function saveChanges(context: vscode.ExtensionContext) {
  try {
    // Ensure CF is initialized
    await CFStateManager.guardInitialized();

    // Create output channel for showing progress
    const outputChannel = vscode.window.createOutputChannel("ContextForge");
    outputChannel.clear();
    outputChannel.show();

    outputChannel.appendLine("🔄 Starting save changes workflow...");

    // Step 1: Get current config
    outputChannel.appendLine("\n📖 Reading version config...");
    const currentConfig = await CFStateManager.getActiveVersion();
    const activeVersion = currentConfig.activeVersion;
    const nextVersionNumber = currentConfig.latestVersion + 1;
    const nextVersionName = `v${nextVersionNumber}`;

    outputChannel.appendLine(`   Active version: ${activeVersion}`);
    outputChannel.appendLine(`   Next version: ${nextVersionName}`);

    // Step 2: Read active version snapshot (last saved state)
    outputChannel.appendLine("\n📸 Reading active version snapshot...");
    let activeSnapshot: SnapshotFile[] | null = null;
    try {
      activeSnapshot = await SnapshotService.readSnapshot(activeVersion);
      if (activeSnapshot) {
        outputChannel.appendLine(`   Found ${activeSnapshot.length} files in ${activeVersion}`);
      } else {
        outputChannel.appendLine("   ⚠️  No snapshot found for active version");
      }
    } catch (error) {
      outputChannel.appendLine(`   ⚠️  Error reading active snapshot: ${error}`);
    }

    // Step 3: Read temp snapshot (working changes)
    outputChannel.appendLine("\n📸 Reading temp snapshot (working changes)...");
    let tempSnapshot: SnapshotFile[] | null = null;
    try {
      tempSnapshot = await SnapshotService.readSnapshot("temp");
      if (tempSnapshot) {
        outputChannel.appendLine(`   Found ${tempSnapshot.length} changed files in temp`);
      } else {
        outputChannel.appendLine("   ⚠️  No temp snapshot found (no uncommitted changes)");
      }
    } catch (error) {
      outputChannel.appendLine(`   ⚠️  Error reading temp snapshot: ${error}`);
    }

    // Step 4: Compare snapshots
    outputChannel.appendLine("\n🔍 Comparing active vs. temp snapshots...");
    let diff;
    if (!tempSnapshot || tempSnapshot.length === 0) {
      outputChannel.appendLine("   ❌ No changes in temp snapshot");
      vscode.window.showInformationMessage("No uncommitted changes found");
      return;
    }

    if (!activeSnapshot) {
      outputChannel.appendLine(
        "   First version - all temp files will be added"
      );
      diff = {
        added: tempSnapshot,
        removed: [],
        modified: [],
        unchanged: [],
      };
    } else {
      diff = DiffService.diffSnapshots(activeSnapshot, tempSnapshot);
    }

    // Step 5: Show diff summary
    outputChannel.appendLine("\n📊 Change Summary:");
    const stats = DiffService.getChangeStatistics(diff);
    outputChannel.appendLine(
      `   Files added: ${stats.summary.addedCount} (${stats.addedSizeFormatted})`
    );
    outputChannel.appendLine(
      `   Files removed: ${stats.summary.removedCount} (${stats.removedSizeFormatted})`
    );
    outputChannel.appendLine(
      `   Files modified: ${stats.summary.modifiedCount}`
    );
    outputChannel.appendLine(
      `   Net change: ${stats.netChangeFormatted}`
    );

    if (diff.added.length > 0) {
      outputChannel.appendLine("\n   Added files:");
      diff.added.slice(0, 10).forEach((f) => {
        outputChannel.appendLine(`     + ${f.path}`);
      });
      if (diff.added.length > 10) {
        outputChannel.appendLine(`     ... and ${diff.added.length - 10} more`);
      }
    }

    if (diff.removed.length > 0) {
      outputChannel.appendLine("\n   Removed files:");
      diff.removed.slice(0, 10).forEach((f) => {
        outputChannel.appendLine(`     - ${f.path}`);
      });
      if (diff.removed.length > 10) {
        outputChannel.appendLine(`     ... and ${diff.removed.length - 10} more`);
      }
    }

    if (diff.modified.length > 0) {
      outputChannel.appendLine("\n   Modified files:");
      diff.modified.slice(0, 10).forEach((m) => {
        outputChannel.appendLine(`     ~ ${m.file.path}`);
      });
      if (diff.modified.length > 10) {
        outputChannel.appendLine(`     ... and ${diff.modified.length - 10} more`);
      }
    }

    // Step 6: Ask for confirmation
    outputChannel.appendLine("\n❓ Awaiting user confirmation...");
    const totalChanges =
      diff.added.length + diff.removed.length + diff.modified.length;
    const confirmMessage = `Save as ${nextVersionName}? ${totalChanges} files changed`;

    const result = await vscode.window.showInformationMessage(
      confirmMessage,
      "Save",
      "Cancel"
    );

    if (result !== "Save") {
      outputChannel.appendLine("   User cancelled save operation");
      return;
    }

    outputChannel.appendLine("   ✅ User confirmed save");

    // Step 7: Read content of changed files
    outputChannel.appendLine("\n📖 Reading content of changed files...");
    const changedFiles = [
      ...diff.added,
      ...diff.modified.map((m) => m.file),
      ...diff.removed,
    ];

    let filesWithContent = null;
    if (changedFiles.length > 0) {
      filesWithContent = await DiffService.readFilesContent(
        changedFiles,
        `changed files (${changedFiles.length})`
      );

      if (filesWithContent) {
        outputChannel.appendLine(
          `   ✅ Read ${filesWithContent.length} files with content`
        );
      } else {
        outputChannel.appendLine("   User cancelled content reading");
        return;
      }
    }

    // Step 8: Send to backend and stream progress
    outputChannel.appendLine("\n🌐 Sending to backend...");
    let taskId: string | null = null;
    let wsCloseFunc: (() => void) | null = null;

    try {
      const backendService = BackendService.getInstance();

      // Prepare payload
      const payload = {
        type: "save_changes",
        version: nextVersionName,
        previousVersion: activeVersion,
        changes: {
          added: diff.added.map(f => f.path),
          removed: diff.removed.map(f => f.path),
          modified: diff.modified.map(m => m.file.path),
        },
        files: filesWithContent?.map(f => ({
          path: f.path,
          content: f.content,
          language: f.language,
          size: f.size,
        })) || [],
      };

      // Send POST request
      const response = await backendService.post<{ taskId: string }>(
        "/tasks",
        payload
      );

      if (!response?.taskId) {
        outputChannel.appendLine("   ❌ Failed to create backend task");
        vscode.window.showErrorMessage("Failed to send changes to backend");
        return;
      }

      taskId = response.taskId;
      outputChannel.appendLine(`   ✅ Task created: ${taskId}`);

      // Connect WebSocket to stream progress
      outputChannel.appendLine("\n📡 Opening progress stream...");
      wsCloseFunc = await backendService.connectWebSocket(
        taskId,
        (data: unknown) => {
          const stepData = data as Record<string, unknown>;
          const step = stepData.step as string || "progress";
          const message = stepData.message as string || "";
          const status = stepData.status as string;

          outputChannel.appendLine(`   📍 ${step}: ${message}`);

          // Show status badge if present
          if (status === "error") {
            vscode.window.showErrorMessage(`Backend error: ${message}`);
          }
        },
        (error) => {
          outputChannel.appendLine(`   ❌ WebSocket error: ${error.message}`);
        },
        () => {
          outputChannel.appendLine("   ✅ Progress stream closed");
        }
      );

      outputChannel.appendLine("   ✅ Connected to progress stream");
    } catch (error) {
      outputChannel.appendLine(`   ⚠️  Backend communication issue: ${error}`);
      // Continue with local save even if backend fails
    }

    // Step 9: Save temp snapshot as new version
    outputChannel.appendLine("\n💾 Promoting temp snapshot to new version...");
    try {
      if (!tempSnapshot) {
        throw new Error("No temp snapshot available");
      }
      await SnapshotService.writeSnapshot(nextVersionName, tempSnapshot);
      outputChannel.appendLine(`   ✅ Snapshot saved for ${nextVersionName}`);
    } catch (error) {
      outputChannel.appendLine(`   ❌ Error saving snapshot: ${error}`);
      vscode.window.showErrorMessage("Failed to save snapshot");
      return;
    }

    // Step 10: Clear temp snapshot
    outputChannel.appendLine("\n🗑️  Clearing temp snapshot...");
    try {
      const cfRoot = CFStateManager.getCFRoot();
      const tempDir = vscode.Uri.joinPath(cfRoot, "temp");
      const tempUri = vscode.Uri.joinPath(tempDir, "snapshot.json");
      
      // Delete temp snapshot if it exists
      const tempExists = await FileSystemService.exists(tempUri);
      if (tempExists) {
        await vscode.workspace.fs.delete(tempUri);
        outputChannel.appendLine("   ✅ Temp snapshot cleared");
      }
    } catch (error) {
      outputChannel.appendLine(`   ⚠️  Could not clear temp snapshot: ${error}`);
      // Don't fail the operation if temp cleanup fails
    }

    // Step 11: Update current.json with new version
    outputChannel.appendLine("\n📝 Updating version configuration...");
    try {
      const cfRoot = CFStateManager.getCFRoot();
      const currentUri = vscode.Uri.joinPath(cfRoot, "current.json");

      const updatedConfig = {
        ...currentConfig,
        activeVersion: nextVersionName,
        latestVersion: nextVersionNumber,
        lastUpdatedAt: new Date().toISOString(),
      };

      await FileSystemService.writeJSON(currentUri, updatedConfig);
      outputChannel.appendLine(
        `   ✅ Updated current.json: activeVersion = ${nextVersionName}`
      );
    } catch (error) {
      outputChannel.appendLine(`   ❌ Error updating current.json: ${error}`);
      vscode.window.showErrorMessage("Failed to update version configuration");
      return;
    }

    // Success
    outputChannel.appendLine("\n✨ Save operation completed successfully!");
    outputChannel.appendLine(`   Version: ${nextVersionName}`);
    outputChannel.appendLine(`   Changes: ${totalChanges} files`);

    // Close WebSocket if still open
    if (wsCloseFunc) {
      try {
        wsCloseFunc();
      } catch (error) {
        console.warn("Error closing WebSocket:", error);
      }
    }

    // Refresh version history sidebar
    outputChannel.appendLine("\n🔄 Refreshing sidebar...");
    await vscode.commands.executeCommand("cf.refreshVersionHistory");

    vscode.window.showInformationMessage(
      `✅ Changes saved as ${nextVersionName}`
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Save changes failed: ${errorMessage}`);
    console.error("saveChanges error:", error);
  }
}
