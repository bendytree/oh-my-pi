{{#if request}}
Set up a schedule for the following request using the `schedule` tool (device `xd://schedule`). Extract the timing (`every` duration or `at` time), then author the `task` as a fully self-contained assignment — each run spawns a fresh subagent with no memory of this conversation, so name exact paths, commands, and the expected output shape. Confirm the schedule back to me with its next run time.

Request: {{request}}
{{else}}
List the active schedules via the `schedule` tool (device `xd://schedule`, op `list`) and summarize each one's name, cadence, and next run time. If there are none, say so.
{{/if}}
