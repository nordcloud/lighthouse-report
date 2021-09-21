import "./utils/support-lh-plugins";

import core from "@actions/core";
import { join } from "path";
import childProcess from "child_process";
import { getInput, hasAssertConfig } from "./config";
import { uploadArtifacts } from "./utils/artifacts";
import { setAnnotations } from "./utils/annotations";
import { setOutput } from "./utils/output"; // add automatic support for LH Plugins env
import { login } from "./auth/login";

const lhciCliPath = require.resolve("@lhci/cli/src/cli");

/**
 * Audit urls with Lighthouse CI in 3 stages:
 * 1. collect (using lhci collect or the custom PSI runner, store results as artifacts)
 * 2. assert (assert results using budgets or LHCI assertions)
 * 3. upload (upload results to LHCI Server, Temporary Public Storage)
 */

async function main() {
  core.startGroup("Action config");
  const resultsPath = join(process.cwd(), ".lighthouseci");
  const input = getInput();
  core.info(`Input args: ${JSON.stringify(input, null, "  ")}`);
  core.endGroup(); // Action config

  /******************************* 0. AUTH **************************************/
  try {
    await login({
      otpSecret: input.auth0OtpSecret,
      credentials: { email: input.auth0Login, password: input.auth0Password },
      loginUrl: "",
    });
  } catch (err) {
    if (err instanceof Error) {
      core.setFailed(err.message);
    }
  }

  /******************************* 1. COLLECT ***********************************/
  core.startGroup(`Collecting`);
  const collectArgs = [`--numberOfRuns=${input.runs}`];

  if (input.staticDistDir) {
    collectArgs.push(`--static-dist-dir=${input.staticDistDir}`);
  } else if (input.urls) {
    for (const url of input.urls) {
      collectArgs.push(`--url=${url}`);
    }
  }
  // else LHCI will panic with a non-zero exit code...

  if (input.configPath) collectArgs.push(`--config=${input.configPath}`);

  const collectStatus = runChildCommand("collect", collectArgs);
  if (collectStatus !== 0) throw new Error(`LHCI 'collect' has encountered a problem.`);

  core.endGroup(); // Collecting

  /******************************* 2. ASSERT ************************************/
  if (input.budgetPath || hasAssertConfig(input.configPath)) {
    core.startGroup(`Asserting`);
    const assertArgs = [];

    if (input.budgetPath) {
      assertArgs.push(`--budgetsFile=${input.budgetPath}`);
    } else {
      assertArgs.push(`--config=${input.configPath}`);
    }

    // run lhci with problem matcher
    // https://github.com/actions/toolkit/blob/master/docs/commands.md#problem-matchers
    runChildCommand("assert", assertArgs);
    core.endGroup(); // Asserting
  }

  /******************************* 3. UPLOAD ************************************/
  core.startGroup(`Uploading`);

  if (input.serverToken || input.temporaryPublicStorage || input.uploadArtifacts) {
    // upload artifacts as soon as collected
    if (input.uploadArtifacts) {
      await uploadArtifacts(resultsPath, input.artifactName);
    }

    if (input.serverToken || input.temporaryPublicStorage) {
      const uploadParams = [];

      if (input.serverToken) {
        uploadParams.push(
          "--target=lhci",
          `--serverBaseUrl=${input.serverBaseUrl}`,
          `--token=${input.serverToken}`,
          "--ignoreDuplicateBuildFailure" // ignore failure on the same commit rerun
        );
      } else if (input.temporaryPublicStorage) {
        uploadParams.push("--target=temporary-public-storage");
      }

      if (input.basicAuthPassword) {
        uploadParams.push(
          `--basicAuth.username=${input.basicAuthUsername}`,
          `--basicAuth.password=${input.basicAuthPassword}`
        );
      }

      if (input.configPath) uploadParams.push(`--config=${input.configPath}`);

      const uploadStatus = runChildCommand("upload", uploadParams);
      if (uploadStatus !== 0) throw new Error(`LHCI 'upload' failed to upload to LHCI server.`);
    }
  }

  // run again for filesystem target
  const uploadStatus = runChildCommand("upload", [
    "--target=filesystem",
    `--outputDir=${resultsPath}`,
  ]);
  if (uploadStatus !== 0) throw new Error(`LHCI 'upload' failed to upload to fylesystem.`);

  core.endGroup(); // Uploading

  await setOutput(resultsPath);
  await setAnnotations(resultsPath); // set failing error/warning annotations
}

// run `main()`

try {
  main();
  core.debug(`done in ${process.uptime()}s`);
} catch (err) {
  if (err instanceof Error) {
    core.setFailed(err.message);
  }
}

/**
 * Run a child command synchronously.
 *
 * @param {'collect'|'assert'|'upload'} command
 * @param {string[]} [args]
 * @return {number}
 */

function runChildCommand(command: string, args: string[] = []) {
  const combinedArgs = [lhciCliPath, command, ...args];
  const { status = -1 } = childProcess.spawnSync(process.argv[0], combinedArgs, {
    stdio: "inherit",
  });
  return status || 0;
}
