const fs = require('fs');
const path = require('path');

const week = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'week.json'), 'utf8'));
const assignments = {};
for (const shift of week.shifts) {
  const picked = [];
  for (const person of week.people) {
    if (picked.length >= shift.need) break;
    if (person.available.includes(shift.id)) picked.push(person.id);
  }
  assignments[shift.id] = picked;
}

const outDir = path.join(__dirname, '..', 'out');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'assignments.json'), JSON.stringify(assignments, null, 2) + '\n');
