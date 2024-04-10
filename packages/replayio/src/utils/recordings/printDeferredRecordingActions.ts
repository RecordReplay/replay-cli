import { dots } from "cli-spinners";
import { isDebugging } from "../../config";
import { Deferred, STATUS_RESOLVED } from "../async/createDeferred";
import { logUpdate } from "../logUpdate";
import { printTable } from "../table";
import { statusFailed, statusPending, statusSuccess } from "../theme";
import { formatRecording } from "./formatRecording";
import { LocalRecording } from "./types";

export async function printDeferredRecordingActions(
  deferredActions: Deferred<boolean, LocalRecording>[],
  {
    renderTitle,
    renderExtraColumns,
    renderFailedSummary,
  }: {
    renderTitle: (options: { done: boolean }) => string;
    renderExtraColumns: (recording: LocalRecording) => string[];
    renderFailedSummary: (failedRecordings: LocalRecording[]) => string;
  }
) {
  let dotIndex = 0;

  const print = (done = false) => {
    const dot = dots.frames[++dotIndex % dots.frames.length];
    const title = renderTitle({ done });
    const table = printTable({
      rows: deferredActions.map(deferred => {
        let status = !isDebugging ? statusPending(dot) : "";
        if (deferred.resolution === true) {
          status = statusSuccess("✔");
        } else if (deferred.resolution === false) {
          status = statusFailed("✘");
        }
        const recording = deferred.data;
        const { date, duration, id, title } = formatRecording(recording);
        return [status, id, title, date, duration, ...renderExtraColumns(recording)];
      }),
    });

    logUpdate(title + "\n" + table);
  };

  print();

  const interval = !isDebugging ? setInterval(print, dots.interval) : undefined;

  await Promise.all(deferredActions.map(deferred => deferred.promise));

  clearInterval(interval);
  print(true);
  logUpdate.done();

  const failedActions = deferredActions.filter(deferred => deferred.status !== STATUS_RESOLVED);
  if (failedActions.length > 0) {
    const failedSummary = renderFailedSummary(failedActions.map(action => action.data));
    console.log(statusFailed(`${failedSummary}`) + "\n");
  }
}
