/**
 * 内脑 Controller 黑盒夹具（FakeLLM，无子进程）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createController, type Controller } from '../openkuroneko/controller/index.js';
import {
  createIORegistry,
  createFileInputEndpoint,
  createFileOutputEndpoint,
} from '../openkuroneko/io/index.js';
import { createMemoryLayer2 } from '../openkuroneko/memory/index.js';
import { createMem0Client } from '../openkuroneko/mem0/index.js';
import { createLogger } from '../openkuroneko/logger/index.js';
import { createToolRegistry } from '../openkuroneko/tools/index.js';
import * as toolsDefs from '../openkuroneko/tools/definitions/index.js';
import { BrainFS } from '../openkuroneko/brain/brain-fs.js';
import type { FakeLLM } from './fake-llm.js';

export interface ControllerHarness {
  workDir: string;
  tempDir: string;
  brain: BrainFS;
  controller: Controller;
  outputPath: string;
  cleanup: () => void;
}

export function createControllerHarness(opts: {
  goal: string;
  llm: FakeLLM;
  agentId?: string;
}): ControllerHarness {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuroneko-ctrl-'));
  const tempDir = path.join(workDir, '.run', 'pi-mono');
  fs.mkdirSync(tempDir, { recursive: true });

  toolsDefs.setWorkDirGuard(workDir, tempDir, []);
  toolsDefs.setCapabilityGapTempDir(tempDir);
  toolsDefs.setDeliverablesTempDir(tempDir);
  toolsDefs.setAsyncWaitBrainDir(toolsDefs.brainDirFromWorkDir(workDir));

  const inputPath = path.join(tempDir, 'input');
  const outputPath = path.join(tempDir, 'output');
  fs.writeFileSync(inputPath, '', 'utf8');
  fs.writeFileSync(outputPath, '', 'utf8');

  const ioRegistry = createIORegistry();
  ioRegistry.registerInput(createFileInputEndpoint('default', inputPath));
  ioRegistry.registerOutput(createFileOutputEndpoint('default', outputPath));

  const brain = new BrainFS(workDir);
  brain.writeGoal(opts.goal);

  const controller = createController(
    { agentId: opts.agentId ?? 'test-agent', workDir, tempDir },
    {
      llm: opts.llm,
      ioRegistry,
      executorToolRegistry: createToolRegistry([]),
      attributorToolRegistry: createToolRegistry([
        toolsDefs.writeConstraintTool,
        toolsDefs.writeSkillTool,
        toolsDefs.writeKnowledgeTool,
      ]),
      memory: createMemoryLayer2(tempDir),
      mem0: createMem0Client(),
      logger: createLogger(opts.agentId ?? 'test-agent', tempDir),
    },
  );

  return {
    workDir,
    tempDir,
    brain,
    controller,
    outputPath,
    cleanup: () => {
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

/** 标准单里程碑 burst 脚本：DECOMPOSE → EXECUTE → ATTRIBUTE(SUCCESS_AND_NEXT) */
export function burstScriptMilestones(): import('./fake-llm.js').FakeLLMScript[] {
  return [
    {
      label: 'decomposer',
      match: '战术拆解器',
      reply: {
        content: [
          '[M1] [Active] 写摘要 — 产出 summary.md',
          '> 输入范围：公开资料',
          '> 交付物：summary.md',
        ].join('\n'),
      },
    },
    {
      label: 'executor',
      match: '反应执行器',
      reply: { content: '已完成本里程碑执行，产出 summary.md。' },
    },
    {
      label: 'attributor',
      match: '强制归因器',
      reply: { content: 'CONTROL: SUCCESS_AND_NEXT\nREASON: M1 交付完成' },
    },
  ];
}
