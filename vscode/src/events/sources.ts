import * as vscode from 'vscode';
import { AmiiConfig } from '../config';
import { categorizeExitCode, findLogTerm, isAllowedCommand, terminalEventType } from '../core/classify';
import { UserEvent, UserEventCategory, UserEventType } from '../core/types';

type Emit = (event: UserEvent) => void;

/** Tasks (tasks.json, npm scripts, build tasks) -> TASK / TEST events. */
export function watchTasks(config: () => AmiiConfig, emit: Emit): vscode.Disposable {
  return vscode.tasks.onDidEndTaskProcess((e) => {
    const category = categorizeExitCode(e.exitCode, config());
    if (!category) return;
    const task = e.execution.task;
    const isTest = task.group?.id === vscode.TaskGroup.Test.id || /\btest/i.test(task.name);
    emit({ type: isTest ? UserEventType.Test : UserEventType.Task, category, name: task.name });
  });
}

/**
 * Integrated terminal commands -> PROCESS / TEST events, plus LOGS when the output contains
 * a configured search term. Needs VS Code shell integration (on by default for bash/zsh/fish/pwsh).
 */
export function watchTerminal(config: () => AmiiConfig, emit: Emit): vscode.Disposable {
  const start = vscode.window.onDidStartTerminalShellExecution(async (e) => {
    const cfg = config();
    if (cfg.logSearchTerms.length === 0 || !cfg.miku.enabledEvents.has(UserEventType.Logs)) return;
    try {
      for await (const chunk of e.execution.read()) {
        const term = findLogTerm(chunk, cfg.logSearchTerms, cfg.logSearchIgnoreCase);
        if (term) {
          emit({ type: UserEventType.Logs, category: UserEventCategory.Negative, name: `Saw "${term}"` });
          return;
        }
      }
    } catch {
      // Stream closed with the terminal; nothing to do.
    }
  });

  const end = vscode.window.onDidEndTerminalShellExecution((e) => {
    const cfg = config();
    if (!cfg.reactToTerminalCommands) return;
    const commandLine = e.execution.commandLine.value.trim();
    if (!commandLine || !isAllowedCommand(commandLine, cfg.terminalCommandAllowList)) return;
    const category = categorizeExitCode(e.exitCode, cfg);
    if (!category) return;
    const name = commandLine.length > 40 ? `${commandLine.slice(0, 39)}…` : commandLine;
    emit({ type: terminalEventType(commandLine), category, name });
  });

  return vscode.Disposable.from(start, end);
}

/** Emits IDLE every `idleTimeout` without editor activity; reports activity so idle memes can go away. */
export class IdleWatcher implements vscode.Disposable {
  private timer?: NodeJS.Timeout;
  private readonly subscriptions: vscode.Disposable[];

  constructor(
    private readonly config: () => AmiiConfig,
    private readonly emit: Emit,
    private readonly onActivity: () => void,
  ) {
    const activity = () => this.activity();
    this.subscriptions = [
      // Output channels are documents too; only count real edits.
      vscode.workspace.onDidChangeTextDocument(
        (e) => e.contentChanges.length > 0 && e.document.uri.scheme !== 'output' && activity(),
      ),
      vscode.window.onDidChangeTextEditorSelection(activity),
      vscode.window.onDidChangeActiveTextEditor(activity),
      vscode.window.onDidChangeActiveTerminal(activity),
      vscode.window.onDidChangeWindowState((s) => s.focused && activity()),
    ];
    this.arm();
  }

  private activity(): void {
    this.onActivity();
    this.arm();
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.emit({ type: UserEventType.Idle, category: UserEventCategory.Neutral, name: 'Idle' });
      this.arm();
    }, this.config().idleTimeoutMs);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.subscriptions.forEach((s) => s.dispose());
  }
}
