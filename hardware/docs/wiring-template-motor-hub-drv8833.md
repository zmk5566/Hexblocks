## 1. 模块概览

- **模块名称**：`motor_hub`
- **角色**：`<hub + local motor output>`
- **驱动器**：`<DRV8833 motor driver module>`
- **负载**：`<2x DC motor>`
- **CAN 收发器**：`<SN65HVD230>`
- **6-pin 磁吸触点数量**：`<1 母>`
- **DRV8833 驱动小板接口**：`<两侧各 6-pin 排针>`

说明：这是一个新的带 motor 的 hub 形态，不是在现有 hub PCB 上飞线改造，也不是普通可堆叠 motor module。它本身作为 CAN hub/root，只保留 1 个磁吸母头 face 给其他模块接入；motor 由本 hub 板上的 ESP32-C3 直接控制一块现成 DRV8833 驱动小板。

---

## 2. 6-pin 磁吸触点定义

磁吸触点（母头，用于接入其他模块）

| Pin # | 信号 | 说明 |
|-------|------|------|
| 1 | VCC (3.3V) | 给外接模块提供逻辑电源 |
| 2 | GND | 共地 |
| 3 | CAN-H | CAN 总线高 |
| 4 | CAN-L | CAN 总线低 |
| 5 | POS_ID | 接 ESP32-C3 GPIO0，用于检测外接模块接入 |
| 6 | POS_GND | 共地 |

没有磁吸公头：`motor_hub` 是拓扑 root，不需要插到其他 hub 或父模块上。

---

## 3. ESP32-C3 引脚分配

| GPIO | 用途 | 接到哪 | 备注 |
|------|------|--------|------|
| GPIO7 | TWAI_TX | SN65HVD230 `TXD` | 以当前 `hardware/firmware/hub/hub.ino` 为准 |
| GPIO6 | TWAI_RX | SN65HVD230 `RXD` | 以当前 `hardware/firmware/hub/hub.ino` 为准 |
| GPIO0 | Face 1 presence | 磁吸母头 `POS_ID` | `INPUT_PULLUP`，低电平表示有模块接入；boot strapping pin |
| GPIO1 | `MOTOR_IN1` | DRV8833 驱动小板 `IN1` | Motor 1 输入 1，可输出 PWM |
| GPIO2 | `MOTOR_IN2` | DRV8833 驱动小板 `IN2` | Motor 1 输入 2，可输出 PWM；boot strapping pin |
| GPIO3 | `MOTOR_IN3` | DRV8833 驱动小板 `IN3` | Motor 2 输入 1，可输出 PWM |
| GPIO4 | `MOTOR_IN4` | DRV8833 驱动小板 `IN4` | Motor 2 输入 2，可输出 PWM |
| GPIO9 | Status LED | 可选 | 若不用状态灯可空置 |

> 如果后续决定沿用旧文档中的 CAN 方向（GPIO6=TX、GPIO7=RX），需要同步修改 `hub.ino` 里的 `CAN_TX_PIN` / `CAN_RX_PIN`，不要只改硬件或只改固件。
>
> `GPIO0` 和 `GPIO2` 是 ESP32-C3 boot strapping pins。`GPIO0` 作为 face detect 时，如果外接模块在上电瞬间把 `POS_ID` 拉低，可能影响启动。bring-up 时建议先空 face 上电，等 hub 启动完成后再插模块。

---

## 4. CAN 收发器接线（`SN65HVD230`）

| 收发器引脚 | 接到 | 备注 |
|------------|------|------|
| TXD | ESP32-C3 GPIO7 | `TWAI_TX` |
| RXD | ESP32-C3 GPIO6 | `TWAI_RX` |
| VCC | 3.3V 主电源轨 | 与 ESP32-C3 同电源 |
| GND | GND | 共地 |
| CANH | 磁吸母头 `CAN-H` | 通过唯一 face 接入外部模块 |
| CANL | 磁吸母头 `CAN-L` | 通过唯一 face 接入外部模块 |
| Rs | GND | 高速模式 |
| Vref | NC | 不使用 |

CAN 总线终端仍建议放在 hub/root 侧：`CAN-H` 与 `CAN-L` 之间接 120Ω。

---

## 5. DRV8833 驱动小板接线

这里使用 Simple Circuit 页面中的 DRV8833 驱动小板，而不是裸 DRV8833 芯片。该小板共 12 个 pin，两侧各 6 个，丝印包括 `VCC`、`GND`、`EEP`、`ULT`、`IN1`、`IN2`、`IN3`、`IN4`、`OUT1`、`OUT2`、`OUT3`、`OUT4`。

### 5.1 控制/状态 pin

| DRV8833 小板丝印 | 接到 | 备注 |
|------------------|------|------|
| `VCC` | Motor 电源正极 | 这是该小板的 motor supply，不是单独的 3.3V logic pin |
| `GND` | `motor_hub` GND + motor 电源负极 | 必须与 ESP32-C3、CAN、磁吸 GND 共地 |
| `EEP` | NC | 该小板已用 47k 上拉到 `VCC`，默认启用；拉到 GND 才进入 sleep |
| `ULT` | NC | `FAULT` 输出，本版按计划悬空 |
| `IN1` | ESP32-C3 GPIO1 | Motor 1 输入 1，`MOTOR_IN1` |
| `IN2` | ESP32-C3 GPIO2 | Motor 1 输入 2，`MOTOR_IN2` |
| `IN3` | ESP32-C3 GPIO3 | Motor 2 输入 1，`MOTOR_IN3` |
| `IN4` | ESP32-C3 GPIO4 | Motor 2 输入 2，`MOTOR_IN4` |

`EEP` 不需要再接电阻到 3.3V。这个模块板上已经把 `EEP` 通过 47k 上拉到 `VCC`；如果 motor 电源 `VCC` 高于 3.3V，不要把 `EEP` 直接接到 ESP32-C3 GPIO。后续若要用 MCU 控制 sleep，建议用小信号 NMOS / NPN 做开漏下拉：平时放开让板载 47k 上拉，需要 sleep 时把 `EEP` 拉到 GND。

### 5.2 电机输出 pin

| DRV8833 小板丝印 | 接到 | 备注 |
|------------------|------|------|
| `OUT1` | Motor 1 `M+` | 电机两端可对调；对调后正反方向互换 |
| `OUT2` | Motor 1 `M-` | 电机两端可对调 |
| `OUT3` | Motor 2 `M+` | 电机两端可对调；对调后正反方向互换 |
| `OUT4` | Motor 2 `M-` | 电机两端可对调 |

> 不建议用磁吸触点上的 3.3V 直接给 motor 供电。磁吸 3.3V 只给外接模块、ESP32-C3 和 CAN 收发器使用；DRV8833 小板的 `VCC` 建议走独立电池或独立稳压电源，并与 `motor_hub` 共地。

---

## 6. Motor 控制真值表

Motor 1 使用 `IN1/IN2`，Motor 2 使用 `IN3/IN4`。两路控制逻辑相同：

| INx1 | INx2 | Motor 状态 | 说明 |
|------|------|------------|------|
| LOW | LOW | 滑行停止 | 输出高阻，电机自由滑行 |
| HIGH | LOW | 正转 | 方向取决于 M1+/M1- 接法 |
| LOW | HIGH | 反转 | 方向取决于 M1+/M1- 接法 |
| HIGH | HIGH | 刹车 | 两端短刹，停止更快，电流更大 |

调速建议：

| 目标 | 推荐做法 |
|------|----------|
| Motor 1 正转调速 | `IN1 = PWM`，`IN2 = LOW` |
| Motor 1 反转调速 | `IN1 = LOW`，`IN2 = PWM` |
| Motor 2 正转调速 | `IN3 = PWM`，`IN4 = LOW` |
| Motor 2 反转调速 | `IN3 = LOW`，`IN4 = PWM` |
| 停止滑行 | 对应 motor 的两个输入都设为 `LOW` |
| 短刹车 | 对应 motor 的两个输入都设为 `HIGH`，短时间后回到 `LOW/LOW` |

---

## 7. 固件影响

后续做固件时，这块板应从 hub 固件派生，而不是从普通 module 固件派生：

| 项目 | 建议 |
|------|------|
| CAN 角色 | hub/root，继续主动枚举外接模块 |
| Face 数量 | 只扫描 1 个 face：`GPIO0` |
| Motor 输出 | 在 hub 本地增加两路 motor actuator 控制逻辑，不通过 CAN 发送给另一个 motor module |
| 拓扑 | 外接模块都挂在 `motor_hub` 的唯一 face 上 |

最小初始化方向：

```cpp
#define FACE1_PIN 0
#define MOTOR_IN1_PIN 1
#define MOTOR_IN2_PIN 2
#define MOTOR_IN3_PIN 3
#define MOTOR_IN4_PIN 4

pinMode(MOTOR_IN1_PIN, OUTPUT);
pinMode(MOTOR_IN2_PIN, OUTPUT);
pinMode(MOTOR_IN3_PIN, OUTPUT);
pinMode(MOTOR_IN4_PIN, OUTPUT);
digitalWrite(MOTOR_IN1_PIN, LOW);
digitalWrite(MOTOR_IN2_PIN, LOW);
digitalWrite(MOTOR_IN3_PIN, LOW);
digitalWrite(MOTOR_IN4_PIN, LOW);

pinMode(FACE1_PIN, INPUT_PULLUP);
```

---

## 8. 电源与保护

| 项目 | 建议 |
|------|------|
| 逻辑电源 | ESP32-C3、SN65HVD230、磁吸外接模块使用 3.3V |
| Motor 电源 | 单独接到 DRV8833 小板 `VCC`，不要直接从 ESP32-C3 GPIO 或 3.3V LDO 取电 |
| 共地 | motor 电源 GND、DRV8833 小板 GND、ESP32-C3 GND、磁吸 GND 必须连接 |
| 去耦 | DRV8833 小板 `VCC` 和 `GND` 旁放 10uF 以上电容 |
| 电机噪声 | 电机两端可并 0.1uF 陶瓷电容；motor 线远离 CAN-H/CAN-L |
| 电流 | 两个电机同时堵转时，总电流不能超过 DRV8833 小板和 motor 电源的能力 |

---

## 9. Bring-up 检查清单

- [ ] 不接 motor，只接 ESP32-C3 + SN65HVD230，确认 hub 能正常启动。
- [ ] 空 face 上电，确认 hub 能正常启动；再插入一个普通模块到唯一磁吸母头，确认 `GPIO0` 可检测到接入，hub 能收到模块 HELLO。
- [ ] 不接 motor，只接 DRV8833 驱动小板，确认 `EEP` 未被拉低；该小板默认通过 47k 上拉启用。
- [ ] 确认 DRV8833 驱动小板 GND、ESP32-C3 GND、motor 电源 GND、磁吸 GND 共地。
- [ ] 使用限流电源给 DRV8833 小板 `VCC` 供电，限流从较低值开始。
- [ ] 固件先分别测试 Motor 1 和 Motor 2 的 `LOW/LOW`，再测 `HIGH/LOW` 和 `LOW/HIGH`。
- [ ] 最后再测试每个 motor 的 `HIGH/HIGH` 刹车，避免长时间刹车导致电流过大。
- [ ] motor 转动时观察外接模块的 CAN 通信是否稳定；若掉线，增加去耦并让 motor 线远离 CAN 线。
