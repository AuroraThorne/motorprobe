# MotorProbe for VS Code

面向达妙/HM、大疆 RoboMaster 和高擎 GD 电机的 VS Code CAN 调试、系统辨识与闭环测试插件。MotorProbe 是 CanMotorKit Windows 上位机功能向 VS Code 的移植版本。

## 安装与开始使用

从本地构建生成的 `artifacts/motorprobe-win32-x64-0.1.0.vsix` 安装：在 VS Code 命令面板执行“扩展：从 VSIX 安装”，选择文件并按提示重新加载窗口。Linux 使用对应平台安装包。

打开左侧 MotorProbe，选择总线和通道后点击“连接”。也可以执行命令 `MotorProbe: 连接演示台并打开工作台`，无需硬件体验。插件标识为 `Aurora.motorprobe`；安装包或源码更新后，需要重新安装才能更新已安装的插件。

可选的软件安全限制默认关闭，请根据电机和测试条件设置。急停会发送零电流/零扭矩并锁存，解除锁存后才能恢复输出；失能由用户单独触发。

## 电机支持

- 达妙 DM / HM：MIT 与 `0x7FF` 配置协议，运行前从电机读取位置、速度和扭矩量程。
- RoboMaster：M3508/C620、M2006/C610、GM6020 电流控制，以及 RM 6623 原始电流控制。
- 高擎 GD 经典 CAN：29 位扩展帧，扭矩与 MIT 控制；支持扫描和演示台。厂家资料没有提供可核验的电流刻度，因此不开放 GD 电流模式。
- 内置演示台覆盖上述协议，用于不接硬件的功能验证。

## 特性

- **开箱即用一键安装**：基于 VS Code 内置 Node 独立 Sidecar 子进程与 `koffi` 预编译 N-API 接口，无需安装 Python 或任何编译工具链。
- **多硬件总线与虚拟演示台**：
  - **Windows PEAK PCAN**：动态加载系统 `PCANBasic.dll`，自动枚举物理通道与占用状态；
  - **Canable2 SLCAN**：按 USB `VID=0x16D0, PID=0x117E` 自动发现动态串口；
  - **Linux SocketCAN**：原生绑定 `AF_CAN` 接口（如 `can0`）；
  - **内置虚拟电机演示台（`DemoBus`）**：无需硬件即可体验 8 台带静摩擦/惯量物理模型的虚拟电机。
- **周期收发与安全锁存**：发送频率最高可设为 1 kHz，实际时序取决于主机与总线；支持多圈位置解缠绕，以及可配置的速度、位置、温度和反馈超时限制。可选限制默认关闭；急停锁存零输出，需用户确认解除。
- **EmberProbe 风格三区工程界面**：
  - **左侧边栏**：总线连接、红色常驻急停主卡、总线扫描、电机 `.chip-hero` 卡片、实时查看与滑条步进写卡；
  - **编辑区波形工作台**：`uPlot` 20 万点 4 通道同步示波、支持**停靠 ↔ 图表上方自由拖拽缩放悬浮窗**的参数数值面板、底部双滑块全局时间轴、频响辨识波特图、上位机串级 PID 闭环与 46 项寄存器表；
  - **底部面板 CAN 报文监控**：对标嵌入式 RTT 终端，提供虚拟滚动/ID 聚合报文流、总线负载率估算、往返延迟直方图与原始帧周期发送器。
- **电控代码深度联动**：频响辨识完成后支持一键复制或向当前活动编辑器插入对齐 `RMPP::Pid::Config` 的 C++ 参数代码。

电机厂家资料和协议整理文档位于 [`docs/protocol-reference/`](docs/protocol-reference/)，适配范围与待验证事项见 [`GD classic CAN notes`](docs/protocol-reference/高擎GD适配说明.md)。仿照的 VS Code 扩展工程结构参考 EmberProbe；电机协议、驱动和安全策略以本项目资料为准。

## 开发

使用 Node.js 24，在仓库根目录执行：

```sh
npm ci
npm run check
npm test
npm run build
```

按 F5 启动扩展开发窗口。执行 `npm run package:win32-x64` 或 `npm run package:linux-x64` 打包，结果保存在 `artifacts/`。

目录职责、调试和打包说明见 [开发指南](docs/development.md)，提交约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。厂家资料纳入版本管理，依赖、构建结果、安装包、测量数据和日志不提交。

项目采用 [MIT 许可证](LICENSE)；厂家资料版权归原权利人。问题与建议请提交到 [GitHub Issues](https://github.com/AuroraThorne/motorprobe/issues)。
