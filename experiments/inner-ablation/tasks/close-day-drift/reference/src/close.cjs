const fs = require('fs');
const path = require('path');

function shanghaiDay(iso) {
  const ms = Date.parse(iso);
  const local = new Date(ms + 8 * 60 * 60 * 1000);
  const y = local.getUTCFullYear();
  const m = String(local.getUTCMonth() + 1).padStart(2, '0');
  const d = String(local.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

const day = process.argv[2];
const dir = path.join(__dirname, '..', 'receipts');
let total = 0;
let count = 0;
for (const name of fs.readdirSync(dir)) {
  if (!name.endsWith('.json')) continue;
  const receipt = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
  if (receipt.voided === true) continue;
  if (shanghaiDay(receipt.at) !== day) continue;
  total += receipt.amount_cents;
  count += 1;
}

const outDir = path.join(__dirname, '..', 'out');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
  path.join(outDir, 'close.json'),
  JSON.stringify({ day, total_cents: total, count }, null, 2) + '\n',
);
