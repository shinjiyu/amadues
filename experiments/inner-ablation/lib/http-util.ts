import http from 'node:http';

/** 读 SSE 的前 n 条 data 消息（JSON） */
export function collectSse(url: string, n: number, timeoutMs: number): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const out: unknown[] = [];
    let buf = '';
    const req = http.get(url, res => {
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buf += chunk;
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const data = block
            .split('\n')
            .filter(l => l.startsWith('data:'))
            .map(l => l.slice(5).trim())
            .join('\n');
          if (!data) continue;
          try {
            out.push(JSON.parse(data));
          } catch { /* skip */ }
          if (out.length >= n) {
            req.destroy();
            clearTimeout(timer);
            resolve(out);
            return;
          }
        }
      });
    });
    req.on('error', e => {
      if (out.length >= n) return;
      clearTimeout(timer);
      reject(e);
    });
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`SSE timeout after ${out.length}/${n} messages`));
    }, timeoutMs);
  });
}

export function getJson(url: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => (body += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`bad JSON (${res.statusCode}): ${body.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
  });
}
