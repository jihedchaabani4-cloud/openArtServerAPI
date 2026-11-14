/**
 * Core Pino logger instantiation with development pino-pretty transport
 * and production NDJSON output.
 */
import pino from "pino";
import { envConfig } from "../config/index.js";
import { redactionConfig } from "./redaction.js";
import { errSerializer, reqSerializer, resSerializer } from "./serializers.js";

const pinoOptions = {
  level: envConfig.level,
  redact: redactionConfig,
  serializers: {
    err: errSerializer,
    error: errSerializer,
    req: reqSerializer,
    res: resSerializer,
  },
  base: {
    pid: process.pid,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
};

if (envConfig.prettyPrint) {
  pinoOptions.transport = {
    target: "pino-pretty",
    options: {
      colorize: true,
      translateTime: "HH:MM:ss",
      ignore: "pid,hostname",
      messageFormat: "{msg}",
    },
  };
}

export const baseLogger = pino(pinoOptions);

export default baseLogger;
