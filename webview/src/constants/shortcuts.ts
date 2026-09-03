/**
 * Keyboard shortcuts, declared once.
 *
 * Listed here so they are discoverable and so a new binding can be checked
 * against VS Code's own — a webview that shadows an editor shortcut is worse
 * than one with no shortcuts at all.
 */
export interface Shortcut {
  readonly key: string;
  readonly mod?: boolean;
  readonly shift?: boolean;
  readonly description: string;
}

export const SHORTCUTS = {
  focusComposer: { key: 'k', mod: true, description: 'Focus the message box' },
  stopRun: { key: 'escape', description: 'Stop the running agent' }
} as const satisfies Record<string, Shortcut>;
