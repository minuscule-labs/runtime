/** Runtime bridge observations, not harness logs or proof of downstream delivery. */
export const SESSION_EVENT_CODES = [
  "bridge_ready", "turn_accepted", "turn_reused", "turn_rejected_conflict",
  "turn_dispatch_requested", "turn_dispatch_returned", "turn_dispatch_failed", "turn_completed", "turn_failed",
  "request_rejected_busy", "steer_requested", "steer_acknowledged", "steer_failed",
  "interrupt_requested", "interrupt_acknowledged", "interrupt_failed", "stop_requested",
] as const;
export type RuntimeSessionEventCode = typeof SESSION_EVENT_CODES[number];
export interface RuntimeSessionEvent {
  sequence: number;
  observedAt: string;
  code: RuntimeSessionEventCode;
}
export interface RuntimeSessionEvents {
  version: 1;
  source: "runtime_bridge";
  capturedAt: string;
  /** Current worker's recording window only; no continuity across worker restarts. */
  recordingSince: string;
  eventsDropped: number;
  events: RuntimeSessionEvent[];
}
export const SESSION_EVENTS_LIMITS = { events: 200, bytes: 32 * 1024, readMs: 2_000 } as const;

/** Reject invalid snapshots; explicitly reconstruct all fields, dropping arbitrary extensions. */
export function sessionEvents(input: unknown): RuntimeSessionEvents {
  const invalid = () => new Error("Session events unavailable");
  const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const time = (value: unknown): value is string => typeof value === "string" && value.length === 24
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
  const counter = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
  const raw = object(input);
  if (raw.version !== 1 || raw.source !== "runtime_bridge" || !time(raw.capturedAt) || !time(raw.recordingSince)
    || !counter(raw.eventsDropped) || !Array.isArray(raw.events) || raw.events.length > SESSION_EVENTS_LIMITS.events) throw invalid();
  let previous = raw.eventsDropped;
  const events = raw.events.map((value): RuntimeSessionEvent => {
    const event = object(value);
    if (!counter(event.sequence) || event.sequence <= previous || event.sequence - previous !== 1
      || !time(event.observedAt) || !SESSION_EVENT_CODES.includes(event.code as RuntimeSessionEventCode)) throw invalid();
    previous = event.sequence;
    return { sequence: event.sequence, observedAt: event.observedAt, code: event.code as RuntimeSessionEventCode };
  });
  // A producer retains the full window until it fills; missing observations must not look complete.
  if (raw.eventsDropped > 0 && events.length !== SESSION_EVENTS_LIMITS.events) throw invalid();
  const snapshot: RuntimeSessionEvents = { version: 1, source: "runtime_bridge", capturedAt: raw.capturedAt,
    recordingSince: raw.recordingSince, eventsDropped: raw.eventsDropped, events };
  if (new TextEncoder().encode(JSON.stringify({ events: snapshot })).byteLength > SESSION_EVENTS_LIMITS.bytes) throw invalid();
  return snapshot;
}
