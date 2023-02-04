import type { TestError, TestStep } from "@replayio/test-utils";

import { TASK_NAME } from "./constants";

declare global {
  interface Window {
    __RECORD_REPLAY_ANNOTATION_HOOK__?: (name: string, value: any) => void;
  }
}

export interface StepEvent {
  event: "step:enqueue" | "step:start" | "step:end" | "test:start" | "test:end";
  test: string[];
  file: string;
  timestamp: string;
  category?: TestStep["category"];
  hook?: TestStep["hook"];
  command?: CommandLike;
  error?: TestError;
}

interface CommandLike {
  id: string;
  groupId?: string;
  name: string;
  args: any[];
  commandId?: string;
}

const makeEvent = (
  currentTest: typeof Cypress.currentTest,
  event: StepEvent["event"],
  category?: TestStep["category"],
  cmd?: CommandLike,
  error?: TestError
): StepEvent => ({
  event,
  test: currentTest.titlePath,
  file: Cypress.spec.relative,
  timestamp: new Date().toISOString(),
  command: cmd,
  category,
  hook: getCurrentTestHook(),
  ...(error
    ? {
        error,
      }
    : null),
});

const handleCypressEvent = (
  currentTest: typeof Cypress.currentTest,
  event: StepEvent["event"],
  category?: TestStep["category"],
  cmd?: CommandLike,
  error?: TestError
) => {
  if (cmd?.args?.[0] === TASK_NAME) return;

  const arg = makeEvent(currentTest, event, category, cmd, error);

  return Promise.resolve()
    .then(() => {
      // Adapted from https://github.com/archfz/cypress-terminal-report
      // @ts-ignore
      Cypress.backend("task", {
        task: TASK_NAME,
        arg,
      })
        // For some reason cypress throws empty error although the task indeed works.
        .catch(error => {
          /* noop */
        });
    })
    .catch(console.error)
    .then(() => cmd);
};

const idMap: Record<string, string> = {};
let gReplayIndex = 1;

const getReplayId = (cypressId: string) => {
  return (idMap[cypressId] = idMap[cypressId] || String(gReplayIndex++));
};

const getCurrentTestHook = (): TestStep["hook"] => {
  try {
    const { type, hookName } = (Cypress as any).mocha.getRunner().currentRunnable;
    if (type === "hook") {
      switch (hookName) {
        case "before each":
          return "beforeEach";
        case "after each":
          return "afterEach";
      }
    }
  } catch {
    return;
  }
};

function getCypressId(cmd: Cypress.CommandQueue): string {
  // Cypress 8 doesn't include an `id` on the command so we fall back to
  // userInvocationStack as a means to uniquely identify a command
  return cmd.get("id") || cmd.get("userInvocationStack");
}

function toCommandJSON(cmd: Cypress.CommandQueue): CommandLike {
  return {
    name: cmd.get("name"),
    id: getReplayId(getCypressId(cmd)),
    groupId: getReplayId(cmd.get("chainerId")),
    args: cmd.get("args"),
  };
}

interface MochaTest {
  title: string;
  parent: MochaTest;
}

let lastTest: MochaTest | undefined;

function getCurrentTest(): { title: string; titlePath: string[] } {
  if (Cypress.currentTest) {
    return Cypress.currentTest;
  }

  // Cypress < 8 logic
  const mochaRunner = (Cypress as any).mocha?.getRunner();

  if (!mochaRunner) {
    throw new Error(`Cypress version ${Cypress.version || "(unknown)"} is not supported`);
  }

  let currentTest: MochaTest = (lastTest = mochaRunner.test || lastTest);
  const titlePath = [];
  const title = currentTest?.title;
  while (currentTest?.title) {
    titlePath.unshift(currentTest.title);
    currentTest = currentTest.parent;
  }

  return { title, titlePath };
}

function addAnnotation(
  currentTest: typeof Cypress.currentTest,
  event: string,
  data?: Record<string, any>
) {
  const payload = JSON.stringify({
    ...data,
    event,
    titlePath: currentTest.titlePath,
  });

  window.top &&
    window.top.__RECORD_REPLAY_ANNOTATION_HOOK__ &&
    window.top.__RECORD_REPLAY_ANNOTATION_HOOK__("replay-cypress", JSON.stringify(payload));
}

export default function register() {
  let lastCommand: Cypress.CommandQueue | undefined;
  let lastAssertionCommand: Cypress.CommandQueue | undefined;
  let currentTest: typeof Cypress.currentTest | undefined;

  Cypress.on("command:enqueued", cmd => {
    // in cypress open, beforeEach isn't called so fetch the current test here
    // as a fallback
    currentTest = currentTest || getCurrentTest();

    const id = getReplayId(cmd.id || cmd.userInvocationStack || [cmd.name, ...cmd.args].toString());
    addAnnotation(currentTest!, "step:enqueue", { commandVariable: "cmd", id });
    handleCypressEvent(currentTest!, "step:enqueue", "other", {
      id,
      groupId: getReplayId(cmd.chainerId),
      name: cmd.name,
      args: cmd.args,
    });
  });
  Cypress.on("command:start", cmd => {
    lastCommand = cmd;
    lastAssertionCommand = undefined;

    addAnnotation(currentTest!, "step:start", {
      commandVariable: "cmd",
      id: getReplayId(getCypressId(cmd)),
    });
    return handleCypressEvent(currentTest!, "step:start", "command", toCommandJSON(cmd));
  });
  Cypress.on("command:end", cmd => {
    const log = cmd
      .get("logs")
      .find((l: any) => l.get("name") === cmd.get("name"))
      ?.toJSON();
    addAnnotation(currentTest!, "step:end", {
      commandVariable: "cmd",
      logVariable: log ? "log" : undefined,
      id: getReplayId(getCypressId(cmd)),
    });
    handleCypressEvent(currentTest!, "step:end", "command", toCommandJSON(cmd));
  });
  Cypress.on("log:added", log => {
    if (log.name === "new url") {
      addAnnotation(currentTest!, "event:navigation", {
        logVariable: "log",
        url: log.url,
        id: getReplayId(log.id),
      });

      return;
    } else if (log.name !== "assert") {
      return;
    }

    const maybeCurrentAssertion: Cypress.CommandQueue | undefined = lastAssertionCommand
      ? lastAssertionCommand.get("next")
      : lastCommand?.get("next");

    if (maybeCurrentAssertion?.get("type") !== "assertion") {
      // debug("Received an assertion log without a prior assertion or command: %o", {
      //   lastAssertionCommandId: lastAssertionCommand && getCypressId(lastAssertionCommand),
      //   lastCommandId: lastCommand && getCypressId(lastCommand),
      //   currentAssertion: maybeCurrentAssertion && maybeCurrentAssertion.toJSON(),
      // });
      return;
    }

    const assertionId = getReplayId(getCypressId(maybeCurrentAssertion));

    // store the current assertion as the last assertion so we can identify the
    // enqueued command for chained assertions
    lastAssertionCommand = maybeCurrentAssertion;

    const cmd = {
      name: log.name,
      id: assertionId,
      groupId: log.chainerId && getReplayId(log.chainerId),
      args: [log.consoleProps.Message],
      category: "assertion",
      commandId: lastCommand ? getReplayId(getCypressId(lastCommand)) : undefined,
    };
    addAnnotation(currentTest!, "step:start", {
      commandVariable: "lastCommand",
      logVariable: "log",
      id: cmd.id,
    });
    handleCypressEvent(currentTest!, "step:start", "assertion", cmd);

    const logChanged = (changedLog: any) => {
      // This callback may be invoked multiple times for an assertion if Cypress
      // retries the evaluation. There doesn't appear to be an indication when
      // it's done retrying and it doesn't report `command:end` for failed
      // events so we're stuck capturing all of these and then ignoring the
      // intermediate events.

      if (changedLog.id !== log.id || !["passed", "failed"].includes(changedLog.state)) return;

      // We only care about asserts
      const changedCmd = {
        ...cmd,
        // Update args which can be updated when an assert resolves
        args: [changedLog.consoleProps.Message],
      };

      const error = changedLog.err
        ? {
            name: changedLog.err.name,
            message: changedLog.err.message,
            line: changedLog.err.codeFrame?.line,
            column: changedLog.err.codeFrame?.column,
          }
        : undefined;

      if (error && lastCommand) {
        const failedCommandLog = lastCommand
          .get("logs")
          ?.find((l: any) => l.get("id") === changedLog.id);

        // if an assertion fails, emit step:end for the failed command
        addAnnotation(currentTest!, "step:end", {
          commandVariable: "lastCommand",
          logVariable: failedCommandLog ? "failedCommandLog" : undefined,
          id: getReplayId(getCypressId(lastCommand)),
        });
        handleCypressEvent(currentTest!, "step:end", "command", toCommandJSON(lastCommand));
      }

      addAnnotation(currentTest!, "step:end", {
        commandVariable: maybeCurrentAssertion ? "maybeCurrentAssertion" : undefined,
        logVariable: "changedLog",
        id: changedCmd.id,
      });
      handleCypressEvent(currentTest!, "step:end", "assertion", changedCmd, error);
    };

    Cypress.on("log:changed", logChanged);
  });
  beforeEach(() => {
    currentTest = getCurrentTest();
    if (currentTest) {
      handleCypressEvent(currentTest!, "test:start");
      addAnnotation(currentTest!, "test:start");
    }
  });
  afterEach(() => {
    if (currentTest) {
      handleCypressEvent(currentTest!, "test:end");
      addAnnotation(currentTest!, "test:end");
    }
  });
}
