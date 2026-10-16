# Codex Remote Tunnel

远程 Codex 连接的隧道、代理桥接与健康检查脚本。

仓库只维护通用源码、配置模板和测试。真实地址、端口、用户名、证书路径、项目路径与登录信息由各机器的 SSH 配置或环境变量提供，不应写入源码、提交说明、标签或测试数据。

## 目录

| 目录 | 内容 |
| --- | --- |
| `local/` | 本机隧道、保活、健康检查及测试 |
| `remote/` | Codex wrapper、功能探针、任务检查及测试 |
| `remote/http-bridge/` | HTTP 到 SOCKS 桥接及依赖锁文件 |
| `launchd/` | 使用占位符的 LaunchAgent 模板 |
| `config/` | 不含实际部署值的配置示例 |
| `tools/` | 配置渲染与隐私检查 |

## 配置

参照 `config/ssh-tunnel.conf.example` 在仓库外配置两个 SSH 别名：一个用于普通控制命令，一个仅用于反向隧道。主机、用户和 SSH 端口只写进个人 SSH 配置。

可配置环境变量见 `config/environment.env.example`。回环代理的示例默认端口为 SOCKS `1080` 与 HTTP `8080`；自定义时，SSH 转发、桥接、wrapper 和检查器必须使用一致的值。远端变量须在远端设置，SSH 不会自动传递本机变量。

生成本机 LaunchAgent 文件：

```sh
python3 tools/render-launchd.py
```

输出在被 Git 忽略的 `generated/launchd/`。该命令不安装或启动服务。

## 验证

使用 macOS、Bash、Python 3、Node.js 24 和 npm：

```sh
make deps
make test
make privacy
```

测试使用模拟客户端、临时目录和本机随机回环端口，不连接实际服务器、不调用真实模型、不重启服务。隐私检查针对待提交内容，不能替代人工审查。

修改源码、提交版本和部署是三个独立步骤。部署前应在仓库外备份目标文件，并确认没有运行中的任务。详细约定见 [维护说明](docs/maintenance.md)。
