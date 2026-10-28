const fs = require('fs');
const path = require('path');

function search(query) {
  const needle = String(query).toLowerCase();
  if (!/[a-z0-9]/.test(needle)) return [];
  const notesDir = path.join(__dirname, '..', 'notes');
  const hits = [];
  for (const name of fs.readdirSync(notesDir)) {
    if (!name.endsWith('.md')) continue;
    const text = fs.readFileSync(path.join(notesDir, name), 'utf8').toLowerCase();
    const words = text.match(/[a-z0-9]+/g) || [];
    if (words.includes(needle)) hits.push(name.replace(/\.md$/, ''));
  }
  return hits.sort();
}

module.exports = { search };
