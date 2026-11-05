import * as vscode from 'vscode';
import { Gender, SelectionPreferences } from './assets/repository';
import { MikuSettings } from './core/miku';
import { UserEventType } from './core/types';

export interface AmiiConfig {
  apiUrl: string;
  assetSource: string;
  displayMode: 'beside' | 'panel';
  displayDurationMs: number;
  volume: number;
  infoOnClick: boolean;
  showMood: boolean;
  customAssetsPath: string;
  idleTimeoutMs: number;
  silenceTimeoutMs: number;
  allowedExitCodes: ReadonlySet<number>;
  positiveExitCodes: ReadonlySet<number>;
  reactToTerminalCommands: boolean;
  terminalCommandAllowList: readonly string[];
  logSearchTerms: readonly string[];
  logSearchIgnoreCase: boolean;
  miku: MikuSettings;
  selection: SelectionPreferences;
}

const MINUTE = 60_000;

export function readConfig(): AmiiConfig {
  const c = vscode.workspace.getConfiguration('amii');
  const get = <T>(key: string, fallback: T): T => c.get<T>(key, fallback);
  return {
    apiUrl: get('apiUrl', 'https://amii.api.unthrottled.io/public/'),
    assetSource: get('assetSource', 'https://amii.assets.unthrottled.io'),
    displayMode: get('displayMode', 'beside'),
    displayDurationMs: get('memeDisplayDurationSeconds', 40) * 1000,
    volume: Math.max(0, Math.min(100, get('volume', 65))) / 100,
    infoOnClick: get('infoOnClick', true),
    showMood: get('showMood', true),
    customAssetsPath: expandHome(get('customAssetsPath', '')),
    idleTimeoutMs: get('idleTimeoutMinutes', 5) * MINUTE,
    silenceTimeoutMs: get('silenceTimeoutMinutes', 20) * MINUTE,
    allowedExitCodes: new Set(get<number[]>('allowedExitCodes', [130])),
    positiveExitCodes: new Set([0, ...get<number[]>('positiveExitCodes', [])]),
    reactToTerminalCommands: get('reactToTerminalCommands', true),
    terminalCommandAllowList: get<string[]>('terminalCommandAllowList', []),
    logSearchTerms: get<string[]>('logSearchTerms', []).filter((t) => t.trim().length > 0),
    logSearchIgnoreCase: get('logSearchIgnoreCase', true),
    miku: {
      allowFrustration: get('allowFrustration', true),
      eventsBeforeFrustration: get('eventsBeforeFrustration', 5),
      probabilityOfFrustration: get('probabilityOfFrustration', 75),
      minimalMode: get('minimalMode', false),
      soundEnabled: get('soundEnabled', true),
      discreetMode: get('discreetMode', false),
      enabledEvents: new Set(get<string[]>('enabledEvents', []) as UserEventType[]),
    },
    selection: {
      allowLewds: get('allowLewds', false),
      onlyCustomAssets: get('onlyCustomAssets', false),
      preferredCharacters: get<string[]>('preferredCharacters', []),
      blacklistedCharacters: get<string[]>('blacklistedCharacters', []),
      preferredGenders: get<Gender[]>('preferredGenders', ['female', 'male', 'other']),
    },
  };
}

function expandHome(p: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  return p.startsWith('~') && home ? home + p.slice(1) : p;
}

export async function toggleSetting(key: string): Promise<boolean> {
  const c = vscode.workspace.getConfiguration('amii');
  const next = !c.get<boolean>(key, false);
  await c.update(key, next, vscode.ConfigurationTarget.Global);
  return next;
}
