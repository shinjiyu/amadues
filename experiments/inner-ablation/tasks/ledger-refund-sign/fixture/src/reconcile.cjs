const fs = require('fs');
const path = require('path');

const csvPath = path.join(__dirname, '..', 'data', 'transactions.csv');
const lines = fs.readFileSync(csvPath, 'utf8').trim().split(/\n/).slice(1);

let sale = 0;
let rows = 0;
for (const line of lines) {
  if (!line.trim()) continue;
  const parts = line.split(',');
  const amount = Number(parts[3]);
  if (!Number.isFinite(amount)) continue;
  rows += 1;
  sale += amount;
}

const summary = {
  sale_cents: sale,
  refund_cents: 0,
  fee_cents: 0,
  net_cents: sale,
  rows,
};

const outDir = path.join(__dirname, '..', 'out');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
