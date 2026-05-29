export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };
export type BrokerId = string | number | null;
export type ToolArgumentsPayload = JsonObject | string;
export type JsonSchema = JsonObject;

export type ToolName =
  | "browser.list_tabs"
  | "browser.open_url"
  | "browser.switch_tab"
  | "browser.get_page_content"
  | "browser.get_interactive_elements"
  | "browser.get_snapshot"
  | "browser.click"
  | "browser.move_mouse"
  | "browser.mouse_down"
  | "browser.mouse_up"
  | "browser.drag"
  | "browser.type"
  | "browser.press_key"
  | "browser.screenshot"
  | "browser.get_console_logs"
  | "browser.get_network_events"
  | "browser.go_back"
  | "browser.go_forward"
  | "browser.close_tab"
  | "browser.close_page"
  | "workspace.list_roots"
  | "workspace.list_projects"
  | "workspace.describe_project"
  | "coding_agent.start_task"
  | "coding_agent.get_status"
  | "coding_agent.get_output"
  | "coding_agent.cancel"
  | "git.status"
  | "git.diff"
  | "git.commit"
  | "git.push"
  | `${string}.${string}`;

export type ErrorCode =
  | "approval_denied"
  | "busy"
  | "invalid_arguments"
  | "lease_expired"
  | "lease_required"
  | "not_found"
  | "slot_limit"
  | "tool_failed"
  | "unknown_message"
  | "unknown_tool";

export type CapabilityAccess = "passive" | "lease_required" | "approval_required";

export type Capability = {
  name: ToolName;
  access: CapabilityAccess;
  description: string;
  inputSchema?: JsonSchema;
  groups?: string[];
};

export type ActiveLease = {
  lease_id: string;
  agent_id: string;
  task_id: string;
  requested_tools: string[];
  expires_at: string;
  workspace_key?: string;
};

export type DaemonStatus = {
  status: "online" | "offline";
  max_agent_slots: number;
  connected_agents: number;
  active_lease: ActiveLease | null;
  active_leases?: ActiveLease[];
};

export type ToolCallMessage = {
  type: "tool_call";
  request_id: string;
  lease_id?: string;
  agent_id?: BrokerId;
  event_run_id?: BrokerId;
  task_id?: BrokerId;
  requested_action_key?: string;
  tool: ToolName;
  arguments?: ToolArgumentsPayload;
  input?: ToolArgumentsPayload;
  tool_input?: ToolArgumentsPayload;
  parameters?: ToolArgumentsPayload;
  params?: ToolArgumentsPayload;
  metadata?: ToolArgumentsPayload;
};

export type ToolResultMessage =
  | {
      type: "tool_result";
      request_id: string;
      status: "ok";
      result: JsonValue;
    }
  | {
      type: "tool_result";
      request_id: string;
      status: "error";
      error_code: ErrorCode;
      message: string;
      details?: JsonObject;
    };

export type ControlAction =
  | "acquire_lease"
  | "heartbeat_lease"
  | "release_lease"
  | "get_daemon_status"
  | "list_capabilities";

export type ControlRequestMessage = {
  type: "control_request";
  request_id: string;
  action: ControlAction;
  arguments?: JsonObject;
};

export type ControlResultMessage =
  | {
      type: "control_result";
      request_id: string;
      status: "ok";
      result: JsonValue;
    }
  | {
      type: "control_result";
      request_id: string;
      status: "error";
      error_code: ErrorCode;
      message: string;
      details?: JsonObject;
    };

export type HelloMessage = {
  type: "hello";
  platform: string;
  daemon_version: string;
  capabilities: {
    tools: Capability[];
  };
};

export type HeartbeatMessage = {
  type: "heartbeat";
  capabilities?: {
    tools: Capability[];
  };
};

export type LocalTaskCompletedMessage = {
  type: "local_task_completed";
  request_id?: string;
  tool: ToolName;
  agent_id?: BrokerId;
  event_run_id?: BrokerId;
  task_id: string;
  local_task_id?: string;
  status: string;
  result: JsonObject;
};

export type ApprovalRequestMessage = {
  type: "approval_request";
  request_id: string;
  tool: string;
  summary: string;
  metadata?: JsonObject;
};

export type ApprovalResponseMessage = {
  type: "approval_response";
  request_id: string;
  approved: boolean;
  reason?: string;
};

export type SyncedAgent = {
  agent_id: BrokerId;
  name?: string;
  icon?: string;
  avatar_url?: string | null;
  browser_enabled?: boolean;
  coding_enabled?: boolean;
  git_read_enabled?: boolean;
  git_write_enabled?: boolean;
  browser_profile_key?: string;
};

export type AgentsSyncMessage = {
  type: "agents_sync";
  connection_id?: BrokerId;
  agents: SyncedAgent[];
};

export type RuntimeMessage =
  | ToolCallMessage
  | ToolResultMessage
  | ControlRequestMessage
  | ControlResultMessage
  | HelloMessage
  | HeartbeatMessage
  | LocalTaskCompletedMessage
  | ApprovalRequestMessage
  | ApprovalResponseMessage
  | AgentsSyncMessage;

export function okToolResult(requestId: string, result: JsonValue): ToolResultMessage {
  return {
    type: "tool_result",
    request_id: requestId,
    status: "ok",
    result
  };
}

export function errorToolResult(
  requestId: string,
  errorCode: ErrorCode,
  message: string,
  details?: JsonObject
): ToolResultMessage {
  return {
    type: "tool_result",
    request_id: requestId,
    status: "error",
    error_code: errorCode,
    message,
    details
  };
}

export function okControlResult(requestId: string, result: JsonValue): ControlResultMessage {
  return {
    type: "control_result",
    request_id: requestId,
    status: "ok",
    result
  };
}

export function errorControlResult(
  requestId: string,
  errorCode: ErrorCode,
  message: string,
  details?: JsonObject
): ControlResultMessage {
  return {
    type: "control_result",
    request_id: requestId,
    status: "error",
    error_code: errorCode,
    message,
    details
  };
}

export function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isToolCallMessage(value: unknown): value is ToolCallMessage {
  return (
    isJsonObject(value) &&
    value.type === "tool_call" &&
    typeof value.request_id === "string" &&
    typeof value.tool === "string" &&
    isToolArgumentsPayload(value.arguments) &&
    isToolArgumentsPayload(value.input) &&
    isToolArgumentsPayload(value.tool_input) &&
    isToolArgumentsPayload(value.parameters) &&
    isToolArgumentsPayload(value.params) &&
    isToolArgumentsPayload(value.metadata)
  );
}

function isToolArgumentsPayload(value: unknown): value is ToolArgumentsPayload | undefined {
  return value === undefined || typeof value === "string" || isJsonObject(value);
}

export function isControlRequestMessage(value: unknown): value is ControlRequestMessage {
  return (
    isJsonObject(value) &&
    value.type === "control_request" &&
    typeof value.request_id === "string" &&
    typeof value.action === "string" &&
    (value.arguments === undefined || isJsonObject(value.arguments))
  );
}

export function isAgentsSyncMessage(value: unknown): value is AgentsSyncMessage {
  return (
    isJsonObject(value) &&
    value.type === "agents_sync" &&
    Array.isArray(value.agents) &&
    value.agents.every((agent) => isJsonObject(agent))
  );
}

export function isApprovalResponseMessage(value: unknown): value is ApprovalResponseMessage {
  return (
    isJsonObject(value) &&
    value.type === "approval_response" &&
    typeof value.request_id === "string" &&
    typeof value.approved === "boolean" &&
    (value.reason === undefined || typeof value.reason === "string")
  );
}

export function toolRequiresLease(tool: string): boolean {
  if (tool === "coding_agent.start_task") {
    return true;
  }

  return tool === "git.commit" || tool === "git.push";
}

export function toolCapabilityAccess(tool: string): CapabilityAccess {
  if (tool === "git.commit" || tool === "git.push") {
    return "approval_required";
  }

  return toolRequiresLease(tool) ? "lease_required" : "passive";
}

export function inputSchemaForTool(tool: string): JsonSchema {
  switch (tool) {
    case "browser.open_url":
      return objectSchema(
        {
          url: stringSchema("HTTP or HTTPS URL to open."),
          page_id: stringSchema("Optional page id to reuse."),
          new_tab: booleanSchema("Open the URL in a new tab."),
          new_window: booleanSchema("Open the URL in a new window."),
          wait_until: stringEnumSchema(
            ["commit", "domcontentloaded", "load", "networkidle"],
            "Navigation load state to wait for. Defaults to load."
          ),
          timeout_ms: numberSchema("Maximum navigation wait in milliseconds. Defaults to 30000."),
          settle_ms: numberSchema("Best-effort network idle wait after load in milliseconds. Defaults to 5000.")
        },
        ["url"]
      );
    case "browser.switch_tab":
      return objectSchema({
        page_id: stringSchema("Page id to switch to."),
        tab_id: numberSchema("Numeric tab id to switch to.")
      });
    case "browser.get_page_content":
      return objectSchema({
        page_id: stringSchema("Optional page id. Defaults to the active page."),
        selector: stringSchema("Optional CSS selector to extract."),
        format: stringEnumSchema(["text", "html"], "Content format to return.")
      });
    case "browser.get_interactive_elements":
      return objectSchema({
        page_id: stringSchema("Optional page id. Defaults to the active page.")
      });
    case "browser.get_snapshot":
      return objectSchema({
        page_id: stringSchema("Optional page id. Defaults to the active page."),
        filter: stringEnumSchema(["all", "interactive"], "Snapshot filter.")
      });
    case "browser.click":
      return objectSchema({
        page_id: stringSchema("Optional page id. Defaults to the active page."),
        ref: stringSchema("Element ref from browser.get_snapshot or browser.get_interactive_elements."),
        selector: stringSchema("CSS selector to click."),
        x: numberSchema("Viewport x coordinate to click."),
        y: numberSchema("Viewport y coordinate to click.")
      });
    case "browser.move_mouse":
      return objectSchema(
        {
          page_id: stringSchema("Optional page id. Defaults to the active page."),
          x: numberSchema("Viewport x coordinate to move to."),
          y: numberSchema("Viewport y coordinate to move to."),
          steps: numberSchema("Number of intermediate mouse move steps. Defaults to 1.")
        },
        ["x", "y"]
      );
    case "browser.mouse_down":
      return objectSchema({
        page_id: stringSchema("Optional page id. Defaults to the active page."),
        button: stringEnumSchema(["left", "right", "middle"], "Mouse button to press. Defaults to left.")
      });
    case "browser.mouse_up":
      return objectSchema({
        page_id: stringSchema("Optional page id. Defaults to the active page."),
        button: stringEnumSchema(["left", "right", "middle"], "Mouse button to release. Defaults to left.")
      });
    case "browser.drag":
      return objectSchema(
        {
          page_id: stringSchema("Optional page id. Defaults to the active page."),
          from_x: numberSchema("Starting viewport x coordinate."),
          from_y: numberSchema("Starting viewport y coordinate."),
          to_x: numberSchema("Ending viewport x coordinate."),
          to_y: numberSchema("Ending viewport y coordinate."),
          steps: numberSchema("Number of intermediate mouse move steps. Defaults to 10."),
          button: stringEnumSchema(["left", "right", "middle"], "Mouse button to hold while dragging. Defaults to left.")
        },
        ["from_x", "from_y", "to_x", "to_y"]
      );
    case "browser.type":
      return objectSchema(
        {
          page_id: stringSchema("Optional page id. Defaults to the active page."),
          ref: stringSchema("Element ref from browser.get_snapshot or browser.get_interactive_elements."),
          selector: stringSchema("CSS selector of the field to fill."),
          text: stringSchema("Text to type or fill into the target field.")
        },
        ["text"]
      );
    case "browser.press_key":
      return objectSchema(
        {
          page_id: stringSchema("Optional page id. Defaults to the active page."),
          key: stringSchema("Keyboard key or shortcut, for example Enter, Escape, Meta+L, or Control+A.")
        },
        ["key"]
      );
    case "browser.screenshot":
      return objectSchema({
        page_id: stringSchema("Optional page id. Defaults to the active page."),
        full_page: booleanSchema("Capture the full scrollable page instead of the viewport.")
      });
    case "browser.get_console_logs":
    case "browser.get_network_events":
    case "browser.go_back":
    case "browser.go_forward":
    case "browser.close_tab":
    case "browser.close_page":
      return objectSchema({
        page_id: stringSchema("Optional page id. Defaults to the active page.")
      });
    case "workspace.list_roots":
      return emptyObjectSchema();
    case "workspace.list_projects":
      return objectSchema({
        root: stringSchema("Optional allowed workspace root to scan. Defaults to all allowed roots."),
        max_depth: numberSchema("Maximum directory depth to scan. Defaults to 3, maximum 8."),
        max_results: numberSchema("Maximum projects to return. Defaults to 50, maximum 200.")
      });
    case "workspace.describe_project":
      return objectSchema({
        project: stringSchema("Preferred project key/name from workspace.list_projects. Use this instead of inventing absolute paths."),
        path: stringSchema("Optional allowed local project directory to describe.")
      });
    case "coding_agent.start_task":
      return objectSchema(
        {
          prompt: stringSchema("Task prompt to send to the local coding agent."),
          project: stringSchema("Preferred project key/name from workspace.list_projects. Use this instead of inventing absolute paths."),
          cwd: stringSchema("Optional allowed working directory for the task. Prefer project unless the user provided an exact path."),
          continue_session: booleanSchema("Continue the previous local coding-agent session for this agent/project when available. Defaults to false."),
          session_key: stringSchema("Optional stable session key. Use the same key with continue_session=true to resume a specific coding-agent session."),
          sandbox: stringEnumSchema(
            ["read-only", "workspace-write", "danger-full-access"],
            "Coding-agent sandbox policy. Defaults to read-only. workspace-write and danger-full-access require approval."
          ),
          model: stringSchema("Optional coding-agent model override."),
          reasoning_effort: stringEnumSchema(
            ["low", "medium", "high", "xhigh", "max"],
            "Optional coding-agent reasoning effort override."
          ),
          permission_mode: stringEnumSchema(
            ["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"],
            "Optional Claude Code permission mode override. Risky modes require local approval."
          ),
          ephemeral: booleanSchema("Codex only: run without persisting session rollout files."),
          skip_git_repo_check: booleanSchema("Allow running outside a git repository.")
        },
        ["prompt"]
      );
    case "coding_agent.get_status":
    case "coding_agent.cancel":
      return objectSchema(
        {
          task_id: stringSchema("Local coding task id returned by coding_agent.start_task.")
        },
        ["task_id"]
      );
    case "coding_agent.get_output":
      return objectSchema(
        {
          task_id: stringSchema("Local coding task id returned by coding_agent.start_task."),
          since_event_index: numberSchema("Return coding-agent JSONL events starting at this event index."),
          max_events: numberSchema("Maximum number of events to return.")
        },
        ["task_id"]
      );
    case "git.status":
      return objectSchema({
        project: stringSchema("Preferred project key/name from workspace.list_projects. Use this instead of inventing absolute paths."),
        cwd: stringSchema("Optional allowed git working directory. Prefer project unless the user provided an exact path.")
      });
    case "git.diff":
      return objectSchema({
        project: stringSchema("Preferred project key/name from workspace.list_projects. Use this instead of inventing absolute paths."),
        cwd: stringSchema("Optional allowed git working directory. Prefer project unless the user provided an exact path."),
        staged: booleanSchema("Return staged diff instead of unstaged diff.")
      });
    case "git.commit":
      return objectSchema(
        {
          project: stringSchema("Preferred project key/name from workspace.list_projects. Use this instead of inventing absolute paths."),
          cwd: stringSchema("Optional allowed git working directory. Prefer project unless the user provided an exact path."),
          message: stringSchema("Commit message."),
          paths: stringArraySchema("Optional paths to stage before committing.")
        },
        ["message"]
      );
    case "git.push":
      return objectSchema({
        project: stringSchema("Preferred project key/name from workspace.list_projects. Use this instead of inventing absolute paths."),
        cwd: stringSchema("Optional allowed git working directory. Prefer project unless the user provided an exact path."),
        remote: stringSchema("Git remote name. Defaults to origin."),
        branch: stringSchema("Branch to push. Defaults to the current branch.")
      });
    default:
      return emptyObjectSchema();
  }
}

export function defaultCapabilities(): Capability[] {
  return [
    capability("browser.list_tabs", "List pages in the local managed browser session."),
    capability("browser.open_url", "Open a URL in the local managed browser session."),
    capability("browser.switch_tab", "Switch to an existing browser page."),
    capability("browser.get_page_content", "Extract visible page text or HTML from the active tab."),
    capability("browser.get_interactive_elements", "Read interactive elements from the active page."),
    capability("browser.get_snapshot", "Return an accessibility-like page snapshot."),
    capability("browser.click", "Click by element ref, selector, or page coordinates."),
    capability("browser.move_mouse", "Move the mouse pointer to page coordinates."),
    capability("browser.mouse_down", "Press and hold a mouse button."),
    capability("browser.mouse_up", "Release a mouse button."),
    capability("browser.drag", "Drag from one page coordinate to another."),
    capability("browser.type", "Type text or fill a targeted field."),
    capability("browser.press_key", "Press a keyboard key or shortcut in the browser."),
    capability("browser.screenshot", "Capture a screenshot from the active tab."),
    capability("browser.get_console_logs", "Return captured console output."),
    capability("browser.get_network_events", "Return captured network events."),
    capability("browser.go_back", "Navigate the active tab back."),
    capability("browser.go_forward", "Navigate the active tab forward."),
    capability("browser.close_tab", "Close the active or selected browser tab."),
    capability("browser.close_page", "Compatibility alias for browser.close_tab."),
    capability("workspace.list_roots", "List local filesystem roots the agent is allowed to inspect. Use this before choosing a project path."),
    capability("workspace.list_projects", "Discover local projects under allowed roots. Use the returned project key/name for coding and git tools instead of inventing absolute paths."),
    capability("workspace.describe_project", "Inspect a discovered local project key/name or path and summarize markers, stack, package metadata, and git state."),
    capability("coding_agent.start_task", "Start a local Codex, Claude Code, or Antigravity task in a discovered project. Prefer project over absolute cwd. Set continue_session=true to resume prior context for the same agent/project when available. Returns immediately with task_id; poll coding_agent.get_status/get_output."),
    capability("coding_agent.get_status", "Get local coding-agent task status by task_id."),
    capability("coding_agent.get_output", "Read local coding-agent task output and streamed events by task_id."),
    capability("coding_agent.cancel", "Cancel a running local coding-agent task."),
    capability("git.status", "Read git status for a discovered project. Prefer project over absolute cwd."),
    capability("git.diff", "Read git diff for a discovered project. Prefer project over absolute cwd."),
    capability("git.commit", "Create a git commit in a discovered project after local approval. Prefer project over absolute cwd."),
    capability("git.push", "Push git commits from a discovered project after local approval. Prefer project over absolute cwd.")
  ];
}

function capability(name: ToolName, description: string): Capability {
  return {
    name,
    access: toolCapabilityAccess(name),
    description,
    inputSchema: inputSchemaForTool(name),
    groups: capabilityGroups(name)
  };
}

export function capabilityGroups(tool: string): string[] {
  if (tool.startsWith("browser.")) {
    return ["browser"];
  }
  if (tool.startsWith("coding_agent.")) {
    return ["codex"];
  }
  if (tool.startsWith("git.")) {
    const verb = tool.split(".", 2)[1];
    return ["commit", "push", "tag", "checkout", "reset", "merge", "rebase"].includes(verb)
      ? ["git_write"]
      : ["git_read"];
  }
  return [];
}

function emptyObjectSchema(): JsonSchema {
  return objectSchema({});
}

function objectSchema(properties: JsonObject, required: string[] = []): JsonSchema {
  const schema: JsonSchema = {
    type: "object",
    additionalProperties: false,
    properties
  };
  if (required.length > 0) {
    schema.required = required;
  }
  return schema;
}

function stringSchema(description: string): JsonSchema {
  return { type: "string", description };
}

function numberSchema(description: string): JsonSchema {
  return { type: "number", description };
}

function booleanSchema(description: string): JsonSchema {
  return { type: "boolean", description };
}

function stringArraySchema(description: string): JsonSchema {
  return {
    type: "array",
    description,
    items: { type: "string" }
  };
}

function stringEnumSchema(values: string[], description: string): JsonSchema {
  return {
    type: "string",
    description,
    enum: values
  };
}
