# Telemetry

CrispCAD sends no telemetry by default and ships no collector endpoint.

- Telemetry is off unless you run `crispcad telemetry enable` **and** set
  `CRISPCAD_TELEMETRY_URL` to a collector you operate. Without that URL nothing is
  sent, even when enabled.
- Off-switches always win: `KERNELCAD_TELEMETRY=0`, `KERNELCAD_TELEMETRY_DISABLED=1`,
  `DO_NOT_TRACK=1`, `CI=true`, and sandbox mode.
- When enabled, events contain only the allow-listed fields in
  `src/shared/telemetry/types.ts` (tool name, outcome, diagnostic code, versions,
  durations, an anonymous install id) — never prompts, code, designs or paths.
- `KERNELCAD_TELEMETRY_DEBUG=1` prints events to stderr instead of sending them.

There is no first-run notice because nothing is collected by default.
