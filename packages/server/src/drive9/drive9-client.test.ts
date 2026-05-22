import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveDrive9Config } from './drive9-client.js';

const ORIGINAL_ENV = {
  DRIVE9_API_KEY: process.env['DRIVE9_API_KEY'],
  DRIVE9_SERVER: process.env['DRIVE9_SERVER'],
  HOME: process.env['HOME'],
  USERPROFILE: process.env['USERPROFILE'],
};

function writeCliConfig(homeDir: string, body: unknown): void {
  const dir = path.join(homeDir, '.drive9');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config'), JSON.stringify(body, null, 2), 'utf8');
}

afterEach(() => {
  process.env['DRIVE9_API_KEY'] = ORIGINAL_ENV.DRIVE9_API_KEY;
  process.env['DRIVE9_SERVER'] = ORIGINAL_ENV.DRIVE9_SERVER;
  process.env['HOME'] = ORIGINAL_ENV.HOME;
  process.env['USERPROFILE'] = ORIGINAL_ENV.USERPROFILE;
});

describe('resolveDrive9Config', () => {
  it('prefers DRIVE9_* environment variables', () => {
    process.env['DRIVE9_API_KEY'] = 'dat9_env_token';
    process.env['DRIVE9_SERVER'] = 'https://env.drive9.test';

    const resolved = resolveDrive9Config();
    expect(resolved).toMatchObject({
      apiKey: 'dat9_env_token',
      apiUrl: 'https://env.drive9.test',
      source: 'env',
    });
  });

  it('falls back to the current drive9 CLI context', () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drive9-home-'));
    process.env['HOME'] = homeDir;
    process.env['USERPROFILE'] = homeDir;
    delete process.env['DRIVE9_API_KEY'];
    delete process.env['DRIVE9_SERVER'];

    writeCliConfig(homeDir, {
      server: 'https://api.drive9.ai',
      current_context: 'demo',
      contexts: {
        demo: {
          type: 'owner',
          server: 'https://ctx.drive9.ai',
          api_key: 'dat9_cli_token',
        },
      },
    });

    const resolved = resolveDrive9Config();
    expect(resolved).toMatchObject({
      apiKey: 'dat9_cli_token',
      apiUrl: 'https://ctx.drive9.ai',
      source: 'cli-config',
      contextName: 'demo',
    });
  });
});
