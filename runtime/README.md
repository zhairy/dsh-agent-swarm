# 可选 Python / Node 执行镜像

容器执行功能单独启用。Dockerfile 固定官方 Node 24.22.3 基础镜像的 manifest digest 和 Python 3 系统包版本，提供插件 kernel 所需的标准库。不会复制项目、模型、凭据或宿主目录到镜像；没有预装 Notebook、NumPy、Jupyter 或项目依赖。

在已解包的插件目录执行：

```bash
docker build --pull -t dsh-swarm-runtime:3.4.2 runtime/
node scripts/swarm-execution-daemon.mjs --image dsh-swarm-runtime:3.4.2 --capabilities-only
node scripts/render-execution-service.mjs --image dsh-swarm-runtime:3.4.2 > dsh-swarm-execution.service
```

最后一个命令仅生成完整 unit。管理员核对后自行安装到用户 systemd 目录；它不会启停服务、改动权限或读取凭据。需要指定路径时使用 `--root <插件绝对路径>` 和 `--node <node绝对路径>`。

生成 unit 使用绝对路径；移动插件目录或切换版本后需重新生成。模板文件 `.service.in` 不能直接作为 service 安装。启动时没有镜像、Docker 或受支持隔离能力会显式失败，不回退到宿主执行。

默认部署合同为 Linux Docker。镜像不随 GitHub 插件资产上传；用户可从这份 Dockerfile 构建或提供满足 Python/Node 标准库合同的可信镜像。基础镜像来自 docker.io/library/node；基础包的传递依赖由 Debian 仓库提供，实际构建的 image ID 应单独记录，不承诺跨时间构建的每个镜像字节相同。
