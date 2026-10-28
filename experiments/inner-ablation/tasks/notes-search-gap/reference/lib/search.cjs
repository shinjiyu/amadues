const fs = require('fs');
const path = require('path');

function search(query) {
  const needle = String(query).toLowerCase();
  if (needle.trim() === '') return [];
  const notesDir = path.join(__dirname, '..', 'notes');
  const hits = [];
  for (const name of fs.readdirSync(notesDir)) {
    if (!name.endsWith('.md')) continue;
    const text = fs.readFileSync(path.join(notesDir, name), 'utf8').toLowerCase();
    if (text.includes(needle)) hits.push(name.replace(/\.md$/, ''));
  }
  return hits.sort();
}

module.exports = { search };
