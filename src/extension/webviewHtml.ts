import * as crypto from 'crypto';
import * as vscode from 'vscode';

export function buildWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  entryName: 'sidebar' | 'workbench' | 'busPanel',
  title: string,
): string {
  const nonce = crypto.randomBytes(16).toString('base64');
  const distWebview = vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
  const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(distWebview, 'webview.css'));
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(distWebview, `${entryName}.js`));
  const cspSource = webview.cspSource;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data: blob:; style-src ${cspSource} 'unsafe-inline'; font-src ${cspSource}; script-src 'nonce-${nonce}' ${cspSource};" />
  <title>${title}</title>
  <link rel="stylesheet" href="${cssUri}" />
</head>
<body data-surface="${entryName}">
  <div id="root"></div>
  <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
