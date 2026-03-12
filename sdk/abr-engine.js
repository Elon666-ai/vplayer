'use strict';

class ABREngine {
    constructor(callbacks) {
        this.callbacks = callbacks || {}; 
        
        this.isAutoMode = true;
        this.abrCooldown = 0;
        this.currentTrackId = null;
        
        this.audioTrackId = null;
        this.videoTrackIds = []; 
        this.trackRegistry = {}; 

        this.avgFps = 0;
        this.avgBw = 0;
        
        this.ignoreUpdates = 0;
        
        this.downgradeCounter = 0;
        this.upgradeCounter = 0;
        this.startupTime = Date.now();
        this.lastSwitchTime = Date.now();
        this.recoveryHoldUntil = 0;
        this.recoveryReason = '';
    }

    // [修复] 增加 currentVideoWidth 参数，用于基于真实画面探测当前 Track
    setTracks(tracks, activeId, currentVideoWidth = 0) {
        this.trackRegistry = {};
        this.videoTrackIds = [];
        this.audioTrackId = null;

        const videos = tracks.filter(t => t.type === 'video');
        tracks.forEach(t => { this.trackRegistry[t.id] = t; });

        // 视频流按码率升序排列 (Low -> High)
        this.videoTrackIds = [...videos]
            .sort((a, b) => (a.bitrate || 0) - (b.bitrate || 0))
            .map(t => t.id);

        const audioT = tracks.find(t => t.type === 'audio');
        if (audioT) {
            this.audioTrackId = audioT.id;
        }

        // ==========================================
        // 初始化当前 Track ID 的智能判定
        // ==========================================
        if (activeId !== undefined && activeId !== null) {
            this.currentTrackId = activeId;
        } else if (this.currentTrackId === null && this.videoTrackIds.length > 0) {
            
            let matchedId = null;
            // 尝试通过当前 video 标签的真实宽度来匹配 Track
            if (currentVideoWidth > 0) {
                // 考虑到横竖屏，宽高可能互换，这里匹配 width 或 height
                const match = videos.find(t => t.width === currentVideoWidth || t.height === currentVideoWidth);
                if (match) matchedId = match.id;
            }

            if (matchedId !== null) {
                this.currentTrackId = matchedId;
                console.log(`[ABR] Initial track detected by real resolution: ID ${this.currentTrackId}`);
            } else {
                // 兜底方案：因为 main.js 初始化 maxBitrate 为 2500，默认是在最高画质
                // 取排序后数组的最后一个元素 (High)
                this.currentTrackId = this.videoTrackIds[this.videoTrackIds.length - 1];
                console.log(`[ABR] Initial track not provided, assuming Highest: ID ${this.currentTrackId}`);
            }
        }

        console.log(`[ABR] Engine Initialized. Video IDs (Low->High): ${this.videoTrackIds}, Audio ID: ${this.audioTrackId}`);
        
        this.startupTime = Date.now();
        this.lastSwitchTime = Date.now();
    }

    notifyManualSwitch(trackId) {
        this.isAutoMode = false;
        this._updateCurrentTrack(trackId);
        this._resetCounters();
        console.log(`[ABR] Manual switch detected. Auto Mode OFF.`);
    }

    notifyLayerSwitched(trackId) {
        this._updateCurrentTrack(trackId);
        this.ignoreUpdates = 3; 
        this.avgFps = 0;
        this._resetCounters();
        this.lastSwitchTime = Date.now(); // 记录切换时间
    }

    _updateCurrentTrack(trackId) {
        this.currentTrackId = trackId;
    }
    
    _resetCounters() {
        this.downgradeCounter = 0;
        this.upgradeCounter = 0;
    }

    setAutoMode(enabled) {
        this.isAutoMode = enabled;
        this._resetCounters();
        console.log(`[ABR] Auto Mode: ${enabled}`);
    }

    enterRecoveryMode(reason = 'unknown', holdSeconds = 15) {
        const sec = Math.max(1, Number(holdSeconds) || 15);
        this.recoveryHoldUntil = Date.now() + sec * 1000;
        this.recoveryReason = reason;
        this.upgradeCounter = 0;
        console.warn(`[ABR] Recovery mode: hold upgrade for ${sec}s, reason=${reason}`);
    }

    update(videoKbps, audioKbps, fps) {
        if (!this.isAutoMode) return;
        
        if (this.abrCooldown > 0) {
            this.abrCooldown--;
            return;
        }
        
        if (this.ignoreUpdates > 0) {
            this.ignoreUpdates--;
            return;
        }
        
        if (Date.now() - this.startupTime < 5000) return;

        if (this.currentTrackId === null) return;
        const currentTrackInfo = this.trackRegistry[this.currentTrackId];
        if (!currentTrackInfo) return;

        const fpsAlpha = fps > 0 ? 0.2 : 0.5;
        this.avgFps = (this.avgFps === 0) ? fps : (fpsAlpha * fps + (1 - fpsAlpha) * this.avgFps);
        
        const totalThroughput = videoKbps + audioKbps;
        const bwAlpha = 0.2;
        this.avgBw = (this.avgBw === 0) ? totalThroughput : (bwAlpha * totalThroughput + (1 - bwAlpha) * this.avgBw);

        const targetBitrateKbps = (currentTrackInfo.bitrate || 0) / 1000;
        if (targetBitrateKbps <= 0) return;

        if (this.avgBw > 0) {
            console.debug(`[ABR Check] Track:${this.currentTrackId} | AvgFPS:${this.avgFps.toFixed(1)} | AvgBW:${this.avgBw.toFixed(0)}k / Target:${targetBitrateKbps.toFixed(0)}k | DG-Count:${this.downgradeCounter}`);
        }

        // ==========================================
        // 降级逻辑 (Downgrade)
        // ==========================================
        const currentVideoIndex = this.videoTrackIds.indexOf(this.currentTrackId);
        const isLowestVideo = (currentVideoIndex === 0);
        
        const fpsThreshold = isLowestVideo ? 12 : 20; 
        const bwThresholdRatio = isLowestVideo ? 0.5 : 0.7; 

        const isLagging = this.avgFps < fpsThreshold;
        const isBandwidthLow = this.avgBw < (targetBitrateKbps * bwThresholdRatio);
        
        if (this.currentTrackId !== this.audioTrackId) {
            if (isLagging || isBandwidthLow) {
                this.downgradeCounter++;
                this.upgradeCounter = 0;

                if (this.downgradeCounter >= 3) {
                    console.warn(`[ABR] DOWNGRADE TRIGGERED: AvgFPS=${this.avgFps.toFixed(1)}, BW=${this.avgBw.toFixed(0)}k`);
                    
                    if (currentVideoIndex > 0) {
                        const nextId = this.videoTrackIds[currentVideoIndex - 1];
                        this._triggerSwitch(nextId, 'downgrade_video', 5);
                    } else if (currentVideoIndex === 0 && this.audioTrackId !== null) {
                        if (this.avgFps < 10 || this.avgBw < 200) {
                            console.warn("[ABR] Network Critical! Switching to Audio Only.");
                            this._triggerSwitch(this.audioTrackId, 'downgrade_audio', 20);
                        }
                    }
                    this.downgradeCounter = 0; 
                }
            } else {
                if (this.downgradeCounter > 0) this.downgradeCounter--;
            }
        }

        // ==========================================
        // 升级逻辑 (Upgrade)
        // ==========================================
        let canUpgrade = false;
        const timeInAudio = (Date.now() - this.lastSwitchTime) / 1000;
        if (this.currentTrackId === this.audioTrackId && timeInAudio > 15) {
            canUpgrade = true;
            console.log(`[ABR] Audio stable for ${timeInAudio.toFixed(1)}s, probing video...`);
            //this.lastSwitchTime = Date.now();
        } else {
            if (this.avgFps >= 25 && this.avgBw >= (targetBitrateKbps * 0.95)) {
                canUpgrade = true;
            }
        }

        const inRecoveryHold = Date.now() < this.recoveryHoldUntil;
        if (canUpgrade && !inRecoveryHold) {
            this.upgradeCounter++;
            this.downgradeCounter = 0;

            // Audio 模式下，升级计数器阈值可以低一点(尝试更积极)，或者保持一致
            const upgradeThreshold = (this.currentTrackId === this.audioTrackId) ? 2 : 4;

            if (this.upgradeCounter >= upgradeThreshold) {
                let nextId = null;
                
                if (this.currentTrackId === this.audioTrackId) {
                    // Audio -> Lowest Video
                    if (this.videoTrackIds.length > 0) nextId = this.videoTrackIds[0];
                } else {
                    // Video -> Higher Video
                    const currentVideoIndex = this.videoTrackIds.indexOf(this.currentTrackId);
                    if (currentVideoIndex >= 0 && currentVideoIndex < this.videoTrackIds.length - 1) {
                        nextId = this.videoTrackIds[currentVideoIndex + 1];
                    }
                }

                if (nextId !== null) {
                    console.log(`[ABR] UPGRADE: Trying ID ${nextId} (Current: ${this.currentTrackId})`);
                    // Audio 升 Video 后，冷却时间给长一点 (10s)，防止震荡
                    const cooldown = (this.currentTrackId === this.audioTrackId) ? 10 : 5;
                    this._triggerSwitch(nextId, 'upgrade', cooldown);
                }
                this.upgradeCounter = 0;
            }
        } else {
             if (canUpgrade && inRecoveryHold && this.upgradeCounter > 0) {
                this.upgradeCounter = 0;
             }
             if (this.upgradeCounter > 0) this.upgradeCounter--;
        }
    }

    _triggerSwitch(trackId, reason, cooldownTime) {
        if (this.callbacks.onSwitchLayer) {
            this.callbacks.onSwitchLayer(trackId, reason);
        }
        this.abrCooldown = cooldownTime; 
        this.ignoreUpdates = 3; 
        this._resetCounters();
    }
}
