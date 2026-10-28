const fs = require('fs');
const path = require('path');

const query = process.argv.slice(2).join(' ').toLowerCase();
const dir = path.join(__dirname, '..', 'docs');
const hits = [];
for (const name of fs.readdirSync(dir).filter(n => n.endsWith('.md')).sort()) {
  const text = fs.readFileSync(path.join(dir, name), 'utf8').toLowerCase();
  if (query && text.includes(query)) hits.push(name);
}
process.stdout.write(hits.join('\n') + (hits.length ? '\n' : ''));
