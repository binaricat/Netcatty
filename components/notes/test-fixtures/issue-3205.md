# 设备TCP栈调优操作记录

> **目标**：根据本地带宽动态调整TCP接收/发送缓冲区，使其能容纳带宽延迟积（BDP）。

## 1. 环境信息收集

### 1.1 基础硬件与系统信息
```bash
# 设备型号
cat /tmp/sysinfo/model

# 内核版本
uname -r

# 总内存
grep MemTotal /proc/meminfo
```

### 1.2 当前TCP参数快照
```bash
sysctl net.ipv4.tcp_rmem \
       net.ipv4.tcp_wmem \
       net.core.rmem_max \
       net.core.wmem_max \
       net.ipv4.tcp_congestion_control \
       net.core.netdev_max_backlog
```

### 1.3 网络链路与带宽测试
- **查看WAN口速率**（替换`<wan口>`为实际接口名，如`eth0`）：
  ```bash
  ethtool <wan口> | grep -i speed
  ```
- **实测带宽**（确保无代理干扰）：
  ```bash
  # 检查代理进程
  ps | grep -E "openclash|mihomo"

  # 若存在代理，请先关闭；然后测速
  speedtest --accept-license --format=json
  ```

### 1.4 检查BBR拥塞控制算法支持
```bash
cat /proc/sys/net/ipv4/tcp_available_congestion_control
```
> **注意**：若输出不包含`bbr`，则后续配置保持`cubic`。

---

## 2. BDP计算与参数确定

### 2.1 计算公式
`最大缓冲区(MB) ≈ 带宽(Mbps) × 0.125 × 最大RTT(秒)`  
即：`带宽(Mbps) × 0.125 × (RTT_ms / 1000)`

### 2.2 参数参考
| 场景 | 预估RTT | 推荐`max`值 |
| :--- | :--- | :--- |
| 本地网络 | ~30ms | 根据实测带宽计算 |
| 代理/国际链路 | ~150-200ms | 根据实测带宽计算 |
| **内存<1GB设备** | - | **固定16MB** |
| 大内存服务器 | - | 可参考GCP建议最大64MB |

### 2.3 配置示例（16MB）
若计算后决定使用16MB上限：
```bash
cat > /etc/sysctl.d/90-tcp-tuning.conf <<'EOF'
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
net.ipv4.tcp_rmem = 4096 131072 16777216
net.ipv4.tcp_wmem = 4096 16384 16777216
net.core.netdev_max_backlog = 8192
net.ipv4.tcp_mtu_probing = 1
net.ipv4.tcp_fastopen = 3
net.ipv4.tcp_slow_start_after_idle = 0
EOF
```

---

## 3. 应用与验证

### 3.1 加载配置
```bash
# 应用配置文件（BusyBox使用-p参数）
sysctl -p /etc/sysctl.d/90-tcp-tuning.conf
```

### 3.2 验证生效
```bash
# 检查关键参数
sysctl net.ipv4.tcp_rmem net.core.rmem_max
```

### 3.3 本地环回吞吐测试
```bash
# 启动临时服务端（运行1次后退出）
iperf3 -s -1 &

# 客户端连接本机测试（3秒）
iperf3 -c 127.0.0.1 -t 3
```
> **目的**：验证内核TCP栈本身是否正常。

---

## 4. 重要说明

- **开机自动加载**：OpenWrt系统下，`/etc/init.d/sysctl`会自动遍历`/etc/sysctl.d/*.conf`，无需额外设置。
- **BBR支持**：若内核不支持BBR，不添加`net.ipv4.tcp_congestion_control=bbr`，保留默认cubic。
- **故障排查**：外网测速慢时，请先排除：
  - 代理软件（openclash/mihomo）劫持流量。
  - 上游运营商或国际链路瓶颈。
- **配置回滚**：如需恢复默认设置，只需：
  ```bash
  rm /etc/sysctl.d/90-tcp-tuning.conf
  sysctl -p /etc/sysctl.d/90-tcp-tuning.conf  # 或重启设备
  ```

---