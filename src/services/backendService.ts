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

  /**
   * Connect to WebSocket for streaming task progress
   * @param taskId Task ID to stream progress for
   * @param onMessage Callback for each progress message
   * @param onError Callback for errors
   * @param onClose Callback when connection closes
   * @returns Function to close the connection
   */
  async connectWebSocket(
    taskId: string,
    onMessage: (data: unknown) => void,
    onError?: (error: Error) => void,
    onClose?: () => void
  ): Promise<() => void> {
    try {
      const backendUrl = this.getBackendUrl();
      const apiKey = this.getApiKey();

      if (!backendUrl) {
        throw new Error("ContextForge backend URL not configured");
      }

      if (!apiKey) {
        throw new Error("ContextForge API key not configured");
      }

      // Convert http/https to ws/wss
      const wsUrl = backendUrl
        .replace(/^https:/, "wss:")
        .replace(/^http:/, "ws:");

      const wsUrlWithParams = `${wsUrl}/ws/tasks/${taskId}?api_key=${encodeURIComponent(apiKey)}`;
      
      const ws = new WebSocket(wsUrlWithParams);

      ws.addEventListener("open", () => {
        console.log(`WebSocket connected for task ${taskId}`);
      });

      ws.addEventListener("message", (event) => {
        try {
          const data = JSON.parse(event.data);
          onMessage(data);
        } catch (error) {
          console.error("Failed to parse WebSocket message:", error);
        }
      });

      ws.addEventListener("error", (event) => {
        const error = new Error(`WebSocket error: ${event.type}`);
        onError?.(error);
      });

      ws.addEventListener("close", () => {
        console.log(`WebSocket closed for task ${taskId}`);
        onClose?.();
      });

      // Return close function
      return () => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.close();
        }
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to connect WebSocket: ${errorMessage}`);
    }
  }
}
