/**
 * Configuration defaults: every Chrome debug port gets its own state directory
 * and its own isolated Chrome profile, so two brokers never share a log, an
 * ownership file, or a `--user-data-dir`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { defaultStateDir, defaultUserDataDir } from '../lib/config.mjs';

test('default state and profile directories are port-scoped', () => {
  assert.equal(path.basename(defaultStateDir(9333)), 'dsh-chrome-webmcp');
  assert.equal(path.basename(defaultStateDir(9444)), 'dsh-chrome-webmcp-9444');
  assert.equal(path.basename(defaultUserDataDir(9333)), 'dsh-webmcp-chrome');
  assert.equal(path.basename(defaultUserDataDir(9444)), 'dsh-webmcp-chrome-9444');
  assert.notEqual(defaultStateDir(9333), defaultStateDir(9444));
  assert.notEqual(defaultUserDataDir(9333), defaultUserDataDir(9444));
});
