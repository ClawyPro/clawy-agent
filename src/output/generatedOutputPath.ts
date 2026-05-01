import path from "node:path";

export const GENERATED_OUTPUT_DIR = "outputs";

export interface GeneratedOutputPath {
  workspacePath: string;
  filename: string;
}

export function resolveGeneratedOutputPath(filename: string): GeneratedOutputPath {
  const raw = filename.trim().replace(/\\/g, "/");
  if (!raw) {
    throw new Error("filename is required");
  }
  if (path.isAbsolute(raw) || raw.startsWith("/")) {
    throw new Error("filename must be a workspace-relative path");
  }
  const parts = raw.split("/").filter((part) => part.length > 0 && part !== ".");
  if (parts.length === 0) {
    throw new Error("filename must include a file name");
  }
  if (parts.some((part) => part === "..")) {
    throw new Error("filename must not contain path traversal");
  }

  const normalized = path.posix.normalize(parts.join("/"));
  const workspacePath = normalized === GENERATED_OUTPUT_DIR || normalized.startsWith(`${GENERATED_OUTPUT_DIR}/`)
    ? normalized
    : `${GENERATED_OUTPUT_DIR}/${normalized}`;
  const outputParts = workspacePath.split("/");
  const outputFilename = outputParts[outputParts.length - 1] ?? "";
  if (!outputFilename || outputFilename === GENERATED_OUTPUT_DIR) {
    throw new Error("filename must include a file name");
  }
  return { workspacePath, filename: outputFilename };
}
