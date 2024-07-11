import type {
  FullConfig,
  Reporter,
  TestCase,
  TestError,
  TestResult,
} from "@playwright/test/reporter";
import { logger } from "@replay-cli/shared/logger";
import { mixpanelAPI } from "@replay-cli/shared/mixpanel/mixpanelAPI";
import { getRuntimePath } from "@replay-cli/shared/runtime/getRuntimePath";
import { emphasize, highlight, link } from "@replay-cli/shared/theme";
import { setUserAgent } from "@replay-cli/shared/userAgent";
import {
  ReplayReporter,
  ReplayReporterConfig,
  ReporterError,
  TestMetadataV2,
  getAccessToken,
  getMetadataFilePath as getMetadataFilePathBase,
  removeAnsiCodes,
} from "@replayio/test-utils";
import { existsSync, readFileSync } from "fs";
import path from "path";
import { name as packageName, version as packageVersion } from "../package.json";
import {
  FixtureStepStart,
  ParsedErrorFrame,
  ReporterErrorEvent,
  TestExecutionIdData,
} from "./fixture";
import { StackFrame } from "./playwrightTypes";
import { REPLAY_CONTENT_TYPE } from "./constants";

type UserActionEvent = TestMetadataV2.UserActionEvent;

export function getMetadataFilePath(workerIndex = 0) {
  return getMetadataFilePathBase("PLAYWRIGHT", workerIndex);
}

function extractErrorMessage(error: TestError) {
  const message = removeAnsiCodes(error.message);
  if (message) {
    // Error message. Set when [Error] (or its subclass) has been thrown.
    const errorMessageLines = message.split("\n");
    let stackStart = errorMessageLines.findIndex(l => l.startsWith("Call log:"));
    stackStart = stackStart == null || stackStart === -1 ? 10 : Math.min(stackStart, 10);
    return errorMessageLines.slice(0, stackStart).join("\n");
  } else if (error.value != null) {
    // The value that was thrown. Set when anything except the [Error] (or its subclass) has been thrown.
    return error.value;
  }

  return "Unknown error";
}

function mapFixtureStepCategory(step: FixtureStep): UserActionEvent["data"]["category"] {
  if (step.apiName.startsWith("expect")) {
    return "assertion";
  }

  return "command";
}

type ReplayPlaywrightRecordingMetadata = {
  title: string;
  test: TestMetadataV2.TestRun;
};

export interface ReplayPlaywrightConfig
  extends ReplayReporterConfig<ReplayPlaywrightRecordingMetadata> {
  captureTestFile?: boolean;
}

interface FixtureStep extends FixtureStepStart {
  error?: ParsedErrorFrame | undefined;
}

export default class ReplayPlaywrightReporter implements Reporter {
  reporter: ReplayReporter<ReplayPlaywrightRecordingMetadata>;
  captureTestFile: boolean;
  config: ReplayPlaywrightConfig;

  private _executedProjects: Record<string, { usesReplayBrowser: boolean }> = {};

  constructor(config: ReplayPlaywrightConfig) {
    setUserAgent(`${packageName}/${packageVersion}`);

    const accessToken = getAccessToken(config);

    logger.initialize(packageName, packageVersion);
    logger.identify(accessToken);

    mixpanelAPI.initialize({
      accessToken,
      packageName,
      packageVersion,
    });
    if (!config || typeof config !== "object") {
      mixpanelAPI.trackEvent("error.invalid-reporter-config", { config });

      throw new Error(
        `Expected an object for @replayio/playwright/reporter configuration but received: ${config}`
      );
    }

    this.config = config;
    this.reporter = new ReplayReporter(
      {
        name: "playwright",
        version: undefined,
        plugin: packageVersion,
      },
      "2.2.0", // Schema version
      { ...this.config, metadataKey: "PLAYWRIGHT_REPLAY_METADATA" }
    );
    this.captureTestFile =
      "captureTestFile" in config
        ? !!config.captureTestFile
        : ["1", "true"].includes(
            process.env.PLAYWRIGHT_REPLAY_CAPTURE_TEST_FILE?.toLowerCase() || "true"
          );
  }

  // Playwright already provides a unique test id:
  // https://github.com/microsoft/playwright/blob/6fb214de2378a9d874b46df6ea99d04da5765cba/packages/playwright/src/common/suiteUtils.ts#L56-L57
  // this is different because it includes `repeatEachIndex` and `attempt`
  // TODO(PRO-667): this could be simplified to `${test.testId}-${test.repeatEachIndex}-${test.attempt}`
  // before doing that all recipients of `TestExecutionIdData` should be rechecked to see if such a change would be safe
  private _getTestExecutionId(test: TestExecutionIdData) {
    return [
      test.filePath,
      test.projectName ?? "",
      test.repeatEachIndex,
      test.attempt,
      ...test.source.scope,
      test.source.title,
    ].join("-");
  }

  getSource(test: TestCase) {
    return {
      title: test.title,
      scope: test.titlePath().slice(3, -1),
    };
  }

  onBegin({ version }: FullConfig) {
    this.reporter.setTestRunnerVersion(version);
    this.reporter.onTestSuiteBegin();
  }

  private _registerExecutedProject(test: TestCase) {
    const project = test.parent.project();
    if (project) {
      let projectMetadata = this._executedProjects[project.name];
      if (!projectMetadata) {
        projectMetadata = this._executedProjects[project.name] = {
          usesReplayBrowser: project.use.launchOptions?.executablePath === getRuntimePath(),
        };
      }
      return projectMetadata;
    }

    return null;
  }

  onTestBegin(test: TestCase, testResult: TestResult) {
    const projectMetadata = this._registerExecutedProject(test);

    // Don't save metadata for non-Replay projects
    if (!projectMetadata?.usesReplayBrowser) return;

    const testExecutionId = this._getTestExecutionId({
      filePath: test.location.file,
      projectName: test.parent.project()?.name,
      repeatEachIndex: test.repeatEachIndex,
      attempt: testResult.retry + 1,
      source: this.getSource(test),
    });

    this.reporter.onTestBegin(testExecutionId, getMetadataFilePath(testResult.workerIndex));
  }

  private _processAttachments(testId: TestExecutionIdData, attachments: TestResult["attachments"]) {
    const indexedSteps = new Map<string, UserActionEvent>();

    const hookMap: Record<
      "afterAll" | "afterEach" | "beforeAll" | "beforeEach",
      UserActionEvent[]
    > = {
      afterAll: [],
      afterEach: [],
      beforeAll: [],
      beforeEach: [],
    };

    const main: UserActionEvent[] = [];

    const stacks: Record<string, StackFrame[]> = {};
    const filenames = new Set([testId.filePath]);

    for (const attachment of attachments) {
      if (attachment.contentType !== REPLAY_CONTENT_TYPE || !attachment.body) {
        continue;
      }

      switch (attachment.name) {
        case "replay:step:start": {
          const fixtureStep = JSON.parse(attachment.body.toString()) as FixtureStep;
          const step: UserActionEvent = {
            data: {
              id: fixtureStep.id,
              parentId: null,
              command: {
                name: fixtureStep.apiName,
                arguments: this.parseArguments(fixtureStep.apiName, fixtureStep.params),
              },
              scope: testId.source.scope,
              error: null,
              category: mapFixtureStepCategory(fixtureStep),
            },
          };

          indexedSteps.set(fixtureStep.id, step);

          const stack = fixtureStep.frames.map(frame => ({
            line: frame.line,
            column: frame.column,
            functionName: frame.function,
            file: path.relative(process.cwd(), frame.file),
          }));

          if (stack) {
            stacks[fixtureStep.id] = stack;

            for (const frame of stack) {
              filenames.add(frame.file);
            }
          }

          if (fixtureStep.hook) {
            hookMap[fixtureStep.hook].push(step);
          } else {
            main.push(step);
          }
          break;
        }
        case "replay:step:end": {
          const fixtureStep = JSON.parse(attachment.body.toString()) as FixtureStep;
          if (!fixtureStep.error) {
            break;
          }
          const step = indexedSteps.get(fixtureStep.id);
          if (!step) {
            break;
          }
          step.data.error = fixtureStep.error;
          break;
        }
        case "replay:step:error": {
          const fixtureEvent = JSON.parse(attachment.body.toString()) as ReporterErrorEvent;
          this.reporter.addError(
            new ReporterError(fixtureEvent.code, fixtureEvent.message, fixtureEvent.detail),
            {
              ...testId,
            }
          );
          break;
        }
      }
    }
    return {
      events: {
        ...hookMap,
        main,
      },
      filenames,
      stacks,
    };
  }

  onTestEnd(test: TestCase, result: TestResult) {
    const status = result.status;

    // Skipped tests won't have a reply so nothing to do here
    if (status === "skipped") return;

    const projectMetadata = this._registerExecutedProject(test);

    // Don't save metadata for non-Replay projects
    if (!projectMetadata?.usesReplayBrowser) return;

    const testExecutionIdData: TestExecutionIdData = {
      filePath: test.location.file,
      projectName: test.parent.project()?.name,
      repeatEachIndex: test.repeatEachIndex,
      attempt: result.retry + 1,
      source: this.getSource(test),
    };

    const { events, filenames, stacks } = this._processAttachments(
      testExecutionIdData,
      result.attachments
    );

    const relativePath = test.titlePath()[2];

    let playwrightMetadata: Record<string, any> | undefined;

    if (this.captureTestFile) {
      playwrightMetadata = {
        "x-replay-playwright": {
          sources: Object.fromEntries(
            [...filenames].map(filename => {
              try {
                return [filename, readFileSync(filename, "utf8")];
              } catch (e) {
                logger.error("PlaywrightReporter:FailedToReadPlaywrightTestSource", {
                  filename,
                  error: e,
                });
                return [filename, undefined];
              }
            })
          ),
          stacks,
        },
      };
    }

    const tests = [
      {
        id: 0,
        attempt: testExecutionIdData.attempt,
        source: testExecutionIdData.source,
        executionGroupId: String(testExecutionIdData.repeatEachIndex),
        executionId: this._getTestExecutionId(testExecutionIdData),
        maxAttempts: test.retries + 1,
        approximateDuration: test.results.reduce((acc, r) => acc + r.duration, 0),
        result: status === "interrupted" ? ("unknown" as const) : status,
        error: result.error
          ? {
              name: "Error",
              message: extractErrorMessage(result.error),
              line: result.error.location?.line ?? 0,
              column: result.error.location?.column ?? 0,
            }
          : null,
        events,
      },
    ];

    const recordings = this.reporter.getRecordingsForTest(tests);

    for (let i = 0; i < recordings.length; i++) {
      const recording = recordings[i];

      // our reporter has to come first in the list of configured reports for this to be useful to other reporters
      test.annotations.push({
        type: "Replay recording" + (i > 0 ? ` ${i + 1}` : ""),
        description: `https://app.replay.io/recording/${recording.id}`,
      });
    }

    this.reporter.onTestEnd({
      tests,
      specFile: relativePath,
      replayTitle: test.title,
      extraMetadata: playwrightMetadata,
    });
  }

  async onEnd() {
    try {
      await this.reporter.onEnd();

      const didUseReplayBrowser = Object.values(this._executedProjects).some(
        ({ usesReplayBrowser }) => usesReplayBrowser
      );
      const isReplayBrowserInstalled = existsSync(getRuntimePath());

      const output: string[] = [];

      if (!didUseReplayBrowser) {
        mixpanelAPI.trackEvent("warning.reporter-used-without-replay-project");
        output.push(emphasize("None of the configured projects ran using Replay Chromium."));
      }

      if (!isReplayBrowserInstalled) {
        if (didUseReplayBrowser) {
          mixpanelAPI.trackEvent("warning.replay-browser-not-installed");
        }

        output.push(
          `To record tests with Replay, you need to install the Replay browser: ${highlight(
            "npx replayio install"
          )}`
        );
      }

      if (output.length) {
        output.push(
          `Learn more at ${link(
            "https://docs.replay.io/reference/test-runners/playwright/overview"
          )}`
        );

        output.forEach((line, index) => {
          if (index > 0) {
            console.log("[replay.io]:");
          }
          console.warn(`[replay.io]: ${line}`);
        });
      }

      // we need to output an extra line that is safe to be deleted
      // Playwright's line reporter removes the last line here:
      // https://github.com/microsoft/playwright/blob/0c11d6ed803db582a5508c70f89e55dc9a36c751/packages/playwright/src/reporters/line.ts#L91
      //
      // so if the user configured their reporters like this:
      //
      // reporters: [replayReporter({ upload: true }), ['line']]
      //
      // that can lead to removing *our* last log line
      //
      // the issue is tracked here: https://github.com/microsoft/playwright/issues/23875
      console.log("");
    } finally {
      await Promise.all([mixpanelAPI.close().catch(noop), logger.close().catch(noop)]);
    }
  }

  parseArguments(apiName: string, params: any) {
    logger.info("PlaywrightReporter:ParseArguments", { apiName, params });
    if (!params || typeof params !== "object") {
      return [];
    }

    switch (apiName) {
      case "page.goto":
        return [params.url];
      case "page.evaluate":
        // TODO(ryanjduffy): This would be nice to improve but it can be nearly
        // anything so it's not obvious how to simplify it well to an array of
        // strings.
        return [];
      case "locator.getAttribute":
        return [params.selector, params.name];
      case "mouse.move":
        // params = {x: 0, y: 0}
        return [JSON.stringify(params)];
      case "locator.hover":
        return [params.selector, String(params.force)];
      case "expect.toBeVisible":
        return [params.selector, params.expression, String(params.isNot)];
      case "keyboard.type":
        return [params.text];
      case "keyboard.down":
      case "keyboard.up":
        return [params.key];
      case "locator.evaluate":
      case "locator.scrollIntoViewIfNeeded":
        return [params.selector, params.state];
      default:
        return params.selector ? [params.selector] : [];
    }
  }
}

function noop() {}
