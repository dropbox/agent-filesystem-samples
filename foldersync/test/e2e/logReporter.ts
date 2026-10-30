// Adds each live test's result to the run log, deletes the log when every test
// passed, and keeps it when the run failed.
import {rmSync} from 'node:fs';

import type {Reporter, TestCase, TestModule} from 'vitest/node';

import {e2eLog} from './log';

export default class LogReporter implements Reporter {
  onTestCaseResult(test: TestCase): void {
    const result = test.result();
    const errors = (result.errors ?? []).map((e) => `\n    ${e.message}`).join('');
    e2eLog(`${result.state} ${test.fullName}${errors}`);
  }

  onTestRunEnd(
    _modules: ReadonlyArray<TestModule>,
    errors: ReadonlyArray<unknown>,
    reason: 'passed' | 'interrupted' | 'failed'
  ): void {
    const log = process.env.FOLDERSYNC_E2E_LOG;
    if (!log) {
      return;
    }
    if (reason === 'passed' && errors.length === 0) {
      rmSync(log, {force: true});
    } else {
      console.log(`\nThe live test log is kept at ${log}`);
    }
  }
}
