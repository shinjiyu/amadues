#!/usr/bin/env node
/**
 * Ensure doc/structurizr/.tools/structurizr.war exists (gitignored; CI auto-download).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const war = path.join(root, 'doc', 'structurizr', '.tools', 'structurizr.war');
const WAR_URL = 'https://download.structurizr.com/structurizr.war';

if (fs.existsSync(war)) {
  process.exit(0);
}

const auto =
  process.env.CI === 'true' ||
  process.env.CI === '1' ||
  process.env.STRUCTURIZR_DOWNLOAD_WAR === '1';

if (!auto) {
  console.error(
    [
      'Missing structurizr.war:',
      war,
      '',
      'Local: download from https://download.structurizr.com/structurizr.war',
      '       into doc/structurizr/.tools/ (see doc/structurizr/TOOLCHAIN.md)',
      'CI:    set CI=true or STRUCTURIZR_DOWNLOAD_WAR=1 to auto-download',
    ].join('\n'),
  );
  process.exit(1);
}

fs.mkdirSync(path.dirname(war), { recursive: true });
console.log(`Downloading Structurizr war → ${war}`);
const res = await fetch(WAR_URL);
if (!res.ok) {
  console.error(`Download failed: ${res.status} ${res.statusText}`);
  process.exit(1);
}
const buf = Buffer.from(await res.arrayBuffer());
fs.writeFileSync(war, buf);
console.log(`Downloaded ${(buf.length / 1024 / 1024).toFixed(1)} MB`);
