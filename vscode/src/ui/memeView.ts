import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { Mood } from '../core/types';

export interface MemeFrame {
  imageFile: string;
  audioFile?: string;
  alt: string;
  volume: number;
  caption: string;
}

type Inbound = { type: 'clicked' } | { type: 'dismiss' };

/**
 * Renders memes either in an editor tab opened beside the code (preserving focus)
 * or in the AMII panel view. Both share one HTML template.
 */
export class MemeView implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'amii.memeView';

  private panel?: vscode.WebviewPanel;
  private view?: vscode.WebviewView;
  private current?: MemeFrame;
  private mood: Mood = Mood.Calm;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly clickEmitter = new vscode.EventEmitter<void>();
  private readonly closeEmitter = new vscode.EventEmitter<void>();
  /** User clicked the meme. */
  readonly onDidClick = this.clickEmitter.event;
  /** User closed the meme themselves. */
  readonly onDidClose = this.closeEmitter.event;

  constructor(
    private readonly roots: () => vscode.Uri[],
    private readonly iconPath: vscode.Uri,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.configure(view.webview);
    view.onDidDispose(() => (this.view = undefined), null, this.disposables);
    this.render(view.webview);
  }

  setMood(mood: Mood): void {
    this.mood = mood;
    if (!this.current && this.view) this.render(this.view.webview);
  }

  async show(frame: MemeFrame, mode: 'beside' | 'panel'): Promise<void> {
    this.current = frame;
    if (mode === 'beside') {
      if (!this.panel) {
        this.panel = vscode.window.createWebviewPanel(
          'amii.meme',
          'MIKU',
          { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
          { enableScripts: true, retainContextWhenHidden: false, localResourceRoots: this.roots() },
        );
        this.panel.iconPath = this.iconPath;
        this.configure(this.panel.webview);
        this.panel.onDidDispose(() => {
          const userClosed = this.panel !== undefined;
          this.panel = undefined;
          if (userClosed && this.current) {
            this.current = undefined;
            this.closeEmitter.fire();
          }
        });
      } else {
        this.panel.reveal(undefined, true);
      }
      this.panel.title = frame.caption;
      this.render(this.panel.webview);
      return;
    }

    if (!this.view) {
      await vscode.commands.executeCommand(`${MemeView.viewId}.focus`, { preserveFocus: true });
      await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    } else {
      this.view.show(true);
    }
    if (this.view) this.render(this.view.webview);
  }

  /** Removes the current meme (does not fire onDidClose). */
  clear(): void {
    this.current = undefined;
    const panel = this.panel;
    this.panel = undefined;
    panel?.dispose();
    if (this.view) this.render(this.view.webview);
  }

  private configure(webview: vscode.Webview): void {
    webview.options = { enableScripts: true, localResourceRoots: this.roots() };
    webview.onDidReceiveMessage(
      (msg: Inbound) => {
        if (msg.type === 'clicked') this.clickEmitter.fire();
        if (msg.type === 'dismiss') {
          this.clear();
          this.closeEmitter.fire();
        }
      },
      null,
      this.disposables,
    );
  }

  private render(webview: vscode.Webview): void {
    const nonce = crypto.randomBytes(16).toString('base64');
    const frame = this.current;
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data:`,
      `media-src ${webview.cspSource}`,
      `style-src 'nonce-${nonce}'`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    const body = frame
      ? `<figure>
          <img src="${webview.asWebviewUri(vscode.Uri.file(frame.imageFile))}" alt="${escape(frame.alt)}" title="${escape(frame.alt)}" />
          <figcaption>${escape(frame.caption)}<button id="x" aria-label="Dismiss">✕</button></figcaption>
        </figure>
        ${frame.audioFile ? `<audio id="a" src="${webview.asWebviewUri(vscode.Uri.file(frame.audioFile))}" autoplay></audio>` : ''}`
      : `<p class="idle">MIKU is feeling <strong>${escape(this.mood)}</strong>.</p>`;

    webview.html = `<!doctype html>
<html><head><meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style nonce="${nonce}">
  html, body { height: 100%; margin: 0; }
  body { display: grid; place-items: center; background: var(--vscode-editor-background); color: var(--vscode-foreground); font-family: var(--vscode-font-family); }
  figure { margin: 0; display: flex; flex-direction: column; align-items: center; gap: 6px; max-width: 100%; max-height: 100%; }
  img { max-width: 100%; max-height: calc(100vh - 40px); object-fit: contain; cursor: pointer; border-radius: 6px; }
  figcaption { font-size: 12px; opacity: .75; display: flex; gap: 8px; align-items: center; }
  button { background: none; border: none; color: inherit; cursor: pointer; opacity: .6; }
  button:hover { opacity: 1; }
  .idle { opacity: .6; }
</style></head>
<body>${body}
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const a = document.getElementById('a');
  if (a) { a.volume = ${frame?.volume ?? 0}; a.play().catch(() => {}); }
  document.querySelector('img')?.addEventListener('click', () => vscode.postMessage({ type: 'clicked' }));
  document.getElementById('x')?.addEventListener('click', () => vscode.postMessage({ type: 'dismiss' }));
</script></body></html>`;
  }

  dispose(): void {
    this.clear();
    this.clickEmitter.dispose();
    this.closeEmitter.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}
