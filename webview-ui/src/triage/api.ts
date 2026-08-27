import type { TriageToExt } from "./protocol";

interface VsCodeApi {
  postMessage(msg: TriageToExt): void;
  getState<T>(): T | undefined;
  setState<T>(state: T): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

export const vscode = acquireVsCodeApi();

export function post(msg: TriageToExt): void {
  vscode.postMessage(msg);
}
