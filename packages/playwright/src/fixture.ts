import { type Browser, type TestInfoError, test } from "@playwright/test";
import { logger } from "@replay-cli/shared/logger";
import { ReporterError } from "@replayio/test-utils";
import assert from "node:assert/strict";
import { REPLAY_CONTENT_TYPE } from "./constants";
import { Errors } from "./error";
import type {
  ClientInstrumentation,
  ClientInstrumentationListener,
  StackFrame,
  TestInfoInternal,
  TestStepInternal,
} from "./playwrightTypes";
import { captureRawStack, filteredStackTrace } from "./stackTrace";

interface StepStartDetail {
  apiName: string;
  category: TestStepInternal["category"];
  frames: StackFrame[];
  params: Record<string, any>;
  title: TestStepInternal["title"];
  hook: "afterAll" | "afterEach" | "beforeAll" | "beforeEach" | undefined;
}

export interface FixtureStepStart extends StepStartDetail {
  id: string;
}

export interface TestExecutionIdData {
  filePath: string;
  projectName: string | undefined;
  repeatEachIndex: number;
  attempt: number;
  source: {
    title: string;
    scope: string[];
  };
}

interface FixtureStepStartEvent extends FixtureStepStart {
  event: "step:start";
  test: TestExecutionIdData;
}

interface StepEndDetail {
  error: ParsedErrorFrame | null;
}

export interface FixtureStepEnd extends StepEndDetail {
  id: string;
}

interface FixtureStepEndEvent extends FixtureStepEnd {
  event: "step:end";
  test: TestExecutionIdData;
}

export interface ReporterErrorEvent extends ReporterError {
  event: "error";
  test: TestExecutionIdData;
}

export type FixtureEvent = FixtureStepStartEvent | FixtureStepEndEvent | ReporterErrorEvent;

declare global {
  interface Window {
    __RECORD_REPLAY_ANNOTATION_HOOK__?: (
      source: string,
      data: { event: string; id: string; data: unknown }
    ) => void;
  }
}

function ReplayAddAnnotation([event, id, data]: readonly [string, string, string]) {
  window.__RECORD_REPLAY_ANNOTATION_HOOK__?.("replay-playwright", {
    event,
    id,
    data: data ? JSON.parse(data) : undefined,
  });
}

function isReplayAnnotation(params?: any) {
  return params?.expression?.includes("ReplayAddAnnotation");
}

function parseLocation(stack?: string) {
  const pattern = /\/([^\/]+):(\d+):(\d+)$/;
  const firstLine = stack?.split("\n").find(l => pattern.test(l));
  const match = firstLine?.match(pattern);

  if (!match) {
    return {
      line: undefined,
      column: undefined,
    };
  }

  return {
    line: parseInt(match[2]),
    column: parseInt(match[3]),
  };
}

export interface ParsedErrorFrame {
  name: string;
  message: string;
  line: number | undefined;
  column: number | undefined;
}

function parseError(error: TestInfoError): ParsedErrorFrame {
  const location = parseLocation(error.stack);

  return {
    name: "name" in error ? (error.name as string) : "Error",
    message: error.message ?? "Unknown",
    line: location?.line,
    column: location?.column,
  };
}

type Playwright = {
  // it's available (as non-nullable) since 1.34.0
  _instrumentation: ClientInstrumentation;
};

const fixtureStates = new WeakMap<
  TestInfoInternal,
  {
    expectSteps: Set<string>;
    ignoredSteps: Set<string>;
    testIdData: TestExecutionIdData;
  }
>();

function getFixtureState(testInfo: TestInfoInternal) {
  let state = fixtureStates.get(testInfo);
  if (!state) {
    const testIdData: TestExecutionIdData = {
      filePath: testInfo.file,
      projectName: testInfo.project.name,
      repeatEachIndex: testInfo.repeatEachIndex,
      attempt: testInfo.retry + 1,
      source: {
        title: testInfo.title,
        // this one only drops the filename (first segment) and the test title (last segment)
        // it's different from the one in the reporter, since the "root" suites are just the file suites created here:
        // https://github.com/microsoft/playwright/blob/a6488c4a2879a22e8da0f6708114ef7b9f4d253f/packages/playwright/src/common/testLoader.ts#L36
        // in this context they are not attached to the root and project suites
        scope: testInfo.titlePath.slice(1, -1),
      },
    };
    state = {
      expectSteps: new Set(),
      ignoredSteps: new Set(),
      testIdData,
    };
    fixtureStates.set(testInfo, state);
  }
  return state;
}

const patchedTestInfos = new WeakSet<TestInfoInternal>();

export async function replayFixture(
  { playwright, browser }: { playwright: Playwright; browser: Browser },
  use: () => Promise<void>,
  testInfo: TestInfoInternal
) {
  const { expectSteps, ignoredSteps, testIdData } = getFixtureState(testInfo);

  // fixtures are created repeatedly for the same test
  // since they are created for beforeAll and afterAll hooks too
  // it's important to avoid patching the test info multiple times
  // otherwise the reporter would get notified multiple times about the same steps
  if (!patchedTestInfos.has(testInfo)) {
    patchedTestInfos.add(testInfo);

    const addStep = testInfo._addStep;
    testInfo._addStep = function (data, ...rest) {
      // expects are not passed through the client side instrumentation (since Playwright 1.41.0: https://github.com/microsoft/playwright/pull/28609)
      // https://github.com/microsoft/playwright/blob/5fa0583dcb708e74d2f7fc456b8c44cec9752709/packages/playwright-core/src/client/channelOwner.ts#L186-L188
      // they call `_addStep` directly
      // https://github.com/microsoft/playwright/blob/5fa0583dcb708e74d2f7fc456b8c44cec9752709/packages/playwright/src/matchers/expect.ts#L267-L275
      // so we need to handle them here
      if (data.category === "expect") {
        let frames = data.location ? [data.location] : undefined;
        if (!frames) {
          // based on those lines we replicate how Playwright computes the location and precompute it here for it so it uses ours
          // https://github.com/microsoft/playwright/blob/2734a0534256ffde6bd8dc8d27581c7dd26fe2a6/packages/playwright/src/worker/testInfo.ts#L266-L272
          const filteredStack = filteredStackTrace(captureRawStack());
          data.location = filteredStack[0];
          frames = filteredStack;
        }

        const step = addStep.call(this, data, ...rest);
        expectSteps.add(step.stepId);

        handlePlaywrightEvent({
          event: "step:start",
          id: step.stepId,
          params: step.params,
          detail: {
            apiName: "expect",
            category: step.category,
            title: step.title,
            params: step.params || {},
            frames,
            hook: getCurrentHookType(),
          },
        }).catch(err => {
          // this should never happen since `handlePlaywrightEvent` should always catch errors internally and shouldn't throw
          logger.error("ReplayFixture:FailedToAddExpectStep", { error: err });
        });

        return step;
      }

      return addStep.call(this, data, ...rest);
    };

    const onStepEnd = testInfo._onStepEnd;
    testInfo._onStepEnd = function (...args) {
      onStepEnd.call(this, ...args);

      const [payload] = args;
      if (expectSteps.has(payload.stepId)) {
        handlePlaywrightEvent({
          event: "step:end",
          id: payload.stepId,
          params: undefined,
          detail: {
            error: payload.error ? parseError(payload.error) : null,
          },
        }).catch(err => {
          // this should never happen since `handlePlaywrightEvent` should always catch errors internally and shouldn't throw
          logger.error("ReplayFixture:FailedToAddExpectStepEnd", { error: err });
        });
      }
    };
  }

  // start of before hooks can't be intercepted by the fixture in `_addStep`
  // `_addStep` gets monkey-patched in the this fixture but fixtures are registered in the `_runAsStage`'s callbacks like here:
  // https://github.com/microsoft/playwright/blob/2734a0534256ffde6bd8dc8d27581c7dd26fe2a6/packages/playwright/src/worker/workerMain.ts#L557-L566
  // while the hook steps are added as part of those main `_runAsStage` functions
  function getCurrentHookType() {
    if (testInfo._currentHookType) {
      return testInfo._currentHookType();
    }

    // based on the removed `hookType` util from Playwright's code:
    // https://github.com/microsoft/playwright/pull/29863/files#diff-e29aa8067f8fe0e63272392dfa682ea47cf92ec4257dffbd725f6c4992f48896L399-L403
    const type = testInfo._timeoutManager?.currentRunnableType?.();
    if (
      type === "afterAll" ||
      type === "afterEach" ||
      type === "beforeAll" ||
      type === "beforeEach"
    ) {
      return type;
    }
  }

  logger.info("ReplayFixture:SettingUp");

  async function addAnnotation(event: string, id?: string, detail?: Record<string, any>) {
    if (!id) {
      return;
    }

    return Promise.allSettled(
      browser.contexts().flatMap(context => {
        return context.pages().flatMap(async page => {
          try {
            // this leads to adding a regular step in the test
            // it would be best if this could be avoided somehow
            await page.evaluate(ReplayAddAnnotation, [
              event,
              id,
              JSON.stringify({ ...detail, test: testIdData }),
            ] as const);
          } catch (error) {
            // `onApiCallBegin`/`onApiCallEnd` are not awaited, see: https://github.com/microsoft/playwright/pull/30795
            // not much can be done about it, an *attempt* could be done to override builtin fixtures like `page` and `browser` to install our hooks there,
            // it's not worth it when a convenient API is available though
            // even when the issue gets fixed, it's still a good idea to catch those errors here and `debug` them
            // they can't be *logged* here because that interferes with the active reporter output
            logger.error("ReplayFixture:FailedToAddAnnotation", { error });
          }
        });
      })
    );
  }

  async function handlePlaywrightEvent({
    detail,
    ...data
  }:
    | {
        event: "step:start";
        id: string;
        params: Record<string, any> | undefined;
        detail: StepStartDetail;
      }
    | {
        event: "step:end";
        id: string;
        params: Record<string, any> | undefined;
        detail: StepEndDetail;
      }) {
    try {
      assert(
        data.id != null,
        new ReporterError(Errors.MissingCurrentStep, "No current step for API call end")
      );

      testInfo.attach(`replay:${data.event}`, {
        body: JSON.stringify({
          ...detail,
          ...data,
        }),
        contentType: REPLAY_CONTENT_TYPE,
      });

      return addAnnotation(data.event, data.id, detail);
    } catch (error) {
      let reporterError: ReporterError;

      if (error instanceof ReporterError) {
        reporterError = error;
      } else if (error instanceof Error) {
        reporterError = new ReporterError(Errors.UnexpectedError, error.message, {
          stack: error.stack,
        });
      } else {
        reporterError = new ReporterError(Errors.UnexpectedError, "Unknown", { error: error });
      }

      testInfo.attach("replay:step:error", {
        body: JSON.stringify(reporterError.valueOf()),
        contentType: REPLAY_CONTENT_TYPE,
      });
    }
  }

  const csiListener: ClientInstrumentationListener = {
    onApiCallBegin: (apiName, params, stackTraceOrFrames, wallTimeOrUserData, userDataOrOut) => {
      const userData = typeof wallTimeOrUserData === "number" ? userDataOrOut : wallTimeOrUserData;
      // `.userObject` holds the step data
      // https://github.com/microsoft/playwright/blob/8dec672121bb12dbc8371995c1cdba3ca0565ffb/packages/playwright/src/index.ts#L254-L261
      // this has been introduced in Playwright 1.17.0
      const step: TestStepInternal | undefined = userData?.userObject;

      if (!step) {
        return;
      }

      if (isReplayAnnotation(params)) {
        // do not emit page.evaluate steps that add replay annotations
        // this would create an infinite async loop
        ignoredSteps.add(step.stepId);
        return;
      }

      if (expectSteps.has(step.stepId)) {
        // at least some `expect` calls were API calls at some point (https://github.com/microsoft/playwright/pull/9117)
        // all of them are added through `_addStep` (it gets called first) and thus those are filtered out here
        return;
      }

      const frames = stackTraceOrFrames
        ? "frames" in stackTraceOrFrames
          ? stackTraceOrFrames.frames
          : stackTraceOrFrames
        : [];

      if (!frames.length) {
        // if frames are empty it likely means that the api call has been made from Playwright internals
        // this helps us to ignore steps created by builtin fixtures like `page` and `browser`
        ignoredSteps.add(step.stepId);
        return;
      }

      return handlePlaywrightEvent({
        event: "step:start",
        id: step.stepId,
        params,
        detail: {
          apiName,
          category: step.category,
          frames,
          params: params ?? {},
          title: step.title,
          hook: getCurrentHookType(),
        },
      });
    },

    onApiCallEnd: (userData, error) => {
      const step: TestStepInternal | undefined = userData?.userObject;

      if (!step || ignoredSteps.has(step.stepId)) {
        return;
      }
      return handlePlaywrightEvent({
        event: "step:end",
        id: step.stepId,
        params: userData?.userObject?.params,
        detail: {
          error: error ? parseError(error) : null,
        },
      });
    },
  };

  const clientInstrumentation = playwright._instrumentation;
  clientInstrumentation.addListener(csiListener);

  await use();

  clientInstrumentation.removeListener(csiListener);
}

// this doesn't work for users using `_baseTest` (the one without any builtin fixtures)
// it's not quite a public API though - it's exported at runtime but it's underscored, not documented and not available in the types
export function addReplayFixture() {
  const testTypeSymbol = Object.getOwnPropertySymbols(test).find(s => s.description === "testType");
  const fixtures = testTypeSymbol ? (test as any)[testTypeSymbol]?.fixtures : null;
  if (!fixtures) {
    logger.error("ReplayFixture:FailedToInject");
    return;
  }

  fixtures.push({
    fixtures: {
      _replay: [
        replayFixture,
        {
          // "all-hooks-included" is supported since Playwright 1.23.0
          // https://github.com/microsoft/playwright/pull/14104
          auto: "all-hooks-included",
          _title: "Replay.io fixture",
        },
      ],
    },
  });
}
