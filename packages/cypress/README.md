# `@replayio/cypress`

Plugin to record your [Cypress](https://cypress.io) tests with [Replay](https://replay.io)

**Check out the ["Recording Automated Tests Guide"](https://docs.replay.io/docs/recording-automated-tests-5bf7d91b65cd46deab1867b07bd12bdf) to get started.**

Use with [action-cypress](https://github.com/replayio/action-cypress) to automatically upload replays of failed tests.

## Installation

`npm i @replayio/cypress`

## Configuration

```js
// cypress.config.js
import { defineConfig } from "cypress";
import cypressReplay from "@replayio/cypress";

module.exports = defineConfig({
  e2e: {
    setupNodeEvents(on, config) {
      // Adds "Replay Firefox" (macOS, linux) and "Replay Chromium" (linux)
      // browsers and hooks into Cypress lifecycle methods to capture test
      // metadata and results
      cypressReplay(on, config);
    },
  },
});
```

## Runtime Configuration

- Use the `--browser` flag to select a Replay Browser to record
- If using the Firefox version of Replay, you must set the `RECORD_ALL_CONTENT` environment variable to enable recording.
- To enable capturing metadata for the tests, you must set `RECORD_REPLAY_METADATA_FILE` to an accessible file path.
- To hide the Cypress sidebar and only show your application, set `CYPRESS_NO_COMMAND_LOG`.

```bash
RECORD_ALL_CONTENT=1 \
RECORD_REPLAY_METADATA_FILE=$(mktemp) \
CYPRESS_NO_COMMAND_LOG=1 \
npx cypress run --browser "Replay Firefox"
```

## Parallel runs on CI

If you have a large test suite, you might choose to split your test suite up and run them in parallel across multiple machines but still treat them as a single suite. By default, `@replayio/cypress` will generate a UUID for the suite and store it in the recording metadata under `test.run.id` but in this case each machine will have its own id.

In order to link these independently ran tests together, you can generate your own UUID and set it in the `RECORD_REPLAY_TEST_RUN_ID` environment variable and it will be used instead of generating a value.
