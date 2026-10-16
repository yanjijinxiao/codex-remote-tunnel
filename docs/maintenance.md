# 维护说明

## 私有配置

实际部署信息只存在于仓库之外：

- SSH 配置负责主机、登录用户名、SSH 端口和私钥选择。
- 环境变量负责 SSH 别名、回环代理端口、探针工作目录、二进制和 CA 路径。
- LaunchAgent 使用模板，渲染后的带本机路径文件不得提交。
- 登录凭据、环境文件、日志、会话、运行状态和备份不得提交。
- 不在文档、测试、提交消息、标签或 Git 作者信息中记录个人或组织部署信息。

示例主机和用户名是占位值；示例端口仅用于说明，不代表任何机器的真实配置。

## 部署映射

| 仓库内容 | 目标位置 |
| --- | --- |
| `local/` 内的非测试脚本 | 本机 `$HOME/.codex/remote-tunnel/` |
| 渲染后的 LaunchAgent | 本机 `$HOME/Library/LaunchAgents/` |
| `remote/probe-codex-app-server.js`、`remote/task-progress.js` | 远端 `$HOME/.codex/remote-tunnel/` |
| `remote/codex-wrapper` | 远端 `$HOME/.local/bin/codex` |
| `remote/http-bridge/` 内的非测试文件 | 远端 `$HOME/.codex/remote-tunnel/http-bridge/` |

源码中的路径基于运行用户的 HOME，不假设用户名或项目目录。部署时只安装需要的生产文件，不同步整个仓库。

## 修改与验证

1. 在仓库修改源码，保留对活动任务与未知状态的保护。
2. 运行 `make deps`、`make test`。
3. 明确列出需要暂存的文件，执行 `git diff --cached --check` 和 `make privacy`。
4. 审查全部待提交内容和提交作者信息，再提交。
5. 如需部署，单独比较目标版本、在仓库外备份并原子替换。
6. 仅在有授权且最新检查确认空闲时刷新服务；不能用真实业务任务作为连通性探针。

Git 提交、推送和回退不会自动部署。禁止将仓库更新绑定到自动重启或凭据同步。

## 边界

回环端口可用不等于模型请求成功。测试不验证真实网络或账号有效性。保活不能消除上游出口故障，未知任务状态不能作为强制重启的理由。
