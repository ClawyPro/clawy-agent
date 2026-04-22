# Clawy Agent

**Autonomous task runtime with agentic interaction.**

Unlike chat-based agent frameworks that respond to one message at a time, Clawy Agent runs an agentic loop — it plans, executes tools, evaluates results, and iterates until the task is complete. You can observe, intervene, and guide at any point.

Think Claude Code, but open-source, multi-provider, and programmable.

## Features

- **Autonomous task execution** — Agent runs a persistent loop: plan → execute → evaluate → iterate until done
- **Agentic interaction** — Observe progress, intervene mid-turn, guide direction. Agent can ask questions back
- **Programmable LLM hooks** — Insert LLM-judged checkpoints anywhere in the turn lifecycle for deterministic control
- **Multi-provider** — Anthropic Claude, OpenAI GPT, Google Gemini natively supported
- **27+ built-in tools** — Bash, FileRead/Write/Edit, Glob, Grep, SpawnAgent, Cron, and more
- **Multi-channel** — Telegram, Discord, Webhook out of the box
- **Built-in memory** — Hipocampus 5-level compaction for persistent cross-session context
- **Coding discipline** — Optional TDD and git commit enforcement
- **Child agents** — Spawn sub-agents for parallel task execution

## Quick Start

```bash
npm install -g clawy-agent
clawy-agent init
clawy-agent start
```

## Usage Modes

### Interactive (CLI)

```bash
clawy-agent start
```

Terminal conversation mode. Like Claude Code.

### Server

```bash
clawy-agent serve --port 8080
```

HTTP API server for platform integration.

### Programmatic

```typescript
import { Agent } from 'clawy-agent'

const agent = new Agent({
  llm: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  hooks: {
    beforeCommit: [myQualityGate]
  }
})

const session = agent.createSession()
const response = await session.run('Fix the login bug in auth.ts')
```

## Configuration

Copy `clawy-agent.yaml.example` to `clawy-agent.yaml`:

```yaml
llm:
  provider: anthropic
  model: claude-sonnet-4-6
  apiKey: ${ANTHROPIC_API_KEY}

hooks:
  builtin:
    factGrounding: true
    discipline: false

memory:
  enabled: true
  compaction: true

workspace: ./workspace
identity:
  name: "My Agent"
  instructions: "You are a helpful coding assistant."
```

## Custom Hooks

The core differentiator. Insert LLM-judged checkpoints anywhere in the turn lifecycle:

```typescript
import { defineHook } from 'clawy-agent'

export default defineHook({
  name: 'quality-gate',
  event: 'beforeCommit',
  priority: 80,

  async handler(ctx) {
    const judgment = await ctx.llm.quick({
      model: 'claude-haiku-4-5',
      prompt: `Does this response accurately answer the question?
        Question: ${ctx.userMessage}
        Response: ${ctx.finalText}
        Verdict: PASS or FAIL + reason`
    })

    if (judgment.includes('FAIL')) {
      return { action: 'retry', reason: judgment }
    }
    return { action: 'pass' }
  }
})
```

### Hook Lifecycle

```
User message
  → beforeTurnStart
    → [agentic loop]
      → beforeLLMCall       ← Context augmentation
      → LLM streaming
      → afterLLMCall        ← Response analysis
      → beforeToolUse       ← Tool permit/deny
      → Tool execution
      → [loop continues...]
    → beforeCommit          ← Quality verification
  → afterTurnEnd            ← Memory save, cleanup
```

### Built-in Hooks

| Hook | Default | Purpose |
|------|---------|---------|
| `factGrounding` | on | Hallucination prevention |
| `preRefusalVerifier` | on | Prevents unnecessary refusals |
| `workspaceAwareness` | on | Auto-injects filesystem context |
| `sessionResume` | on | Seeds context on session resume |
| `discipline` | off | TDD/git commit enforcement |
| `dangerousPatterns` | on | Blocks dangerous operations |

## Architecture

```
Agent (singleton)
  ├── Session (per conversation)
  │   ├── Turn (atomic agentic loop)
  │   │   ├── LLM call → Tool dispatch → Evaluate → Repeat
  │   │   └── Hook checkpoints at each lifecycle point
  │   ├── Transcript (persistent history)
  │   └── Context (layered: identity + rules + memory + tools)
  ├── Tool Registry (27+ built-in)
  ├── Hook Registry (built-in + custom)
  ├── Channel Adapters (Telegram, Discord, Webhook)
  ├── Cron Scheduler
  ├── Memory (Hipocampus compaction)
  └── SpawnAgent (child agent execution)
```

## Docker

```bash
docker run -e ANTHROPIC_API_KEY=sk-... -p 8080:8080 clawy/clawy-agent
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache 2.0 — see [LICENSE](LICENSE).
