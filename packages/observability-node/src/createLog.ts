import debug from "debug";
import { appendFileSync, ensureFileSync } from "fs-extra";
import util from "util";
import { getReplayPath } from "./getReplayPath";

// MBUDAYR - the existence of this file in this package is confusing.
export function createLog(name: string, logFilePath?: string) {
  const logger = debug(`replayio:${name}`);

  if (logFilePath) {
    logFilePath = getReplayPath(logFilePath);
  }

  if (logFilePath) {
    try {
      ensureFileSync(logFilePath);
    } catch (error) {
      logFilePath = undefined;
      logger("Failed to create log directory %o", error);
    }
  }

  // MBUDAYR - I do not want to be tied down to this logger formatter.
  return function log(formatter: string, ...args: any[]) {
    logger(formatter, ...args);

    if (logFilePath) {
      try {
        const formatted = util.format(formatter, ...args);

        appendFileSync(logFilePath, `${formatted}\n`);
      } catch (error) {
        logger("Failed to write log %o", error);
      }
    }
  };
}
