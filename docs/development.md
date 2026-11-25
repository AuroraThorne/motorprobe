# 开发指南

## 环境与目录

仓库根目录是包含 `package.json` 的目录。开发使用 Node.js 24 和 npm；插件用户无需另装 Node.js 或 Python。真实 CAN 接口仍需安装相应设备驱动。

| 目录 | 内容 |
| --- | --- |
| `src/extension/` | VS Code 扩展入口、Webview 与 Sidecar 通信 |
| `src/sidecar/` | CAN 总线、协议驱动、控制、辨识与演示台 |
| `src/webview/` | React 界面与曲线 |
| `src/shared/` | 共用消息类型、寄存器与翻译 |
| `test/` | 协议、控制、演示和 IPC 回归测试 |
| `docs/protocol-reference/` | 厂家资料和协议整理稿，纳入版本管理 |
| `scripts/` | 图标生成与平台打包脚本 |
| `.github/workflows/` | Windows/Linux 自动检查 |
| `dist/` | 构建输出，不提交 |
| `artifacts/` | 本地 VSIX 安装包，不提交 |
| `node_modules/` | npm 依赖，不提交 |

## 构建与调试

```sh
npm ci
npm run check
npm test
npm run build
```

`npm test` 会先构建后端，保证全新克隆后 IPC 测试有可运行的 Sidecar。测试主要使用 DemoBus；PCAN FFI 测试仅在系统存在 DLL 时读取通道枚举，不发送电机控制帧。

在 VS Code 打开仓库根目录，按 F5 启动扩展开发窗口。在新窗口执行命令 `MotorProbe: 连接演示台并打开工作台`，可以不接硬件验证界面与控制流程。修改代码后重新构建并重新启动扩展开发窗口。

## 打包与安装

```sh
npm run package:win32-x64
npm run package:linux-x64
```

打包自动构建，并将对应平台的安装包写入 `artifacts/`，例如 `artifacts/motorprobe-win32-x64-0.1.3.vsix`。Windows x64 安装包同时复制到仓库根目录，按用户要求纳入版本管理，方便下载后直接安装。脚本使用临时平台排除规则，不改写仓库中的 `.vscodeignore`。安装包只包含运行需要的构建输出、资源和依赖；开发文档及厂家资料保留在仓库中。

在 VS Code 执行“扩展：从 VSIX 安装”，选择对应平台的文件，安装后按提示重新加载窗口。源码或本地 VSIX 更新不会自动更新已经安装的插件，需要重新打包并安装。

## 标识与资料

包名为 `motorprobe`，发布者为 `Aurora`，扩展标识为 `Aurora.motorprobe`。仓库地址为 <https://github.com/AuroraThorne/motorprobe>。

厂家资料保留原文件名，版权归原权利人。资料收录不表示协议已接入；以 [协议资料索引](protocol-reference/README.md)、当前驱动与测试覆盖范围为准。
