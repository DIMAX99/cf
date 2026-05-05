import * as vscode from "vscode";
import { FileSystemService } from "../services/FileSystemService";
import {
    CurrentConfig,
    GlobalConfig,
} from "../utils/types/index";

/**
 * CFStateManager — single source of truth for all .contextforge state access.
 *
 * Architecture:
 *   current.json          — tracks activeVersion + latestVersion number
 *   temp/global.json      — live staging area (changes accumulate here until saveChanges)
 *   {version}/global.json — committed snapshot of global config for that version
 *
 * Reading global config always prefers temp/global.json (live edits).
 * If temp/global.json doesn't exist (e.g. immediately after a save cleared temp),
 * it falls back to the active version's global.json.
 *
 * Writing global config always targets temp/global.json only.
 * The backend's save_coordinator is responsible for promoting temp → versioned copy.
 */
export class CFStateManager {
    private static currentCache: CurrentConfig | null = null;
    private static globalCache: GlobalConfig | null = null;

    // ─────────────────────────────────────────────────────────────────────
    // Internal helpers
    // ─────────────────────────────────────────────────────────────────────

    private static getWorkspaceRoot(): vscode.Uri {
        const workspace = vscode.workspace.workspaceFolders?.[0];
        if (!workspace) {
            throw new Error(
                "No workspace folder found. Please open a project folder first."
            );
        }
        return workspace.uri;
    }

    private static getErrorMessage(error: unknown): string {
        if (error instanceof Error) {
            return error.message;
        }
        return String(error);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Path helpers  (no I/O, always safe to call)
    // ─────────────────────────────────────────────────────────────────────

    static getCFRoot(): vscode.Uri {
        return vscode.Uri.joinPath(this.getWorkspaceRoot(), ".contextforge");
    }

    static getTempPath(): vscode.Uri {
        return vscode.Uri.joinPath(this.getCFRoot(), "temp");
    }

    static getVersionPath(version: number | string): vscode.Uri {
        const normalized =
            typeof version === "number"
                ? `v${version}`
                : version.startsWith("v")
                ? version
                : `v${version}`;
        return vscode.Uri.joinPath(this.getCFRoot(), normalized);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Initialization guard
    // ─────────────────────────────────────────────────────────────────────

    /**
     * Throws if .contextforge/current.json is missing.
     * current.json is the canonical indicator that CF has been initialised.
     */
    static async guardInitialized(): Promise<void> {
        const currentUri = vscode.Uri.joinPath(this.getCFRoot(), "current.json");
        const exists = await FileSystemService.exists(currentUri);
        if (!exists) {
            throw new Error(
                "ContextForge is not initialized. Please run 'ContextForge: Init CF' first."
            );
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // current.json  (version tracking)
    // ─────────────────────────────────────────────────────────────────────

    /**
     * Read and validate current.json.
     * Result is cached until invalidateCurrentCache() or invalidateCache() is called.
     */
    static async getActiveVersion(): Promise<CurrentConfig> {
        if (this.currentCache) {
            return this.currentCache;
        }

        await this.guardInitialized();

        const currentUri = vscode.Uri.joinPath(this.getCFRoot(), "current.json");

        let current: CurrentConfig;
        try {
            current = await FileSystemService.readJSON<CurrentConfig>(currentUri);
        } catch (error) {
            throw new Error(
                `Failed to read current.json. ${this.getErrorMessage(error)}`
            );
        }

        if (!current.activeVersion) {
            throw new Error("Invalid current.json: missing activeVersion");
        }
        if (typeof current.latestVersion !== "number") {
            throw new Error(
                "Invalid current.json: latestVersion is missing or not a number"
            );
        }

        this.currentCache = current;
        return current;
    }

    /**
     * Atomically update current.json with the given partial fields.
     * Always stamps lastUpdatedAt to the current time.
     * Invalidates both caches on success.
     */
    static async updateCurrent(partial: Partial<CurrentConfig>): Promise<CurrentConfig> {
        await this.guardInitialized();

        // Always read fresh from disk — never use stale cache when writing.
        this.invalidateCurrentCache();
        const existing = await this.getActiveVersion();

        const updated: CurrentConfig = {
            ...existing,
            ...partial,
            lastUpdatedAt: new Date().toISOString(),
        };

        const currentUri = vscode.Uri.joinPath(this.getCFRoot(), "current.json");

        try {
            await FileSystemService.writeJSON(currentUri, updated);
        } catch (error) {
            throw new Error(
                `Failed to update current.json. ${this.getErrorMessage(error)}`
            );
        }

        // Invalidate both — a version bump can affect which global.json we fall back to.
        this.invalidateCurrentCache();
        this.invalidateGlobalCache();
        return updated;
    }

    // ─────────────────────────────────────────────────────────────────────
    // global.json  (project-wide config)
    // ─────────────────────────────────────────────────────────────────────

    /**
     * Read the global config.
     *
     * Priority:
     *   1. In-memory cache (if valid).
     *   2. temp/global.json  — live staging area for uncommitted changes.
     *   3. {activeVersion}/global.json — fallback when temp has been cleared
     *      (e.g. immediately after saveChanges promoted temp → versioned copy).
     *
     * Throws only if neither location has a readable file.
     */
    static async getGlobal(): Promise<GlobalConfig> {
        if (this.globalCache) {
            return this.globalCache;
        }

        await this.guardInitialized();

        const tempGlobalUri = vscode.Uri.joinPath(
            this.getCFRoot(), "temp", "global.json"
        );

        // ── Primary: temp/global.json ─────────────────────────────────────
        if (await FileSystemService.exists(tempGlobalUri)) {
            try {
                const config = await FileSystemService.readJSON<GlobalConfig>(tempGlobalUri);
                this.globalCache = config;
                return config;
            } catch (error) {
                // File exists but is corrupt — fall through to versioned fallback.
                console.warn(
                    "CFStateManager: temp/global.json is corrupt, falling back to versioned copy.",
                    error
                );
            }
        }

        // ── Fallback: {activeVersion}/global.json ─────────────────────────
        // Happens right after saveChanges clears temp, before the user makes
        // any new edits that would recreate temp/global.json.
        const current = await this.getActiveVersion();
        const versionedGlobalUri = vscode.Uri.joinPath(
            this.getCFRoot(), current.activeVersion, "global.json"
        );

        if (await FileSystemService.exists(versionedGlobalUri)) {
            try {
                const config = await FileSystemService.readJSON<GlobalConfig>(versionedGlobalUri);

                // Re-materialise temp/global.json so subsequent writes have somewhere to go.
                // This keeps the invariant: writes always go to temp/global.json.
                await FileSystemService.ensureDirectory(
                    vscode.Uri.joinPath(this.getCFRoot(), "temp")
                );
                await FileSystemService.writeJSON(tempGlobalUri, config);

                this.globalCache = config;
                return config;
            } catch (error) {
                throw new Error(
                    `Failed to read versioned global config (${current.activeVersion}/global.json). ` +
                    this.getErrorMessage(error)
                );
            }
        }

        throw new Error(
            "global.json not found in temp/ or the active version directory. " +
            "ContextForge may not be initialized correctly. " +
            "Please run 'ContextForge: Init CF' again."
        );
    }

    /**
     * Merge partial fields into temp/global.json and persist.
     *
     * Always reads fresh from disk before merging to avoid overwriting
     * concurrent writes with stale cached data.
     */
    static async updateGlobal(partial: Partial<GlobalConfig>): Promise<GlobalConfig> {
        await this.guardInitialized();

        // Invalidate before reading so we always merge against the latest disk state.
        this.invalidateGlobalCache();
        const existing = await this.getGlobal();

        const updated: GlobalConfig = {
            ...existing,
            ...partial,
            updatedAt: new Date().toISOString(),
        };

        const tempGlobalUri = vscode.Uri.joinPath(
            this.getCFRoot(), "temp", "global.json"
        );

        // Ensure temp/ exists (may have been cleared by saveChanges).
        await FileSystemService.ensureDirectory(this.getTempPath());

        try {
            await FileSystemService.writeJSON(tempGlobalUri, updated);
        } catch (error) {
            throw new Error(
                `Failed to update temp/global.json. ${this.getErrorMessage(error)}`
            );
        }

        this.invalidateGlobalCache();
        return updated;
    }

    // ─────────────────────────────────────────────────────────────────────
    // Cache management
    // ─────────────────────────────────────────────────────────────────────

    /** Invalidate all in-memory caches. */
    static invalidateCache(): void {
        this.currentCache = null;
        this.globalCache = null;
    }

    /** Invalidate only the CurrentConfig cache. */
    static invalidateCurrentCache(): void {
        this.currentCache = null;
    }

    /** Invalidate only the GlobalConfig cache. */
    static invalidateGlobalCache(): void {
        this.globalCache = null;
    }
}
































// import * as vscode from "vscode";
// import { FileSystemService } from "../services/FileSystemService";
// import {
//     CurrentConfig,
//     GlobalConfig
// } from "../utils/types";

// export class CFStateManager {
//     private static currentCache: CurrentConfig | null = null;
//     private static globalCache: GlobalConfig | null = null;

//     private static getWorkspaceRoot(): vscode.Uri {
//         const workspace = vscode.workspace.workspaceFolders?.[0];
//         if (!workspace) {
//             throw new Error("No workspace folder found. Please open a project folder first.");
//         }
//         return workspace.uri;
//     }

//     static getCFRoot(): vscode.Uri {
//         const root = this.getWorkspaceRoot();
//         return vscode.Uri.joinPath(root, ".contextforge");
//     }

//     // Only check current.json — that's the real indicator CF is initialized
//     static async guardInitialized(): Promise<void> {
//         const cfRoot = this.getCFRoot();
//         const currentUri = vscode.Uri.joinPath(cfRoot, "current.json");

//         const currentExists = await FileSystemService.exists(currentUri);
//         if (!currentExists) {
//             throw new Error(
//                 "ContextForge is not initialized. Please run 'ContextForge: Init CF' first."
//             );
//         }
//     }

//     static async getActiveVersion(): Promise<CurrentConfig> {
//         if (this.currentCache) {
//             return this.currentCache;
//         }

//         await this.guardInitialized();

//         const currentUri = vscode.Uri.joinPath(this.getCFRoot(), "current.json");

//         try {
//             const current = await FileSystemService.readJSON<CurrentConfig>(currentUri);

//             if (!current.activeVersion) {
//                 throw new Error("Invalid current.json: missing activeVersion");
//             }
//             if (typeof current.latestVersion !== "number") {
//                 throw new Error("Invalid current.json: latestVersion is missing or not a number");
//             }

//             this.currentCache = current;
//             return current;
//         } catch (error) {
//             throw new Error(
//                 `Failed to load current configuration. ${this.getErrorMessage(error)}`
//             );
//         }
//     }

//     // No parameter needed — temp path is always the same
//     static getTempPath(): vscode.Uri {
//         return vscode.Uri.joinPath(this.getCFRoot(), "temp");
//     }

//     static getVersionPath(version: number | string): vscode.Uri {
//         const normalizedVersion =
//             typeof version === "number"
//                 ? `v${version}`
//                 : version.startsWith("v")
//                 ? version
//                 : `v${version}`;

//         return vscode.Uri.joinPath(this.getCFRoot(), normalizedVersion);
//     }

//     // Reads from temp/global.json — source of truth for active changes
//     static async getGlobal(): Promise<GlobalConfig> {
//         if (this.globalCache) {
//             return this.globalCache;
//         }

//         await this.guardInitialized();

//         const globalUri = vscode.Uri.joinPath(this.getCFRoot(), "temp", "global.json");

//         const globalExists = await FileSystemService.exists(globalUri);
//         if (!globalExists) {
//             throw new Error(
//                 "temp/global.json not found. ContextForge may not be initialized correctly."
//             );
//         }

//         try {
//             const global = await FileSystemService.readJSON<GlobalConfig>(globalUri);
//             this.globalCache = global;
//             return global;
//         } catch (error) {
//             throw new Error(
//                 `Failed to load global configuration. ${this.getErrorMessage(error)}`
//             );
//         }
//     }

//     // Updates temp/global.json — changes live in temp until saveChanges is run
//     static async updateGlobal(partial: Partial<GlobalConfig>): Promise<GlobalConfig> {
//         await this.guardInitialized();

//         const existingGlobal = await this.getGlobal();

//         const updatedGlobal: GlobalConfig = {
//             ...existingGlobal,
//             ...partial,
//             updatedAt: new Date().toISOString(),
//         };

//         const globalUri = vscode.Uri.joinPath(this.getCFRoot(), "temp", "global.json");

//         try {
//             await FileSystemService.writeJSON(globalUri, updatedGlobal);
//             this.invalidateGlobalCache();
//             return updatedGlobal;
//         } catch (error) {
//             throw new Error(
//                 `Failed to update temp/global.json. ${this.getErrorMessage(error)}`
//             );
//         }
//     }

//     static async updateCurrent(partial: Partial<CurrentConfig>): Promise<CurrentConfig> {
//         await this.guardInitialized();

//         const existingCurrent = await this.getActiveVersion();

//         const updatedCurrent: CurrentConfig = {
//             ...existingCurrent,
//             ...partial,
//             lastUpdatedAt: new Date().toISOString(),
//         };

//         const currentUri = vscode.Uri.joinPath(this.getCFRoot(), "current.json");

//         try {
//             await FileSystemService.writeJSON(currentUri, updatedCurrent);
//             this.invalidateCurrentCache();
//             this.invalidateGlobalCache();
//             return updatedCurrent;
//         } catch (error) {
//             throw new Error(
//                 `Failed to update current.json. ${this.getErrorMessage(error)}`
//             );
//         }
//     }

//     static invalidateCache(): void {
//         this.currentCache = null;
//         this.globalCache = null;
//     }

//     static invalidateCurrentCache(): void {
//         this.currentCache = null;
//     }

//     static invalidateGlobalCache(): void {
//         this.globalCache = null;
//     }

//     private static getErrorMessage(error: unknown): string {
//         if (error instanceof Error) {
//             return error.message;
//         }
//         return String(error);
//     }
// }