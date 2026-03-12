// main.js - Fixed version with video resume handling

const urlInput = document.getElementById('urlInput');
const vcenterInput = document.getElementById('vcenterInput');
const emailInput = document.getElementById('emailInput');
const appSecretInput = document.getElementById('appSecretInput');
const video = document.getElementById('video');
const statsContainer = document.getElementById('stats');
const layerSelect = document.getElementById('layerSelect');
const wsStatusDot = document.getElementById('wsStatus');
const ENABLE_E2E_DELAY = new URLSearchParams(window.location.search).get('e2e') !== '0';

let reader = null;
let controlClient = null;
let ptsWS = null;
let ptsWSReconnectTimer = null;
let ptsWSConnected = false;
let statsInterval = null;
let lastStats = { videoBytes: 0, audioBytes: 0, timestamp: 0 };
let previousTrackType = null; // Track if we were in audio-only mode
let latestPubPtsFnMs = null;
let lastPubPtsFnMs = null;
let latestPubPtsTsMs = null;
let latestDecodePtsFmMs = null;
let latestRawLagMs = 0;
let latestE2ELagMs = 0;
let latestE2ECalcTsMs = null;
let e2eLagBaseOffsetMs = 0;
let currentStreamPath = '';
let lastLagReportAtMs = 0;
let streamRunId = 0;
let readerPullHealthy = false;
let controlSessionId = null;
let whepRecoverTimer = null;
let whepRecoverAttempts = 0;
const WHEP_RECOVER_MAX_ATTEMPTS = 5;
let currentWebrtcABRWSPath = '';
let controlRecoverTimer = null;
const CONTROL_RECOVER_DELAY_MS = 12000;
const WHEP_REQUEST_TIMEOUT_MS = 15000;

// ABR engine instance
const abrEngine = new ABREngine({
    onSwitchLayer: (trackId, reason) => {
        const currentReaderSessionId = reader ? reader.sessionId : null;
        if (
            controlClient &&
            readerPullHealthy &&
            controlSessionId &&
            currentReaderSessionId &&
            controlSessionId === currentReaderSessionId
        ) {
            console.log(`[Main] ABR Triggered Switch: ${trackId} (${reason})`);
            controlClient.selectLayer(trackId, reason);
        }
    }
});

// Video resolution monitor with dedup logic
let lastWidth = 0;
let lastHeight = 0;
let loadStartTime = 0;
let isFirstFrameLogged = false;

video.addEventListener('resize', () => {
    const w = video.videoWidth;
    const h = video.videoHeight;
    
    // Ignore duplicate resize events (metadata load / browser internal redraw).
    if (w === lastWidth && h === lastHeight) return;
    
    lastWidth = w;
    lastHeight = h;

    const msg = `[Video] Resolution Changed: ${w}x${h}`;
    console.log(`%c${msg}`, 'background: #222; color: #bada55; font-size: 16px; padding: 4px; border-radius: 4px;');
    // showToast(msg);
});

video.addEventListener('loadedmetadata', () => {
    console.log(`[Video] Metadata loaded. Initial size: ${video.videoWidth}x${video.videoHeight}`);
});

// Monitor video state for debugging.
video.addEventListener('waiting', () => {
    console.log('[Video] State: WAITING (buffering)');
});

video.addEventListener('playing', () => {
    if (loadStartTime > 0 && !isFirstFrameLogged) {
        const loadTime = Date.now() - loadStartTime;
        console.log(`[Stats] Video Loaded in: ${loadTime} ms`);
        isFirstFrameLogged = true;
    }
});

video.addEventListener('pause', () => {
    console.log('[Video] State: PAUSED');
});

function showToast(text) {
    const toast = document.createElement('div');
    toast.innerText = text;
    toast.style.cssText = `
        position: absolute; top: 20px; left: 50%; transform: translateX(-50%);
        background: rgba(40, 167, 69, 0.9); color: white; padding: 10px 20px;
        border-radius: 20px; font-weight: bold; z-index: 1000; transition: opacity 0.5s;
    `;
    document.body.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 500);
    }, 3000);
}

document.getElementById('startBtn').addEventListener('click', () => {
    resetWhepRecoverState();
    startStream();
});
document.getElementById('registerBtn').addEventListener('click', registerByEmail);
document.getElementById('exitBtn').addEventListener('click', stopStream);
document.getElementById('pauseBtn').onclick = togglePauseStream;
window.addEventListener('pagehide', () => {
    clearControlRecoverTimer();
    if (controlClient) {
        controlClient.close();
        controlClient = null;
    }
    controlSessionId = null;
    if (reader) {
        reader.close();
        reader = null;
    }
    stopPublisherPtsWS();
});

layerSelect.addEventListener('change', (e) => {
    const val = e.target.value;
    if (val === "auto") {
        abrEngine.setAutoMode(true);
        console.log(`[UI] Switched to AUTO mode`);
    } else {
        abrEngine.setAutoMode(false);
        const trackId = parseInt(val);
        if (!isNaN(trackId) && controlClient) {
            console.log(`[UI] Manual select track: ${trackId}`);
            // Notify engine that a manual switch happened and sync internal state.
            abrEngine.notifyManualSwitch(trackId);
            controlClient.selectLayer(trackId, 'manual_user');
        }
    }
});

async function startStream() {
    stopStream(false);
    const runId = ++streamRunId;

    const inputValue = (urlInput.value || '').trim();
    if (!inputValue) return alert('Please enter streamPath/WhepUrl');

    loadStartTime = Date.now();
    isFirstFrameLogged = false;
    const check = await MediaMTXWebRTCReader.checkSupport();
    if (runId !== streamRunId) return;
    if (!check.supported) {
        alert("Playback Not Supported:\n" + check.error);
        statsContainer.innerHTML = `<div style="color: red; text-align: center;">${check.error}</div>`;
        return;
    }

    statsContainer.innerHTML = '<div style="color: #00bcd4; text-align: center;">Resolving WHEP URL...</div>';
    previousTrackType = null;
    latestPubPtsFnMs = null;
    lastPubPtsFnMs = null;
    latestPubPtsTsMs = null;
    latestDecodePtsFmMs = null;
    latestRawLagMs = 0;
    latestE2ELagMs = 0;
    latestE2ECalcTsMs = null;
    e2eLagBaseOffsetMs = 0;
    lastLagReportAtMs = 0;
    readerPullHealthy = false;
    let streamPath = '';
    let rawWhepUrl = '';
    let abrWSPath = '';
    if (isValidWhepUrl(inputValue)) {
        rawWhepUrl = inputValue;
        streamPath = extractStreamPathFromWhep(rawWhepUrl);
    } else {
        streamPath = inputValue;
        const resolved = await resolveWhepUrlForStream(streamPath);
        rawWhepUrl = resolved ? resolved.whepUrl : '';
        abrWSPath = resolved ? (resolved.webrtcABRWSPath || '') : '';
    }
    if (runId !== streamRunId) return;
    if (!rawWhepUrl) {
        statsContainer.innerHTML = '<div style="color: red; text-align: center;">Failed to resolve WHEP URL from vcenter</div>';
        return;
    }
    currentStreamPath = streamPath;
    currentWebrtcABRWSPath = abrWSPath;

    const url = await ensureSignedWhepUrl(rawWhepUrl);
    if (runId !== streamRunId) return;
    if (!url) {
        statsContainer.innerHTML = '<div style="color: red; text-align: center;">Failed to get auth token from vcenter</div>';
        return;
    }
    console.log(`[Play] streamPath=${streamPath || '(from url)'}, whep=${url}, abr=${currentWebrtcABRWSPath || '(default)'}`);

    statsContainer.innerHTML = '<div style="color: #00bcd4; text-align: center;">Connecting WHEP...</div>';
    currentStreamPath = extractStreamPathFromWhep(url) || streamPath;
    if (ENABLE_E2E_DELAY) {
        startPublisherPtsWS();
    }

    reader = new MediaMTXWebRTCReader({
        // Reader callbacks
        url: url,
        maxBitrate: 2500, 
        requestTimeoutMs: WHEP_REQUEST_TIMEOUT_MS,
        onTrack: (evt) => {
            if (runId !== streamRunId) return;
            if (evt.track.kind === 'video' || evt.track.kind === 'audio') {
                readerPullHealthy = true;
                if (video.srcObject !== evt.streams[0]) {
                    video.srcObject = evt.streams[0];
                }
            }
        },
        onError: (err) => {
            if (runId !== streamRunId) return;
            console.error("Reader Error:", err);
            abrEngine.enterRecoveryMode('reader_error', 25);
            clearControlRecoverTimer();
            readerPullHealthy = false;
            clearE2EStats();
            // Stop reader internal retry loop and rely on outer recover flow only.
            if (reader) {
                reader.close();
                reader = null;
            }
            if (controlClient) {
                controlClient.close();
                controlClient = null;
            }
            controlSessionId = null;
            scheduleWhepRecover(runId, err);
        },
        onConnected: () => {
            if (runId !== streamRunId) return;
            abrEngine.enterRecoveryMode('whep_connected', 12);
            resetWhepRecoverState();
            const sessionId = reader.sessionId;
            console.log(`[Glue] WHEP Connected. SessionID: ${sessionId}`);
            if (sessionId) {
                // Rebind control channel whenever session changes.
                if (controlClient && controlSessionId !== sessionId) {
                    controlClient.close();
                    controlClient = null;
                }
                if (!controlClient) {
                    initControlClient(url, sessionId, currentWebrtcABRWSPath);
                }
            }
        }
    });

    lastStats.timestamp = Date.now();
    statsInterval = setInterval(updateStats, 1000);
}

async function ensureSignedWhepUrl(rawWhepUrl) {
    try {
        const u = new URL(rawWhepUrl);
        if (u.searchParams.get('txSecret') && u.searchParams.get('txTime')) {
            return u.toString();
        }

        const streamPath = extractStreamPathFromWhep(rawWhepUrl);
        if (!streamPath) {
            console.warn('[AUTH] cannot parse streamPath from whep url');
            return rawWhepUrl;
        }
        if (!streamPath.includes('/')) {
            throw new Error(`invalid streamPath, expected appId/stream: ${streamPath}`);
        }

        const appSecret = (appSecretInput && appSecretInput.value ? appSecretInput.value.trim() : '');
        if (!appSecret) {
            throw new Error('missing appSecret');
        }
        const txTime = Math.floor(Date.now() / 1000 + 24 * 3600).toString(16);
        const txSecret = await md5Hex(appSecret + streamPath + txTime.toUpperCase());
        u.searchParams.set('txSecret', txSecret);
        u.searchParams.set('txTime', txTime);
        return u.toString();
    } catch (err) {
        console.error('[AUTH] ensureSignedWhepUrl failed:', err);
        return null;
    }
}

async function registerByEmail() {
    try {
        const email = (emailInput && emailInput.value ? emailInput.value.trim() : '');
        if (!email) {
            alert('Please input e-mail');
            return;
        }
        const base = resolveVcenterHttpBase();
        if (!base) {
            alert('vcenter HTTP is empty');
            return;
        }
        const resp = await fetch(`${base}/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email })
        });
        const payload = await resp.json().catch(() => ({}));
        if (!resp.ok) {
            const msg = payload && payload.msg ? payload.msg : `register failed: ${resp.status}`;
            alert(msg);
            return;
        }
        const appId = payload && payload.data && payload.data.appId ? payload.data.appId : '';
        const trialU = payload && payload.data && payload.data.trialU ? payload.data.trialU : 50;
        alert(`Register success. appId=${appId}, trial=${trialU}U. Please check email for appSecret.`);
    } catch (err) {
        console.error('[AUTH] register failed:', err);
        alert(`register failed: ${err}`);
    }
}

async function md5Hex(text) {
    function cmn(q, a, b, x, s, t) {
        a = (a + q + x + t) | 0;
        return (((a << s) | (a >>> (32 - s))) + b) | 0;
    }
    function ff(a, b, c, d, x, s, t) { return cmn((b & c) | ((~b) & d), a, b, x, s, t); }
    function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & (~d)), a, b, x, s, t); }
    function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
    function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | (~d)), a, b, x, s, t); }
    function md5blk(s) {
        const md5blks = [];
        for (let i = 0; i < 64; i += 4) {
            md5blks[i >> 2] = s.charCodeAt(i) + (s.charCodeAt(i + 1) << 8) + (s.charCodeAt(i + 2) << 16) + (s.charCodeAt(i + 3) << 24);
        }
        return md5blks;
    }
    function md5cycle(x, k) {
        let a = x[0], b = x[1], c = x[2], d = x[3];
        a = ff(a, b, c, d, k[0], 7, -680876936); d = ff(d, a, b, c, k[1], 12, -389564586); c = ff(c, d, a, b, k[2], 17, 606105819); b = ff(b, c, d, a, k[3], 22, -1044525330);
        a = ff(a, b, c, d, k[4], 7, -176418897); d = ff(d, a, b, c, k[5], 12, 1200080426); c = ff(c, d, a, b, k[6], 17, -1473231341); b = ff(b, c, d, a, k[7], 22, -45705983);
        a = ff(a, b, c, d, k[8], 7, 1770035416); d = ff(d, a, b, c, k[9], 12, -1958414417); c = ff(c, d, a, b, k[10], 17, -42063); b = ff(b, c, d, a, k[11], 22, -1990404162);
        a = ff(a, b, c, d, k[12], 7, 1804603682); d = ff(d, a, b, c, k[13], 12, -40341101); c = ff(c, d, a, b, k[14], 17, -1502002290); b = ff(b, c, d, a, k[15], 22, 1236535329);
        a = gg(a, b, c, d, k[1], 5, -165796510); d = gg(d, a, b, c, k[6], 9, -1069501632); c = gg(c, d, a, b, k[11], 14, 643717713); b = gg(b, c, d, a, k[0], 20, -373897302);
        a = gg(a, b, c, d, k[5], 5, -701558691); d = gg(d, a, b, c, k[10], 9, 38016083); c = gg(c, d, a, b, k[15], 14, -660478335); b = gg(b, c, d, a, k[4], 20, -405537848);
        a = gg(a, b, c, d, k[9], 5, 568446438); d = gg(d, a, b, c, k[14], 9, -1019803690); c = gg(c, d, a, b, k[3], 14, -187363961); b = gg(b, c, d, a, k[8], 20, 1163531501);
        a = gg(a, b, c, d, k[13], 5, -1444681467); d = gg(d, a, b, c, k[2], 9, -51403784); c = gg(c, d, a, b, k[7], 14, 1735328473); b = gg(b, c, d, a, k[12], 20, -1926607734);
        a = hh(a, b, c, d, k[5], 4, -378558); d = hh(d, a, b, c, k[8], 11, -2022574463); c = hh(c, d, a, b, k[11], 16, 1839030562); b = hh(b, c, d, a, k[14], 23, -35309556);
        a = hh(a, b, c, d, k[1], 4, -1530992060); d = hh(d, a, b, c, k[4], 11, 1272893353); c = hh(c, d, a, b, k[7], 16, -155497632); b = hh(b, c, d, a, k[10], 23, -1094730640);
        a = hh(a, b, c, d, k[13], 4, 681279174); d = hh(d, a, b, c, k[0], 11, -358537222); c = hh(c, d, a, b, k[3], 16, -722521979); b = hh(b, c, d, a, k[6], 23, 76029189);
        a = hh(a, b, c, d, k[9], 4, -640364487); d = hh(d, a, b, c, k[12], 11, -421815835); c = hh(c, d, a, b, k[15], 16, 530742520); b = hh(b, c, d, a, k[2], 23, -995338651);
        a = ii(a, b, c, d, k[0], 6, -198630844); d = ii(d, a, b, c, k[7], 10, 1126891415); c = ii(c, d, a, b, k[14], 15, -1416354905); b = ii(b, c, d, a, k[5], 21, -57434055);
        a = ii(a, b, c, d, k[12], 6, 1700485571); d = ii(d, a, b, c, k[3], 10, -1894986606); c = ii(c, d, a, b, k[10], 15, -1051523); b = ii(b, c, d, a, k[1], 21, -2054922799);
        a = ii(a, b, c, d, k[8], 6, 1873313359); d = ii(d, a, b, c, k[15], 10, -30611744); c = ii(c, d, a, b, k[6], 15, -1560198380); b = ii(b, c, d, a, k[13], 21, 1309151649);
        a = ii(a, b, c, d, k[4], 6, -145523070); d = ii(d, a, b, c, k[11], 10, -1120210379); c = ii(c, d, a, b, k[2], 15, 718787259); b = ii(b, c, d, a, k[9], 21, -343485551);
        x[0] = (x[0] + a) | 0; x[1] = (x[1] + b) | 0; x[2] = (x[2] + c) | 0; x[3] = (x[3] + d) | 0;
    }
    function md51(s) {
        const n = s.length;
        const state = [1732584193, -271733879, -1732584194, 271733878];
        let i;
        for (i = 64; i <= n; i += 64) md5cycle(state, md5blk(s.substring(i - 64, i)));
        s = s.substring(i - 64);
        const tail = new Array(16).fill(0);
        for (i = 0; i < s.length; i++) tail[i >> 2] |= s.charCodeAt(i) << ((i % 4) << 3);
        tail[i >> 2] |= 0x80 << ((i % 4) << 3);
        if (i > 55) { md5cycle(state, tail); for (let j = 0; j < 16; j++) tail[j] = 0; }
        tail[14] = n * 8;
        md5cycle(state, tail);
        return state;
    }
    function rhex(n) {
        let s = '';
        const hexChr = '0123456789abcdef';
        for (let j = 0; j < 4; j++) {
            s += hexChr.charAt((n >> (j * 8 + 4)) & 0x0F) + hexChr.charAt((n >> (j * 8)) & 0x0F);
        }
        return s;
    }
    return md51(unescape(encodeURIComponent(text))).map(rhex).join('');
}

function startPublisherPtsWS() {
    stopPublisherPtsWS();
    const wsUrl = resolveVcenterPlayWsUrl(currentStreamPath);
    if (!wsUrl) return;

    try {
        ptsWS = new WebSocket(wsUrl);
    } catch (err) {
        console.warn('[PTS] ws connect failed:', err);
        ptsWSConnected = false;
        clearE2EStats();
        schedulePublisherPtsWSReconnect();
        return;
    }

    ptsWS.onopen = () => {
        ptsWSConnected = true;
    };

    ptsWS.onmessage = (evt) => {
        if (!ptsWSConnected) return;
        try {
            const msg = JSON.parse(evt.data);
            if (!msg || msg.type !== 'PUB_PTS') return;
            const pts = Number(msg.ptsFnMs);
            if (Number.isNaN(pts)) return;
            latestPubPtsFnMs = pts;
            latestPubPtsTsMs = Date.now();
            updateE2ELagAndMaybeReport();
        } catch (err) {
            console.warn('[PTS] invalid ws payload:', err);
        }
    };

    ptsWS.onclose = () => {
        ptsWS = null;
        ptsWSConnected = false;
        clearE2EStats();
        schedulePublisherPtsWSReconnect();
    };

    ptsWS.onerror = () => {
        ptsWSConnected = false;
        clearE2EStats();
        if (ptsWS) {
            try { ptsWS.close(); } catch (_) {}
        }
    };
}

function stopPublisherPtsWS() {
    ptsWSConnected = false;
    clearE2EStats();
    if (ptsWSReconnectTimer) {
        clearTimeout(ptsWSReconnectTimer);
        ptsWSReconnectTimer = null;
    }
    if (ptsWS) {
        try { ptsWS.close(); } catch (_) {}
        ptsWS = null;
    }
}

function clearE2EStats() {
    latestPubPtsFnMs = null;
    lastPubPtsFnMs = null;
    latestPubPtsTsMs = null;
    latestDecodePtsFmMs = null;
    latestRawLagMs = 0;
    latestE2ELagMs = 0;
    latestE2ECalcTsMs = null;
    e2eLagBaseOffsetMs = 0;
}

function schedulePublisherPtsWSReconnect() {
    if (!ENABLE_E2E_DELAY) return;
    if (ptsWSReconnectTimer || !reader) return;
    ptsWSReconnectTimer = setTimeout(() => {
        ptsWSReconnectTimer = null;
        if (reader) startPublisherPtsWS();
    }, 10000);
}

function extractStreamPathFromWhep(whepUrl) {
    try {
        const u = new URL(whepUrl);
        const path = (u.pathname || '').replace(/^\/+/, '');
        if (!path) return '';
        if (path.endsWith('/whep')) {
            return path.slice(0, -'/whep'.length);
        }
        return path;
    } catch (_) {
        return '';
    }
}

function resolveVcenterHttpBase() {
    if (vcenterInput && vcenterInput.value && vcenterInput.value.trim()) {
        return vcenterInput.value.trim().replace(/\/+$/, '');
    }

    const query = new URLSearchParams(window.location.search);
    const explicit = query.get('vcenterHttp');
    if (explicit) {
        return explicit.replace(/\/+$/, '');
    }
    if (!window.location || !window.location.origin) return '';
    return window.location.origin.replace(/\/+$/, '');
}

function resolveVcenterPlayWsUrl(streamPath) {
    const wsBase = resolveVcenterPlayWsBase();
    if (!wsBase) return '';
    const path = encodeURIComponent(streamPath || '');
    return `${wsBase}/ws/play?streamPath=${path}`;
}

function scheduleWhepRecover(runId, err) {
    if (!currentStreamPath) {
        statsContainer.innerHTML = `<div style="color: red; text-align: center;">${err}</div>`;
        return;
    }
    if (whepRecoverTimer) return;

    if (whepRecoverAttempts >= WHEP_RECOVER_MAX_ATTEMPTS) {
        statsContainer.innerHTML = `<div style="color: red; text-align: center;">Playback failed after ${WHEP_RECOVER_MAX_ATTEMPTS} retries: ${err}</div>`;
        return;
    }

    whepRecoverAttempts += 1;
    const delayMs = Math.min(3000 * whepRecoverAttempts, 15000);
    const delaySec = Math.round(delayMs / 1000);
    statsContainer.innerHTML = `<div style="color: #ff9800; text-align: center;">Playback error. Refreshing WHEP URL and retrying in ${delaySec}s... (${whepRecoverAttempts}/${WHEP_RECOVER_MAX_ATTEMPTS})</div>`;

    whepRecoverTimer = setTimeout(() => {
        whepRecoverTimer = null;
        if (runId !== streamRunId) return;
        if (!currentStreamPath) return;

        // Force next start to resolve a fresh WHEP URL from vcenter.
        urlInput.value = currentStreamPath;
        startStream();
    }, delayMs);
}

function resetWhepRecoverState() {
    whepRecoverAttempts = 0;
    if (whepRecoverTimer) {
        clearTimeout(whepRecoverTimer);
        whepRecoverTimer = null;
    }
}

function clearControlRecoverTimer() {
    if (controlRecoverTimer) {
        clearTimeout(controlRecoverTimer);
        controlRecoverTimer = null;
    }
}

function scheduleControlRecover(runId, reason) {
    if (controlRecoverTimer) return;
    if (!currentStreamPath) return;

    controlRecoverTimer = setTimeout(() => {
        controlRecoverTimer = null;
        if (runId !== streamRunId) return;
        if (!reader) return;
        if (controlClient && controlClient.connected) return;

        console.warn(`[Recover] ABR control channel remained disconnected for ${CONTROL_RECOVER_DELAY_MS}ms, restarting stream. reason=${reason || 'unknown'}`);
        readerPullHealthy = false;
        clearE2EStats();
        if (reader) {
            try { reader.close(); } catch (_) {}
            reader = null;
        }
        if (controlClient) {
            try { controlClient.close(); } catch (_) {}
            controlClient = null;
        }
        controlSessionId = null;

        urlInput.value = currentStreamPath;
        startStream();
    }, CONTROL_RECOVER_DELAY_MS);
}

function isValidWhepUrl(input) {
    if (!input) return false;
    try {
        const u = new URL(input);
        const p = (u.pathname || '').toLowerCase();
        return (u.protocol === 'http:' || u.protocol === 'https:') && p.endsWith('/whep');
    } catch (_) {
        return false;
    }
}

function resolveVcenterPlayWsBase() {
    const httpBase = resolveVcenterHttpBase();
    if (!httpBase) return '';
    try {
        const u = new URL(httpBase);
        const wsProtocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
        return `${wsProtocol}//${u.host}`;
    } catch (_) {
        return '';
    }
}

async function resolveWhepUrlForStream(streamPath) {
    const fromWS = await resolveWhepUrlViaWS(streamPath);
    if (fromWS) return fromWS;
    return await resolveWhepUrlViaHTTP(streamPath);
}

async function resolveWhepUrlViaWS(streamPath) {
    const wsBase = resolveVcenterPlayWsBase();
    if (!wsBase) return null;
    const wsUrl = `${wsBase}/ws/play`;

    return await new Promise((resolve) => {
        let done = false;
        let timer = null;
        let ws = null;
        const finish = (url) => {
            if (done) return;
            done = true;
            if (timer) clearTimeout(timer);
            if (ws) {
                try { ws.close(); } catch (_) {}
            }
            resolve(url || null);
        };

        try {
            ws = new WebSocket(wsUrl);
        } catch (err) {
            console.warn('[Play] WS resolve connect failed:', err);
            finish(null);
            return;
        }

        timer = setTimeout(() => finish(null), 3000);

        ws.onopen = () => {
            const req = {
                type: 'GET_WHEP_URL',
                streamPath: streamPath,
                region: ''
            };
            try {
                ws.send(JSON.stringify(req));
            } catch (_) {
                finish(null);
            }
        };

        ws.onmessage = (evt) => {
            try {
                const msg = JSON.parse(evt.data);
                if (!msg || msg.type !== 'WHEP_URL') return;
                if (msg.streamPath && msg.streamPath !== streamPath) return;
                if (Number(msg.code) === 0 && msg.whepUrl) {
                    finish({
                        whepUrl: String(msg.whepUrl),
                        webrtcABRWSPath: String(msg.webrtcABRWSPath || '')
                    });
                    return;
                }
                finish(null);
            } catch (_) {
            }
        };

        ws.onerror = () => finish(null);
        ws.onclose = () => finish(null);
    });
}

async function resolveWhepUrlViaHTTP(streamPath) {
    const base = resolveVcenterHttpBase();
    if (!base) return null;
    try {
        const resp = await fetch(`${base}/api/play/edgeNode`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                expTime: 0,
                streamId: streamPath,
                region: ''
            })
        });
        if (!resp.ok) return null;
        const payload = await resp.json();
        if (!payload || Number(payload.code) !== 0) return null;
        const data = payload.data || {};
        if (data.recommended) {
            return {
                whepUrl: String(data.recommended),
                webrtcABRWSPath: String(data.webrtcABRWSPath || '')
            };
        }
        if (Array.isArray(data.edges) && data.edges.length > 0 && data.edges[0].webrtcPlayUrl) {
            return {
                whepUrl: String(data.edges[0].webrtcPlayUrl),
                webrtcABRWSPath: String(data.edges[0].webrtcABRWSPath || '')
            };
        }
        return null;
    } catch (err) {
        console.warn('[Play] HTTP edgeNode fallback failed:', err);
        return null;
    }
}

function getCurrentDecodePtsFmMs() {
    if (!video || Number.isNaN(video.currentTime) || !Number.isFinite(video.currentTime)) {
        return null;
    }
    if (video.currentTime < 0) return null;
    return Math.round(video.currentTime * 1000);
}

function updateE2ELagAndMaybeReport() {
    if (!ptsWSConnected) return;
    if (latestPubPtsFnMs === null || Number.isNaN(latestPubPtsFnMs)) return;
    const ptsFmMs = getCurrentDecodePtsFmMs();
    if (ptsFmMs === null) return;

    // vpublisher restart can reset pts_fn back to a small value.
    // Detect large backward jump and re-calibrate baseline immediately.
    if (lastPubPtsFnMs !== null && latestPubPtsFnMs+1000 < lastPubPtsFnMs) {
        e2eLagBaseOffsetMs = latestPubPtsFnMs - ptsFmMs;
        lastLagReportAtMs = 0;
    }
    lastPubPtsFnMs = latestPubPtsFnMs;

    latestDecodePtsFmMs = ptsFmMs;
    latestRawLagMs = latestPubPtsFnMs - ptsFmMs;
    // Publisher PTS and local decode clock don't share a zero point.
    // Use the first valid sample as baseline, then track relative lag.
    if (latestE2ECalcTsMs === null || !Number.isFinite(e2eLagBaseOffsetMs)) {
        e2eLagBaseOffsetMs = latestRawLagMs;
    }
    
    latestE2ELagMs = latestRawLagMs - e2eLagBaseOffsetMs;
    if (latestE2ELagMs < 0) {
        // Guard against transient negative values after restart / clock drift.
        latestE2ELagMs = 0;
    }
    latestE2ECalcTsMs = Date.now();

    if (!isLagReportAllowed()) return;

    // Keep lag non-negative for reporting/storage.
    const reportLag = Math.max(0, Math.round(latestE2ELagMs));
    if (reportLag <= 2000 || !currentStreamPath) return;

    if ((Date.now() - lastLagReportAtMs) < 3000) return;
    lastLagReportAtMs = Date.now();

    const base = resolveVcenterHttpBase();
    if (!base) return;
    fetch(`${base}/api/play/lag`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            streamPath: currentStreamPath,
            lagDuration: reportLag
        })
    }).catch((err) => {
        console.warn('[PTS] report lag failed:', err);
    });
}

function isLagReportAllowed() {
    if (!readerPullHealthy) return false;
    if (!reader || !reader.pc) return false;
    if (reader.pc.connectionState !== 'connected') return false;
    if (latestE2ECalcTsMs === null) return false;
    if ((Date.now() - latestE2ECalcTsMs) > 5000) return false;
    return true;
}

function initControlClient(whepUrl, sessionId, webrtcABRWSPath) {
    clearControlRecoverTimer();
    controlSessionId = sessionId;
    controlClient = new MMXControlClient(whepUrl, sessionId, {
        onConnected: () => {
            clearControlRecoverTimer();
            abrEngine.enterRecoveryMode('control_ws_connected', 10);
            wsStatusDot.classList.remove('ws-disconnected');
            wsStatusDot.classList.add('ws-connected');
            layerSelect.disabled = false;
            layerSelect.innerHTML = '<option value="-1">Loading...</option>';
        },
        onDisconnected: () => {
            abrEngine.enterRecoveryMode('control_ws_disconnected', 20);
            wsStatusDot.classList.remove('ws-connected');
            wsStatusDot.classList.add('ws-disconnected');
            layerSelect.disabled = true;
            scheduleControlRecover(streamRunId, 'ws_disconnected');
        },
        onServerError: (message) => {
            if (typeof message === 'string' && message.toLowerCase().includes('session not found')) {
                controlSessionId = null;
                scheduleControlRecover(streamRunId, 'session_not_found');
            }
        },
        onTracksInfo: (tracks, activeId) => {
            console.log("[UI] Received Tracks Info:", tracks);
            
            // Use current rendered video width to help ABR detect real initial state.
            const currentVideoWidth = video.videoWidth || 0;
            abrEngine.setTracks(tracks, activeId, currentVideoWidth);
            
            if (!layerSelect.disabled){
                updateLayerSelectUI(tracks, activeId);
            }
        },
        onLayerSwitched: (id) => {
            console.log("[UI] Received Track switch:", id);

            const currentTrack = abrEngine.trackRegistry[id];
            const wasAudioOnly = previousTrackType === 'audio';
            const isNowVideo = currentTrack && currentTrack.type === 'video';
            
            if (wasAudioOnly && isNowVideo) {
                console.log('[Main] Resuming from audio-only to video - forcing video play');
                handleVideoResume();
            }
            
            previousTrackType = currentTrack ? currentTrack.type : null;
            abrEngine.notifyLayerSwitched(id);
            
            if (!abrEngine.isAutoMode && !layerSelect.disabled) {
                layerSelect.value = id;
            }
        }
    }, webrtcABRWSPath);
}

// Handle video resume after audio-only mode.
function handleVideoResume() {
    if (!video || !video.srcObject) {
        console.warn('[Main] Cannot resume video - no video element or stream');
        return;
    }
    
    // Strategy 1: Ensure video is not paused
    if (video.paused) {
        console.log('[Main] Video is paused, attempting to play...');
        video.play().catch(err => {
            console.warn('[Main] Auto-play failed:', err);
        });
    }
    
    // Strategy 2: Force a small seek to trigger rendering
    // This helps in cases where the video element is "stuck"
    setTimeout(() => {
        if (video.readyState >= 2) { // HAVE_CURRENT_DATA or better
            const currentTime = video.currentTime;
            if (currentTime > 0.01) {
                video.currentTime = currentTime - 0.01;
                console.log('[Main] Applied micro-seek to trigger video rendering');
            }
        }
    }, 100);
    
    // Strategy 3: Force video element refresh
    // Some browsers need this to properly resume video rendering
    setTimeout(() => {
        if (video.paused && video.srcObject) {
            console.log('[Main] Video still paused after 500ms, forcing play');
            video.play().catch(err => {
                console.warn('[Main] Delayed auto-play failed:', err);
            });
        }
    }, 500);
}

function updateLayerSelectUI(tracks, activeId) {
    layerSelect.innerHTML = '';
    
    const autoOption = document.createElement('option');
    autoOption.value = 'auto';
    autoOption.text = 'Auto (ABR)';
    layerSelect.appendChild(autoOption);

    const videos = tracks.filter(t => t.type === 'video');
    // UI display: bitrate sorted high to low.
    videos.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

    videos.forEach(t => {
        const option = document.createElement('option');
        option.value = t.id;
        let label = t.label || `Video ${t.id}`;
        if (t.height) label += ` (${t.height}p)`;
        if (t.bitrate) label += ` ${(t.bitrate/1000).toFixed(0)}k`;
        option.text = label;
        layerSelect.appendChild(option);
    });

    const audios = tracks.filter(t => t.type === 'audio');
    if (audios.length > 0) {
        const audioT = audios[0];
        const option = document.createElement('option');
        option.value = audioT.id;
        option.text = `Audio Only (${(audioT.bitrate/1000).toFixed(0)}k)`;
        option.style.fontWeight = 'bold';
        option.style.color = '#ff9800'; 
        layerSelect.appendChild(option);
    }

    if (activeId !== undefined && activeId !== null) {
        if (!abrEngine.isAutoMode) {
            layerSelect.value = activeId;
        } else {
            layerSelect.value = 'auto';
        }
    }
}

function stopStream(invalidateRun = true) {
    if (invalidateRun) {
        streamRunId++;
    }
    if (controlClient) {
        controlClient.close();
        controlClient = null;
    }
    controlSessionId = null;
    if (reader) {
        reader.close();
        reader = null;
    }
    if (statsInterval) {
        clearInterval(statsInterval);
        statsInterval = null;
    }
    if (invalidateRun) {
        resetWhepRecoverState();
    }
    clearControlRecoverTimer();
    stopPublisherPtsWS();
    video.srcObject = null;
    statsContainer.innerHTML = '<div style="color: #888; text-align: center;">Stopped</div>';
    
    wsStatusDot.classList.remove('ws-connected');
    wsStatusDot.classList.remove('ws-disconnected');
    layerSelect.disabled = true;
    layerSelect.innerHTML = '<option value="-1">Auto</option>';
    
    abrEngine.setAutoMode(true);
    previousTrackType = null;
    latestPubPtsFnMs = null;
    lastPubPtsFnMs = null;
    latestPubPtsTsMs = null;
    latestDecodePtsFmMs = null;
    latestRawLagMs = 0;
    latestE2ELagMs = 0;
    latestE2ECalcTsMs = null;
    e2eLagBaseOffsetMs = 0;
    currentStreamPath = '';
    currentWebrtcABRWSPath = '';
    lastLagReportAtMs = 0;
    readerPullHealthy = false;
    loadStartTime = 0;
    isFirstFrameLogged = false;
    isPaused = false;
    const pauseBtn = document.getElementById('pauseBtn');
    if (pauseBtn) pauseBtn.innerText = "Pause";
    video.style.opacity = '1';
}

async function updateStats() {
    if (!reader || !reader.pc) return;
    const pc = reader.pc;
    if (pc.connectionState !== 'connected' && pc.connectionState !== 'checking') return;

    try {
        const stats = await pc.getStats();
        const now = Date.now();
        const deltaTime = (now - lastStats.timestamp) / 1000;
        if (deltaTime <= 0) return;

        let videoStats = null;
        let audioStats = null;
        let networkStats = null;
        // Used to resolve codec names.
        const codecs = new Map(); 

        stats.forEach(report => {
            if (report.type === 'inbound-rtp' && report.kind === 'video') videoStats = report;
            if (report.type === 'inbound-rtp' && report.kind === 'audio') audioStats = report;
            if (report.type === 'candidate-pair' && report.state === 'succeeded') networkStats = report;
            // Collect codec info.
            if (report.type === 'codec') {
                codecs.set(report.id, report.mimeType); // e.g. "video/H264"
            }
        });

        // --- Calculate real-time metrics ---
        let videoKbps = 0;
        let audioKbps = 0;
        let fps = 0;
        let currentPacketLoss = 0;

        if (videoStats) {
            videoKbps = ((videoStats.bytesReceived - lastStats.videoBytes) * 8 / deltaTime / 1000);
            fps = videoStats.framesPerSecond || 0;
            const vLoss = (videoStats.packetsLost || 0) - (lastStats.videoPacketsLost || 0);
            if (vLoss > 0) currentPacketLoss += vLoss;
            lastStats.videoBytes = videoStats.bytesReceived;
            lastStats.videoPacketsLost = videoStats.packetsLost || 0;
        }

        if (audioStats) {
            audioKbps = ((audioStats.bytesReceived - lastStats.audioBytes) * 8 / deltaTime / 1000);
            const aLoss = (audioStats.packetsLost || 0) - (lastStats.audioPacketsLost || 0);
            if (aLoss > 0) currentPacketLoss += aLoss;
            lastStats.audioBytes = audioStats.bytesReceived;
            lastStats.audioPacketsLost = audioStats.packetsLost || 0;
        }

        lastStats.timestamp = now;

        // --- Update ABR engine ---
        if (abrEngine) {
            abrEngine.update(videoKbps, audioKbps, fps, currentPacketLoss);
        }

        // --- Render UI ---
        let html = '';

        if (videoStats) {
            const displayW = video.videoWidth || videoStats.frameWidth || 0;
            const displayH = video.videoHeight || videoStats.frameHeight || 0;
            
            // Resolve video codec name.
            let vCodec = 'N/A';
            if (videoStats.codecId && codecs.has(videoStats.codecId)) {
                // mimeType is usually "video/H264"; keep codec part only.
                vCodec = codecs.get(videoStats.codecId).split('/')[1] || 'Unknown';
            }

            html += renderStatGroup('Video', {
                'Codec': vCodec, // display
                'Resolution': `${displayW}x${displayH}`,
                'Recv Bitrate': `${videoKbps.toFixed(0)} kbps`,
                'FPS': fps.toFixed(1),
                'Packet Loss': `${videoStats.packetsLost} pkts`
            });
        }

        if (audioStats) {
            // Resolve audio codec name.
            let aCodec = 'N/A';
            if (audioStats.codecId && codecs.has(audioStats.codecId)) {
                aCodec = codecs.get(audioStats.codecId).split('/')[1] || 'Unknown';
            }

            html += renderStatGroup('Audio', {
                'Codec': aCodec, // display
                'Recv Bitrate': `${audioKbps.toFixed(0)} kbps`,
                'Packet Loss': `${audioStats.packetsLost} pkts`,
                'Jitter': `${(audioStats.jitter * 1000).toFixed(1)} ms`
            });
        }

        if (networkStats) {
            let bw = 'N/A';
            if (networkStats.availableIncomingBitrate) {
                bw = `${(networkStats.availableIncomingBitrate / 1000).toFixed(0)} kbps`;
            }
            
            let abrStatus = (abrEngine && abrEngine.isAutoMode) ? 'Auto' : 'Manual';
            if (abrEngine && abrEngine.abrCooldown > 0) abrStatus += ` (Cool ${abrEngine.abrCooldown})`;

            html += renderStatGroup('Network', {
                'RTT': `${(networkStats.currentRoundTripTime * 1000).toFixed(1)} ms`,
                'Est. Bandwidth': bw,
                'ABR State': abrStatus
            });
        }

        if (ENABLE_E2E_DELAY && latestPubPtsFnMs !== null && !Number.isNaN(latestPubPtsFnMs)) {
            let age = 'N/A';
            if (latestPubPtsTsMs !== null && !Number.isNaN(latestPubPtsTsMs)) {
                age = `${Math.max(0, Date.now() - latestPubPtsTsMs)} ms`;
            }

            const e2eLagText = (latestE2ELagMs !== null && !Number.isNaN(latestE2ELagMs))
                ? `${Math.round(latestE2ELagMs)} ms`
                : 'N/A';
            const rawLagText = (latestRawLagMs !== null && !Number.isNaN(latestRawLagMs))
                ? `${Math.round(latestRawLagMs)} ms`
                : 'N/A';

            html += renderStatGroup('E2E-delay', {
                // 'Raw Lag(fn-fm)': rawLagText,
                'E2E Lag(fn-fm)': e2eLagText
            });
        }

        if (html) statsContainer.innerHTML = html;

    } catch (e) {
        console.warn("Error updating stats:", e);
    }
}

function renderStatGroup(title, data) {
    let rows = '';
    for (const [key, value] of Object.entries(data)) {
        let valClass = '';
        if (key === 'Packet Loss' && parseInt(value) > 0) valClass = 'warn';
        if (key === 'Est. Bandwidth') valClass = 'good';
        rows += `<div class="stat-row"><span class="stat-key">${key}:</span><span class="stat-val ${valClass}">${value}</span></div>`;
    }
    return `<div class="stat-group"><div class="stat-title">${title}</div>${rows}</div>`;
}

let isPaused = false;

function togglePauseStream() {
    if (!reader) {
        // startStream(); // if needed, can start full flow here
        return;
    }

    if (!isPaused) {
        // === Pause ===
        console.log("[Action] Pausing stream (Switching to Audio Only to save BW)...");
        layerSelect.disabled = true;
        
        // 1. Switch to Audio Only through WS.
        // Use abrEngine.audioTrackId when available.
        if (abrEngine.audioTrackId !== null) {
            controlClient.selectLayer(abrEngine.audioTrackId, 'user_pause');
        }
        
        // 2. Stop ABR interference.
        abrEngine.setAutoMode(false);
        
        // 3. Update UI.
        video.style.opacity = '0.5'; // dim video
        // statsContainer.innerHTML += '<div style="color:yellow">PAUSED (Audio Keep-alive)</div>';
        
        isPaused = true;
        document.getElementById('pauseBtn').innerText = "Resume";
    } else {
        // === Resume ===
        console.log("[Action] Resuming stream (Switching back to Auto)...");
        layerSelect.disabled = false;
        
        // 1. Resume ABR (it will switch to an appropriate video layer).
        abrEngine.setAutoMode(true);
        
        // 2. Optional: trigger an immediate manual upgrade.
        // For example switch directly to Video High (ID 0).
        controlClient.selectLayer(0, 'user_resume'); 
        
        // 3. Restore UI.
        video.style.opacity = '1';
        
        isPaused = false;
        document.getElementById('pauseBtn').innerText = "Pause";
    }
}


