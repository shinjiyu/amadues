#!/usr/bin/env node
/**
 * 把环境里的 JEV_KEY 写入仓库根 .env。
 * 密钥从 MCP Guard 保险箱注入，不要把值写进参数或日志。
 *
 *   vault_run_with_secret  name=JEV_KEY  env_key=JEV_KEY  command=node  args=[scripts/write-jev-key-env.mjs]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, '.env');
const value = process.env.JEV_KEY ?? '';
if (!value.trim()) {
  console.error('JEV_KEY is empty. Inject it from the vault; do not pass it on the command line.');
  process.exit(1);
}

const lines = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8').split(/\r?\n/) : [];
const kept = lines.filter(line => line.length > 0 && !line.startsWith('JEV_KEY='));
kept.push(`JEV_KEY=${value}`);
fs.writeFileSync(envPath, `${kept.join('\n')}\n`, { mode: 0o600 });
console.log(`updated ${envPath} (JEV_KEY, ${value.length} chars)`);
