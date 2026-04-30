import path from "node:path";
import type {
  ResourceBindings,
  UsedResourceKind,
  UsedResourceRecord,
} from "./ExecutionContract.js";

export type ResourceBoundaryViolationKind =
  | "workspace_path_outside_binding"
  | "artifact_outside_binding"
  | "source_path_outside_binding"
  | "db_handle_outside_binding"
  | "external_source_outside_binding";

export interface ResourceBoundaryViolation {
  kind: ResourceBoundaryViolationKind;
  value: string;
  toolName: string;
  toolUseId?: string;
  reason: string;
}

export interface ResourceBoundaryInspection {
  usedResources: Array<Omit<UsedResourceRecord, "recordedAt">>;
  violations: ResourceBoundaryViolation[];
}

export interface ToolCallResourceBoundaryInput {
  toolName: string;
  toolUseId?: string;
  input: unknown;
  bindings: ResourceBindings;
}

const BASH_RESOURCE_COMMAND_RE =
  /\b(?:cat|head|tail|less|sed|awk|python|python3|node|sqlite3|cp|mv|touch|mkdir|rm|ls|find|grep|rg)\b\s+([^;&|]+)/gi;
const EXTERNAL_URL_RE = /\bhttps?:\/\/[^\s'")]+/gi;

export function resourceBindingsAreActive(bindings: ResourceBindings): boolean {
  return (
    bindings.allowedWorkspacePaths.length > 0 ||
    bindings.allowedSourcePaths.length > 0 ||
    bindings.artifactIds.length > 0 ||
    bindings.resourceIds.length > 0 ||
    bindings.dbHandles.length > 0
  );
}

export function inspectToolCallResourceBoundary(
  args: ToolCallResourceBoundaryInput,
): ResourceBoundaryInspection {
  const usedResources = extractUsedResources(args.toolName, args.toolUseId, args.input);
  const violations: ResourceBoundaryViolation[] = [];

  for (const resource of usedResources) {
    if (resource.kind === "workspace_path" && args.bindings.allowedWorkspacePaths.length > 0) {
      if (!workspacePathAllowed(resource.value, args.bindings.allowedWorkspacePaths)) {
        violations.push({
          kind: "workspace_path_outside_binding",
          value: resource.value,
          toolName: args.toolName,
          toolUseId: args.toolUseId,
          reason: `workspace path is outside allowed bindings: ${args.bindings.allowedWorkspacePaths.join(", ")}`,
        });
      }
    }
    if (resource.kind === "artifact" && args.bindings.artifactIds.length > 0) {
      if (!args.bindings.artifactIds.includes(resource.value)) {
        violations.push({
          kind: "artifact_outside_binding",
          value: resource.value,
          toolName: args.toolName,
          toolUseId: args.toolUseId,
          reason: `artifact id is outside allowed bindings: ${args.bindings.artifactIds.join(", ")}`,
        });
      }
    }
    if (resource.kind === "source_path" && args.bindings.allowedSourcePaths.length > 0) {
      if (!args.bindings.allowedSourcePaths.includes(resource.value)) {
        violations.push({
          kind: "source_path_outside_binding",
          value: resource.value,
          toolName: args.toolName,
          toolUseId: args.toolUseId,
          reason: `source path is outside allowed bindings: ${args.bindings.allowedSourcePaths.join(", ")}`,
        });
      }
    }
    if (resource.kind === "db_handle" && args.bindings.dbHandles.length > 0) {
      if (!args.bindings.dbHandles.includes(resource.value)) {
        violations.push({
          kind: "db_handle_outside_binding",
          value: resource.value,
          toolName: args.toolName,
          toolUseId: args.toolUseId,
          reason: `db handle is outside allowed bindings: ${args.bindings.dbHandles.join(", ")}`,
        });
      }
    }
    if (resource.kind === "external_url" && resourceBindingsAreActive(args.bindings)) {
      if (!args.bindings.allowedSourcePaths.includes(resource.value)) {
        violations.push({
          kind: "external_source_outside_binding",
          value: resource.value,
          toolName: args.toolName,
          toolUseId: args.toolUseId,
          reason: "external URL is not one of the allowed source paths",
        });
      }
    }
  }

  return { usedResources: dedupeUsedResources(usedResources), violations };
}

function extractUsedResources(
  toolName: string,
  toolUseId: string | undefined,
  input: unknown,
): Array<Omit<UsedResourceRecord, "recordedAt">> {
  const resources: Array<Omit<UsedResourceRecord, "recordedAt">> = [];
  const add = (kind: UsedResourceKind, value: string): void => {
    const normalized = kind === "workspace_path" ? normalizeWorkspacePath(value) : value.trim();
    if (!normalized || normalized === ".") return;
    resources.push({
      kind,
      value: normalized,
      toolName,
      ...(toolUseId ? { toolUseId } : {}),
    });
  };

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return resources;
  }
  const record = input as Record<string, unknown>;

  for (const key of ["path", "file_path", "cwd", "outputPath", "filename"]) {
    const value = record[key];
    if (typeof value === "string") add("workspace_path", value);
  }

  const source = record.source;
  if (source && typeof source === "object" && !Array.isArray(source)) {
    const sourceRecord = source as Record<string, unknown>;
    if (typeof sourceRecord.path === "string") add("workspace_path", sourceRecord.path);
    if (typeof sourceRecord.blocksFile === "string") {
      add("workspace_path", sourceRecord.blocksFile);
    }
  }

  if (typeof record.artifactId === "string") add("artifact", record.artifactId);
  if (typeof record.resourceId === "string") add("resource", record.resourceId);
  if (typeof record.sourcePath === "string") add("source_path", record.sourcePath);
  if (typeof record.dbHandle === "string") add("db_handle", record.dbHandle);

  if (toolName === "Bash" && typeof record.command === "string") {
    for (const url of record.command.matchAll(EXTERNAL_URL_RE)) {
      add("external_url", url[0]);
    }
    for (const value of extractBashPathTokens(record.command)) {
      add("workspace_path", value);
    }
  }

  return dedupeUsedResources(resources);
}

function extractBashPathTokens(command: string): string[] {
  const paths: string[] = [];
  for (const match of command.matchAll(BASH_RESOURCE_COMMAND_RE)) {
    const tail = match[1] ?? "";
    for (const token of shellishTokens(tail)) {
      if (token.startsWith("-")) continue;
      if (token.includes("://")) continue;
      if (looksLikeShellSyntax(token)) continue;
      paths.push(token);
    }
  }
  return paths;
}

function shellishTokens(value: string): string[] {
  return value
    .split(/\s+/)
    .map((token) => token.replace(/^['"]|['"]$/g, "").trim())
    .filter(Boolean);
}

function looksLikeShellSyntax(token: string): boolean {
  return (
    token === "." ||
    token === "/" ||
    token.startsWith("$") ||
    token.includes("=") ||
    token.includes("*") ||
    token.includes("{") ||
    token.includes("}")
  );
}

function normalizeWorkspacePath(value: string): string {
  const trimmed = value.trim().replace(/^\/+/, "");
  return path.posix.normalize(trimmed).replace(/^\.\//, "");
}

function workspacePathAllowed(value: string, allowedPaths: string[]): boolean {
  const normalized = normalizeWorkspacePath(value);
  if (!normalized || normalized.startsWith("../") || normalized === "..") return false;
  return allowedPaths.some((allowed) => {
    const normalizedAllowed = normalizeWorkspacePath(allowed);
    if (!normalizedAllowed) return false;
    if (allowed.endsWith("/")) {
      const prefix = normalizedAllowed.endsWith("/")
        ? normalizedAllowed
        : `${normalizedAllowed}/`;
      return normalized.startsWith(prefix);
    }
    return normalized === normalizedAllowed;
  });
}

function dedupeUsedResources(
  resources: Array<Omit<UsedResourceRecord, "recordedAt">>,
): Array<Omit<UsedResourceRecord, "recordedAt">> {
  const seen = new Set<string>();
  const out: Array<Omit<UsedResourceRecord, "recordedAt">> = [];
  for (const resource of resources) {
    const key = `${resource.kind}:${resource.value}:${resource.toolName}:${resource.toolUseId ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(resource);
  }
  return out;
}
