import { z } from 'zod';

/** 产出物索引条目（D/K/S/P/T/M） */
export const OutcomeRefSchema = z.object({
  id: z.string(),
  path: z.string(),
  mime: z.string().optional(),
});

export type OutcomeRef = z.infer<typeof OutcomeRefSchema>;

export const RunManifestSchema = z.object({
  schema: z.literal('run-manifest.v1'),
  runId: z.string(),
  workDir: z.string(),
  startedAt: z.string(),
  updatedAt: z.string(),
  outcomes: z.object({
    deliverables: z.array(OutcomeRefSchema).default([]),
    knowledge: z.array(OutcomeRefSchema).default([]),
    skills: z.array(OutcomeRefSchema).default([]),
    policy: z.array(OutcomeRefSchema).default([]),
    telemetry: z.object({ tracePath: z.string().optional() }).default({}),
    messages: z
      .array(z.object({ kind: z.string(), path: z.string().optional() }))
      .default([]),
  }),
  promotions: z.record(z.string()).optional(),
});

export type RunManifest = z.infer<typeof RunManifestSchema>;

export function emptyManifest(runId: string, workDir: string): RunManifest {
  const now = new Date().toISOString();
  return {
    schema: 'run-manifest.v1',
    runId,
    workDir,
    startedAt: now,
    updatedAt: now,
    outcomes: {
      deliverables: [],
      knowledge: [],
      skills: [],
      policy: [],
      telemetry: {},
      messages: [],
    },
  };
}
