import { logError } from "@replay-cli/shared/logger";
import { exitProcess } from "@replay-cli/shared/process/exitProcess";
import { statusSuccess } from "@replay-cli/shared/theme";
import { registerCommand } from "../utils/commander/registerCommand";
import { checkForNpmUpdate } from "../utils/initialization/checkForNpmUpdate";
import { checkForRuntimeUpdate } from "../utils/initialization/checkForRuntimeUpdate";
import { promptForNpmUpdate } from "../utils/initialization/promptForNpmUpdate";
import { installLatestRelease } from "../utils/installation/installLatestRelease";

registerCommand("update", {
  checkForRuntimeUpdate: false,
  checkForNpmUpdate: false,
})
  .description("Update Replay")
  .alias("install")
  .action(update);

async function update() {
  try {
    const [runtimeUpdateCheck, npmUpdateCheck] = await Promise.all([
      process.env.RECORD_REPLAY_CHROMIUM_DOWNLOAD_FILE
        ? { hasUpdate: true }
        : checkForRuntimeUpdate(),
      checkForNpmUpdate(),
    ]);

    if (runtimeUpdateCheck.hasUpdate && npmUpdateCheck.hasUpdate) {
      await installLatestRelease();
      await promptForNpmUpdate(npmUpdateCheck, false);
    } else if (npmUpdateCheck.hasUpdate) {
      console.log(statusSuccess("✔"), "You have the latest version of the Replay Browser");

      await promptForNpmUpdate(npmUpdateCheck, false);
    } else if (runtimeUpdateCheck.hasUpdate) {
      console.log(statusSuccess("✔"), "You have the latest version of replayio");

      await installLatestRelease();
    } else {
      console.log(
        statusSuccess("✔"),
        "You have the latest version of replayio and the Replay Browser"
      );
    }

    await exitProcess(0);
  } catch (error) {
    logError("Update:Failed", { error });
    console.error(error);

    await exitProcess(1);
  }
}
