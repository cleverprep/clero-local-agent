import {
  errorToolResult,
  capabilityGroups,
  inputSchemaForTool,
  isJsonObject,
  okToolResult,
  toolCapabilityAccess,
  toolRequiresLease,
  type Capability,
  type ErrorCode,
  type JsonObject,
  type JsonSchema,
  type JsonValue,
  type ToolCallMessage,
  type ToolArgumentsPayload,
  type ToolName,
  type ToolResultMessage
} from "@clero-local-agent/protocol";

export type ToolExecutionContext = {
  requestId: string;
  leaseId?: string;
  agentId?: string;
  taskId?: string;
  eventRunId?: string;
  requestedActionKey?: string;
};

export type ToolHandler = (args: JsonObject, context: ToolExecutionContext) => Promise<JsonValue> | JsonValue;

export type ToolDefinition = {
  name: ToolName;
  description: string;
  inputSchema?: JsonSchema;
  groups?: string[];
  requiresLease?: boolean;
  handler: ToolHandler;
};

export class ToolExecutionError extends Error {
  readonly errorCode: ErrorCode;
  readonly details?: JsonObject;

  constructor(errorCode: ErrorCode, message: string, details?: JsonObject) {
    super(message);
    this.name = "ToolExecutionError";
    this.errorCode = errorCode;
    this.details = details;
  }
}

export type EnsureLeaseForToolCallInput = {
  requestId: string;
  leaseId?: string;
  agentId?: string;
  taskId?: string;
  requestedActionKey?: string;
  toolName: ToolName;
  workspaceKey?: string;
};

export type EnsureLeaseForToolCallResult =
  | { status: "ok"; leaseId: string }
  | { status: "error"; errorCode: ErrorCode; message: string; details?: JsonObject };

export interface LeaseGuard {
  hasActiveLease(leaseId: string): boolean;
  ensureLeaseForToolCall?(input: EnsureLeaseForToolCallInput): EnsureLeaseForToolCallResult;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register(definition: ToolDefinition): void {
    if (this.tools.has(definition.name)) {
      throw new Error(`Tool is already registered: ${definition.name}`);
    }

    this.tools.set(definition.name, {
      ...definition,
      inputSchema: definition.inputSchema ?? inputSchemaForTool(definition.name),
      requiresLease: definition.requiresLease ?? toolRequiresLease(definition.name)
    });
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  capabilities(): Capability[] {
    return this.list().map((definition) => ({
      name: definition.name,
      access: capabilityAccessForDefinition(definition),
      description: definition.description,
      inputSchema: definition.inputSchema ?? inputSchemaForTool(definition.name),
      groups: definition.groups ?? capabilityGroups(definition.name)
    }));
  }

  async execute(message: ToolCallMessage, leaseGuard: LeaseGuard): Promise<ToolResultMessage> {
    const definition = this.tools.get(message.tool);
    if (!definition) {
      return errorToolResult(message.request_id, "unknown_tool", `Unknown tool: ${message.tool}`);
    }

    const args = toolCallArguments(message);
    const argumentError = validateToolArguments(definition.inputSchema ?? inputSchemaForTool(definition.name), args);
    if (argumentError) {
      return errorToolResult(message.request_id, "invalid_arguments", argumentError);
    }

    const runContext = toolCallRunContext(message);
    const leaseResult = this.ensureLease(message, definition, leaseGuard, runContext, args);
    if (leaseResult.status === "error") {
      return errorToolResult(message.request_id, leaseResult.errorCode, leaseResult.message, leaseResult.details);
    }

    try {
      const result = await definition.handler(args, {
        requestId: message.request_id,
        leaseId: leaseResult.leaseId,
        agentId: runContext.agentId,
        taskId: runContext.taskId,
        eventRunId: runContext.eventRunId,
        requestedActionKey: message.requested_action_key
      });
      return okToolResult(message.request_id, result);
    } catch (error: unknown) {
      if (error instanceof ToolExecutionError) {
        return errorToolResult(message.request_id, error.errorCode, error.message, error.details);
      }

      const detail = error instanceof Error ? error.message : String(error);
      return errorToolResult(message.request_id, "tool_failed", detail);
    }
  }

  private ensureLease(
    message: ToolCallMessage,
    definition: ToolDefinition,
    leaseGuard: LeaseGuard,
    runContext: ToolCallRunContext,
    args: JsonObject
  ): EnsureLeaseForToolCallResult | { status: "ok"; leaseId?: string } {
    if (!definition.requiresLease) {
      return { status: "ok", leaseId: message.lease_id };
    }

    if (leaseGuard.ensureLeaseForToolCall) {
      return leaseGuard.ensureLeaseForToolCall({
        requestId: message.request_id,
        leaseId: message.lease_id,
        agentId: runContext.agentId,
        taskId: runContext.taskId,
        requestedActionKey: message.requested_action_key,
        toolName: message.tool,
        workspaceKey: workspaceKeyForToolCall(message.tool, args)
      });
    }

    if (!message.lease_id) {
      return { status: "error", errorCode: "lease_required", message: "This tool requires the active lease." };
    }

    if (!leaseGuard.hasActiveLease(message.lease_id)) {
      return {
        status: "error",
        errorCode: "lease_expired",
        message: "The lease is missing, expired, or no longer active."
      };
    }

    return { status: "ok", leaseId: message.lease_id };
  }
}

function workspaceKeyForToolCall(tool: ToolName, args: JsonObject): string | undefined {
  if (tool !== "coding_agent.start_task" && tool !== "git.commit" && tool !== "git.push" && tool !== "shell.run") {
    return undefined;
  }

  const project = args.project;
  if (typeof project === "string" && project.trim().length > 0) {
    return project;
  }

  const cwd = args.cwd;
  return typeof cwd === "string" && cwd.trim().length > 0 ? cwd : undefined;
}

function capabilityAccessForDefinition(definition: ToolDefinition): Capability["access"] {
  if (definition.requiresLease === false && toolCapabilityAccess(definition.name) !== "approval_required") {
    return "passive";
  }

  return toolCapabilityAccess(definition.name);
}

function validateToolArguments(schema: JsonSchema, args: JsonObject): string | undefined {
  const properties = isJsonObject(schema.properties) ? schema.properties : {};
  for (const key of stringArrayFromSchema(schema.required)) {
    const value = args[key];
    const propertySchema = isJsonObject(properties[key]) ? properties[key] : undefined;
    if (value === undefined || (propertySchema?.type === "string" && value === "")) {
      return `${key} is required`;
    }
  }

  for (const [key, value] of Object.entries(args)) {
    const propertySchema = isJsonObject(properties[key]) ? properties[key] : undefined;
    if (!propertySchema) {
      continue;
    }

    const typeError = validateJsonType(key, value, propertySchema);
    if (typeError) {
      return typeError;
    }
  }

  return undefined;
}

function validateJsonType(key: string, value: JsonValue, schema: JsonObject): string | undefined {
  const expectedType = typeof schema.type === "string" ? schema.type : undefined;
  if (expectedType === "string" && typeof value !== "string") {
    return `${key} must be a string`;
  }
  if (expectedType === "number" && (typeof value !== "number" || !Number.isFinite(value))) {
    return `${key} must be a finite number`;
  }
  if (expectedType === "boolean" && typeof value !== "boolean") {
    return `${key} must be a boolean`;
  }
  if (expectedType === "array") {
    if (!Array.isArray(value)) {
      return `${key} must be an array`;
    }
    if (isJsonObject(schema.items) && schema.items.type === "string" && value.some((item) => typeof item !== "string")) {
      return `${key} must contain only strings`;
    }
  }
  if (expectedType === "object" && !isJsonObject(value)) {
    return `${key} must be an object`;
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0 && !schema.enum.includes(value)) {
    return `${key} must be one of ${schema.enum.join(", ")}`;
  }
  return undefined;
}

function stringArrayFromSchema(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export type ToolCallRunContext = {
  agentId?: string;
  taskId: string;
  eventRunId?: string;
};

export function toolCallRunContext(message: ToolCallMessage): ToolCallRunContext {
  const eventRunId = normalizeBrokerId(message.event_run_id);
  const taskId = eventRunId ?? normalizeBrokerId(message.task_id) ?? message.request_id;
  return {
    agentId: normalizeBrokerId(message.agent_id),
    taskId,
    eventRunId
  };
}

export function toolCallArguments(message: ToolCallMessage): JsonObject {
  const explicitArguments = normalizeArgumentsPayload(message.arguments);
  if (explicitArguments && Object.keys(explicitArguments).length > 0) {
    return explicitArguments;
  }

  for (const key of ["input", "tool_input", "parameters", "params", "metadata"] as const) {
    const aliasedArguments = normalizeArgumentsPayload(message[key]);
    if (aliasedArguments && Object.keys(aliasedArguments).length > 0) {
      return aliasedArguments;
    }
  }

  return explicitArguments ?? {};
}

function normalizeArgumentsPayload(value: ToolArgumentsPayload | undefined): JsonObject | undefined {
  if (typeof value === "string") {
    return parseJsonObject(value);
  }

  if (!isJsonObject(value)) {
    return undefined;
  }

  const keys = Object.keys(value);
  if (keys.length === 1) {
    const nestedKey = keys[0];
    if (isArgumentAlias(nestedKey)) {
      const nested = value[nestedKey];
      if (typeof nested === "string") {
        return parseJsonObject(nested);
      }
      if (isJsonObject(nested)) {
        return nested;
      }
    }
  }

  return value;
}

function parseJsonObject(value: string): JsonObject | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return isJsonObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isArgumentAlias(value: string): boolean {
  return ["arguments", "input", "tool_input", "parameters", "params"].includes(value);
}

function normalizeBrokerId(value: string | number | null | undefined): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}
