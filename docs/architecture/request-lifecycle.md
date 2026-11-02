# Request Lifecycle

What happens between a user asking a question and receiving a streamed answer.
This is the current implementation; the historical walkthrough has the original
Phase 1 code excerpts.

## Flow

1. **Validate the request.** The API checks `question`, `conversationId`, and `mode`.
2. **Load context.** It loads the conversation, the owned connection, the schema
   snapshot, and the saved table scope. It also loads the last six turns.
3. **Resolve the model.** The session's pinned model is used, or the Auto chain is
   resolved in order.
4. **Plan.** Record-count questions use an exact count operation. Schema mode
   answers from metadata. Otherwise the LLM returns a plan with `data`, `schema`,
   or `clarify`.
5. **Validate the query.** The generated SQL or MongoDB pipeline is checked
   against the engine and the session scope.
6. **Repair once.** If validation fails, the LLM gets one repair attempt.
7. **Execute read-only.** SQL runs in a read-only transaction with a statement
   timeout and row cap. MongoDB uses an allowlisted pipeline with a time limit.
8. **Stream evidence.** The API emits `status`, then `evidence`, then answer
   `token` events, followed by `done` or `error`.
9. **Persist.** The turn and evidence are written in one transaction.

If the client disconnects, the upstream LLM request is aborted and the turn is not
persisted.

## SSE events

```text
event: status   data: {"phase":"planning","label":"Understanding the question"}
event: evidence data: {"evidence":{...}}
event: token    data: {"text":"partial answer"}
event: done     data: {"conversationId":1,"messageId":42,"answer":"...","model":"...","mode":"data"}
event: error    data: {"error":"...","code":"timeout","sql":"SELECT ..."}
```

Pre-stream validation and provider failures return normal JSON with a non-2xx
status. See the [Questions API](../reference/api/questions.md) for the full contract.

## Safety boundaries

- The planner never sees credentials.
- The generated query must be a single read-only statement or an allowlisted
  aggregation, and every referenced table must be in scope.
- Even if validation were bypassed, the target connection is read-only by
  transaction or account privilege.
- Database values and comments are treated as untrusted data in prompts.

## Related

- [Current state](current-state.md)
- [Read-only SQL execution](../concepts/08-readonly-sql-execution.md)
- [NL-to-SQL agent](../concepts/10-nl-to-sql-agent.md)
- [Provider registry and failover](../concepts/15-provider-registry-and-failover.md)
