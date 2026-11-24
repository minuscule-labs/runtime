/** Named, fixed-text setup errors. Callers match error.name; the text never carries paths or raw native output. */
export class CodexNotInstalledError extends Error {
  constructor() {
    super("Codex is not installed; install `codex`");
    this.name = "CodexNotInstalledError";
  }
}
export class CodexAuthRequiredError extends Error {
  constructor() {
    super("Codex is not logged in; run `codex login`");
    this.name = "CodexAuthRequiredError";
  }
}
