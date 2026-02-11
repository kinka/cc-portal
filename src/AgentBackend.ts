/**
 * AgentBackend - Universal interface for AI agent backends
 * Based on happy-cli's AgentBackend interface
 */

/** Unique identifier for an agent session */
export type SessionId = string;

/** Unique identifier for a tool call */
export type ToolCallId = string;

/**
 * Messages emitted by an agent backend during a session.
 */
export type AgentMessage =
  | { type: 'model-output'; textDelta?: string; fullText?: string }
  | { type: 'status'; status: 'starting' | 'running' | 'idle' | 'stopped' | 'error'; detail?: string }
  | { type: 'tool-call'; toolName: string; args: Record<string, unknown>; callId: ToolCallId }
  | { type: 'tool-result'; toolName: string; result: unknown; callId: ToolCallId }
  | { type: 'permission-request'; id: string; reason: string; payload: unknown }
  | { type: 'permission-response'; id: string; approved: boolean }
  | { type: 'fs-edit'; description: string; diff?: string; path?: string }
  | { type: 'terminal-output'; data: string }
  | { type: 'event'; name: string; payload: unknown }
  | { type: 'token-count'; [key: string]: unknown }
  | { type: 'error'; error: string };

/** MCP server configuration for tools */
export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** Transport type for agent communication */
export type AgentTransport = 'native-claude' | 'mcp-codex' | 'acp';

/** Agent identifier */
export type AgentId = 'claude' | 'codex' | 'gemini' | 'opencode' | 'claude-acp' | 'codex-acp';

/**
 * Configuration for creating an agent backend
 */
export interface AgentBackendConfig {
  /** Working directory for the agent */
  cwd: string;

  /** Name of the agent */
  agentName: AgentId;

  /** Transport protocol to use */
  transport: AgentTransport;

  /** Environment variables to pass to the agent */
  env?: Record<string, string>;

  /** MCP servers to make available to the agent */
  mcpServers?: Record<string, McpServerConfig>;
}

/**
 * Result of starting a session
 */
export interface StartSessionResult {
  sessionId: SessionId;
}

/**
 * Handler function type for agent messages
 */
export type AgentMessageHandler = (msg: AgentMessage) => void;

/**
 * Universal interface for agent backends.
 */
export interface AgentBackend {
  /**
   * Start a new agent session.
   */
  startSession(initialPrompt?: string): Promise<StartSessionResult>;

  /**
   * Send a prompt to an existing session.
   */
  sendPrompt(sessionId: SessionId, prompt: string): Promise<void>;

  /**
   * Cancel the current operation in a session.
   */
  cancel(sessionId: SessionId): Promise<void>;

  /**
   * Register a handler for agent messages.
   */
  onMessage(handler: AgentMessageHandler): void;

  /**
   * Remove a previously registered message handler.
   */
  offMessage?(handler: AgentMessageHandler): void;

  /**
   * Respond to a permission request.
   */
  respondToPermission?(requestId: string, approved: boolean): Promise<void>;

  /**
   * Wait for the current response to complete.
   */
  waitForResponseComplete?(timeoutMs?: number): Promise<void>;

  /**
   * Clean up resources and close the backend.
   */
  dispose(): Promise<void>;
}
