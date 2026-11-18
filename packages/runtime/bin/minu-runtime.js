#!/usr/bin/env node
import { createRuntimeProgram } from "../dist/src/cli.js";
createRuntimeProgram().parseAsync(process.argv).catch(error => {
  console.error(error instanceof Error ? error.message : "Runtime command failed");
  process.exitCode = 1;
});
