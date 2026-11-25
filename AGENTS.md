# MotorProbe 协作约定

## 项目范围

- MotorProbe 是 CanMotorKit Windows 电机调试上位机的 VS Code 插件实现，目录结构与 Webview 工作台参考 EmberProbe。
- 桌面版 `reference/` 的厂家原始资料和协议整理稿副本保存在 `docs/protocol-reference/`；支持能力以当前驱动和测试为准。
- 当前支持 DM/HM、RoboMaster M3508、M2006、GM6020、RM 6623，以及高擎 GD 经典 CAN。GD FDCAN 与 VESC 尚未接入。

## 安全与协议

- 急停和安全超限必须发送零电流/零扭矩并锁存；用户明确解除前，不能恢复非零目标，也不自动失能。
- 失能帧只能由用户明确触发失能操作发送。断连和插件关闭只发送零输出，不发达妙/HM 失能帧。
- 不猜测资料缺失的单位、量程、错误码或报文子命令。GD 电流刻度没有可核验资料，因此不实现 GD 电流控制。
- GD 经典 CAN 使用 29 位扩展数据帧；解析时同时校验扩展帧标志、CAN ID 和数据结构。错误码 0 表示正常，不能复用 DM/HM 状态码。
- 软件演示和测试不等于实机验证。未经用户明确要求，不连接、扫描或驱动真实 CAN 硬件。

## 开发与验证

- 新增驱动或控制行为时，同时补充 DemoBus 覆盖和协议/安全回归测试。
- 面向用户的项目名统一为 MotorProbe，VS Code Marketplace `publisher` 使用 Aurora；仓库远端地址对应真实 GitHub 仓库，只有用户明确迁移仓库时才更新。
- 完成后运行 `npm run check`、`npm test` 和 `npm run build`；不提交缓存、CSV、日志和常规构建产物。用户要求根目录的 `motorprobe-win32-x64-0.1.3.vsix` 纳入仓库，方便直接下载安装；修改插件后同步重新打包。
- 仓库根目录是包含 `package.json` 的本层目录；开发流程与目录职责见 `docs/development.md`。
- 所有界面统一通过 `numberWheel` 处理已聚焦数值框的滚轮调节，拦截页面滚动并遵守步长与上下限；数值写卡的滚轮只修改待应用值。
- `artifacts/` 保存本地 VSIX，`dist/` 保存构建输出，`node_modules/` 保存依赖，均由 `.gitignore` 排除；厂家资料保留在 `docs/protocol-reference/` 并纳入版本管理。
- `npm test` 自动先构建 Sidecar，保证全新克隆可直接运行 IPC 测试；`.github/workflows/ci.yml` 在 Windows/Linux 检查类型、测试和构建，不操作电机。
