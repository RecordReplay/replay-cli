// Manage installation of browsers for other NPM packages.

const { spawnSync } = require("child_process");
const fs = require("fs");
const https = require("https");
const path = require("path");
const { defer, getDirectory, maybeLog } = require("./utils");

const EXECUTABLE_PATHS = {
  "darwin:firefox": ["firefox", "Nightly.app", "Contents", "MacOS", "firefox"],
  "linux:chromium": ["chrome-linux", "chrome"],
  "linux:firefox": ["firefox", "firefox"],
};

async function ensurePlaywrightBrowsersInstalled(kind = "all", opts = {}) {
  maybeLog(opts.verbose, `Installing ${kind === "all" ? "browsers" : kind} for ${process.platform}`);
  if (kind !== "all" && !getPlatformKey(kind)) {
    console.log(`${kind} browser for Replay is not supported on ${process.platform}`);
    return;
  }

  switch (process.platform) {
    case "darwin":
      if (["all", "gecko"].includes(kind)) {
        await installReplayBrowser("macOS-replay-playwright.tar.xz", "playwright", "firefox", "firefox", opts);
      }
      break;
    case "linux":
      if (["all", "gecko"].includes(kind)) {
        await installReplayBrowser("linux-replay-playwright.tar.xz", "playwright", "firefox", "firefox", opts);
      }
      if (["all", "chromium"].includes(kind)) {
        await installReplayBrowser("linux-replay-chromium.tar.xz", "playwright", "replay-chromium", "chrome-linux", opts);
      }
      break;
  }
}

async function ensurePuppeteerBrowsersInstalled(kind = "all") {
  switch (process.platform) {
    case "linux":
      if (["all", "chromium"].includes(kind)) {
        await installReplayBrowser("linux-replay-chromium.tar.xz", "puppeteer", "replay-chromium", "chrome-linux");
      }
      break;
  }
}

async function updateBrowsers(opts = {}) {
  switch (process.platform) {
    case "darwin":
      await updateReplayBrowser("macOS-replay-playwright.tar.xz", "playwright", "firefox", "firefox", opts);
      break;
    case "linux":
      await updateReplayBrowser("linux-replay-playwright.tar.xz", "playwright", "firefox", "firefox", opts);
      await updateReplayBrowser("linux-replay-chromium.tar.xz", "playwright", "replay-chromium", "chrome-linux", opts);
      await updateReplayBrowser("linux-replay-chromium.tar.xz", "puppeteer", "replay-chromium", "chrome-linux", opts);
      break;
  }
}

function getPlatformKey(browserName) {
  const key = `${process.platform}:${browserName}`;
  switch (key) {
    case "darwin:firefox":
    case "linux:firefox":
    case "linux:chromium":
      return key;
  }

  return undefined;
}

function getExecutablePath(runner, browserName) {
  // Override with replay specific browsers.
  const replayDir = getDirectory();

  const key = getPlatformKey(browserName);
  if (!key) {
    return null;
  }

  return path.join(replayDir, runner, ...EXECUTABLE_PATHS[key]);
}

function getPlaywrightBrowserPath(kind) {
  return getExecutablePath("playwright", kind);
}

function getPuppeteerBrowserPath(kind) {
  return getExecutablePath("puppeteer", kind);
}

// Installs a browser if it isn't already installed.
async function installReplayBrowser(name, subdir, srcName, dstName, opts) {
  const replayDir = getDirectory();
  const browserDir = path.join(replayDir, subdir);

  if (fs.existsSync(path.join(browserDir, dstName))) {
    maybeLog(opts.verbose, `Skipping ${dstName}. Already exists in ${browserDir}`);
    return;
  }

  const contents = await downloadReplayFile(name, opts);

  for (const dir of [replayDir, browserDir]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir);
    }
  }

  maybeLog(opts.verbose, `Saving ${dstName} to ${browserDir}`);
  fs.writeFileSync(path.join(browserDir, name), contents);
  spawnSync("tar", ["xf", name], { cwd: browserDir });
  fs.unlinkSync(path.join(browserDir, name));

  if (srcName != dstName) {
    fs.renameSync(path.join(browserDir, srcName), path.join(browserDir, dstName));
  }
}

// Updates a browser if it is already installed.
async function updateReplayBrowser(name, subdir, srcName, dstName, opts) {
  const replayDir = getDirectory(opts);
  const browserDir = path.join(replayDir, subdir);
  const dstDir = path.join(browserDir, dstName);

  if (fs.existsSync(dstDir)) {
    // Remove the browser so installReplayBrowser will reinstall it. We don't have a way
    // to see that the current browser is up to date.
    fs.rmSync(dstDir, { force: true, recursive: true });
  } else {
    maybeLog(opts.verbose, `Browser ${name} is not installed.`);
    return;
  }

  await installReplayBrowser(name, subdir, srcName, dstName, opts);

  maybeLog(opts.verbose, `Updated.`);
}

async function downloadReplayFile(downloadFile, opts) {
  const options = {
    host: "static.replay.io",
    port: 443,
    path: `/downloads/${downloadFile}`,
  };

  for (let i = 0; i < 5; i++) {
    const waiter = defer();
    maybeLog(opts.verbose, `Downloading ${downloadFile} from replay.io (Attempt ${i + 1} / 5)`);
    const request = https.get(options, response => {
      if (response.statusCode != 200) {
        console.log(`Download received status code ${response.statusCode}, retrying...`);
        request.destroy();
        waiter.resolve(null);
        return;
      }
      const buffers = [];
      response.on("data", data => buffers.push(data));
      response.on("end", () => waiter.resolve(buffers));
    });
    request.on("error", err => {
      console.log(`Download error ${err}, retrying...`);
      request.destroy();
      waiter.resolve(null);
    });
    const buffers = await waiter.promise;
    if (buffers) {
      return Buffer.concat(buffers);
    }

    maybeLog(opts.verbose, `Download of ${downloadFile} complete`);
  }

  throw new Error("Download failed, giving up");
}

module.exports = {
  ensurePlaywrightBrowsersInstalled,
  ensurePuppeteerBrowsersInstalled,
  getPlaywrightBrowserPath,
  getPuppeteerBrowserPath,
  updateBrowsers,
};
