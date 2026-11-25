import * as fs from 'fs';
import * as vscode from 'vscode';
import {
  HostToWebviewMessage,
  ModelFit,
  PidSuggestion,
  WebviewToHostMessage,
  WorkbenchMode,
} from '../shared/protocol';
import { SidecarClient } from './sidecarClient';
import { buildWebviewHtml } from './webviewHtml';

function formatRmppPidCpp(s: PidSuggestion, m: ModelFit | null): string {
  const r = s.startRatio;
  const f = (v: number) => Number(v.toPrecision(5));
  const header = m
    ? `// MotorProbe 辨识模型: ${m.text}`
    : `// MotorProbe 自动整定参数 (${(r * 100).toFixed(0)}% 起步比例)`;
  return [
    header,
    `// 速度内环 PI (-3dB 带宽 ${s.velBw.toFixed(1)} Hz, 相位裕度 ${s.velPhaseMargin.toFixed(1)} deg)`,
    `const RMPP::Pid::Config kVelPidConfig{`,
    `    .kp = ${f(s.velKp * r)}f,`,
    `    .ki = ${f(s.velKi * r)}f,`,
    `    .kd = 0.0f,`,
    `    .max_i = 10.0f,`,
    `    .max_out = 20.0f,`,
    `};`,
    ``,
    `// 串级位置外环 PID (带宽 ${s.posBw.toFixed(1)} Hz, 相位裕度 ${s.posPhaseMargin.toFixed(1)} deg)`,
    `const RMPP::Pid::Config kPosOuterPidConfig{`,
    `    .kp = ${f(s.posKp * r)}f,`,
    `    .ki = ${f(s.posKi * r)}f,`,
    `    .kd = ${f(s.posKd * r)}f,`,
    `    .max_i = 2.0f,`,
    `    .max_out = 40.0f,`,
    `};`,
    ``,
  ].join('\n');
}

export function activate(context: vscode.ExtensionContext): void {
  const sidecar = new SidecarClient(context.extensionPath);
  const webviews = new Set<vscode.Webview>();
  let workbenchPanel: vscode.WebviewPanel | null = null;

  const resolveLang = (): 'zh' | 'en' => {
    const cfg = vscode.workspace.getConfiguration('motorprobe').get<string>('language', 'auto');
    if (cfg === 'zh' || cfg === 'en') return cfg;
    const saved = context.globalState.get<string>('motorprobe.lang');
    if (saved === 'zh' || saved === 'en') return saved;
    return vscode.env.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
  };

  let currentLang: 'zh' | 'en' = resolveLang();

  const broadcast = (msg: HostToWebviewMessage): void => {
    for (const wv of webviews) {
      wv.postMessage(msg).then(undefined, () => {});
    }
  };

  // StatusBar: Telemetry + Persistent Red E-Stop button
  const statusInfo = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusInfo.command = 'motorprobe.openWorkbench';
  statusInfo.text = '$(circuit-board) MotorProbe: 未连接';
  statusInfo.tooltip = '点击打开 MotorProbe 波形与测试工作台';
  statusInfo.show();

  const statusEstop = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 101);
  statusEstop.command = 'motorprobe.estop';
  statusEstop.text = '$(stop-circle) 急停 (零扭矩)';
  statusEstop.tooltip = '立即发送零扭矩/零电流急停，不触发失能猛刹 (Alt+Esc / Ctrl+Shift+Space)';
  statusEstop.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  statusEstop.color = new vscode.ThemeColor('statusBarItem.errorForeground');

  const syncUiFromState = (): void => {
    const st = sidecar.state;
    const connected = Boolean(st?.connected);
    const active = Boolean(st?.active);
    vscode.commands.executeCommand('setContext', 'motorprobe.connected', connected);
    vscode.commands.executeCommand('setContext', 'motorprobe.active', active);

    if (!st || !st.connected) {
      statusInfo.text = '$(circuit-board) MotorProbe: 未连接';
      statusEstop.hide();
      return;
    }

    const motorLabel = st.driver ? `${st.driver.model}#${st.driver.motorId}` : '未选电机';
    const rateLabel = st.sending ? ` · ${st.txRate.toFixed(0)}Hz` : '';
    const stateTag = st.tripped
      ? ' [⛔零扭矩锁存]'
      : st.active
        ? ' [●输出中]'
        : '';
    statusInfo.text = `$(pulse) ${st.busName} | ${motorLabel}${rateLabel}${stateTag}`;
    if (st.driver) {
      statusEstop.show();
    } else {
      statusEstop.hide();
    }
  };

  const openOrFocusWorkbench = (mode?: WorkbenchMode, applySuggestion?: PidSuggestion): void => {
    if (workbenchPanel) {
      workbenchPanel.reveal(workbenchPanel.viewColumn ?? vscode.ViewColumn.One);
      if (mode) {
        workbenchPanel.webview.postMessage({
          type: 'switchWorkbenchMode',
          mode,
          applySuggestion,
        } satisfies HostToWebviewMessage);
      }
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'motorprobe.workbench',
      currentLang === 'zh' ? 'MotorProbe 波形工作台' : 'MotorProbe Workbench',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview')],
      },
    );
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'activity-icon.svg');
    workbenchPanel = panel;
    attachWebview(panel.webview, 'workbench', 'MotorProbe Workbench', () => {
      if (mode) {
        panel.webview.postMessage({
          type: 'switchWorkbenchMode',
          mode,
          applySuggestion,
        } satisfies HostToWebviewMessage);
      }
    });

    panel.onDidDispose(() => {
      webviews.delete(panel.webview);
      if (workbenchPanel === panel) workbenchPanel = null;
    });
  };

  const handleWebviewMessage = async (
    wv: vscode.Webview,
    msg: WebviewToHostMessage,
    onReadyExtra?: () => void,
  ): Promise<void> => {
    switch (msg.type) {
      case 'ready':
        wv.postMessage({
          type: 'hydrate',
          snapshot: sidecar.snapshot(currentLang),
        } satisfies HostToWebviewMessage);
        onReadyExtra?.();
        break;
      case 'engine':
        sidecar.send(msg.cmd);
        break;
      case 'openWorkbench':
        openOrFocusWorkbench(msg.mode, msg.applySuggestion);
        break;
      case 'openBusMonitor':
        await vscode.commands.executeCommand('motorprobe.frameMonitor.focus');
        break;
      case 'setLang':
        currentLang = msg.lang;
        await context.globalState.update('motorprobe.lang', currentLang);
        if (workbenchPanel) {
          workbenchPanel.title = currentLang === 'zh' ? 'MotorProbe 波形工作台' : 'MotorProbe Workbench';
        }
        broadcast({ type: 'lang', lang: currentLang });
        break;
      case 'saveFile': {
        const uri = await vscode.window.showSaveDialog({
          defaultUri: vscode.workspace.workspaceFolders?.[0]
            ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, msg.defaultName)
            : undefined,
          filters: { [msg.filterName]: msg.extensions },
        });
        if (uri) {
          await fs.promises.writeFile(uri.fsPath, msg.content, 'utf8');
          vscode.window.showInformationMessage(`已导出文件：${uri.fsPath}`);
        }
        break;
      }
      case 'pickImportJson': {
        const uris = await vscode.window.showOpenDialog({
          canSelectMany: false,
          filters: { JSON: ['json'] },
        });
        if (uris && uris[0]) {
          try {
            const raw = await fs.promises.readFile(uris[0].fsPath, 'utf8');
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') {
              wv.postMessage({ type: 'importedRegs', regs: parsed } satisfies HostToWebviewMessage);
            }
          } catch (e) {
            vscode.window.showErrorMessage(`导入 JSON 失败: ${(e as Error).message}`);
          }
        }
        break;
      }
      case 'pidCodeAction': {
        const code = formatRmppPidCpp(msg.suggestion, msg.model);
        if (msg.action === 'insert' && vscode.window.activeTextEditor) {
          const editor = vscode.window.activeTextEditor;
          await editor.edit((eb) => eb.insert(editor.selection.active, code));
          vscode.window.showInformationMessage('已向当前编辑器插入 RMPP::Pid::Config 参数代码');
        } else {
          await vscode.env.clipboard.writeText(code);
          vscode.window.showInformationMessage('已复制 RMPP::Pid::Config C++ 代码到剪贴板');
        }
        break;
      }
      case 'copyText':
        await vscode.env.clipboard.writeText(msg.text);
        break;
    }
  };

  const attachWebview = (
    webview: vscode.Webview,
    entry: 'sidebar' | 'workbench' | 'busPanel',
    title: string,
    onReadyExtra?: () => void,
  ): void => {
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview')],
    };
    webview.html = buildWebviewHtml(webview, context.extensionUri, entry, title);
    webviews.add(webview);
    sidecar.start();
    webview.onDidReceiveMessage((m: WebviewToHostMessage) => {
      void handleWebviewMessage(webview, m, onReadyExtra);
    });
  };

  const sidebarProvider: vscode.WebviewViewProvider = {
    resolveWebviewView(webviewView: vscode.WebviewView): void {
      attachWebview(webviewView.webview, 'sidebar', 'MotorProbe Sidebar');
      webviewView.onDidDispose(() => webviews.delete(webviewView.webview));
    },
  };

  const busMonitorProvider: vscode.WebviewViewProvider = {
    resolveWebviewView(webviewView: vscode.WebviewView): void {
      attachWebview(webviewView.webview, 'busPanel', 'CAN Frame Monitor');
      webviewView.onDidDispose(() => webviews.delete(webviewView.webview));
    },
  };

  const unsubSidecar = sidecar.onEvent((ev) => {
    if (ev.type === 'state') {
      syncUiFromState();
    }
    broadcast({ type: 'engineEvent', event: ev });
  });

  context.subscriptions.push(
    statusInfo,
    statusEstop,
    { dispose: unsubSidecar },
    sidecar,
    vscode.window.registerWebviewViewProvider('motorprobe.mainView', sidebarProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider('motorprobe.frameMonitor', busMonitorProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('motorprobe.openWorkbench', () => openOrFocusWorkbench()),
    vscode.commands.registerCommand('motorprobe.openDemoWorkbench', () => {
      sidecar.start();
      sidecar.send({
        type: 'connect',
        params: {
          kind: 'sim',
          channel: 0,
          channelName: '演示台（虚拟电机，无需硬件）',
          baudKey: '1M',
          baud: 0x0014,
          bitrate: 1_000_000,
        },
      });
      openOrFocusWorkbench('scope');
    }),
    vscode.commands.registerCommand('motorprobe.estop', () => {
      sidecar.send({ type: 'estop', reason: '快捷键/状态栏急停' });
    }),
    vscode.commands.registerCommand('motorprobe.resetSafety', () => {
      sidecar.send({ type: 'resetSafety' });
    }),
    vscode.commands.registerCommand('motorprobe.showBusMonitor', () => {
      void vscode.commands.executeCommand('motorprobe.frameMonitor.focus');
    }),
    vscode.commands.registerCommand('motorprobe.clearBusLog', () => {
      broadcast({ type: 'clearBusLog' });
    }),
    vscode.commands.registerCommand('motorprobe.insertPidConfig', async () => {
      const sugg = sidecar.lastAnalysis?.suggestion;
      if (!sugg) {
        vscode.window.showWarningMessage('尚无频响辨识整定结果，请先在「频响辨识」页面完成测试');
        return;
      }
      const code = formatRmppPidCpp(sugg, sidecar.lastAnalysis?.model ?? null);
      if (vscode.window.activeTextEditor) {
        const ed = vscode.window.activeTextEditor;
        await ed.edit((eb) => eb.insert(ed.selection.active, code));
      } else {
        await vscode.env.clipboard.writeText(code);
        vscode.window.showInformationMessage('未打开文本编辑器，已将 RMPP::Pid::Config 复制到剪贴板');
      }
    }),
  );
}

export function deactivate(): void {
  // SidecarClient in context.subscriptions automatically disconnects & sends zero-torque frames
}
