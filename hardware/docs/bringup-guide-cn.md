# WearBlocks 硬件联调测试指南

适用范围：当前 `main` 分支的固件（hub: ESP32-C3-MINI-1，digital PosID）+ 任意一种或多种模块。本指南按"先 hub smoke test，再逐模块单插验证，再热插拔/堆叠"的顺序组织，不再绑定到某一种模块。

---

## 0. 准备工作

### 0.1 烧录 hub 固件

| 板子 | sketch 路径 | 目标芯片 |
|---|---|---|
| Hub | `hardware/firmware/hub/hub.ino` | ESP32-C3-MINI-1 |

烧录前安装的 lib：把 `hardware/firmware/lib/` 下的 `WearBlocksCAN`、`WearBlocksProtocol`、`WearBlocksDescriptor`、`WearBlocksModule`、`WearBlocksECA`、`WearBlocksPosID` 软链或拷到 Arduino libraries 目录。

### 0.2 烧录模块固件

每个模块是一块 ESP32-C3-MINI-1。Sketch 路径：

| 模块 | Sketch 路径 | 颜色 (canvas) | 主要传感/执行器 |
|---|---|---|---|
| 6-Axis IMU | `hardware/firmware/module_imu/module_imu.ino` | `#7CA1BB` 灰蓝 | MPU6050 |
| RGB LED | `hardware/firmware/module_led/module_led.ino` | `#C68E9E` 玫粉 | WS2812B ring |
| Vibration | `hardware/firmware/module_vibration/module_vibration.ino` | `#50C878` 海绿 | DRV2605L + ERM |
| Audio Synth | `hardware/firmware/module_amplifier/module_amplifier.ino` | `#9885BF` 紫 | MAX98357A + 8Ω |
| Light Sensor | `hardware/firmware/module_light_resistor/module_light_resistor.ino` | `#C1B496` 米色 | GL5528 LDR |
| Rotary Knob | `hardware/firmware/module_resistor/module_resistor.ino` | `#98AF6F` 橄榄绿 | WH148 B100K |

> 同一种模块的多个实例不需要改 slot 号——slot 由 hub 在 `$H` 之后动态分配。但同一个 UID 不能上线两次。每块板子的 UID 来自 efuse MAC，天然唯一。

**C3 烧录常见坑**：

- **GPIO 2、8、9 是 strap pin**。如果板子烧完按 RESET 起不来，多半是某个 child-detect / face pin 上电时被外部硬拉到 GND 或 3.3V。先把可疑外设拔掉再 RESET。
- **MPU6050 等 I2C 外设接错**会让 `*.begin()` 挂住但不报错。先单独跑 `Wire.begin(); Wire.beginTransmission(0x68);` 之类的最小代码确认 ACK。

### 0.3 安装 bridge 依赖

```bash
cd frontend/bridge
pip install -r requirements.txt
```

### 0.4 列举串口

```bash
python3 frontend/tools/wb_debug.py --list
```

记下 hub 的 port（macOS 形如 `/dev/cu.usbmodem...`，Linux 形如 `/dev/ttyACM0`）。模块板子不需要接电脑，只要 CAN 和电源（USB 给 hub 供电时，模块通过 pogo 共享 3.3V 即可）。

---

## 1. Smoke test：只接 hub

不插任何模块，先单独看 hub 自己起得来。

```bash
python3 frontend/tools/wb_debug.py --port /dev/cu.usbmodemXXX
```

期望输出（关键几行）：

```
=== WearBlocks Hub — Digital PosID ===
[OK] CAN: TX=GPIO6 RX=GPIO7 @500kbps
[OK] Face pins: F1=GPIO0  F2=GPIO2  F3=GPIO3  F4=GPIO4  F5=GPIO8  F6=GPIO10
  F1 initial: empty
  F2 initial: empty
  F3 initial: empty
  F4 initial: empty
  F5 initial: empty
  F6 initial: empty
[WAIT] Listening for module HELLO ...
```

按 `s` 键 → 期望立刻收到 `$Q DONE`（registry 为空）。按 `t` 键 → `=== TOPOLOGY === HUB 0 module(s) registered === END ===`。

**如果某个 face 初始显示 `OCCUPIED` 但其实没接东西**——对应 GPIO 被悬空/拉低了，是硬件问题。查 PCB 走线或外接 pull-up 验证。

---

## 2. 单模块插入：每种模块的期望事件

通用流程：
1. 启动 bridge 和前端：`python3 frontend/bridge/serial_bridge.py /dev/cu.usbmodemXXX`
2. 浏览器打开 `http://localhost:3000`，可选按 `Ctrl/Cmd + D` 打开调试面板。
3. 把模块插到 hub 的某一面（任意面均可），观察日志和 canvas。

### 2.1 通用 `$H` 行格式

```
$H,<uid_hex>,<moduleId>,HUB,<face>
```

- `<uid_hex>`：8 位十六进制，由模块 efuse MAC 派生
- `<moduleId>`：descriptor.moduleId 字段。除 vibration 写死为 `vib_v2` 外，其他模块都是 `<category>_<uid>`（IMU 是 `imu_<uid>`，LED 是 `led_<uid>`，依此类推）。
- 紧接着 hub 会发 `[DESC] requesting slot N descriptor`，模块回 `$D ...`，hub 回 `$OK`。
- canvas 上对应 face 出现一个对应颜色的六边形。

### 2.2 各模块期望

| 模块 | 期望 `$H` 关键字段 | 期望 `$S` 频率（直接看不到，但 debug panel 会显示 rate） | canvas 颜色 |
|---|---|---|---|
| IMU | moduleId=`imu_<uid>` | 6 raw 通道默认 50 Hz → ~300 frame/s；启用 ACC_MAG/PITCH 后翻倍 | 灰蓝 `#7CA1BB` |
| LED | moduleId=`led_<uid>` | 0/s（执行器，不主动报） | 玫粉 `#C68E9E` |
| Vibration | moduleId=`vib_v2` | 0/s | 海绿 `#50C878` |
| Audio Synth | moduleId=`audio_<uid>` | 0/s | 紫 `#9885BF` |
| Light Sensor | moduleId=`light_<uid>` | 单通道 ~10–20 Hz | 米色 `#C1B496` |
| Rotary Knob | moduleId=`knob_<uid>` | 仅在转���时上报，最高 50 Hz；静止时为 0 | 橄榄绿 `#98AF6F` |

### 2.3 验证执行器（LED / Vibration / Audio）

执行器模块插入后默认不会主动产出 `$S`。最快的"它真的在线"测试是从 Blockly 写一条 ECA 规则触发它，或在调试面板里手动发一条：

- **LED**: 拖一个 "always" → "set color" 块，颜色任选。期望模块上的 NeoPixel 立刻亮。
- **Vibration**: "always" → "vibrate, 200ms"。模块上的 ERM 短促一震。
- **Audio Synth**: "always" → "play tone 440Hz"。喇叭出 1 声 A4。

如果在 canvas 上看到模块但执行没反应，9 成是这一面的 pogo 没接通 GND/3.3V——晃一晃模块再试。

---

## 3. 热插拔验证

任意一种模块都适用。流程和期望：

| 操作 | 期望 CLI | 期望 UI |
|---|---|---|
| 拔掉模块 | 100 ms 后：`$X slot N from F<face> (pending)`；7 s 后：`✕ UNPLUG slot N` | 拔的瞬间六边形变淡 35%（ghost），7 s 后消失 |
| 拔掉后 5 s 内换面插回 | `$X slot N from F<old> (pending)` 然后 `↔ HOT-SWAP slot N: F<old> → F<new>` | Ghost 变回实色，六边形从旧面跳到新面；slot 号不变 |
| 同时插两个模块 | 两组 `[DESC] requesting slot N descriptor` **串行** 出现，不会交错 | 两个六边形依次出现 |
| 浏览器按 ↻（resync） | bridge → 串口发 `$Q,STATUS`；hub 回所有 `$H`+`$D` 然后 `$Q DONE` | canvas 保持稳定，不闪烁 |

---

## 4. 堆叠（CHILD_EVENT）

任何 down-half 面上有 PosID GND 打脚的模块都能承载子模块。当前 IMU、LED、Vibration、Amplifier 的 `module_*.ino` 里都定义了 `CHILD_PINS[]`（一般是 face 4/5/6 → GPIO 2/8/10），意思是这三个面在物理上做了 down-half pogo。

### 4.1 物理拓扑（以 hub → IMU-A → IMU-B 为例）

```
    ┌──────────┐
    │   HUB    │
    └────┬─────┘
         │  F1
    ┌────┴──────┐
    │  IMU-A    │   ← slot 1，直连 hub F1
    │  (up F1,  │
    │   dn F4)  │   ← down-half face 4 是子模块挂载位
    └────┬──────┘
         │
    ┌────┴──────┐
    │  IMU-B    │   ← slot 2，堆在 IMU-A 的 F4 上
    └───────────┘
```

### 4.2 期望事件序列

**阶段 1：先插 IMU-A 到 hub F1**——同 §2 单模块流程，hub 给它发 `$H,...,HUB,1`。

**阶段 2：把 IMU-B 堆到 IMU-A 的 F4 上**——IMU-A 上电后周期检测 child detect pin，发现 F4 被拉低，发 `CHILD_EVENT` 给 hub。期望日志：

```
[CHILD] slot 1 face 4 OCCUPIED → child-side
$H,<uid_B>,imu_<uid_B>,SLOT 1,4
[DESC] requesting slot 2 descriptor
$D ...
$OK ...
```

注意 `$H` 的第三个字段从 `HUB` 变成 `SLOT 1`——表示父节点是 slot 1 而不是 hub。canvas 上 IMU-B 渲染在 IMU-A 的 F4 方向上。

**阶段 3：拔 IMU-B**——slot 2 走 §3 的热插拔逻辑；IMU-A（slot 1）不动。

---

## 5. 常见坑速查

| 现象 | 多半原因 |
|---|---|
| Hub 起来但所有 face 都 `OCCUPIED` | face pin 全被外部下拉。检查 PCB 走线或临时把 pull-up 改成 33k 试试。|
| 模块插上去 hub 没有 `$H` | (a) CAN 接反 / 没接 120Ω 终端；(b) 模块烧错了 sketch；(c) 模块那一面的 GND pogo 没接通。先用万用表量 CAN_H/CAN_L 静态电压（应在 ~2.5V）。|
| `$D` parse 失败（`[DESC] slot N: parse failed`） | 描述字段超长（name > 32, category > 32, color > 8）或字符串没 null-terminate。`strlcpy` 的第三个参数对了吗？|
| 数���率极低（<10/s 而期望 300） | `WBModule.tick()` 没在 `loop()` 里调用，或 `sendChannel()` 被 topic gating 卡住。debug panel 里手动 enable 一下相关通道。|
| LED / Vibration 在线但执行无响应 | 执行器供电 pogo 没接通；或者 actuator command id 写错（IDs 见各 sketch 头部注���）。|
| 堆叠后子模块的 `$H` 不出现 | 父模块这一面没在 `CHILD_PINS[]` 里登记，或登记的 GPIO 跟实际 PCB 不一致。|
