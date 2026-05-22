#!/usr/bin/env node
/**
 * 智谱 Coding Plan OpenAI 兼容接口连通性自测（独立脚本，不接入 server/dashboard）。
 *
 * 用法（仓库根目录 utlraKuroneko/）：
 *   npm run smoke:zhipu
 *   npm run smoke:zhipu:vision
 *
 * 依赖：Node >= 20；读取 ./.env（与主程序相同变量名）。
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

function loadDotEnv() {
  const p = join(repoRoot, '.env');
  if (!existsSync(p)) return;
  const text = readFileSync(p, 'utf8');
  for (const line of text.split('\n')) {
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
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

function normalizeBaseUrl(url) {
  return url.replace(/\/$/, '');
}

async function chatCompletion({ baseUrl, apiKey, model, messages, maxTokens, thinking }) {
  const url = `${normalizeBaseUrl(baseUrl)}/chat/completions`;
  const body = {
    model,
    messages,
    max_tokens: maxTokens,
    temperature: 0.3,
    thinking: { type: thinking },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
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
        ? content.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('')
        : content != null
          ? String(content)
          : '';
  if (!text.trim()) throw new Error('empty assistant content');
  return { text: text.trim(), raw };
}

async function main() {
  loadDotEnv();

  const wantVision = process.argv.includes('--vision');
  const apiKey = process.env.ZHIPU_API_KEY?.trim();
  if (!apiKey) {
    console.error('缺少 ZHIPU_API_KEY：在仓库根目录创建 .env（参考 .env.example）');
    process.exit(1);
  }

  const baseUrl =
    process.env.ZHIPU_BASE_URL?.trim() ?? 'https://open.bigmodel.cn/api/coding/paas/v4';
  const textModel = process.env.ZHIPU_MODEL?.trim() ?? 'glm-5.1';
  const visionModel = process.env.ZHIPU_VISION_MODEL?.trim() ?? 'glm-5v-turbo';
  const thinking = process.env.ZHIPU_THINKING === 'enabled' ? 'enabled' : 'disabled';

  console.log('baseUrl:', baseUrl);
  console.log('text model:', textModel);

  try {
    const { text } = await chatCompletion({
      baseUrl,
      apiKey,
      model: textModel,
      messages: [{ role: 'user', content: '只回复一个字：好' }],
      maxTokens: 32,
      thinking,
    });
    console.log('[text] ok, reply:', JSON.stringify(text.slice(0, 200)));
  } catch (e) {
    console.error('[text] failed:', e.message);
    process.exit(1);
  }

  if (wantVision) {
    console.log('vision model:', visionModel);
    const tinyPngB64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const dataUrl = `data:image/png;base64,${tinyPngB64}`;
    try {
      const { text } = await chatCompletion({
        baseUrl,
        apiKey,
        model: visionModel,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: '图中是什么颜色或形状？用一句话回答。' },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ],
        maxTokens: 128,
        thinking,
      });
      console.log('[vision] ok, reply:', JSON.stringify(text.slice(0, 300)));
    } catch (e) {
      console.error('[vision] failed:', e.message);
      process.exit(1);
    }
  }

  console.log('done.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
