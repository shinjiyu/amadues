const fs = require('fs');
const path = require('path');

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let quoted = false;
  const s = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(cur);
      cur = '';
    } else if (c === '\n') {
      row.push(cur);
      rows.push(row);
      row = [];
      cur = '';
    } else if (c !== '\r') {
      cur += c;
    }
  }
  if (cur.length > 0 || row.length > 0) {
    row.push(cur);
    rows.push(row);
  }
  return rows.filter(r => r.some(cell => cell.length > 0));
}

const csvPath = path.join(__dirname, '..', 'data', 'transactions.csv');
const table = parseCsv(fs.readFileSync(csvPath, 'utf8'));
const header = table[0];
const idOf = name => header.indexOf(name);
const kindAt = idOf('kind');
const amountAt = idOf('amount_cents');

let sale = 0;
let refund = 0;
let fee = 0;
let rows = 0;
for (const rec of table.slice(1)) {
  const kind = rec[kindAt];
  const amount = Number(rec[amountAt]);
  if (!Number.isFinite(amount)) continue;
  rows += 1;
  if (kind === 'sale') sale += amount;
  else if (kind === 'refund') refund += amount;
  else if (kind === 'fee') fee += amount;
}

const summary = {
  sale_cents: sale,
  refund_cents: refund,
  fee_cents: fee,
  net_cents: sale - refund - fee,
  rows,
};

const outDir = path.join(__dirname, '..', 'out');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
