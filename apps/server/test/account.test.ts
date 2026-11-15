import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { childEnv } from '../src/engine/claude.ts';

const shell = { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/somewhere/else', CLAUDECODE: '1' };

test('the account does not depend on the shell that started the office', () => {
  const env = childEnv(null, { base: shell });
  assert.equal('CLAUDE_CONFIG_DIR' in env, false);
  assert.equal('CLAUDECODE' in env, false);
  assert.equal(env.PATH, '/usr/bin');
});

test('the office can be given an account folder of its own', () => {
  const env = childEnv(null, { base: shell, officeConfigDir: '~/accounts/office' });
  assert.equal(env.CLAUDE_CONFIG_DIR, path.join(os.homedir(), 'accounts/office'));
});

test('a staff member given an account keeps it over the office one', () => {
  const env = childEnv('/accounts/second', { base: shell, officeConfigDir: '/accounts/office' });
  assert.equal(env.CLAUDE_CONFIG_DIR, '/accounts/second');
});

test('connected apps are switched on only when asked for', () => {
  assert.equal(childEnv(null, { base: shell }).ENABLE_CLAUDEAI_MCP_SERVERS, undefined);
  assert.equal(childEnv(null, { base: shell, connectors: true }).ENABLE_CLAUDEAI_MCP_SERVERS, '1');
});
