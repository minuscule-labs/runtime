import { collectDarwinProcessDomainObservation } from "../../src/darwin-process-domain.js";

if (process.argv[2] === "hang") {
  // Owned query-timeout fixture; never inspects any other process.
  setInterval(() => {}, 1_000);
} else if (process.argv[2] === "overflow") {
  process.stdout.write("x".repeat(128 * 1024));
  setInterval(() => {}, 1_000);
} else {
  // The parent's observation is not passed in: collect independently and return
  // identifiers only over the owned private IPC channel, never stdout/stderr.
  const observation = await collectDarwinProcessDomainObservation();
  process.send?.({ observation }, () => process.disconnect());
}
