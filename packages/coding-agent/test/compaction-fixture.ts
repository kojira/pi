/** Complete offline response fixture for the default D-COMP-002 output contract. */
export function structuredSummary(goal = "Continue approved task"): string {
	return `## Goal
${goal}
## Constraints & Preferences
- Preserve history and authorized scope.
## Progress
### Done
- Confirmed fixture.
### In Progress
- Continue task.
### Blocked
- None known.
## Key Decisions
- Preserve chronological source order to retain overrides.
## Next Steps
1. Continue approved work.
## Critical Context
- Fixture references; preserve uncertainty.`;
}
