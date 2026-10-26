/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Cópia de github.com/AlessandroLobo/claude-usage-statusbar (MIT, versão 0.10.0); a fonte do código fica lá.

'use strict';

const vscode = require('vscode');
const core = require('./core');
const direct = require('./direct');

const CONSENT_ASKED = 'claudeUsageBar.directConsentAsked';
const METER_ID = 'shivakrishnakokkula.claude-usage-meter';

class PanelProvider {
  constructor() {
    this.view = null;
    this.html = '';
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: false, enableCommandUris: true };
    view.webview.html = this.html;
    view.onDidDispose(() => {
      if (this.view === view) this.view = null;
    });
  }

  set(html) {
    if (html === this.html) return;
    this.html = html;
    if (this.view) this.view.webview.html = html;
  }
}

const toColor = value => {
  const c = core.normalizeColor(value);
  if (!c) return undefined;
  return c.startsWith('#') ? c : new vscode.ThemeColor(c);
};

// Se a extensão avulsa estiver instalada (Open VSX/Marketplace), ela assume e esta cópia não registra nada.
const STANDALONE_ID = 'alessandrolobo.claude-usage-statusbar-metric';
const ENABLED_CONTEXT = 'agentecode.usage.enabled';

function registerUsage(context) {
  if (vscode.extensions.getExtension(STANDALONE_ID)) {
    vscode.commands.executeCommand('setContext', ENABLED_CONTEXT, false);
    return;
  }
  vscode.commands.executeCommand('setContext', ENABLED_CONTEXT, true);
  // Itens separados (prioridade maior = mais à esquerda): só assim cada trecho pode ter cor própria.
  // A faixa de prioridade é alta e exclusiva para que itens de outras extensões não se encaixem no meio.
  const make = (name, priority) => {
    const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, priority);
    item.name = name;
    item.command = 'claudeUsageBar.openPanel';
    return item;
  };
  const items = {
    main: make('Claude Usage', 10003),
    five: make('Claude Usage 5h', 10002),
    week: make('Claude Usage 7d', 10001),
    tail: make('Claude Usage custo', 10000),
  };
  const tracker = new core.Tracker();
  const panel = new PanelProvider();
  let hidden = false;
  let timer;
  let lastNudge = 0;
  let polling = false;

  const options = () => {
    const c = vscode.workspace.getConfiguration('claudeUsageBar');
    return {
      contextWindow: c.get('contextWindow', 0),
      showCost: c.get('showCost', true),
      showTurn: c.get('showTurn', true),
      showSessionTime: c.get('showSessionTime', true),
      showLimits: c.get('showLimits', true),
      showStatusBar: c.get('showStatusBar', true),
      refreshSeconds: Math.max(1, c.get('refreshSeconds', 5)),
      limitsSnapshotPath: c.get('limitsSnapshotPath', ''),
      limitsStaleMinutes: Math.max(1, c.get('limitsStaleMinutes', 30)),
      refreshLimits: c.get('refreshLimits', true),
      fetchLimitsDirectly: c.get('fetchLimitsDirectly', false),
      // Extensões desativadas não aparecem em getExtension.
      meterActive: Boolean(vscode.extensions.getExtension(METER_ID)),
      directRefreshMinutes: Math.max(3, c.get('directRefreshMinutes', 5)),
      activeRefreshSeconds: Math.max(30, c.get('activeRefreshSeconds', 60)),
      colorFive: c.get('colorSession5h', 'charts.green'),
      colorWeek: c.get('colorWeekly7d', 'charts.green'),
      colorGradient: c.get('colorGradient', true),
      colorGradientStart: c.get('colorGradientStart', 50),
      colorGradientAmber: c.get('colorGradientAmber', 75),
      colorGradientRed: c.get('colorGradientRed', 90),
    };
  };

  const enableDirect = () =>
    vscode.workspace.getConfiguration('claudeUsageBar').update('fetchLimitsDirectly', true, vscode.ConfigurationTarget.Global);

  // Pergunta uma única vez; sem o "Ativar", a extensão não lê o token nem usa a rede.
  const askConsent = async () => {
    const opts = options();
    if (opts.fetchLimitsDirectly || opts.meterActive || context.globalState.get(CONSENT_ASKED)) return;
    await context.globalState.update(CONSENT_ASKED, true);
    const choice = await vscode.window.showInformationMessage(
      'Claude Usage: mostrar os limites de 5h e 7d da sua assinatura? Para isso a extensão lê o token do Claude Code neste computador e consulta a API de uso da Anthropic (a cada minuto enquanto você usa o Claude). Nada é enviado a outro lugar.',
      'Ativar',
      'Agora não',
    );
    if (choice === 'Ativar') await enableDirect();
  };

  const pollIfDue = (opts, wantFresh) => {
    if (polling) return;
    polling = true;
    direct
      .poll({ baseMs: opts.directRefreshMinutes * 60_000, minGapMs: opts.activeRefreshSeconds * 1000, wantFresh })
      .then(
        fetched => fetched && update(),
        () => {},
      )
      .finally(() => {
        polling = false;
      });
  };

  const hideAll = () => Object.values(items).forEach(i => i.hide());

  const update = () => {
    try {
      const opts = options();
      const now = Date.now();
      const paths = (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath);
      const session = core.findSession(paths);
      const snap = session ? tracker.update(session.file, now) : null;

      const meterLimits = core.readLimits(now, { snapshotPath: opts.limitsSnapshotPath, staleMinutes: opts.limitsStaleMinutes });
      let directLimits = null;
      if (opts.fetchLimitsDirectly) {
        const shared = direct.readShared(now, opts.limitsStaleMinutes);
        directLimits = shared.limits;
        // Uso do Claude depois da última leitura: os limites mudaram, vale consultar antes do intervalo.
        const activity = snap && snap.lastActivityAt;
        pollIfDue(opts, Boolean(activity && (!directLimits || activity > directLimits.receivedAt)));
        opts.directError = shared.lastError;
      }
      const limits = core.pickLimits(meterLimits, directLimits);

      if (!opts.fetchLimitsDirectly && opts.meterActive && opts.refreshLimits && core.shouldNudge(limits, now, lastNudge)) {
        lastNudge = now;
        // A meter é quem consulta a API e controla o limite de requisições; aqui só pedimos que releia.
        Promise.resolve(vscode.commands.executeCommand('claudeUsageMeter.refresh')).then(update, () => {});
      }

      panel.set(core.renderPanel(snap, now, opts, limits));

      if (hidden || !opts.showStatusBar) {
        hideAll();
        return;
      }
      const view = core.render(snap, now, opts, limits);
      const tooltip = new vscode.MarkdownString(view.tooltip);
      const warning = new vscode.ThemeColor('statusBarItem.warningBackground');
      const colors = { five: toColor(opts.colorFive), week: toColor(opts.colorWeek) };
      const red = new vscode.ThemeColor('charts.red');
      const alertColors = { main: new vscode.ThemeColor('charts.orange'), five: red, week: red, tail: undefined };

      const text = { main: view.segments.main, five: view.segments.five, week: view.segments.week, tail: view.segments.tail };
      if (!Object.values(text).some(Boolean)) text.main = view.text;

      for (const [key, item] of Object.entries(items)) {
        if (!text[key]) {
          item.hide();
          continue;
        }
        item.text = text[key];
        item.tooltip = tooltip;
        // Com degradê a cor vem do uso; sem ele, em alerta o texto assume a cor de severidade do tema
        // (o fundo de alerta de alguns temas é igual ao da barra).
        item.color = view.colors ? toColor(view.colors[key]) : view.warn[key] ? alertColors[key] : colors[key];
        item.backgroundColor = view.warn[key] ? warning : undefined;
        item.show();
      }
    } catch (e) {
      items.main.text = '$(warning) Claude';
      items.main.tooltip = `claude-usage-statusbar: ${e && e.message ? e.message : e}`;
      items.main.show();
    }
  };

  const schedule = () => {
    clearInterval(timer);
    timer = setInterval(update, options().refreshSeconds * 1000);
  };

  context.subscriptions.push(
    ...Object.values(items),
    { dispose: () => clearInterval(timer) },
    vscode.window.registerWebviewViewProvider('claudeUsageBar.panel', panel),
    vscode.commands.registerCommand('claudeUsageBar.refresh', update),
    vscode.commands.registerCommand('claudeUsageBar.enableDirect', enableDirect),
    // Painel visível: um novo clique fecha a barra lateral; senão, abre e foca o painel.
    vscode.commands.registerCommand('claudeUsageBar.openPanel', () =>
      panel.view && panel.view.visible
        ? vscode.commands.executeCommand('workbench.action.closeSidebar')
        : vscode.commands.executeCommand('claudeUsageBar.panel.focus'),
    ),
    vscode.commands.registerCommand('claudeUsageBar.toggle', () => {
      hidden = !hidden;
      update();
    }),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('claudeUsageBar')) {
        schedule();
        update();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(update),
    // Ao voltar para a janela os números precisam estar certos, mesmo depois de o computador hibernar.
    vscode.window.onDidChangeWindowState(state => state.focused && update()),
  );

  schedule();
  update();
  askConsent().catch(() => {});
}

module.exports = { registerUsage };
