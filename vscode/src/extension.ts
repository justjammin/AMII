import * as vscode from 'vscode';
import { VisualRepository } from './assets/repository';
import { AssetStore } from './assets/store';
import { AmiiConfig, readConfig, toggleSetting } from './config';
import { Miku } from './core/miku';
import { Mood, UserEvent, UserEventCategory, UserEventType } from './core/types';
import { IdleWatcher, watchTasks, watchTerminal } from './events/sources';
import { MemeService } from './memeService';
import { MemeView } from './ui/memeView';

const MOOD_ICON: Partial<Record<Mood, string>> = {
  [Mood.Enraged]: '$(flame)',
  [Mood.Frustrated]: '$(error)',
  [Mood.Agitated]: '$(warning)',
  [Mood.Happy]: '$(smiley)',
  [Mood.Relieved]: '$(pass)',
  [Mood.Excited]: '$(star-full)',
  [Mood.Smug]: '$(sparkle)',
  [Mood.Shocked]: '$(alert)',
  [Mood.Disappointed]: '$(thumbsdown)',
  [Mood.MildlyDisappointed]: '$(circle-slash)',
  [Mood.Bored]: '$(watch)',
  [Mood.Tired]: '$(eye-closed)',
  [Mood.Patient]: '$(clock)',
  [Mood.Attentive]: '$(eye)',
};

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('AMII', { log: true });
  const log = (m: string) => output.info(m);
  let config: AmiiConfig = readConfig();
  const getConfig = () => config;

  const storageDir = context.globalStorageUri.fsPath;
  const makeStore = () =>
    new AssetStore({ apiUrl: config.apiUrl, assetSource: config.assetSource, storageDir, log });
  let store = makeStore();
  const repo = new VisualRepository();

  const roots = () => [
    context.globalStorageUri,
    vscode.Uri.joinPath(context.extensionUri, 'media'),
    ...(config.customAssetsPath ? [vscode.Uri.file(config.customAssetsPath)] : []),
  ];
  const view = new MemeView(roots, vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.svg'));

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'amii.showMeme';
  const renderStatus = (mood: Mood) => {
    status.text = `${MOOD_ICON[mood] ?? '$(heart)'} ${mood}`;
    status.tooltip = config.miku.discreetMode ? 'MIKU (discreet mode) — click for a meme' : 'MIKU — click for a meme';
    config.showMood ? status.show() : status.hide();
  };

  // MemeService and Miku reference each other through `emit`.
  let miku: Miku | undefined;
  const emit = (event: UserEvent) => miku?.dispatch(event);
  const memes = new MemeService(
    getConfig,
    repo,
    // `store` is swapped when the API URL changes.
    { resolveMedia: (c, p) => store.resolveMedia(c, p), resolveUrl: (u) => store.resolveUrl(u) },
    view,
    emit,
    log,
  );
  miku = new Miku(config.miku, {
    react: (reaction) => void memes.react(reaction),
    onMood: (mood) => {
      renderStatus(mood);
      view.setMood(mood);
    },
  });
  renderStatus(miku.mood);

  const sync = async (force: boolean) => {
    const defs = await store.loadAll(force);
    repo.index(defs);
    repo.indexGiphy(config.giphyEnabled ? await store.loadGiphy(force) : []);
    const custom = await repo.scanCustom(config.customAssetsPath || undefined);
    log(`Indexed ${repo.size} memes (${defs.visuals.length} AMII, ${custom} custom).`);
    return repo.size;
  };

  context.subscriptions.push(
    output,
    status,
    view,
    memes,
    { dispose: () => miku?.dispose() },
    vscode.window.registerWebviewViewProvider(MemeView.viewId, view),
    watchTasks(getConfig, emit),
    watchTerminal(getConfig, emit),
    new IdleWatcher(getConfig, emit, () => memes.onUserActivity()),

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('amii')) return;
      const previous = config;
      config = readConfig();
      miku?.updateSettings(config.miku);
      renderStatus(miku!.mood);
      if (config.miku.discreetMode) memes.clear();
      if (
        previous.apiUrl !== config.apiUrl ||
        previous.assetSource !== config.assetSource ||
        previous.giphyEnabled !== config.giphyEnabled
      ) {
        store = makeStore();
        void sync(true);
      } else if (previous.customAssetsPath !== config.customAssetsPath) {
        void repo.scanCustom(config.customAssetsPath || undefined);
      }
    }),

    vscode.commands.registerCommand('amii.showMeme', () =>
      emit({ type: UserEventType.OnDemand, category: UserEventCategory.Neutral, name: 'On demand' }),
    ),
    vscode.commands.registerCommand('amii.relax', () => miku?.relax()),
    vscode.commands.registerCommand('amii.clear', () => memes.clear()),
    vscode.commands.registerCommand('amii.previousMeme', () => memes.showPrevious()),
    vscode.commands.registerCommand('amii.toggleDiscreetMode', async () => {
      const on = await toggleSetting('discreetMode');
      void vscode.window.showInformationMessage(`AMII discreet mode ${on ? 'on' : 'off'}.`);
    }),
    vscode.commands.registerCommand('amii.toggleMinimalMode', async () => {
      const on = await toggleSetting('minimalMode');
      void vscode.window.showInformationMessage(`AMII minimal mode ${on ? 'on' : 'off'}.`);
    }),
    vscode.commands.registerCommand('amii.syncAssets', () =>
      vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'AMII: synchronizing assets…' },
        async () => {
          const count = await sync(true);
          void vscode.window.showInformationMessage(`AMII: ${count} memes ready.`);
        },
      ),
    ),
    vscode.commands.registerCommand('amii.rescanCustomAssets', async () => {
      const count = await repo.scanCustom(config.customAssetsPath || undefined);
      void vscode.window.showInformationMessage(`AMII: found ${count} custom memes.`);
    }),
    vscode.commands.registerCommand('amii.choosePreferredCharacters', async () => {
      const preferred = new Set(config.selection.preferredCharacters);
      const picks = await vscode.window.showQuickPick(
        repo.allCharacters.map((c) => ({
          label: c.name,
          description: c.anime,
          id: c.id,
          picked: preferred.has(c.id) || preferred.has(c.name),
        })),
        { canPickMany: true, matchOnDescription: true, placeHolder: 'Who should show up more often?' },
      );
      if (!picks) return;
      await vscode.workspace
        .getConfiguration('amii')
        .update('preferredCharacters', picks.map((p) => p.label), vscode.ConfigurationTarget.Global);
    }),
    vscode.commands.registerCommand('amii.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', '@ext:justjammin.amii-vscode'),
    ),
    vscode.commands.registerCommand('amii.testReaction', async () => {
      const pick = await vscode.window.showQuickPick(
        [
          { label: 'Test passed', type: UserEventType.Test, category: UserEventCategory.Positive },
          { label: 'Test failed', type: UserEventType.Test, category: UserEventCategory.Negative },
          { label: 'Task failed', type: UserEventType.Task, category: UserEventCategory.Negative },
          { label: 'Idle', type: UserEventType.Idle, category: UserEventCategory.Neutral },
          { label: 'Startup', type: UserEventType.Startup, category: UserEventCategory.Neutral },
        ],
        { placeHolder: 'Pretend this happened' },
      );
      if (pick) emit({ type: pick.type, category: pick.category, name: pick.label });
    }),
  );

  // Load whatever is cached right away, refresh in the background, then greet.
  void sync(false).then(() =>
    emit({ type: UserEventType.Startup, category: UserEventCategory.Neutral, name: 'Welcome' }),
  );
}

export function deactivate(): void {}
