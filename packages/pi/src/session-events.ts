import {
  SESSION_EVENT_CODES, SESSION_EVENTS_LIMITS, sessionEvents,
  type RuntimeSessionEvent, type RuntimeSessionEventCode, type RuntimeSessionEvents,
} from "@minu/runtime-core";

/** Fixed-field, current-worker-only retention. Never accepts a raw event or free-text payload. */
export class SessionEventLog {
  private readonly recordingSince = new Date().toISOString();
  private readonly events: RuntimeSessionEvent[] = [];
  private sequence = 0;
  private failed = false;

  record(code: RuntimeSessionEventCode): void {
    if (this.failed) return;
    try {
      if (!SESSION_EVENT_CODES.includes(code) || this.sequence >= Number.MAX_SAFE_INTEGER) throw new Error("Unavailable");
      this.events.push({ sequence: ++this.sequence, observedAt: new Date().toISOString(), code });
      if (this.events.length > SESSION_EVENTS_LIMITS.events) this.events.shift();
    } catch {
      // Optional diagnostics must never fail admission, dispatch, interruption or shutdown.
      this.failed = true;
      this.events.length = 0;
    }
  }

  snapshot(): RuntimeSessionEvents {
    if (this.failed) throw new Error("Session events unavailable");
    return sessionEvents({ version: 1, source: "runtime_bridge", capturedAt: new Date().toISOString(),
      recordingSince: this.recordingSince, eventsDropped: this.sequence - this.events.length, events: this.events });
  }
}
