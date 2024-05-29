import { readdirSync, removeSync, writeFileSync } from "fs-extra";
import { join } from "path";
import { recordingLogPath, recordingsPath } from "./config";
import { debug } from "./debug";
import { getRecordings } from "./getRecordings";
import { readRecordingLog } from "./readRecordingLog";
import { LocalRecording, RECORDING_LOG_KIND } from "./types";

function getAssetsUsageMap(recordings: LocalRecording[]) {
  const usageMap: Record<string, number> = {};

  for (const recording of recordings) {
    for (const sourceMap of recording.metadata.sourceMaps) {
      usageMap[sourceMap.path] ??= 0;
      usageMap[sourceMap.path]++;

      for (const originalSource of sourceMap.originalSources) {
        usageMap[originalSource.path] ??= 0;
        usageMap[originalSource.path]++;
      }
    }
  }
  return usageMap;
}

export function removeFromDisk(id?: string) {
  if (id) {
    debug("Removing recording %s", id);

    const recordings = getRecordings();
    const recording = recordings.find(recording => recording.id.startsWith(id));
    if (recording) {
      const assetsUsageMap = getAssetsUsageMap(recordings);

      const { metadata, path } = recording;

      metadata.sourceMaps.forEach(sourceMap => {
        if (assetsUsageMap[sourceMap.path] === 1) {
          debug("Removing recording source-map file %s", sourceMap.path);
          removeSync(sourceMap.path);
          removeSync(sourceMap.path.replace(/\.map$/, ".lookup"));
        }

        sourceMap.originalSources.forEach(source => {
          if (assetsUsageMap[source.path] === 1) {
            debug("Removing recording original source file %s", source.path);
            removeSync(source.path);
          }
        });
      });

      // Delete recording data file
      if (path) {
        debug("Removing recording data file %s", path);

        removeSync(path);
      }

      // Remove entries from log
      const filteredLogs = readRecordingLog().filter(entry => {
        switch (entry.kind) {
          case RECORDING_LOG_KIND.originalSourceAdded:
          case RECORDING_LOG_KIND.sourcemapAdded: {
            return entry.recordingId !== id;
          }
          default: {
            return entry.id !== id;
          }
        }
      });

      writeFileSync(
        recordingLogPath,
        filteredLogs.map(log => JSON.stringify(log)).join("\n"),
        "utf8"
      );
    } else {
      console.log("Recording not found");
    }
  } else {
    debug("Removing all recordings");

    const files = readdirSync(recordingsPath);
    files.forEach(fileName => {
      if (/(recording|sourcemap|original)-/.test(fileName)) {
        removeSync(join(recordingsPath, fileName));
      }
    });
    removeSync(recordingLogPath);
  }
}
