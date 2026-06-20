# Example: Inject dolores context into an agent system prompt

`dolores context` returns a minimal-token memory blob (flat text, ~500–600 tokens regardless of store size). This example shows how to pipe it into any LLM agent at startup so the agent "wakes up" with relevant context.

## The shell helper

```bash
chmod +x inject-context.sh

# Returns a JSON system message with the memory blob:
./inject-context.sh "implement the auth refactor"
# → {"role":"system","content":"[dolores context output]"}

# Without a task argument — returns everything in memory:
./inject-context.sh
```

## Pipe into an API call (curl + Anthropic)

```bash
SYSTEM_MSG="$(dolores context "auth refactor")"

curl -s https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d "$(jq -n \
    --arg sys "$SYSTEM_MSG" \
    --arg user "Outline the auth refactor plan." \
    '{
      model: "claude-opus-4-8-20260801",
      max_tokens: 1024,
      system: $sys,
      messages: [{"role":"user","content":$user}]
    }')"
```

## Pipe into a Node.js agent

```js
import { execSync } from "node:child_process";

const context = execSync("dolores context 'auth refactor'").toString().trim();

// Pass as system prompt to your SDK call:
const response = await anthropic.messages.create({
  model: "claude-opus-4-8-20260801",
  max_tokens: 1024,
  system: context,
  messages: [{ role: "user", content: "Outline the auth refactor plan." }],
});
```

## Token cost

| Store size | Naive (all memories) | dolores context |
|------------|----------------------|-----------------|
| 100        | ~2,000 tokens        | ~590 tokens     |
| 1,000      | ~20,500 tokens       | ~590 tokens     |

The blob stays flat at ~590 tokens as the store grows — only the most relevant memories are included.
