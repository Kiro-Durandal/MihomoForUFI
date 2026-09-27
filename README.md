# F50 Mihomo UFI-Tools Device Manager Beta 2.6-RC2

RC2 以已在 F50 实机验证的 RC1 双栈脚本为基础，新增全新安装框架。目标不是为 IPv6 强制改选节点，而是稳定保留以下行为：

- 国内 IPv4/IPv6 规则可 `DIRECT`。
- 国外流量继续使用用户在“手动选择”中指定的同一个节点。
- 节点没有 IPv6 出口时，双栈应用可以自行回落 IPv4。
- 国外纯 IPv6 在所选节点不支持时允许失败。
- 不创建专用“IPv6 出口”组，不偷偷切换到其他节点。

## 当前状态

RC2 已作为公开 prerelease 发布：

1. `config/config.template.yaml` 已保留审定的 DNS、规则集与策略组，只留下 `__SUBSCRIPTION_URL__` 供安装器本地替换。
2. 全新安装模板的 MetaCubeXD 控制器使用 `0.0.0.0:9090`，初始密钥为 `123456`；该默认值是已知的，安装后应尽快修改。现有安装升级不会套用这两个值。
3. GitHub Actions 已下载并校验官方 Android arm64 Mihomo `v1.19.31`；来源、压缩前后 SHA-256、ELF 架构和 GPL-3.0 许可记录位于 `runtime/`。二进制保持 Git 忽略，只进入发布包。
4. 公开仓库、不可变 tag、清单和五个 Release 资产均可匿名读取：<https://github.com/Kiro-Durandal/MihomoForUFI/releases/tag/v2.6-rc2>。
5. tag 中的发布清单已写入真实 `.tar` 字节数、SHA-256 及 `published: true`；前端从不可变 tag 读取该清单。

以上任一项未完成时，首次安装器会明确报错，不会留下半安装状态。

## 用户流程

1. 在 UFI-Tools 中启用高级功能并导入 RC2 JS。
2. 点击“F50 Mihomo”。
3. 后端缺失时自动打开首次安装向导。
4. 输入自己的 HTTPS 订阅链接。
5. 选择“从 GitHub 安装”，或同时选择本地 `release-manifest.json` 与完整 `.tar` 包。
6. 前端上传文件，设备核对字节数和 SHA-256，执行包内 `install.sh`。
7. 安装器校验配置和内核、原子提交目录、启动 Mihomo、建立 IPv4/IPv6 TProxy、进行健康检查并登记开机启动。

不会在页面加载时自动执行 Root 命令；安装必须由用户点击并确认。

## 文件结构

```text
f50-mihomo-ufi-device-manager-beta2.6-rc2.js  UFI-Tools 前端与首次安装向导
LICENSE                                       原创项目文件的 MIT 许可证
THIRD_PARTY_NOTICES.md                        第三方组件许可、来源与校验说明
install.sh                                    全新安装/升级统一入口
install-upgrade.sh                            现有安装事务式升级器
rollback-last.sh                              最近一次脚本升级回退
ufi-backend.sh                                固定动作后端
config/config.template.yaml                   脱敏配置模板
CONFIG-REVIEW.md                              DNS、IPv6、更新路径和泄露风险复核结论
runtime/README.md                              内核/UI/种子数据打包说明
runtime/MIHOMO-PROVENANCE.md                   内核版本、来源、架构及校验记录
runtime/LICENSE.mihomo                         Mihomo 上游 GPL-3.0 许可证
runtime/mihomo-v1.19.31-source.tar.gz          构建时校验、作为独立 Release 资产发布的对应源码
release-manifest.json                         版本固定的发布清单模板
scripts/env.sh                                运行参数
scripts/firewall-start.sh                     IPv4/IPv6 TProxy 建立
scripts/firewall-stop.sh                      IPv4/IPv6 TProxy 清理
scripts/start.sh                              启动、校验与日志限容
scripts/stop.sh                               安全停止
scripts/status.sh                             状态检测
scripts/boot-start.sh                         开机等待网络并启动
scripts/uninstall.sh                          彻底卸载后端与运行数据
tools/build-release.ps1                       发布包构建与基础泄露扫描
.github/workflows/release-rc2.yml             手动触发、校验后创建 RC2 tag 与 Release
RELEASE-CHECKLIST.md                          发布前人工检查项
SECURITY.md                                   安全和漏洞报告说明
```

## 手动测试全新安装

制作可安装包前至少需要：

- 确认 `runtime/mihomo` 通过构建器固定的版本、架构与 SHA-256 校验；
- 准备一个只在第一行保存个人 HTTPS 订阅链接的本地文本文件。

然后在 F50 的 UFI-Tools TTYD Root 环境执行：

```sh
sh /sdcard/Download/F50-Mihomo-UFI-Device-Manager-Beta2.6-RC2/install.sh \
  --subscription-file /sdcard/Download/my-subscription.txt
```

也可以提供一份完整配置，绕过模板生成：

```sh
sh /sdcard/Download/F50-Mihomo-UFI-Device-Manager-Beta2.6-RC2/install.sh \
  --config /sdcard/Download/config.yaml
```

`--config` 不代表配置是安全的；它仍会由 Mihomo 校验，但其中的订阅、节点和密钥由提供者自行负责。

## 现有安装升级

统一入口会自动识别完整的 `/data/f50-mihomo`，只替换 RC2 脚本。现有 `config.yaml` 不重写、不迁移，也不做格式化；内核、provider、UI、日志和选择状态同样保留。前端与后端会从现有配置动态读取 `external-controller` 的 TCP 端口，因此 RC1 原端口可继续使用：

```sh
sh /sdcard/Download/F50-Mihomo-UFI-Device-Manager-Beta2.6-RC2/install.sh
```

也可以继续直接使用：

```sh
sh /sdcard/Download/F50-Mihomo-UFI-Device-Manager-Beta2.6-RC2/install-upgrade.sh
```

注意：RC1 升级不会用 RC2 `config.template.yaml` 覆盖旧配置，连 `external-controller` 和 secret 也不会修改。升级器只会只读校验现有配置并在安装脚本后重启服务；DNS、规则、订阅、节点缓存及所有用户自定义项均原样继承。RC2 模板中的 `0.0.0.0:9090` 与 `123456` 仅用于全新安装。想采用新模板时，必须由用户另行上传并应用，或彻底卸载后全新安装。

## 彻底卸载

设备管理窗口的“危险操作”区提供“彻底卸载后端”。确认后会：

- 停止 Mihomo，并清除 IPv4/IPv6 TProxy、DNS 链和策略路由；
- 删除 UFI-Tools 开机脚本中的 F50 Mihomo 启动项；
- 永久删除 `/data/f50-mihomo`、安装/失败遗留目录及开机日志；
- 同时删除配置、订阅、provider 缓存、日志和回滚备份，不创建恢复副本。

UFI-Tools 中已导入的前端 JS 与 `/sdcard/Download` 中的发布包不属于后端目录，需用户手动删除。

## 事务与失败处理

- 全新安装先写入 `/data/f50-mihomo.install.*`。
- 暂存内核无法运行或配置校验失败时，不创建正式安装目录。
- 首次启动或双栈健康检查失败时，停止服务并把现场移动为 `/data/f50-mihomo.failed.*`。
- 现有安装升级沿用 RC1 的脚本备份和自动恢复机制，但备份对象只有将要替换的脚本。
- `config.yaml` 在升级和回退中都只读，不进入升级备份，也不会被写回；可用升级前后 SHA-256 验证内容完全一致。
- `rollback-last.sh` 只回退最近一次脚本升级，不删除或改写配置、provider、UI、日志及其他运行数据。

## IPv6 设计

F50 内核没有 `ip6tables nat` 表，因此 IPv6 不复制 IPv4 DNS REDIRECT：

- IPv4 DNS 继续 REDIRECT 到 `1053`；其他 IPv4 TCP/UDP TProxy 到 `7894`。
- IPv6 公网 TCP/UDP 统一 TProxy 到 `7894`。
- `dns.fake-ip-range6` 在 ULA 旁路之前捕获。
- 链路本地、多播、ULA、保留范围和 `br0` 当前直连前缀旁路。
- 配置通过 `ChinaIpv6` 规则集决定国内 IPv6 `DIRECT`。
- 没有 IPv6 出口的代理节点不会触发自动换节点。

## 发布

不要直接把整个上级工作区初始化为 Git 仓库。只发布本 RC2 目录，并先完成 `CONFIG-REVIEW.md` 与 `RELEASE-CHECKLIST.md`。

构建脚本会拒绝缺少内核、带待审定标记或含明显凭据模式的源目录：

```powershell
pwsh -File .\tools\build-release.ps1
```

构建器已固定 `Kiro-Durandal/MihomoForUFI` 与 `v2.6-rc2`，会校验 Mihomo 二进制、许可证和对应源码归档，生成安装 `.tar`，并回写最终 `release-manifest.json` 与源码 `SHA256SUMS.txt`。也可显式传入相同的 `-Owner`、`-Repository` 和 `-Tag`；不同值会被拒绝，以免生成指向错误仓库的安装器。

仓库还提供手动触发的 `Publish RC2` GitHub Actions 工作流。它只接受固定的 `v2.6-rc2`，从上游 HTTPS 地址下载内核和源码并核对固定 SHA-256；随后执行同一构建器、提交最终清单、创建不可变 tag，并把五个发布资产上传为 prerelease。若 tag 已存在、主分支发生竞争更新、下载校验失败或产物内容异常，工作流会停止而不是覆盖发布。

发布产物应包括：

- `f50-mihomo-ufi-device-manager-beta2.6-rc2.js`
- `release-manifest.json`
- `F50-Mihomo-UFI-Device-Manager-Beta2.6-RC2-arm64.tar`
- `mihomo-v1.19.31-source.tar.gz`
- `SHA256SUMS.release.txt`

安装 `.tar` 包含 Mihomo 可执行文件、上游 GPL 文本、来源记录、项目 MIT 文本及第三方声明，但不重复包含 1.2 MB 的源码归档；源码归档作为同一个 Release 的独立配套资产发布。

## 许可证

本项目原创的前端 JS、安装/管理脚本、模板与文档采用仓库根目录的 MIT 许可证。发布包内的 Mihomo 是独立的第三方程序，仍由上游 GNU GPL version 3 管辖；项目采用 MIT 不会把 Mihomo 重新许可为 MIT。完整边界、来源、二进制校验值和对应源码取得方式见 `THIRD_PARTY_NOTICES.md` 与 `runtime/MIHOMO-PROVENANCE.md`。

## 安全说明

- 不要提交真实 `config.yaml`、订阅、节点、provider 缓存、日志、诊断报告或 Mihomo 缓存数据库。
- 发布清单必须指向不可变 tag，不能指向分支或 `latest`。
- 不允许跳过 TLS 或 SHA-256 校验。
- 订阅链接只应在用户设备本地写入生成的配置。
- 模板中的 `123456` 是发布要求的初始值，不是私密密钥；由于控制器监听全部接口，长期使用它会构成局域网控制风险。
