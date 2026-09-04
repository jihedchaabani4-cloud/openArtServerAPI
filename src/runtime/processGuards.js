import { ErrorSystem } from "./ErrorSystem.js";

export function setupProcessGuards() {
  process.on("unhandledRejection", (reason) => {
    ErrorSystem.process(reason, { source: "unhandledRejection" });
  });

  process.on("uncaughtException", (err) => {
    ErrorSystem.process(err, { source: "uncaughtException" });
    process.exit(1); // do not keep serving with unreliable internal state
  });
}

export default setupProcessGuards;
