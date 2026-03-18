# vplayer SDK v1.0.1 开发文档

## 1. 简介
vplayer包括sdk和demo两部分，是一套轻量级的webrtc前端解决方案，支持Simulcast特性。它包含三个个核心组件：
1.  **`MediaMTXWebRTCReader`**: 负责 WHEP 协议交互、WebRTC 连接建立、RTP 接收和 SDP 协商。
2.  **`ABREngine`**: 自适应码率（ABR）控制引擎，负责监控网络状态并自动切换视频层级。
3.  **`MMXControlClient`** (内部): 负责 WebSocket 信令通道，与服务端进行层级切换通信。

---

## 2. 快速集成

### 2.1 引入文件
请在 HTML 中按顺序引入脚本：
```html
<script src="mmxplayer-v1.0.0.js"></script>
<script src="abr-engine.js"></script>
```

### 2.2 基础示例 (Main.js)
```javascript
// 1. 实例化 ABR 引擎
const abrEngine = new ABREngine({
    // 当 ABR 决策需要切换时回调
    onSwitchLayer: (trackId, reason) => {
        if (controlClient) {
            console.log(`切换到 Track: ${trackId}, 原因: ${reason}`);
            controlClient.selectLayer(trackId, reason);
        }
    }
});

// 2. 实例化播放器
const reader = new MediaMTXWebRTCReader({
    url: 'http://localhost:8899/live/stream/whep',
    maxBitrate: 2500, // 初始带宽限制 (可选)
    
    // WebRTC Track 回调
    onTrack: (evt) => {
        const videoEl = document.getElementById('video');
        if (videoEl.srcObject !== evt.streams[0]) {
            videoEl.srcObject = evt.streams[0];
        }
    },
    
    // WHEP 连接成功回调 (拿到 SessionID 后)
    onConnected: () => {
        initControlClient(reader.sessionId);
    },
    
    onError: (err) => console.error("播放错误:", err)
});

// 3. 初始化控制信令 (WebSocket)
function initControlClient(sessionId) {
    const wsUrl = "http://localhost:8899/live/stream/whep"; // WHEP URL
    controlClient = new MMXControlClient(wsUrl, sessionId, {
        onConnected: () => console.log("信令连接成功"),
        onTracksInfo: (tracks, activeId) => {
            // 将 Track 信息注入 ABR 引擎
            abrEngine.setTracks(tracks, activeId);
        },
        onLayerSwitched: (id) => {
            // 通知 ABR 引擎切换完成
            abrEngine.notifyLayerSwitched(id);
        }
    });
}

// 4. 周期性驱动 ABR (建议 1s - 3s 一次)
setInterval(async () => {
    const stats = await reader.pc.getStats();
    // ... 计算 kbps 和 fps ...
    abrEngine.update(videoKbps, audioKbps, fps);
}, 1000);
```

---

## 3. API 接口说明

### 3.1 MediaMTXWebRTCReader (核心播放器)

#### 构造函数
`new MediaMTXWebRTCReader(config)`

**config 参数对象:**
| 属性 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `url` | String | 是 | 完整的 WHEP URL，例如 `http://host:port/live/stream/whep` |
| `maxBitrate` | Number | 否 | 初始连接时的最大带宽限制 (kbps)。用于 SDP `b=AS`。 |
| `user` | String | 否 | Basic Auth 用户名 |
| `pass` | String | 否 | Basic Auth 密码 |
| `token` | String | 否 | Bearer Token |
| `onTrack` | Function | 否 | 回调：`(RTCTrackEvent) => void`。当收到媒体轨道时触发。 |
| `onConnected` | Function | 否 | 回调：`() => void`。当 WHEP 握手完成并获得 SessionID 后触发。 |
| `onError` | Function | 否 | 回调：`(String) => void`。发生错误时触发。 |

#### 属性
| 属性名 | 类型 | 说明 |
| :--- | :--- | :--- |
| `sessionId` | String | WHEP 会话 ID，用于建立 WebSocket 连接。只读。 |
| `pc` | RTCPeerConnection | 底层的 WebRTC 连接对象。 |

#### 方法
| 方法名 | 参数 | 说明 |
| :--- | :--- | :--- |
| `close()` | 无 | 关闭连接并清理资源。 |

---

### 3.2 MMXControlClient (WebSocket 信令)

#### 构造函数
`new MMXControlClient(whepUrl, sessionId, callbacks)`

| 参数 | 类型 | 说明 |
| :--- | :--- | :--- |
| `whepUrl` | String | WHEP URL，用于自动解析 WebSocket 地址和路径。 |
| `sessionId` | String | 从 Reader 获取的 Session ID。 |
| `callbacks` | Object | 回调函数集合 (见下表)。 |

**callbacks 参数对象:**
| 回调名 | 参数 | 说明 |
| :--- | :--- | :--- |
| `onConnected` | - | WebSocket 连接成功。 |
| `onDisconnected` | - | WebSocket 连接断开。 |
| `onTracksInfo` | `(tracks: Array, activeId: Number)` | 收到服务端下发的流列表 (Tracks Manifest)。 |
| `onLayerSwitched` | `(currentId: Number)` | 服务端确认切换完成。 |

#### 方法
| 方法名 | 参数 | 说明 |
| :--- | :--- | :--- |
| `selectLayer(trackId, reason)` | `trackId`: Number, `reason`: String | 发送切换指令给服务端。 |
| `close()` | - | 关闭 WebSocket 连接。 |

---

### 3.3 ABREngine (自适应码率引擎)

#### 构造函数
`new ABREngine(callbacks)`

**callbacks 参数对象:**
| 回调名 | 参数 | 说明 |
| :--- | :--- | :--- |
| `onSwitchLayer` | `(trackId: Number, reason: String)` | 当 ABR 算法决定需要切换时触发。需在此回调中调用 `controlClient.selectLayer`。 |

#### 方法
| 方法名 | 参数 | 说明 |
| :--- | :--- | :--- |
| `setTracks(tracks, activeId)` | `tracks`: Array, `activeId`: Number | 初始化引擎。传入从 WebSocket 获取的 track 列表。 |
| `update(videoKbps, audioKbps, fps)` | `videoKbps`: Number (kbps)<br>`audioKbps`: Number (kbps)<br>`fps`: Number | **核心驱动方法**。需由外部定时器调用，传入实时统计数据。 |
| `notifyLayerSwitched(trackId)` | `trackId`: Number | 通知引擎切换已完成（重置内部冷却计时器）。 |
| `notifyManualSwitch(trackId)` | `trackId`: Number | 通知引擎用户进行了手动切换（将自动关闭 Auto 模式）。 |
| `setAutoMode(enabled)` | `enabled`: Boolean | 开启/关闭自动 ABR 模式。 |

---

## 4. 数据结构定义

### Track Info 对象
由服务端通过 WebSocket 的 `TRACKS_INFO` 消息下发。
```javascript
{
    "id": 0,            // Track ID (唯一标识)
    "type": "video",    // "video" | "audio"
    "codec": "h264",    // "h264" | "hevc" | "opus"
    "bitrate": 2500000, // 目标码率 (bps)
    "width": 1920,      // (Video Only)
    "height": 1080      // (Video Only)
}
```

---

## 5. ABR 逻辑说明 (内置策略)

**ABREngine** 采用保守降级、探测升级策略：

1.  **降级 (Downgrade)**:
    *   **触发条件**: `AvgFPS < 12` (严重卡顿) 或 `Bandwidth < Target * 0.5` (严重拥塞)。
    *   **防抖**: 需连续 **3次** `update` 均满足条件才触发切换。
    *   **Audio Only**: 仅当 FPS < 10 或 带宽极低 (< 200kbps) 时才降级至纯音频。

2.  **升级 (Upgrade)**:
    *   **触发条件**: `AvgFPS >= 25` (流畅) 且 `Bandwidth >= Target * 0.95` (带宽充裕)。
    *   **防抖**: 需连续 **3次** `update` 均满足条件。

3.  **起播保护**:
    *   引擎初始化后的前 **5秒** 内不执行降级操作，以等待缓冲区填充和解码器稳定。

---

**视频秒开方案**
停止时，调用pause而不是exit。player客户端切换到 **Audio Only** (极低带宽占用，128kbps)状态。
重新恢复(resume)播放时，视频就是秒开。服务器会立即切换回视频源，并**立即发送一个关键帧IF**
- 方案优点
1.  **极速恢复**：因为 ICE 和 DTLS 根本没断，恢复耗时 = RTT (信令往返) + 0ms (建连)。
2.  **带宽极低**：暂停期间只有音频流量（128kbps），对于宽带几乎可以忽略。
3.  **实现简单**：不需要改动底层 WebRTC 握手逻辑，复用现有的 ABR 切换能力。

---

## 6. E2E Latency (Step1-3)

`main.js` has integrated the end-to-end latency flow with `vcenter + vpublisher`:

1. Step1 (`vcenter -> vpublisher`)
`vcenter` queries publisher for current encoding frame PTS (`pts_fn`).

2. Step2 (`vcenter -> vplayer`)
`vcenter` pushes `PUB_PTS` message to player via `/ws/play`.

3. Step3 (`vplayer` computes)
`vplayer` uses `pts_fm = video.currentTime * 1000` and computes:
`e2eLagMs = pts_fn - pts_fm`

### 6.1 New optional URL params

- `vcenterWs`: override default `ws://<current-host>/ws/play`
- `vcenterHttp`: override default `<current-origin>`

Example:

```text
http://localhost:8081/index.html?vcenterWs=ws://localhost:8080/ws/play&vcenterHttp=http://localhost:8080
```

### 6.2 PTS message format (`vcenter -> vplayer`)

```json
{
  "type": "PUB_PTS",
  "streamPath": "live/xxx",
  "ptsFnMs": 123456,
  "workerId": 1,
  "msgId": "1730000000000-1",
  "tsMs": 1730000000000
}
```

### 6.3 Lag reporting (`vplayer -> vcenter`)

`main.js` reports every ~3s (throttled):

- `POST /api/play/lag`
- body:

```json
{
  "streamPath": "live/xxx",
  "lagDuration": 235
}
```

# ppcdn-demo
**demo-player**: http://8.220.177.159:8080/vplayer/
**admin-portal**: http://8.220.177.159:8090
**recordings**: http://8.220.177.159/mmx/
