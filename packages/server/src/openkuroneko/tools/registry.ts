import type { Tool, ToolRegistry } from './index.js';

export function createToolRegistry(tools: Tool[]): ToolRegistry {
  const map = new Map<string, Tool>(tools.map(t => [t.name, t]));

  return {
    get(name) { return map.get(name); },
    list() { return [...map.values()]; },
    schema() {
      return [...map.values()].map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: {
            type: 'object',
            properties: t.parameters ?? {},
            required: t.required ?? [],
            additionalProperties: !t.parameters,
          },
        },
      }));
    },
  };
}
