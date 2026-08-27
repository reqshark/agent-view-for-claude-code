import * as vscode from "vscode";
import * as fs from "fs";
import { randomBytes } from "crypto";
import { TriageEngine } from "./engine";
import { ExtToTriage, TriageToExt } from "./types";

export interface TriageViewDeps {
  /** Reveal a waiting session in the Detail panel below. */
  focusAgent(sessionId: string): void;
  /** Flip mas.triage.autoAnswer.dryRun from the panel's toggle. */
  setDryRun(on: boolean): Promise<void>;
}

/**
 * Host side of the Triage view — the middle third of the Agent View sidebar,
 * between the Agents tree and the Detail panel. It is a thin projection: the
 * engine owns every decision, this only streams state down and forwards the
 * human's actions back up.
 */
export class TriageViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "mas.triage";
  private view?: vscode.WebviewView;
  private postTimer?: NodeJS.Timeout;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly engine: TriageEngine,
    private readonly deps: TriageViewDeps,
  ) {
    engine.onDidChange(() => this.schedulePost());
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "webview-ui", "dist")],
    };
    view.webview.html = this.html(view.webview);

    view.webview.onDidReceiveMessage((msg: TriageToExt) => {
      switch (msg.type) {
        case "ready":
        case "refresh":
          this.postState();
          break;
        case "answer":
          this.engine.answer(msg.clusterId, msg.answer, msg.scope, msg.expiry);
          break;
        case "dismiss":
          this.engine.dismiss(msg.clusterId);
          break;
        case "split":
          this.engine.split(msg.clusterId, msg.questionId);
          break;
        case "openSession":
          this.deps.focusAgent(msg.sessionId);
          break;
        case "revokeDecision":
          this.engine.revokeDecision(msg.decisionId, msg.reason);
          break;
        case "confirmDecision":
          this.engine.confirmDecision(msg.decisionId);
          break;
        case "editDecision":
          this.engine.editDecision(msg.decisionId, msg.answer);
          break;
        case "reviewAuto":
          this.engine.markAutoReviewed(msg.clusterId);
          break;
        case "undoAuto":
          this.engine.undoAuto(msg.clusterId);
          break;
        case "setDryRun":
          void this.deps.setDryRun(msg.on).then(() => this.postState());
          break;
      }
    });

    view.onDidDispose(() => {
      if (this.postTimer) {
        clearTimeout(this.postTimer);
        this.postTimer = undefined;
      }
      this.view = undefined;
    });
  }

  /** Bring the Triage view forward (used by the command + notifications). */
  focus(): void {
    void vscode.commands.executeCommand(`${TriageViewProvider.viewId}.focus`);
  }

  /** The engine can tick several times per store refresh; coalesce the posts. */
  private schedulePost(): void {
    if (this.postTimer) return;
    this.postTimer = setTimeout(() => {
      this.postTimer = undefined;
      this.postState();
    }, 150);
  }

  private postState(): void {
    this.post({ type: "state", state: this.engine.buildState() });
  }

  private post(msg: ExtToTriage): void {
    void this.view?.webview.postMessage(msg);
  }

  private html(webview: vscode.Webview): string {
    const distUri = vscode.Uri.joinPath(this.extensionUri, "webview-ui", "dist");
    const indexPath = vscode.Uri.joinPath(distUri, "triage.html").fsPath;

    let html: string;
    try {
      html = fs.readFileSync(indexPath, "utf8");
    } catch {
      return this.placeholder();
    }

    const base = webview.asWebviewUri(distUri).toString();
    const nonce = randomBytes(16).toString("base64");

    html = html.replace(/(href|src)="(\.?\/)?(assets\/[^"]+)"/g, (_m, attr, _p, p) => {
      return `${attr}="${base}/${p}"`;
    });
    html = html.replace(/<script /g, `<script nonce="${nonce}" `);

    // cspSource alongside the nonce: Vite code-splits a shared vendor chunk the
    // entry imports as an ES module, which a nonce alone cannot authorise.
    const csp =
      `default-src 'none'; ` +
      `style-src ${webview.cspSource} 'unsafe-inline'; ` +
      `script-src 'nonce-${nonce}' ${webview.cspSource}; ` +
      `img-src ${webview.cspSource} https: data:; ` +
      `font-src ${webview.cspSource};`;
    const meta = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
    return html.replace(/<head>/, `<head>\n  ${meta}`);
  }

  private placeholder(): string {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 1rem; }
      code { background: var(--vscode-textCodeBlock-background); padding: 0 4px; border-radius: 3px; }
      </style></head><body>
      <h3>Triage</h3>
      <p>The webview UI has not been built yet.</p>
      <p>Run <code>npm run build:webview</code> (or <code>npm run build</code>) and reload the window.</p>
      </body></html>`;
  }
}
