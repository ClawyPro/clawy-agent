/**
 * Resource existence checker — beforeCommit, priority 83.
 *
 * Blocks commits where the assistant claims specific file contents
 * without having read the file this turn. Pure heuristic — no LLM
 * call, zero cost, <1ms latency.
 *
 * Example: bot writes "DAILY_RUNBOOK_v3.md에 따르면 Actor는 Gemini
 * 2.5 Flash" without FileRead → blocked. Bot reads it first → pass.
 *
 * Retry budget: 1, then fail-open.
 * Toggle: `CORE_AGENT_RESOURCE_CHECK=off` disables globally.
 */

import type { RegisteredHook, HookContext } from "../types.js";
import type { TranscriptEntry } from "../../storage/Transcript.js";

const MAX_RETRIES = 1;

/** File extensions we recognise as workspace files. */
const CODE_EXTENSIONS = new Set([
  "md", "json", "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "yaml", "yml", "toml", "ini", "cfg", "conf",
  "txt", "csv", "sql", "sh", "bash", "zsh",
  "py", "rb", "go", "rs", "java", "kt", "swift",
  "html", "css", "scss", "xml", "svg",
  "env", "lock", "log",
  "dockerfile",
]);

/** Tools whose presence means the bot DID read a file. */
const READ_TOOLS = new Set(["FileRead", "Grep", "Glob", "Bash"]);

/**
 * Extract file references from assistant text.
 * Returns deduplicated list of filenames/paths.
 */
export function extractFileReferences(text: string): string[] {
  const refs = new Set<string>();

  // Pattern 1: backtick-quoted file references (`file.ext`)
  const backtickRe = /`([\w\-./]+\.(\w{1,10}))`/g;
  let m: RegExpExecArray | null;
  while ((m = backtickRe.exec(text)) !== null) {
    const ext = m[2];
    const full = m[1];
    if (ext && full && CODE_EXTENSIONS.has(ext.toLowerCase())) {
      refs.add(full);
    }
  }

  // Pattern 2: bare file references (word boundaries)
  // Matches: DAILY_RUNBOOK_v3.md, src/config.ts, SOUL.md
  const bareRe = /(?:^|[\s(,`"'])(([\w\-]+\/)*[\w\-]+\.(\w{1,10}))(?=[\s),`"':;을를에의는이가]|$)/gm;
  while ((m = bareRe.exec(text)) !== null) {
    const ext = m[3];
    const full = m[1];
    if (ext && full && CODE_EXTENSIONS.has(ext.toLowerCase())) {
      refs.add(full);
    }
  }

  return [...refs];
}

/**
 * Check if the text makes a content claim about a specific file
 * (not just mentioning it). Content claims reference what's IN the
 * file; mentions just name the file.
 */
export function hasContentClaim(filename: string, text: string): boolean {
  // Escape filename for regex
  const escaped = filename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const contentClaimPatterns: RegExp[] = [
    // Korean: "X에 따르면/의하면/보면/나와있"
    new RegExp(`${escaped}[^.\\n]{0,20}에\\s*(?:따르면|의하면|보면|나와)`, "u"),
    // Korean: "X에 명시/기재/작성/설정/정의"
    new RegExp(`${escaped}[^.\\n]{0,20}에\\s*(?:명시|기재|작성|설정|정의)`, "u"),
    // Korean: "X의 내용/구조/설정/값"
    new RegExp(`${escaped}[^.\\n]{0,10}(?:의\\s*)?(?:내용|구조|설정|값)(?:은|는|이|을)`, "u"),
    // English: "X contains/says/shows/states/specifies"
    new RegExp(`${escaped}[^.\\n]{0,20}\\b(?:contains?|says?|shows?|states?|specif)`, "i"),
    // English: "in X, the/as stated in X/as shown in X/according to X"
    new RegExp(`(?:according\\s+to|as\\s+(?:stated|shown|defined)\\s+in)\\s+(?:\`)?${escaped}`, "i"),
  ];

  for (const p of contentClaimPatterns) {
    if (p.test(text)) return true;
  }

  return false;
}

/**
 * Detect generic "I read the file" claims that don't name a specific file.
 * Example: "파일을 다시 읽어보니", "확인해보니", "I checked the file"
 */
export function matchesGenericReadClaim(text: string): boolean {
  const GENERIC_READ_PATTERNS: RegExp[] = [
    // Korean: "파일을 (다시) 읽어보니/확인해보니/열어보니"
    /파일을?\s*(?:다시\s*)?(?:읽어|확인해|열어)보니/u,
    // Korean: "다시 읽어보니/확인해보니" (without 파일)
    /다시\s*(?:읽어|확인해|열어)보[니면]/u,
    // Korean: "파일에 따르면" (generic, no specific filename)
    /(?:해당|그|이)\s*파일에\s*(?:따르면|의하면|보면)/u,
    // Korean: "확인 결과" + specific detail claim
    /확인\s*결과[,:]?\s*[^.]{10,}/u,
    // Korean: "문서에 따르면" / "스크립트에 따르면"
    /(?:문서|스크립트|설정|코드)에\s*(?:따르면|의하면|보면|명시)/u,
    // English: "I (re-)read/checked the file"
    /\b(?:I|i)\s+(?:re-?)?(?:read|checked|reviewed|looked at)\s+the\s+file\b/i,
    // English: "according to the file/document/script"
    /according\s+to\s+the\s+(?:file|document|script|config)/i,
  ];
  for (const p of GENERIC_READ_PATTERNS) {
    if (p.test(text)) return true;
  }
  return false;
}

export interface ResourceCheckAgent {
  readSessionTranscript(
    sessionKey: string,
  ): Promise<ReadonlyArray<TranscriptEntry> | null>;
}

export interface ResourceExistenceCheckerOptions {
  agent?: ResourceCheckAgent;
}

function isEnabled(): boolean {
  const raw = process.env.CORE_AGENT_RESOURCE_CHECK;
  if (raw === undefined || raw === null) return true;
  const v = raw.trim().toLowerCase();
  return v === "" || v === "on" || v === "true" || v === "1";
}

/**
 * Check if a file was read this turn by looking at tool_call entries.
 * Matches by filename (basename) — if FileRead("/workspace/foo/SOUL.md")
 * was called, reference to "SOUL.md" passes.
 */
function wasFileReadThisTurn(
  filename: string,
  transcript: ReadonlyArray<TranscriptEntry>,
  turnId: string,
): boolean {
  const baseFilename = filename.split("/").pop() ?? filename;
  for (const entry of transcript) {
    if (entry.kind !== "tool_call") continue;
    if (entry.turnId !== turnId) continue;
    if (!READ_TOOLS.has(entry.name)) continue;

    const input = entry.input as Record<string, unknown> | undefined;
    if (!input) continue;

    // FileRead: check file_path
    if (entry.name === "FileRead" && typeof input.file_path === "string") {
      const readBase = input.file_path.split("/").pop() ?? input.file_path;
      if (readBase === baseFilename || input.file_path.includes(filename)) {
        return true;
      }
    }

    // Grep: check path parameter
    if (entry.name === "Grep" && typeof input.path === "string") {
      const grepBase = input.path.split("/").pop() ?? input.path;
      if (grepBase === baseFilename || input.path.includes(filename)) {
        return true;
      }
    }

    // Glob: check pattern
    if (entry.name === "Glob" && typeof input.pattern === "string") {
      if (input.pattern.includes(baseFilename)) {
        return true;
      }
    }

    // Bash: check command for cat/head/tail/less + filename
    if (entry.name === "Bash" && typeof input.command === "string") {
      if (input.command.includes(baseFilename)) {
        return true;
      }
    }
  }
  return false;
}

export function makeResourceExistenceCheckerHook(
  opts: ResourceExistenceCheckerOptions = {},
): RegisteredHook<"beforeCommit"> {
  return {
    name: "builtin:resource-existence-checker",
    point: "beforeCommit",
    priority: 83,
    blocking: true,
    timeoutMs: 2_000,
    handler: async ({ assistantText, toolCallCount, retryCount }, ctx: HookContext) => {
      try {
        if (!isEnabled()) return { action: "continue" };
        if (!assistantText || assistantText.trim().length === 0) {
          return { action: "continue" };
        }

        // Extract file references from the response
        const fileRefs = extractFileReferences(assistantText);
        if (fileRefs.length === 0) return { action: "continue" };

        // Find files with content claims
        const filesWithClaims = fileRefs.filter((f) =>
          hasContentClaim(f, assistantText),
        );
        if (filesWithClaims.length === 0) return { action: "continue" };

        // Get transcript
        let entries: ReadonlyArray<TranscriptEntry> | null = null;
        if (opts.agent) {
          try {
            entries = await opts.agent.readSessionTranscript(ctx.sessionKey);
          } catch (err) {
            ctx.log(
              "warn",
              "[resource-existence-checker] transcript read failed; failing open",
              { error: err instanceof Error ? err.message : String(err) },
            );
            return { action: "continue" };
          }
        }
        const source = entries ?? (ctx.transcript as ReadonlyArray<TranscriptEntry>);

        // Check each file with content claims
        const unreadFile = filesWithClaims.find(
          (f) => !wasFileReadThisTurn(f, source, ctx.turnId),
        );

        if (!unreadFile) {
          ctx.emit({
            type: "rule_check",
            ruleId: "resource-existence-checker",
            verdict: "ok",
            detail: `all referenced files were read this turn`,
          });
          return { action: "continue" };
        }

        // Unread file with content claim found
        if (retryCount >= MAX_RETRIES) {
          ctx.log(
            "warn",
            "[resource-existence-checker] retry budget exhausted; failing open",
            { unreadFile, retryCount },
          );
          ctx.emit({
            type: "rule_check",
            ruleId: "resource-existence-checker",
            verdict: "violation",
            detail: `retry exhausted for ${unreadFile}; failing open`,
          });
          return { action: "continue" };
        }

        ctx.log(
          "warn",
          "[resource-existence-checker] blocking: content claim without reading file",
          { unreadFile, retryCount },
        );
        ctx.emit({
          type: "rule_check",
          ruleId: "resource-existence-checker",
          verdict: "violation",
          detail: `claimed content of ${unreadFile} without reading; retryCount=${retryCount}`,
        });

        return {
          action: "block",
          reason: [
            `[RETRY:RESOURCE_CHECK] You referenced specific content from "${unreadFile}"`,
            "but did not read this file during the current turn. Memory-based",
            "claims about file contents are unreliable — the file may have",
            "changed or your recollection may be inaccurate.",
            "",
            "Before finalising this answer:",
            `1) FileRead the file "${unreadFile}" to get current contents.`,
            "2) Re-draft your answer based on what the file actually says.",
            "3) If the file doesn't exist, verify with Glob/Bash ls and state so.",
          ].join("\n"),
        };
      } catch (err) {
        ctx.log(
          "warn",
          "[resource-existence-checker] unexpected error; failing open",
          { error: err instanceof Error ? err.message : String(err) },
        );
        return { action: "continue" };
      }
    },
  };
}
