const fs = require('fs');
const path = require('path');

function redactLine(line) {
  return line
    .replace(/\b(token|api_key|password)=([^&\s]+)/g, '$1=[redacted]')
    .replace(/(Authorization:\s*Bearer\s+)\S+/g, '$1[redacted]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]');
}

function main() {
  const src = path.join(__dirname, '..', 'data', 'access.log');
  const text = fs.readFileSync(src, 'utf8');
  const out = text.split('\n').map(line => redactLine(line)).join('\n');
  const outDir = path.join(__dirname, '..', 'out');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'clean.log'), out);
}

module.exports = { redactLine };

if (require.main === module) main();
