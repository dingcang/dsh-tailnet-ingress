# dsh-tailnet-ingress

中文 | [English](README.en.md)

一个小的 DSH bundle：把回环地址上的 Web UI 同时服务到本机的其他非公网地址上。DSH 刻意只绑定一个具体地址并拒绝通配地址，本插件让部署能同时应答局域网网卡和隧道网卡，而 `http://127.0.0.1:<端口>` 照常可用。

它在每个可服务地址上监听，把原始 TCP 管道接到回环监听器：HTTP、WebSocket 升级以及其他一切原样通过。不解析、不改写、不注入。

## 默认零配置

`autoDetect` 默认开启，因此每次启动都会读取 `os.networkInterfaces()`，服务所有落在下列网段内的非回环 IPv4 地址：

| 网段 | 用途 |
| --- | --- |
| `10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16` | 普通局域网地址 |
| `100.64.0.0/10` | CGNAT —— Tailscale 的 `100.x` 地址来自这里 |
| `198.18.0.0/15` | RFC 2544 基准网段；Shadowrocket 的 TUN 就在 `198.18.0.1` |

DSH 自己绑定的地址总会被跳过，所以在 `--host 192.168.1.5` 的部署上启用插件也不会与自身监听冲突。公网地址永不服务。

### 地址列表如何得出

探测只读操作系统的网卡表（Node 的 `os.networkInterfaces()`）——不调用外部命令、不发探测流量，也不向隧道应用查询：

1. 收集所有 `internal: false` 且协议族为 IPv4 的条目。IPv6 永不服务。
2. 去重。
3. 只保留落在上述网段内的地址，公网地址一律丢弃。
4. 把显式 `hosts` 条目排在最前，因此配置永远优先且顺序确定。
5. 剔除 DSH 自己绑定的地址（从 `webServer.getOrigin()` 读回）。
6. 对剩下的每个地址，用解析出的端口执行监听。

探测在每次激活时执行，因此 DHCP 续租或隧道上线会在下次启动时自动跟上，无需改配置。某个地址若在探测与 `listen` 之间消失，只记一条警告，其余地址继续服务。

## 为什么 `198.18.0.1` 重要

Shadowrocket 的 Tailscale 模块是一个 NetworkExtension 包隧道。它把目标为节点 tailnet 地址的入站包改写成自己 TUN 接口的地址——`utun6` 上的 `198.18.0.1`——并保留端口。因此 macOS 只看得见目标为该字面量的流量，这就是为什么监听在 `127.0.0.1` 或局域网地址上的服务收不到 tailnet 入站。

## 监听地址不等于放行

管道不改写 `Host`。DSH 的 `/api` 信任栅栏仍然拒绝每一个未被 `--trusted-host` 点名的 authority，所以在酒店局域网地址上监听并不会在那里暴露界面。为浏览器会使用的每个 authority 声明：

```bash
dsh web --host 127.0.0.1 --trusted-host 192.168.1.5 100.x.y.z
```

不声明则 `/api` 返回 `403`。启动 token 是进程级的，每个 authority 需要各自完成一次 cookie 兑换。

## 生命周期

监听器由 `ctx.effect` 持有：每次 `dsh web` 启动随之建立，关闭或重载时随之关闭。`port: 0` 跟随 Web 监听器实际绑定的端口，因此 `--port` 变化时两侧保持一致。

## 安装

```bash
# 从 npm 安装（推荐）
dsh plugin --profile web add @dingcang/dsh-tailnet-ingress

# 从 GitHub 安装
dsh plugin --profile web add github:dingcang/dsh-tailnet-ingress

# 或从本地目录安装
dsh plugin --profile web add file:/path/to/dsh-tailnet-ingress
```

安装后重启 `dsh web`，让 profile 重新加载该包。

## 配置

bundle 自带的 patch 提供默认值。在**你的 profile** 的 `cordis.patch.yml` 里按 row id 覆盖——绝不要改这个包：

```yaml
- id: dsh-tailnet-ingress
  config:
    hosts: [192.168.1.5]   # 显式地址，替代或叠加在探测结果上
    autoDetect: true
    port: 0                # 0 = 跟随 Web 监听器
    upstreamHost: 127.0.0.1
    upstreamPort: 0        # 0 = 跟随 `port`
```

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `hosts` | `[]` | 额外服务的地址，与探测结果合并 |
| `autoDetect` | `true` | 服务本机私有 / CGNAT / 隧道 IPv4 地址 |
| `port` | `0` | `0` 表示跟随 Web 监听器的端口 |
| `upstreamHost` | `127.0.0.1` | DSH 持有的回环监听器 |
| `upstreamPort` | `0` | `0` 表示跟随 `port` |

要锁定单一地址，把 `autoDetect` 设为 `false`，并显式列出 `hosts`。
