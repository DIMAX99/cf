import * as vscode from "vscode";
import { FileSystemService } from "../services/FileSystemService";
import {
    CurrentConfig,
    GlobalConfig
} from "../utils/types";

export class CFStateManager {
    private static currentCache: CurrentConfig | null = null;
    private static globalCache: GlobalConfig | null = null;

    private static getWorkspaceRoot(): vscode.Uri {
        const workspace = vscode.workspace.workspaceFolders?.[0];
        if (!workspace) {
            throw new Error("No workspace folder found. Please open a project folder first.");
        }
        return workspace.uri;
    }

    static getCFRoot(): vscode.Uri {
        const root = this.getWorkspaceRoot();
        return vscode.Uri.joinPath(root, ".contextforge");
    }

    // Only check current.json — that's the real indicator CF is initialized
    static async guardInitialized(): Promise<void> {
        const cfRoot = this.getCFRoot();
        const currentUri = vscode.Uri.joinPath(cfRoot, "current.json");

        const currentExists = await FileSystemService.exists(currentUri);
        if (!currentExists) {
            throw new Error(
                "ContextForge is not initialized. Please run 'ContextForge: Init CF' first."
            );
        }
    }

    static async getActiveVersion(): Promise<CurrentConfig> {
        if (this.currentCache) {
            return this.currentCache;
        }

        await this.guardInitialized();

        const currentUri = vscode.Uri.joinPath(this.getCFRoot(), "current.json");

        try {
            const current = await FileSystemService.readJSON<CurrentConfig>(currentUri);

            if (!current.activeVersion) {
                throw new Error("Invalid current.json: missing activeVersion");
            }
            if (typeof current.latestVersion !== "number") {
                throw new Error("Invalid current.json: latestVersion is missing or not a number");
            }

            this.currentCache = current;
            return current;
        } catch (error) {
            throw new Error(
                `Failed to load current configuration. ${this.getErrorMessage(error)}`
            );
        }
    }

    // No parameter needed — temp path is always the same
    static getTempPath(): vscode.Uri {
        return vscode.Uri.joinPath(this.getCFRoot(), "temp");
    }

    static getVersionPath(version: number | string): vscode.Uri {
        const normalizedVersion =
            typeof version === "number"
                ? `v${version}`
                : version.startsWith("v")
                ? version
                : `v${version}`;

        return vscode.Uri.joinPath(this.getCFRoot(), normalizedVersion);
    }

    // Reads from temp/global.json — source of truth for active changes
    static async getGlobal(): Promise<GlobalConfig> {
        if (this.globalCache) {
            return this.globalCache;
        }

        await this.guardInitialized();

        const globalUri = vscode.Uri.joinPath(this.getCFRoot(), "temp", "global.json");

        const globalExists = await FileSystemService.exists(globalUri);
        if (!globalExists) {
            throw new Error(
                "temp/global.json not found. ContextForge may not be initialized correctly."
            );
        }

        try {
            const global = await FileSystemService.readJSON<GlobalConfig>(globalUri);
            this.globalCache = global;
            return global;
        } catch (error) {
            throw new Error(
                `Failed to load global configuration. ${this.getErrorMessage(error)}`
            );
        }
    }

    // Updates temp/global.json — changes live in temp until saveChanges is run
    static async updateGlobal(partial: Partial<GlobalConfig>): Promise<GlobalConfig> {
        await this.guardInitialized();

        const existingGlobal = await this.getGlobal();

        const updatedGlobal: GlobalConfig = {
            ...existingGlobal,
            ...partial,
            updatedAt: new Date().toISOString(),
        };

        const globalUri = vscode.Uri.joinPath(this.getCFRoot(), "temp", "global.json");

        try {
            await FileSystemService.writeJSON(globalUri, updatedGlobal);
            this.invalidateGlobalCache();
            return updatedGlobal;
        } catch (error) {
            throw new Error(
                `Failed to update temp/global.json. ${this.getErrorMessage(error)}`
            );
        }
    }

    static async updateCurrent(partial: Partial<CurrentConfig>): Promise<CurrentConfig> {
        await this.guardInitialized();

        const existingCurrent = await this.getActiveVersion();

        const updatedCurrent: CurrentConfig = {
            ...existingCurrent,
            ...partial,
            lastUpdatedAt: new Date().toISOString(),
        };

        const currentUri = vscode.Uri.joinPath(this.getCFRoot(), "current.json");

        try {
            await FileSystemService.writeJSON(currentUri, updatedCurrent);
            this.invalidateCurrentCache();
            this.invalidateGlobalCache();
            return updatedCurrent;
        } catch (error) {
            throw new Error(
                `Failed to update current.json. ${this.getErrorMessage(error)}`
            );
        }
    }

    static invalidateCache(): void {
        this.currentCache = null;
        this.globalCache = null;
    }

    static invalidateCurrentCache(): void {
        this.currentCache = null;
    }

    static invalidateGlobalCache(): void {
        this.globalCache = null;
    }

    private static getErrorMessage(error: unknown): string {
        if (error instanceof Error) {
            return error.message;
        }
        return String(error);
    }
}