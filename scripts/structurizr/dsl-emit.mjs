/**
 * Emit Structurizr DSL from structured model.
 */
import { EXTERNAL_SYSTEMS, L2_CONTAINERS, L3_COMPONENTS, L3_RELATIONSHIPS, SOFTWARE_SYSTEM } from './manifest.mjs';

function qid(containerId, componentId) {
  return `kuroneko.${containerId}.${componentId}`;
}

export function buildModel(options) {
  const { granularity, importEdges, repoRoot } = options;
  const lines = [];
  const push = (s = '') => lines.push(s);

  push(`// GENERATED — granularity=${granularity.key} — ${new Date().toISOString()}`);
  push(`// ${granularity.label}`);
  push(`// Do not edit by hand; run: npm run structurizr:generate -- --granularity ${granularity.key}`);
  push('');
  push('workspace "Kuroneko (generated)" "Auto-generated from code manifest + package.json" {');
  push('');
  push('    !identifiers hierarchical');
  push('');
  push('    model {');
  push('        user = person "User" "Generated"');
  push('');

  for (const ext of EXTERNAL_SYSTEMS) {
    push(`        ${ext.id} = softwareSystem "${ext.name}" "${ext.description}" {`);
    push('            tags "External"');
    push('        }');
  }
  push('');

  push(`        ${SOFTWARE_SYSTEM.id} = softwareSystem "${SOFTWARE_SYSTEM.name}" "${SOFTWARE_SYSTEM.description}" {`);

  if (granularity.l2) {
    for (const c of L2_CONTAINERS) {
      const tags = c.kind === 'library' ? 'Library' : '';
      push(`            ${c.id} = container "${c.name}" "path: ${c.path}" "${c.technology}" {`);
      if (tags) push(`                tags "${tags}"`);
      push('                properties {');
      push(`                    "path" "${c.path}"`);
      push(`                    "generated.package" "${c.packageName ?? ''}"`);
      push('                }');

      const l3 = [];
      if (granularity.l3Outer && c.id === 'agentServer') l3.push(...L3_COMPONENTS.agentServer);
      if (granularity.l3Inner && c.id === 'innerWorker') l3.push(...L3_COMPONENTS.innerWorker);

      for (const comp of l3) {
        const exists = options.pathExists?.(comp.path) ?? true;
        if (!exists) continue;
        push(`                ${comp.id} = component "${comp.name}" "generated from ${comp.path}" "TypeScript" {`);
        push('                    properties {');
        push(`                        "path" "${comp.path}"`);
        push('                    }');
        push('                }');
      }
      push('            }');
      push('');
    }
  }

  push('        }');
  push('');

  // L1
  push('        user -> kuroneko "uses" ""');
  for (const ext of EXTERNAL_SYSTEMS) {
    push(`        kuroneko -> ${ext.id} "integration" "HTTPS" {`);
    push('            tags "http"');
    push('        }');
  }
  push('');

  if (importEdges?.length) {
    push('        // import edges from package.json');
    for (const e of importEdges) {
      push(`        kuroneko.${e.from} -> kuroneko.${e.to} "${e.reason}" "npm import" {`);
      push('            tags "import"');
      push('        }');
    }
    push('');
  }

  if (granularity.l3InternalEdges) {
    push('        // L3 internal (manifest)');
    for (const [parent, src, dst, tag] of L3_RELATIONSHIPS) {
      push(`        ${qid(parent, src)} -> ${qid(parent, dst)} "internal" "" {`);
      push(`            tags "${tag}"`);
      push('        }');
    }
    push('');
  }

  if (granularity.l3Outer || granularity.l3Inner) {
    push(`        kuroneko.agentServer.innerSpawner -> kuroneko.innerWorker.workerHost "spawn" "" {`);
    push('            tags "spawn"');
    push('        }');
  }

  push('    }');
  push('');
  push('    views {');
  push('        systemContext kuroneko "gen-L1" {');
  push('            include *');
  push('            autolayout lr');
  push('        }');
  if (granularity.l2) {
    push('        container kuroneko "gen-L2" {');
    push('            include *');
    push('            autolayout tb');
    push('        }');
  }
  push('    }');
  push('');
  push('    configuration {');
  push('        scope softwaresystem');
  push('    }');
  push('}');
  push('');

  return lines.join('\n');
}
