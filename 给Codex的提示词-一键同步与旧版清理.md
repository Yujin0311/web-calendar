# 任务：一键把本地网站同步到远端，且服务器只保留一套最新版

仓库 `D:\清序网站\web-calendar`（纯前端 + Node/Express，无构建，改完重启 Node）。改造根目录 `update-server.ps1`（若要新文件就叫 `sync-server.ps1`），保持「一条命令 `.\update-server.ps1` 走完」，并在 `DEPLOY.md` 同步更新用法。

## 环境（已确认，别猜、别改）
Windows 本地打包（用系统自带 tar/ssh/scp，**不新增依赖**、不引入 rsync/WSL）→ `yujin0311@2.56.255.206`（SSH 端口 51822，用户名与路径**全小写**）→ 部署目录 `/home/yujin0311/web-calendar`，systemd 服务 `qingxu`，Node 监听 `127.0.0.1:3000`，前面有反向代理。

现有脚本流程：`tar` 排除 `node_modules/.git/data/data-backup/.env/export_history.json/DEPLOY.md/自身` → `scp` 到 `/tmp` → `ssh` 解包 → `npm install --omit=dev` → `sudo systemctl restart qingxu` → `is-active` + `curl 127.0.0.1:3000` + `journalctl -n 12`。
它**只覆盖不清理**，所以本地删掉/改名的文件会一直残留在服务器上——这就是要修的问题。

## 需求
1. **只保留一套最新版**：每次同步后，远程 `web-calendar/` 的代码内容必须与本地一致——本地删掉的文件、改名的文件、旧页面/旧 css/js 全部消失，不得残留任何旧版本目录或文件。
2. **清理器与传输环节绝对不能碰**：远程 `data/`（SQLite 线上库，唯一一份）、`data-backup/`、`.env`（含密钥，systemd `EnvironmentFile` 指向它，缺了服务起不来）、`node_modules/`（Linux 原生，重下约 50MB）、`~/backup/`。这几类只允许在本地打包时排除，远程一律不清、不覆盖、不删。**注意区分**：`node_modules/` 这层保护不约束 `npm install` 本身，包更新后需要正常增量安装（见需求 5）；脚本里不许出现自动执行的 `rm -rf node_modules`。
3. **一键 + 幂等**：无参数即可跑完；重复执行结果一致。保留 `-Message`；新增 `-DryRun`（只打印将要执行的远程清理/传输动作，不落地）。
4. **安全清理**：远程删除必须限定在 `$RemoteDir` 下并带三重保险（目录存在 + 不等于 `/`/`$HOME` + 名称匹配 `web-calendar`）；排除项用**白名单**判定，不要黑名单硬拼字符串。
5. **失败不毁站**：任一步（打包/上传/解包/清理/install/重启）失败即中止并打印清晰原因；失败后服务仍能启动（`data/`、`.env` 完好）且可直接重跑修复。代码就位后执行 `npm install --omit=dev`（增量、幂等，**不要用会清空重装的 `npm ci`**）；若本地 `package-lock.json` 哈希与远程上次记录的一致就跳过 install，该哈希文件要放在 `$RemoteDir` 之外（如 `~/.qingxu-deploy/`），否则会被清理器删掉。`install` 失败要中止且不重启服务，让旧进程继续跑。若不违背需求 1，优先做「先上传校验、后切换」。
6. **结束态**：`systemctl is-active qingxu` = active；`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000` = 200/302；`journalctl` 无 ERROR。顺手清掉 `/tmp` 里的包和遗留的 `web-calendar.old-*`、`web-calendar.failed-*` 目录（**只删名字匹配这两个模式的目录**，不删任何含 `data` 的备份），并打印远程目录 `ls -la` 供核对。
7. 远程执行的命令保持纯 ASCII（中文经 ssh 会乱码），中文提示只写在本地 `Write-Host`。

## 交付
① 改动/新增文件清单；② 脚本全文；③ 用法（首次配置、日常同步、DryRun、出问题怎么回滚）；④ 一次真实执行的完整输出（含清理前后远程 `ls -la` 对比），并说明服务器上现在确实只剩一套最新版。
