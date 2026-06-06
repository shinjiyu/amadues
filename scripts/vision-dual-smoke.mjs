#!/usr/bin/env node
/**
 * 识图双路 smoke：LocalModule vision + 智谱 Vision MCP
 * 用法：node scripts/vision-dual-smoke.mjs
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function loadEnvFile(relPath) {
  const p = join(repoRoot, relPath);
  if (!existsSync(p)) return false;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
  return true;
}

function normalizeLocalBaseUrl(raw) {
  const trimmed = raw.replace(/\/$/, '');
  return /\/v\d+$/i.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

async function chatCompletion({ baseUrl, apiKey, model, messages, maxTokens = 256 }) {
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.3 }),
  });
  const raw = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = raw?.error?.message ?? res.statusText;
    throw new Error(`HTTP ${res.status}: ${msg}`);
  }
  const content = raw?.choices?.[0]?.message?.content;
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((p) => p?.text ?? '').join('')
        : '';
  if (!text.trim()) throw new Error('empty assistant content');
  return text.trim();
}

async function testLocalModuleVision() {
  console.log('\n=== [1] LocalModule vision (bot2.env) ===');
  if (!loadEnvFile('deploy/agent/env/bot2.env')) {
    console.error('skip: deploy/agent/env/bot2.env missing');
    return { ok: false, skipped: true };
  }
  const apiKey = process.env.LOCALMODULE_API_KEY?.trim();
  const baseUrl = normalizeLocalBaseUrl(
    process.env.LOCALMODULE_BASE_URL?.trim() ?? 'https://ai.pocketcity.com',
  );
  const model = process.env.LOCALMODULE_VISION_MODEL?.trim() ?? 'MiMo-V2.5';
  if (!apiKey) {
    console.error('skip: LOCALMODULE_API_KEY empty');
    return { ok: false, skipped: true };
  }
  console.log('baseUrl:', baseUrl);
  console.log('visionModel:', model);
  const dataUrl = `data:image/png;base64,${TINY_PNG_B64}`;
  const t0 = Date.now();
  try {
    const text = await chatCompletion({
      baseUrl,
      apiKey,
      model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '图中是什么颜色？用一句话中文回答。' },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
    });
    console.log(`[PASS] ${Date.now() - t0}ms reply:`, JSON.stringify(text.slice(0, 200)));
    return { ok: true, model, ms: Date.now() - t0, preview: text.slice(0, 200) };
  } catch (e) {
    console.error(`[FAIL] ${Date.now() - t0}ms`, e.message);
    return { ok: false, model, error: e.message };
  }
}

async function analyzeImageWithMcp(apiKey, imagePath, prompt) {
  const child = spawn('npx', ['-y', '@z_ai/mcp-server@latest'], {
    env: { ...process.env, Z_AI_API_KEY: apiKey, Z_AI_MODE: 'ZHIPU' },
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
  const initReq = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'vision-dual-smoke', version: '1.0' },
    },
  };
  const callReq = {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'analyze_image', arguments: { image_source: imagePath, prompt } },
  };
  child.stdin.write(JSON.stringify(initReq) + '\n');
  child.stdin.write(JSON.stringify(callReq) + '\n');
  child.stdin.end();

  let text = '';
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const timeout = setTimeout(() => child.kill('SIGTERM'), 90_000);
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed);
        if (msg.error) throw new Error(msg.error.message || 'Vision MCP error');
        if (msg.id === 2 && msg.result?.content) {
          for (const c of msg.result.content) {
            if (c.type === 'text' && c.text) text += c.text;
          }
          break;
        }
      } catch (e) {
        if (e instanceof Error && e.message !== 'Vision MCP error' && !e.message.includes('MCP')) {
          /* ignore non-json lines */
        } else if (e instanceof Error) throw e;
      }
    }
  } finally {
    clearTimeout(timeout);
  }
  if (!text.trim()) throw new Error('Vision MCP returned empty text');
  return text.trim();
}

async function testGlmVisionMcp() {
  console.log('\n=== [2] 智谱 GLM Vision MCP (aoi.env ZHIPU_API_KEY) ===');
  if (!loadEnvFile('deploy/agent/env/aoi.env')) {
    console.error('skip: deploy/agent/env/aoi.env missing');
    return { ok: false, skipped: true };
  }
  const apiKey = process.env.ZHIPU_API_KEY?.trim();
  if (!apiKey) {
    console.error('skip: ZHIPU_API_KEY empty');
    return { ok: false, skipped: true };
  }
  console.log('mcp: @z_ai/mcp-server analyze_image');
  const dir = mkdtempSync(join(tmpdir(), 'vision-smoke-'));
  const imgPath = join(dir, 'probe.png');
  writeFileSync(imgPath, Buffer.from(TINY_PNG_B64, 'base64'));
  const prompt = '描述这张图片的颜色或形状，用一句中文。';
  const t0 = Date.now();
  try {
    const text = await analyzeImageWithMcp(apiKey, imgPath, prompt);
    console.log(`[PASS] ${Date.now() - t0}ms reply:`, JSON.stringify(text.slice(0, 200)));
    return { ok: true, ms: Date.now() - t0, preview: text.slice(0, 200) };
  } catch (e) {
    console.error(`[FAIL] ${Date.now() - t0}ms`, e.message);
    return { ok: false, error: e.message };
  }
}

async function main() {
  const r1 = await testLocalModuleVision();
  const r2 = await testGlmVisionMcp();
  console.log('\n=== Summary ===');
  console.log(
    'LocalModule:',
    r1.skipped ? 'SKIPPED' : r1.ok ? 'PASS' : 'FAIL',
    r1.model ?? '',
    r1.error ?? '',
  );
  console.log('GLM Vision MCP:', r2.skipped ? 'SKIPPED' : r2.ok ? 'PASS' : 'FAIL', r2.error ?? '');
  const anyFail = (!r1.skipped && !r1.ok) || (!r2.skipped && !r2.ok);
  process.exit(anyFail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
