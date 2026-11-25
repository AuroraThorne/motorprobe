# 参与开发

先阅读 [AGENTS.md](AGENTS.md) 和 [开发指南](docs/development.md)。

使用 Node.js 24 和 npm，执行 `npm ci` 安装锁定的依赖。提交前运行：

```sh
npm run check
npm test
npm run build
```

修改驱动、控制或安全行为时，补充对应的演示台和回归测试。演示测试通过不代表实机验证通过；实机操作必须单独获得授权，并记录设备、协议和验证范围。

不提交依赖、测量数据、日志、凭据和常规构建产物。根目录的 Windows VSIX 是提供给用户的安装入口，修改插件后应重新打包并同步提交；其他安装包保存在忽略的 `artifacts/`。厂家资料保留来源与原始文件名，整理注应与厂家原文区分。
