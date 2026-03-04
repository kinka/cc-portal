/**
 * SDK types aligned with Claude Code / happy-cli
 * - Message types: system, user, assistant, result, log, control_request, control_response
 * - Permission: PermissionResult, CanCallToolCallback
 * - Control: can_use_tool, interrupt, control_cancel_request
 */

export interface SDKMessage {
  type: string;
  [key: string]: unknown;
}

export interface SDKUserMessage extends SDKMessage {
  type: 'user';
  parent_tool_use_id?: string;
  message: {
    role: 'user';
    content:
      | string
      | Array<{
          type: string;
          text?: string;
          tool_use_id?: string;
          content?: unknown;
          [key: string]: unknown;
        }>;
  };
}

export interface SDKAssistantMessage extends SDKMessage {
  type: 'assistant';
  parent_tool_use_id?: string;
  message: {
    role: 'assistant';
    content: Array<{
      type: string;
      text?: string;
      id?: string;
      name?: string;
      input?: unknown;
      [key: string]: unknown;
    }>;
  };
}

export interface SDKSystemMessage extends SDKMessage {
  type: 'system';
  subtype: string;
  session_id?: string;
  model?: string;
  cwd?: string;
  tools?: string[];
  slash_commands?: string[];
}

export interface SDKResultMessage extends SDKMessage {
  type: 'result';
  subtype: 'success' | 'error_max_turns' | 'error_during_execution';
  result?: string;
  /** Error details from CLI (e.g. "No conversation found with session ID: ...") */
  errors?: string[];
  num_turns: number;
  session_id: string;
  is_error: boolean;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  total_cost_usd?: number;
  duration_ms?: number;
  duration_api_ms?: number;
}

export interface SDKLog extends SDKMessage {
  type: 'log';
  log: {
    level: 'debug' | 'info' | 'warn' | 'error';
    message: string;
  };
}

// --- Control protocol (permission / interrupt) ---

export interface SDKControlResponse extends SDKMessage {
  type: 'control_response';
  response: {
    request_id: string;
    subtype: 'success' | 'error';
    error?: string;
    response?: PermissionResult;
  };
}

export type PermissionResult =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

export interface CanCallToolCallback {
  (toolName: string, input: unknown, options: { signal: AbortSignal }): Promise<PermissionResult>;
}

export interface ControlRequest {
  subtype: string;
}

export interface CanUseToolRequest extends ControlRequest {
  subtype: 'can_use_tool';
  tool_name: string;
  input: unknown;
}

export interface CanUseToolControlRequest extends SDKMessage {
  type: 'control_request';
  request_id: string;
  request: CanUseToolRequest;
}

export interface CanUseToolControlResponse {
  type: 'control_response';
  response: {
    subtype: 'success' | 'error';
    request_id: string;
    response?: PermissionResult;
    error?: string;
  };
}

export interface SDKControlRequest {
  request_id: string;
  type: 'control_request';
  request: ControlRequest;
}

export interface ControlCancelRequest extends SDKMessage {
  type: 'control_cancel_request';
  request_id: string;
}

/** Claude Code --permission-mode values */
export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
