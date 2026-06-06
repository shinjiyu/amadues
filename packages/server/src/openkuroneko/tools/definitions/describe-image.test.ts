import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { InnerLlmEnv, InnerLlmStepInput, InnerLlmStepResult } from '../../../llm/inner-llm-step.js';
import {
  ZHIPU_VISION_MCP_LABEL,
  describeImageFile,
  describeImageTool,
} from './describe-image.js';
import { setWorkDirGuard } from './workdir-guard.js';

describe('describeImageFile', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const d of tmpDirs.splice(0)) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  function writePng(dir: string, name: string, bytes: Buffer): string {
    const file = path.join(dir, name);
    fs.writeFileSync(file, bytes);
    return file;
  }

  const fakeEnv: InnerLlmEnv = {
    provider: 'localmodule',
    apiKey: 'test-key',
    baseUrl: 'https://example.com/v1',
    textModel: 'GLM-5.1-FP8',
    visionModel: 'MiMo-V2.5',
    maxTokensText: 4096,
    maxTokensMultimodal: 8192,
    thinking: 'disabled',
  };

  it('rejects unsupported extension', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'describe-img-'));
    tmpDirs.push(dir);
    const file = path.join(dir, 'notes.txt');
    fs.writeFileSync(file, 'hello', 'utf8');
    const r = await describeImageFile(file, 'notes.txt', { loadEnv: () => fakeEnv });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.output).toContain('Not a supported image');
  });

  it('rejects oversized image', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'describe-img-'));
    tmpDirs.push(dir);
    const file = writePng(dir, 'big.png', Buffer.alloc(100));
    const r = await describeImageFile(file, 'big.png', { loadEnv: () => fakeEnv, maxBytes: 50 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.output).toContain('too large');
  });

  it('uses zhipu vision mcp when ZHIPU_API_KEY is set', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'describe-img-mcp-'));
    tmpDirs.push(dir);
    const file = writePng(dir, 'shot.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]));

    const r = await describeImageFile(file, 'shot.png', {
      resolveZhipuKey: () => 'sk-test-zhipu',
      mcpDescribe: async (_key, imagePath, userPrompt) => {
        expect(imagePath).toBe(file);
        expect(userPrompt).toContain('客观描述');
        return '页面显示粉色矩形色块。';
      },
    });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.visionModel).toBe(ZHIPU_VISION_MCP_LABEL);
      expect(r.output).toContain('[describe_image: zhipu-vision-mcp');
      expect(r.output).toContain('粉色矩形');
    }
  });

  it('returns vision summary with model header via llm fallback', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'describe-img-'));
    tmpDirs.push(dir);
    const file = writePng(dir, 'shot.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]));

    const r = await describeImageFile(file, '.run/shot.png', {
      resolveZhipuKey: () => null,
      loadEnv: () => fakeEnv,
      describe: async (_env, input: InnerLlmStepInput): Promise<InnerLlmStepResult> => {
        expect(input.imageBase64).toBeTruthy();
        expect(input.imageMime).toBe('image/png');
        return { assistantText: '页面显示登录表单与验证码。', usedVision: true };
      },
    });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.visionModel).toBe('MiMo-V2.5');
      expect(r.output).toContain('[describe_image: MiMo-V2.5');
      expect(r.output).toContain('登录表单');
    }
  });

  it('tool call rejects path outside workdir', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'describe-img-tool-'));
    tmpDirs.push(dir);
    const temp = path.join(dir, '.run', 'pi-mono');
    fs.mkdirSync(temp, { recursive: true });
    setWorkDirGuard(dir, temp, []);

    const r = await describeImageTool.call({ path: '../../../etc/passwd.png' });
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/outside|not allowed|Path/i);
  });

  it('reports missing LLM env when not configured', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'describe-img-tool-'));
    tmpDirs.push(dir);
    const file = writePng(dir, 'cap.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const r = await describeImageFile(file, 'cap.png', {
      resolveZhipuKey: () => null,
      loadEnv: () => null,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.output).toContain('ZHIPU_API_KEY');
  });
});
