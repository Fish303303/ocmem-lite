# OCMem Lite

**Token-cheap long-term memory for [OpenCode](https://opencode.ai).**
Local-first, no embedding model, no API keys — about **200 tokens per request** instead of 1–2k.

```
opencode plugin add github:Fish303303/ocmem-lite
```

## Why another memory plugin?

Most agent-memory plugins inject a pile of retrieved context on every turn, or ship a
500 MB embedding model. OCMem Lite takes the opposite bet:

- **AI extraction, rules as fallback.** A small model (default `deepseek-v4.1-flash`) reads each user message and pulls out durable facts; if the call fails, a local regex takes over. One short call per message, not a per-turn context dump.
- **Small, fixed digest.** Top facts are written into `AGENTS.md` as a managed block, so they ride
  along with the system prompt — no extra tool call, no vector search.
- **Topic groups (L2).** Only the current topic's facts are expanded; other topics are shown as
  counts (`other topics: deploy 3`). One extra line instead of a wall of memories.
- **On-demand search.** A single `memory` tool (add / search / list / forget) for everything else.

| | OCMem Lite | Typical memory plugin |
| --- | --- | --- |
| Fixed cost per request | ~200 tokens (measured) | 1–2k (estimated) |
| Vector model | none | 100–500 MB |
| External API | none | often |
| Storage | local JSON | SQLite / cloud |

The 1–2k figure for other plugins is an estimate from their documentation and injection
format — it is not a benchmark. OCMem Lite's own number is measured; see below.

## Measured cost

Method: two fresh `opencode run` sessions with the identical prompt, one with the OCMem Lite digest
block in `AGENTS.md` and one without; prompt tokens read from OpenCode's session database.

| Run | Prompt tokens |
| --- | --- |
| with digest | 6406 |
| without digest | 6316 |
| **delta** | **90** |

The digest block was 169 characters at the time. The `memory` tool schema is always registered
(~100 tokens), so the total per-request overhead is roughly **200 tokens**. In long sessions the
prefix is cached (`cache.read`), so the billed cost is lower than the nominal size.

## What it does

1. **Auto-capture** — sentences that look like durable preferences (`I prefer…`, `from now on…`,
   `don't…`, `default to…`) are saved automatically. Questions, one-off commands and test chatter are
   filtered out.
2. **Dedupe** — near-duplicates are merged (character-bigram Jaccard ≥ 0.75).
3. **Digest** — up to 6 facts of the *current topic* (coding / computer / work / life) plus
   a one-line index of the rest, written to `AGENTS.md` inside `<!-- ocmem:begin --> … <!-- ocmem:end -->`.
4. **Short-term recall** — the last few non-question messages from previous sessions are kept under
   “last talked about”, so a fresh session can continue where you left off.
5. **Retrieval tool** — `memory` with `search` (bigram + recency + usage scoring), `list`, `forget`.

## AI extraction

Capture is model-based by default:

| Env | Default | Meaning |
| --- | --- | --- |
| `OCMEM_AI` | `1` | `0` turns model extraction off and falls back to regex |
| `OCMEM_AI_PROVIDER` | `opencode-go` | provider id used for extraction |
| `OCMEM_AI_MODEL` | `deepseek-v4.1-flash` | model id used for extraction |

Short messages, slash commands, code blocks and pure acknowledgements skip the call. If extraction fails, capture silently falls back to rules, so it can never break a conversation.

## Storage

- Facts: `~/.local/share/ocmem/memories.json`
- Recent: `~/.local/share/ocmem/recent.json`
- Digest: the managed block in `~/.config/opencode/AGENTS.md`

Nothing leaves your machine.

## Limits

- Capture runs on a small model, so unusually worded facts can still be missed. Say `remember …` to force a save, or call the `memory` tool.
- No semantic search (by design). Chinese/English both work through character bigrams.
- The digest is capped at 6 facts per topic; older facts stay searchable but not injected.

## License

MIT

---
