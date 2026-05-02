---
id: user-harness:pricing-source-fetch
trigger: beforeCommit
condition:
  userMessageMatches: "(pricing|price|cost|요금|가격|비용)"
action:
  type: require_tool_input_match
  toolName: WebFetch
  inputPath: url
  pattern: "^https://docs\\.example\\.com/"
enforcement: block_on_fail
timeoutMs: 2000
---

For pricing or cost answers, fetch the canonical pricing source before giving a precise answer.
