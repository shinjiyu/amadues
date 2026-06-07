/**
 * baseNode 级 browser 工具作用域（workDir + nodeInstId）。
 *
 * ADL：doc/structurizr/BROWSER-SESSION-TOOL.md §3
 */

let _workDir = '';
let _nodeInstId = '';

export function setBrowserSessionScope(workDir: string, nodeInstId: string): void {
  _workDir = workDir;
  _nodeInstId = nodeInstId;
}

export function clearBrowserSessionScope(): void {
  _workDir = '';
  _nodeInstId = '';
}

export function getBrowserSessionWorkDir(): string {
  return _workDir;
}

export function getBrowserSessionNodeInstId(): string {
  return _nodeInstId;
}
