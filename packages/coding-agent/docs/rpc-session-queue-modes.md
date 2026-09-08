# Session-only RPC queue modes

## Problem

The existing RPC commands `set_steering_mode` and `set_follow_up_mode` call `AgentSession` setters that both update the active `Agent` and persist the value to global `settings.json`. An embedding application may need a queue policy only for its own RPC process. Using the persistent command for that purpose silently changes later interactive Pi sessions and can leave the global setting changed after a crash.

## Contract

Add a session-only RPC command:

```json
{"type":"set_session_steering_mode","mode":"all"}
```

The command:

- changes the queue mode of the active in-memory `Agent` immediately;
- does not mutate global or project settings;
- does not write `settings.json`;
- returns the usual successful RPC response with its own command name;
- accepts the same `all` and `one-at-a-time` values as the persistent command.

The existing persistent commands retain their current behavior for compatibility. A distinct command name is required so older Pi versions reject the request instead of accepting an unknown `persist: false` field and still modifying global settings.

## API shape

`AgentSession.setSteeringMode()` remains persistent. Add an explicit `setSessionSteeringMode()` method that only assigns the corresponding `Agent` property. RPC routing calls the session-only method for the new command.

## Tests

Before implementation, add tests proving that:

1. the new RPC command changes the active session mode and returns success;
2. it does not call the persistent settings setter or change the settings file;
3. existing persistent commands continue to persist;
4. RPC command and response unions include the new command names.

## Compatibility

This is additive. Existing SDK callers and RPC clients are unchanged. Clients requiring isolation must use the new command and should fail closed when connected to an older Pi version that does not support it.
