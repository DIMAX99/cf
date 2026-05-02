import * as vscode from "vscode";

export class BackendService {
  private static instance: BackendService;

  private constructor() {}

  static getInstance(): BackendService {
    if (!BackendService.instance) {
      BackendService.instance = new BackendService();
    }
    return BackendService.instance;
  }

  /**
   * Get backend URL from VS Code settings
   */
  private getBackendUrl(): string {
    const config = vscode.workspace.getConfiguration("contextforge");
    const url = config.get<string>("backendUrl", "");
    return url.trim();
  }

  /**
   * Get API key from VS Code settings
   */
  private getApiKey(): string {
    const config = vscode.workspace.getConfiguration("contextforge");
    const key = config.get<string>("apiKey", "");
    return key.trim();
  }

  /**
   * Ping the backend health endpoint
   * GET /health
   */
  async ping(): Promise<boolean> {
    try {
      const backendUrl = this.getBackendUrl();
      const apiKey = this.getApiKey();

      if (!backendUrl) {
        vscode.window.showWarningMessage(
          "ContextForge backend URL not configured. Please set 'contextforge.backendUrl' in settings."
        );
        return false;
      }

      const healthUrl = `${backendUrl}/health`;
      const response = await fetch(healthUrl, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey && { "X-API-Key": apiKey })
        }
      });

      return response.ok;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      vscode.window.showWarningMessage(
        `ContextForge backend is unreachable: ${errorMessage}`
      );
      return false;
    }
  }

  /**
   * Make an authenticated POST request to the backend
   * POST {endpoint}
   */
  async post<T>(endpoint: string, body: unknown): Promise<T | null> {
    try {
      const backendUrl = this.getBackendUrl();
      const apiKey = this.getApiKey();

      if (!backendUrl) {
        vscode.window.showWarningMessage(
          "ContextForge backend URL not configured. Please set 'contextforge.backendUrl' in settings."
        );
        return null;
      }

      if (!apiKey) {
        vscode.window.showWarningMessage(
          "ContextForge API key not configured. Please set 'contextforge.apiKey' in settings."
        );
        return null;
      }

      const url = `${backendUrl}${endpoint.startsWith("/") ? endpoint : "/" + endpoint}`;

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": apiKey
        },
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Backend returned ${response.status}: ${errorText}`
        );
      }

      const data = await response.json() as T;
      return data;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      vscode.window.showWarningMessage(
        `ContextForge backend request failed: ${errorMessage}`
      );
      return null;
    }
  }
}
