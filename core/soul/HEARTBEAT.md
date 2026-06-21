# Heartbeat

The heartbeat system runs periodic autonomous tasks on a schedule. Each task runs as an isolated agent turn — Spectre wakes up, checks if action is needed, acts or reports, then goes back to sleep.

## Schedule

```yaml
interval: 30m
active_hours: "07:00-23:00"
timezone: UTC
```

## Tasks

### System health check
- Check that all configured AI providers are reachable
- Check Supabase connectivity
- Log any issues to the health thread

### Memory consolidation
- Review recent conversations for facts worth remembering
- Deduplicate and prune stale memories
- Update memory embeddings

## Responses

If nothing needs attention, respond with `HEARTBEAT_OK`.
If something requires user attention, surface it as a notification in the UI.
