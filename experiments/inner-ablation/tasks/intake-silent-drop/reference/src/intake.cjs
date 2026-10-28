const fs = require('fs');
const path = require('path');

function readSubmission(file) {
  let raw = fs.readFileSync(file, 'utf8');
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  return JSON.parse(raw);
}

function emailProblem(email) {
  if (email == null || String(email).trim() === '') return 'missing_email';
  const s = String(email).trim();
  const parts = s.split('@');
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '' || /\s/.test(s)) return 'invalid_email';
  return null;
}

function main() {
  const incoming = path.join(__dirname, '..', 'incoming');
  const accepted = [];
  const rejected = [];
  for (const name of fs.readdirSync(incoming).filter(n => n.endsWith('.json')).sort()) {
    let obj;
    try {
      obj = readSubmission(path.join(incoming, name));
    } catch {
      rejected.push({ file: name, reason: 'invalid_json' });
      continue;
    }
    const emailErr = emailProblem(obj.email);
    if (emailErr) {
      rejected.push({ file: name, reason: emailErr });
      continue;
    }
    const message = obj.message == null ? '' : String(obj.message);
    if (message.trim() === '') {
      rejected.push({ file: name, reason: 'empty_message' });
      continue;
    }
    if (message.length > 500) {
      rejected.push({ file: name, reason: 'message_too_long' });
      continue;
    }
    accepted.push({ file: name, email: String(obj.email).trim(), message });
  }
  const outDir = path.join(__dirname, '..', 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const line = rows => rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
  fs.writeFileSync(path.join(outDir, 'accepted.jsonl'), line(accepted));
  fs.writeFileSync(path.join(outDir, 'rejections.jsonl'), line(rejected));
}

main();
