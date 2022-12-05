/// <reference types="cypress" />

import path from "path";
import semver from "semver";
import { getPlaywrightBrowserPath } from "@replayio/replay";
import { getDirectory } from "@replayio/replay/src/utils";
import { ReplayReporter, Test } from "@replayio/test-utils";
import { TASK_NAME } from "./constants";
import type { StepEvent } from "./support";
import { groupStepsByTest } from "./steps";

const pluginVersion = require("../package.json").version;

const plugin: Cypress.PluginConfig = (on, config) => {
  let steps: StepEvent[] = [];

  const reporter = new ReplayReporter({
    name: "cypress",
    version: config.version,
    plugin: pluginVersion,
  });
  let selectedBrowser: "chromium" | "firefox";
  let startTime: number | undefined;

  on("before:browser:launch", (browser, launchOptions) => {
    selectedBrowser = browser.family;
    reporter.onTestSuiteBegin(undefined, "CYPRESS_REPLAY_METADATA");

    if (config.version && semver.gte(config.version, "10.9.0")) {
      return {
        ...launchOptions,
        env: {
          RECORD_REPLAY_DRIVER:
            process.env.RECORD_REPLAY_NO_RECORD && selectedBrowser === "chromium"
              ? __filename
              : undefined,
          RECORD_ALL_CONTENT: process.env.RECORD_REPLAY_NO_RECORD ? undefined : 1,
          RECORD_REPLAY_METADATA_FILE: getMetadataFilePath(),
        },
      };
    }
  });
  on("before:spec", () => {
    startTime = Date.now();
    reporter.onTestBegin(undefined, getMetadataFilePath());
  });
  on("after:spec", (spec, result) => {
    let testsWithSteps: Test[] = [];
    try {
      testsWithSteps = groupStepsByTest(steps, startTime!);
    } catch (e) {
      console.warn("Failed to build test step metadata for this replay.");
      console.warn(e);
    }

    if (!result.tests) {
      // If the browser crashes, no tests are run and tests will be null
      return;
    }

    const tests = result.tests.map<Test>(t => {
      const foundTest = testsWithSteps.find(ts => ts.title === t.title[t.title.length - 1]) || null;

      const error = t.displayError
        ? {
            // typically, we won't use this because we'll have a step error that
            // originated the message but keeping as a fallback
            message: t.displayError.substring(0, t.displayError.indexOf("\n")),
          }
        : undefined;

      return {
        title: t.title[t.title.length - 1] || spec.relative,
        // If we found the test from the steps array (we should), merge it in
        // and overwrite the default title and relativePath values. It won't
        // have the correct path or result so those are added and we bubble up
        // the first error found in a step falling back to reported test error
        // if it exists.
        ...foundTest,
        relativePath: spec.relative,
        path: ["", selectedBrowser || "", spec.relative, spec.specType || ""],
        result: t.state == "failed" ? "failed" : "passed",
        error,
      };
    });

    reporter.onTestEnd(tests, spec.relative);
  });

  on("task", {
    // Events are sent to the plugin by the support adapter which runs in the
    // browser context and has access to `Cypress` and `cy` methods.
    [TASK_NAME]: value => {
      if (!value || typeof value !== "object") return;

      steps.push(value);

      return true;
    },
  });

  const chromiumPath = getPlaywrightBrowserPath("chromium");
  if (chromiumPath) {
    Object.assign(config, {
      browsers: config.browsers.concat({
        name: "Replay Chromium",
        channel: "stable",
        family: "chromium",
        displayName: "Replay",
        version: "91.0",
        path: chromiumPath,
        majorVersion: 91,
        isHeaded: true,
        isHeadless: false,
      }),
    });
  }

  const firefoxPath = getPlaywrightBrowserPath("firefox");
  if (firefoxPath) {
    Object.assign(config, {
      browsers: config.browsers.concat({
        name: "Replay Firefox",
        channel: "stable",
        family: "firefox",
        displayName: "Replay",
        version: "91.0",
        path: firefoxPath,
        majorVersion: 91,
        isHeaded: true,
        isHeadless: false,
      }),
    });
  }

  return config;
};

export function getMetadataFilePath(workerIndex = 0) {
  return (
    process.env.RECORD_REPLAY_METADATA_FILE ||
    path.join(getDirectory(), `CYPRESS_METADATA_${workerIndex}`)
  );
}

export default plugin;
