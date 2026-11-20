// Temporary, payload-free diagnostics for the CLI cancellation subprocess only.
import { ReadableStreamDefaultReader } from "node:stream/web";
let signalled = false;
const note = (message: string) => process.stderr.write(`CLI_CANCEL_PROBE ${message}\n`);
const emit = process.emit;
process.emit = function (this: typeof process, event: string | symbol, ...args: unknown[]) {
  if (event === "SIGINT" || event === "SIGTERM") {
    signalled = true;
    note(`signal=${String(event)} listeners=${process.listenerCount(event)}`);
    setTimeout(() => note(`resources=${process.getActiveResourcesInfo().join(",")}`), 1_000).unref();
  }
  return Reflect.apply(emit, this, [event, ...args]);
} as typeof process.emit;
const abort = AbortController.prototype.abort;
AbortController.prototype.abort = function (reason?: unknown) {
  if (signalled) note("abort-controller");
  return abort.call(this, reason);
};
const read = ReadableStreamDefaultReader.prototype.read;
ReadableStreamDefaultReader.prototype.read = function () {
  const result = read.call(this);
  void result.then(() => { if (signalled) note("reader-read-settled"); }, () => { if (signalled) note("reader-read-rejected"); });
  return result;
};
const cancel = ReadableStreamDefaultReader.prototype.cancel;
ReadableStreamDefaultReader.prototype.cancel = function (reason?: unknown) {
  if (signalled) note("reader-cancel");
  const result = cancel.call(this, reason);
  void result.then(() => { if (signalled) note("reader-cancel-settled"); }, () => { if (signalled) note("reader-cancel-rejected"); });
  return result;
};
process.once("beforeExit", () => { if (signalled) note("before-exit"); });
