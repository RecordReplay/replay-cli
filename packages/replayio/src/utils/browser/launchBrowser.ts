import { ensureDirSync, existsSync } from "fs-extra";
import { join } from "path";
import { getReplayPath } from "../getReplayPath";
import { runtimeMetadata, runtimePath } from "../installation/config";
import { prompt } from "../prompt/prompt";
import { spawnProcess } from "../spawnProcess";
import { dim, stderrPrefix, stdoutPrefix } from "../theme";
import { debug } from "./debug";
import { getBrowserPath } from "./getBrowserPath";

export async function launchBrowser(
  url: string,
  options: {
    processGroupId: string;
  }
) {
  const { processGroupId } = options;

  const profileDir = join(runtimePath, "profiles", runtimeMetadata.runtime);
  ensureDirSync(profileDir);

  const browserExecutablePath = getBrowserPath();
  const args = [
    url,
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${profileDir}`,
  ];
  const processOptions = {
    env: {
      RECORD_ALL_CONTENT: "1",
      RECORD_REPLAY_DIRECTORY: getReplayPath(),
      RECORD_REPLAY_METADATA: JSON.stringify({ processGroupId }),
    },
    stdio: undefined,
  };

  if (!existsSync(browserExecutablePath)) {
    debug(`Replay browser not found at: ${browserExecutablePath}`);
    throw new Error(`Replay browser not found at: ${browserExecutablePath}`);
  }

  debug(
    `Launching browser: ${browserExecutablePath} with args:\n`,
    args.join("\n"),
    "\n",
    processOptions
  );

  // Wait until the user quits the browser process OR
  // until the user presses a key to continue (in which case, we will kill the process)
  const abortControllerForPrompt = new AbortController();

  const spawnDeferred = spawnProcess(browserExecutablePath, args, processOptions, {
    onSpawn: () => {
      if (process.stdin.isTTY) {
        console.log(`Recording... ${dim("(press any key to stop recording)")}`);

        prompt({
          signal: abortControllerForPrompt.signal,
        }).then(() => {
          spawnDeferred.data.kill();
        });
      } else {
        console.log(`Recording... ${dim("(quit the Replay Browser to stop recording)")}`);
      }
    },
    printStderr: (text: string) => {
      debug(stderrPrefix("stderr"), text);
    },
    printStdout: (text: string) => {
      debug(stdoutPrefix("stdout"), text);
    },
  });

  try {
    await spawnDeferred.promise;
  } finally {
    abortControllerForPrompt.abort();
  }
}
