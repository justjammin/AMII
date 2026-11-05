import * as vscode from 'vscode';
import { MediaResolver } from './assets/store';
import { Visual, VisualRepository } from './assets/repository';
import { AmiiConfig } from './config';
import { Comparison, Reaction, shouldReplace } from './core/personality';
import { Mood, UserEvent, UserEventCategory, UserEventType } from './core/types';
import { MemeView } from './ui/memeView';

const INVULNERABLE_MS = 3_000;
const HISTORY = 10;

interface Displayed {
  reaction: Reaction;
  visual: Visual;
  shownAt: number;
}

/** Port of MemeEventService: decides whether a reaction gets on screen and for how long. */
export class MemeService implements vscode.Disposable {
  private displayed?: Displayed;
  private history: Visual[] = [];
  private timer?: NodeJS.Timeout;
  private silenceTimer?: NodeJS.Timeout;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(
    private config: () => AmiiConfig,
    private readonly repo: VisualRepository,
    private readonly store: MediaResolver,
    private readonly view: MemeView,
    private readonly emit: (event: UserEvent) => void,
    private readonly log: (msg: string) => void,
  ) {
    this.subscriptions.push(
      view.onDidClick(() => this.showInfo()),
      view.onDidClose(() => this.afterDismiss(this.displayed)),
    );
    this.armSilence();
  }

  async react(reaction: Reaction): Promise<void> {
    if (!shouldReplace(this.displayed?.reaction, reaction)) return;
    const visual = this.repo.pick(reaction.categories, this.config().selection);
    if (!visual) {
      this.log(`No meme available for ${reaction.event.type} (${reaction.mood}). Try "AMII: Synchronize Assets".`);
      return;
    }
    await this.display(reaction, visual);
  }

  async showPrevious(): Promise<void> {
    const visual = this.history[1] ?? this.history[0];
    if (!visual) return;
    const reaction: Reaction = {
      event: { type: UserEventType.OnDemand, category: UserEventCategory.Neutral, name: 'Previous meme' },
      mood: this.displayed?.reaction.mood ?? Mood.Calm,
      categories: [],
      dismissal: 'timed',
      sound: this.config().miku.soundEnabled,
      notifyReturnOnDismiss: false,
      comparator: () => Comparison.Greater,
    };
    await this.display(reaction, visual, false);
  }

  /**
   * Called on keystrokes/selection changes. Idle memes go away when the user comes back,
   * after a short invulnerability window so the meme is not dismissed by the very keystroke that
   * was in flight.
   */
  onUserActivity(): void {
    const d = this.displayed;
    if (d?.reaction.dismissal === 'focusLoss' && Date.now() - d.shownAt > INVULNERABLE_MS) {
      this.clear();
      this.afterDismiss(d);
    }
  }

  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.displayed = undefined;
    this.view.clear();
  }

  private async display(reaction: Reaction, visual: Visual, record = true): Promise<void> {
    const cfg = this.config();
    const imageFile =
      visual.source.kind === 'custom' ? visual.source.file : await this.store.resolveMedia('visuals', visual.source.path);
    if (!imageFile) return;

    const audioPath = reaction.sound ? this.repo.audioPath(visual.audioId) : undefined;
    const audioFile = audioPath ? await this.store.resolveMedia('audible', audioPath) : undefined;

    // Something better may have arrived while downloading.
    if (this.displayed && this.displayed.reaction !== reaction && !shouldReplace(this.displayed.reaction, reaction)) return;

    if (this.timer) clearTimeout(this.timer);
    this.displayed = { reaction, visual, shownAt: Date.now() };
    if (record) this.history = [visual, ...this.history.filter((v) => v.id !== visual.id)].slice(0, HISTORY);

    await this.view.show(
      { imageFile, audioFile, alt: visual.alt, volume: cfg.volume, caption: `${reaction.event.name} · ${reaction.mood}` },
      cfg.displayMode,
    );

    if (reaction.dismissal === 'timed') {
      this.timer = setTimeout(() => {
        if (this.displayed?.reaction === reaction) this.clear();
      }, cfg.displayDurationMs);
    }
    this.armSilence();
  }

  private afterDismiss(d: Displayed | undefined): void {
    this.displayed = undefined;
    if (d?.reaction.notifyReturnOnDismiss) {
      this.emit({ type: UserEventType.Return, category: UserEventCategory.Neutral, name: 'Welcome back' });
    }
  }

  private showInfo(): void {
    const d = this.displayed;
    if (!d || !this.config().infoOnClick) return;
    const who = d.visual.characters.map((c) => `${c.name} (${c.anime})`).join(', ');
    void vscode.window.showInformationMessage(who ? `${d.visual.alt} — ${who}` : d.visual.alt);
  }

  /** SILENCE: after a long stretch without memes, show a quiet one. */
  private armSilence(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => {
      this.emit({ type: UserEventType.Silence, category: UserEventCategory.Neutral, name: 'Silence' });
      this.armSilence();
    }, this.config().silenceTimeoutMs);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.subscriptions.forEach((s) => s.dispose());
  }
}
