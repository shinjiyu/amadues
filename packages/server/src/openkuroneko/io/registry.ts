import type { InputEndpoint, IORegistry, OutputEndpoint } from './index.js';

export function createIORegistry(): IORegistry {
  const inputs = new Map<string, InputEndpoint>();
  const outputs = new Map<string, OutputEndpoint>();

  return {
    registerInput(ep) { inputs.set(ep.id, ep); },
    registerOutput(ep) { outputs.set(ep.id, ep); },
    getInput(id) { return inputs.get(id); },
    getOutput(id) { return outputs.get(id); },
    listInputs() { return [...inputs.keys()]; },
    listOutputs() { return [...outputs.keys()]; },
  };
}
