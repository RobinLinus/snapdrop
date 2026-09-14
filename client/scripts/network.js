window.URL = window.URL || window.webkitURL;
window.isRtcSupported = !!(window.RTCPeerConnection || window.mozRTCPeerConnection || window.webkitRTCPeerConnection);
class ConnectionLog {
    static write(event, details = {}) {
        const line = 'Snapdrop: ' + JSON.stringify({
            version: 2, time: new Date().toISOString(), page: ConnectionLog.page, event, ...details,
            clientVersion: ConnectionLog.clientVersion
        });
        if (event.endsWith('-error')) console.error(line);
        else console.log(line);
    }

    static message(message) {
        // Keep routing and connection details, never SDP credentials or shared content.
        const details = {};
        for (const key of ['type', 'sender', 'to', 'sessionId', 'senderSession', 'toSession',
            'reversed', 'reverse', 'restart', 'disconnected', 'connectionCheck', 'peerId']) {
            if (message[key] !== undefined) details[key] = message[key];
        }
        if (message.sdp) details.sdp = { type: message.sdp.type };
        if (message.ice) details.ice = RTCPeer._candidateSummary(message.ice);
        const peerInfo = peer => ({ id: peer.id, name: peer.name && peer.name.displayName, rtcSupported: peer.rtcSupported });
        if (message.peers) details.peers = message.peers.map(peerInfo);
        if (message.peer) details.peer = peerInfo(message.peer);
        if (message.type === 'display-name') details.identity = {
            id: message.message.id, connectionId: message.message.connectionId, name: message.message.displayName
        };
        return details;
    }
}
// Bump with the service-worker cache version for each client release.
ConnectionLog.clientVersion = 'v20';
ConnectionLog.page = Math.random().toString(36).slice(2, 10);
ConnectionLog.write('client-start', { userAgent: typeof navigator === 'undefined' ? undefined : navigator.userAgent });

class ServerConnection {

    constructor() {
        this._sessionCounter = 0;
        this._destinations = new Map();
        this._connect();
        Events.on('beforeunload', e => this._disconnect());
        Events.on('pagehide', e => this._disconnect());
        Events.on('pageshow', () => this._connect());
        document.addEventListener('visibilitychange', e => this._onVisibilityChange());
    }

    _connect() {
        clearTimeout(this._reconnectTimer);
        if (this._isConnected() || this._isConnecting()) return;
        const ws = new WebSocket(this._endpoint());
        ws.binaryType = 'arraybuffer';
        ws.onopen = () => ConnectionLog.write('ws-open');
        ws.onmessage = e => { if (this._socket === ws) this._onMessage(e.data); };
        ws.onclose = event => {
            if (this._socket !== ws) return;
            this._socket = null;
            this._onDisconnect(event);
        };
        ws.onerror = () => ConnectionLog.write('ws-error', { readyState: ws.readyState });
        this._socket = ws;
    }

    _onMessage(msg) {
        try { msg = SnapdropProtocol.decode(msg); }
        catch (error) { ConnectionLog.write('ws-protocol-error', { name: error.name }); return; }
        ConnectionLog.write('ws-receive', ConnectionLog.message(msg));
        switch (msg.type) {
            case 'peers':
                this._destinations = new Map(msg.peers.map(peer => [peer.id, peer.connectionId]));
                Events.fire('peers', msg.peers.filter(peer => peer.id !== this._selfId));
                break;
            case 'peer-joined':
                this._destinations.set(msg.peer.id, msg.peer.connectionId);
                if (msg.peer.id !== this._selfId) Events.fire('peer-joined', msg.peer);
                break;
            case 'peer-updated':
                this._destinations.set(msg.peer.id, msg.peer.connectionId);
                Events.fire('peer-updated', msg);
                break;
            case 'peer-left':
                this._destinations.delete(msg.peerId);
                Events.fire('peer-left', msg.peerId);
                break;
            case 'signal':
                if (msg.sender !== this._selfId) Events.fire('signal', msg);
                break;
            case 'text':
                if (msg.sender !== this._selfId) Events.fire('text-received', { sender: msg.sender, text: msg.text });
                break;
            case 'display-name':
                this._selfId = msg.message.id;
                this._connectionId = msg.message.connectionId;
                if (this._selfId) Events.fire('peer-identity', this._selfId);
                Events.fire('display-name', msg);
                break;
            default:
                ConnectionLog.write('ws-unknown-message', { type: msg.type });
        }
    }

    send(message) {
        const recipient = message.toSession || this._destinations.get(message.to);
        if (!this._isConnected() || !recipient || message.to === this._selfId) return false;
        try {
            const data = SnapdropProtocol.encode(recipient, message);
            if (this._socket.bufferedAmount + data.byteLength > 512 * 1024) return false;
            this._socket.send(data);
            ConnectionLog.write('ws-send', ConnectionLog.message(message));
            return true;
        } catch (error) {
            ConnectionLog.write('ws-send-error', { name: error.name });
            return false;
        }
    }

    nextSessionId() {
        return this._connectionId ? this._connectionId + ':' + (++this._sessionCounter) : undefined;
    }

    _endpoint() {
        const protocol = location.protocol.startsWith('https') ? 'wss' : 'ws';
        const webrtc = window.isRtcSupported ? '/webrtc' : '/fallback';
        const url = protocol + '://' + location.host + location.pathname + 'server' + webrtc;
        return url;
    }

    _disconnect() {
        clearTimeout(this._reconnectTimer);
        const socket = this._socket;
        if (!socket) return;
        this._socket = null;
        socket.onclose = socket.onmessage = null;
        socket.close();
    }

    _onDisconnect(event = {}) {
        ConnectionLog.write('ws-close', { code: event.code, clean: event.wasClean });
        Events.fire('notify-user', 'Connection lost. Retry in 5 seconds...');
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = setTimeout(_ => this._connect(), 5000);
    }

    _onVisibilityChange() {
        if (document.hidden) return;
        this._connect();
    }

    _isConnected() {
        return this._socket && this._socket.readyState === this._socket.OPEN;
    }

    _isConnecting() {
        return this._socket && this._socket.readyState === this._socket.CONNECTING;
    }
}

class Peer {

    constructor(serverConnection, peerId) {
        this._server = serverConnection;
        this._peerId = peerId;
        this._filesQueue = [];
        this._busy = false;
    }

    sendJSON(message) {
        this._send(JSON.stringify(message));
    }

    sendFiles(files) {
        for (let i = 0; i < files.length; i++) {
            this._filesQueue.push(files[i]);
        }
        if (this._busy) return;
        this._dequeueFile();
    }

    _dequeueFile() {
        if (!this._filesQueue.length) return;
        this._busy = true;
        const file = this._filesQueue.shift();
        this._sendFile(file);
    }

    _sendFile(file) {
        Events.fire('file-progress', { sender: this._peerId, progress: 0, status: 'Sending…' });
        this.sendJSON({
            type: 'header',
            name: file.name,
            mime: file.type,
            size: file.size
        });
        this._chunker = new FileChunker(file,
            chunk => this._send(chunk),
            offset => this._onPartitionEnd(offset));
        this._chunker.nextPartition();
    }

    _onPartitionEnd(offset) {
        this.sendJSON({ type: 'partition', offset: offset });
    }

    _onReceivedPartitionEnd(offset) {
        this.sendJSON({ type: 'partition-received', offset: offset });
    }

    _sendNextPartition() {
        if (!this._chunker || this._chunker.isFileEnd()) return;
        this._chunker.nextPartition();
    }

    _sendProgress(progress) {
        this.sendJSON({ type: 'progress', progress: progress });
    }

    _onMessage(message) {
        if (typeof message !== 'string') {
            this._onChunkReceived(message);
            return;
        }
        message = JSON.parse(message);
        ConnectionLog.write('data-receive', { peer: this._peerId, type: message.type, size: message.size, progress: message.progress });
        switch (message.type) {
            case 'header':
                this._onFileHeader(message);
                break;
            case 'partition':
                this._onReceivedPartitionEnd(message);
                break;
            case 'partition-received':
                this._sendNextPartition();
                break;
            case 'progress':
                this._onDownloadProgress(message.progress);
                break;
            case 'transfer-complete':
                this._onTransferCompleted();
                break;
        }
    }

    _onFileHeader(header) {
        Events.fire('file-progress', { sender: this._peerId, progress: 0, status: 'Receiving…' });
        this._lastProgress = 0;
        this._digester = new FileDigester({
            name: header.name,
            mime: header.mime,
            size: header.size
        }, file => this._onFileReceived(file));
    }

    _onChunkReceived(chunk) {
        if(!chunk.byteLength) return;
        
        this._digester.unchunk(chunk);
        const progress = this._digester.progress;
        this._onDownloadProgress(progress);

        // occasionally notify sender about our progress 
        if (progress - this._lastProgress < 0.01) return;
        this._lastProgress = progress;
        this._sendProgress(progress);
    }

    _onDownloadProgress(progress) {
        Events.fire('file-progress', { sender: this._peerId, progress: progress });
    }

    _onFileReceived(proxyFile) {
        Events.fire('file-received', proxyFile);
        this.sendJSON({ type: 'transfer-complete' });
    }

    _onTransferCompleted() {
        this._onDownloadProgress(1);
        this._reader = null;
        this._busy = false;
        this._dequeueFile();
        Events.fire('notify-user', 'File transfer completed.');
    }
}

class RTCPeer extends Peer {

    constructor(serverConnection, peerId, sessionId, deferConnection = false) {
        super(serverConnection, peerId);
        this._signalId = sessionId || (serverConnection.nextSessionId && serverConnection.nextSessionId());
        this._operations = Promise.resolve();
        this._closed = false;
        if (peerId && !deferConnection) this._connect(peerId, true);
    }

    _connect(peerId, isCaller) {
        if (this._closed || this._conn) return;
        this._peerId = peerId;
        this._isCaller = isCaller;
        const conn = new RTCPeerConnection(RTCPeer.config);
        this._conn = conn;
        this._connectedOnce = false;
        this._connectionCheck = 'connecting';
        this._armConnectionTimeout(conn, 15000, 'connection-timeout');
        this._needsRecovery = false;
        this._pendingIce = [];
        this._lastOffer = null;
        this._ignoreOffer = false;
        this._diagnostics = {
            localCandidates: [], remoteCandidates: [], iceServerErrors: [],
            descriptionsSent: [], descriptionsReceived: [], signalingErrors: []
        };
        conn.onicecandidate = event => {
            if (this._conn === conn && event.candidate) {
                this._diagnostics.localCandidates.push(RTCPeer._candidateSummary(event.candidate));
                this._sendSignal({ ice: event.candidate });
            }
        };
        conn.onicecandidateerror = event => {
            if (this._conn !== conn) return;
            // Omit SDP and credentials; candidate hostnames are logged for resolution tests.
            this._diagnostics.iceServerErrors.push({ url: event.url, code: event.errorCode });
            this._reportDiagnostics(conn, 'ice-server-error');
        };
        conn.onicegatheringstatechange = () => {
            if (this._conn === conn && conn.iceGatheringState === 'complete') {
                this._reportDiagnostics(conn, 'gathering-complete');
            }
        };
        conn.oniceconnectionstatechange = () => {
            if (this._conn === conn) this._reportDiagnostics(conn, 'ice-state-change');
        };
        conn.onconnectionstatechange = () => {
            if (this._conn !== conn) return;
            ConnectionLog.write('rtc-state', { peer: this._peerId, session: this._signalId, connection: conn.connectionState });
            if (conn.connectionState === 'failed') this._failConnection(conn, 'connection-failed');
        };
        conn.ondatachannel = event => this._setChannel(event.channel, conn);
        if (isCaller) {
            // Store the channel immediately so repeated sends cannot create more offers.
            this._setChannel(conn.createDataChannel('data-channel', { ordered: true }), conn);
            this._enqueue(conn, async () => {
                const offer = await conn.createOffer();
                if (this._conn !== conn) return;
                await conn.setLocalDescription(offer);
                if (this._conn === conn) this._sendSignal({ sdp: conn.localDescription });
            });
        }
    }

    _enqueue(conn, operation) {
        // SDP and ICE must be applied in order, including local offer creation.
        this._operations = this._operations.then(async () => {
            if (this._conn === conn && !this._closed) await operation();
        }).catch(error => {
            if (this._conn === conn && !this._closed) this._onError(error);
        });
        return this._operations;
    }

    onServerMessage(message) {
        if (this._closed) return;
        // Older cached clients do not understand role swaps.
        if (message.connectionCheck === true) this._supportsConnectionCheck = true;
        if (typeof message.reversed === 'boolean') this._supportsReversal = true;
        if (message.reverse) {
            if (this._isCaller !== undefined) this._reverseRoles(false);
            return;
        }
        // Ignore signals still in flight from the attempt before the role swap.
        if (!!message.reversed !== !!this._reversed) return;
        if (message.restart) {
            // Permission retries preserve the current roles.
            const isCaller = this._isCaller === true;
            this._closeConnection();
            this._connect(message.sender, isCaller);
            return;
        }
        // Late answers and candidates must not resurrect a failed connection.
        if (!this._conn) {
            if (!message.sdp || message.sdp.type !== 'offer') return;
            this._connect(message.sender, false);
        }
        const conn = this._conn;
        if (message.sdp) this._diagnostics.descriptionsReceived.push(message.sdp.type);
        if (message.ice) this._diagnostics.remoteCandidates.push(RTCPeer._candidateSummary(message.ice));
        return this._enqueue(conn, async () => {
            if (message.sdp) {
                const description = message.sdp;
                if (description.type === 'offer') {
                    if (description.sdp === this._lastOffer) return;
                    // Only the current callee yields when offers collide.
                    this._ignoreOffer = conn.signalingState !== 'stable' && this._isCaller;
                    if (this._ignoreOffer) return;
                } else if (description.type !== 'answer' || conn.signalingState !== 'have-local-offer') {
                    return;
                }
                await conn.setRemoteDescription(description);
                if (this._conn !== conn) return;
                this._ignoreOffer = false;
                if (description.type === 'offer') {
                    this._lastOffer = description.sdp;
                    const answer = await conn.createAnswer();
                    if (this._conn !== conn) return;
                    await conn.setLocalDescription(answer);
                    if (this._conn !== conn) return;
                    this._sendSignal({ sdp: conn.localDescription });
                }
                for (const candidate of this._pendingIce.splice(0)) {
                    if (this._conn !== conn) return;
                    await conn.addIceCandidate(candidate);
                }
            } else if (message.ice) {
                if (this._ignoreOffer) return;
                if (!conn.remoteDescription) this._pendingIce.push(message.ice);
                else await conn.addIceCandidate(message.ice);
            }
        });
    }

    _setChannel(channel, conn) {
        if (this._conn !== conn) return channel.close();
        this._channel = channel;
        channel.binaryType = 'arraybuffer';
        const log = (event, details = {}) => ConnectionLog.write(event, {
            peer: this._peerId, session: this._signalId, attempt: this._reversed ? 'reversed' : 'initial',
            channel: channel.id, state: channel.readyState, bufferedAmount: channel.bufferedAmount,
            ...details
        });
        log('channel-attached');
        let opened = false;
        channel.onopen = () => {
            if (this._conn !== conn || opened || channel.readyState !== 'open') return;
            opened = true;
            log('channel-open');
            if (!this._supportsConnectionCheck) return this._confirmConnection(conn, 'unsupported');
            this._connectionCheck = 'pending';
            this._checkId = (this._checkId || 0) + 1;
            this._armConnectionTimeout(conn, 5000, 'connection-check-timeout');
            // Send over the data channel itself, before allowing file transfers.
            channel.send(JSON.stringify({ type: 'connection-check', id: this._checkId }));
            log('connection-check-send', { id: this._checkId });
        };
        channel.onmessage = event => {
            if (this._conn !== conn) return;
            if (typeof event.data === 'string') {
                const message = JSON.parse(event.data);
                if (message.type === 'connection-check') {
                    log('connection-check-receive', { id: message.id });
                    channel.send(JSON.stringify({ type: 'connection-check-reply', id: message.id }));
                    log('connection-check-reply-send', { id: message.id });
                    return;
                }
                if (message.type === 'connection-check-reply') {
                    log('connection-check-reply-receive', { id: message.id });
                    if (this._connectionCheck === 'pending' && message.id === this._checkId) {
                        this._confirmConnection(conn, 'passed');
                    }
                    return;
                }
            }
            this._onMessage(event.data);
        };
        channel.onclose = () => {
            if (this._conn !== conn) return;
            log('channel-close');
            if (!this._connectedOnce) this._failConnection(conn, 'channel-closed-before-verification');
            else {
                this._closeConnection();
                this._needsRecovery = true;
            }
        };
        channel.onerror = event => {
            if (this._conn !== conn) return;
            const error = event.error || {};
            log('channel-error', { name: error.name, message: error.message,
                detail: error.errorDetail, sctpCauseCode: error.sctpCauseCode });
        };
        // Incoming channels can already be open in ondatachannel. Start once,
        // whether readiness is observed here or in a subsequent open event.
        if (channel.readyState === 'open') channel.onopen();
    }

    _armConnectionTimeout(conn, delay, reason) {
        clearTimeout(this._connectionTimer);
        this._connectionTimer = setTimeout(() => this._failConnection(conn, reason), delay);
    }

    _confirmConnection(conn, result) {
        if (this._conn !== conn) return;
        clearTimeout(this._connectionTimer);
        this._connectedOnce = true;
        this._connectionCheck = result;
        this._reportDiagnostics(conn, result === 'passed' ? 'connection-verified' : 'channel-open');
        const pending = this._pendingFiles;
        this._pendingFiles = null;
        if (pending) super.sendFiles(pending);
    }

    _failConnection(conn, reason) {
        if (this._conn !== conn || this._closed) return;
        this._reportDiagnostics(conn, reason);
        if (!this._connectedOnce && !this._reversed && this._supportsReversal) return this._reverseRoles();
        this._closeConnection();
        this._needsRecovery = true;
        if (this._pendingFiles) Events.fire('file-progress', {
            sender: this._peerId, progress: 0, status: 'Connection failed'
        });
        if (!this._connectedOnce) Events.fire('connection-failed', { peerId: this._peerId });
        Events.fire('notify-user', 'Could not connect to this device. Check local network access and try again.');
    }

    _closeConnection() {
        clearTimeout(this._connectionTimer);
        const conn = this._conn;
        const channel = this._channel;
        this._conn = null;
        this._channel = null;
        this._pendingIce = [];
        if (channel) {
            channel.onopen = channel.onmessage = channel.onclose = channel.onerror = null;
            channel.close();
        }
        if (conn) {
            conn.onicecandidate = conn.onconnectionstatechange = conn.ondatachannel = null;
            conn.onicecandidateerror = conn.onicegatheringstatechange = conn.oniceconnectionstatechange = null;
            conn.close();
        }
        // Cancel any partial transfer; a new send starts from its header again.
        this._filesQueue = [];
        this._busy = false;
        this._chunker = null;
        this._digester = null;
    }

    close() {
        this._closed = true;
        this._pendingFiles = null;
        this._closeConnection();
    }

    _onError(error) {
        ConnectionLog.write('rtc-error', { peer: this._peerId, session: this._signalId, name: error.name, message: error.message });
        if (this._conn) {
            this._diagnostics.signalingErrors.push({ name: error.name, state: this._conn.signalingState });
            this._reportDiagnostics(this._conn, 'signaling-error');
        }
    }

    static _candidateSummary(candidate) {
        if (!candidate) return null;
        const parts = (candidate.candidate || '').split(/\s+/);
        const address = candidate.address || parts[4] || '';
        return {
            type: candidate.candidateType || candidate.type || parts[7] || 'end-of-candidates',
            protocol: candidate.protocol || parts[2],
            address: address || undefined,
            port: candidate.port === undefined ? (Number(parts[5]) || undefined) : candidate.port,
            mid: candidate.sdpMid === undefined ? undefined : candidate.sdpMid,
            addressKind: !address ? 'unavailable' : address.endsWith('.local') ? 'mdns'
                : address.includes(':') ? 'ipv6' : /^\d+\./.test(address) ? 'ipv4' : 'hostname'
        };
    }

    async _reportDiagnostics(conn, reason) {
        // Capture state before an asynchronous stats request or connection teardown.
        const report = {
            version: 2, time: new Date().toISOString(), reason, peer: this._peerId,
            session: this._signalId, remoteSession: this._remoteSession,
            attempt: this._reversed ? 'reversed' : 'initial',
            connectionCheck: this._connectionCheck,
            channel: this._channel ? { id: this._channel.id, state: this._channel.readyState,
                bufferedAmount: this._channel.bufferedAmount } : null,
            sctp: conn.sctp ? conn.sctp.state : null,
            role: this._isCaller ? 'offerer' : 'answerer',
            connection: conn.connectionState, ice: conn.iceConnectionState,
            gathering: conn.iceGatheringState, signaling: conn.signalingState,
            localDescription: conn.localDescription && conn.localDescription.type,
            remoteDescription: conn.remoteDescription && conn.remoteDescription.type,
            ...JSON.parse(JSON.stringify(this._diagnostics)),
            pairs: [], transports: [], dataChannels: []
        };
        try {
            const stats = await conn.getStats();
            stats.forEach(stat => {
                if (stat.type === 'candidate-pair') {
                    report.pairs.push({
                        local: RTCPeer._candidateSummary(stats.get(stat.localCandidateId)),
                        remote: RTCPeer._candidateSummary(stats.get(stat.remoteCandidateId)),
                        state: stat.state, nominated: stat.nominated,
                        requestsSent: stat.requestsSent, responsesReceived: stat.responsesReceived,
                        requestsReceived: stat.requestsReceived, responsesSent: stat.responsesSent,
                        bytesSent: stat.bytesSent, bytesReceived: stat.bytesReceived
                    });
                } else if (stat.type === 'transport') {
                    report.transports.push({ iceState: stat.iceState, dtlsState: stat.dtlsState });
                } else if (stat.type === 'data-channel') {
                    report.dataChannels.push({ id: stat.dataChannelIdentifier, state: stat.state,
                        messagesSent: stat.messagesSent, messagesReceived: stat.messagesReceived,
                        bytesSent: stat.bytesSent, bytesReceived: stat.bytesReceived });
                }
            });
        } catch (error) {
            report.statsError = error.name;
        }
        ConnectionLog.write('rtc-diagnostics', report);
        return report;
    }

    sendFiles(files) {
        if (this._closed) return;
        if (this._isConnected()) return super.sendFiles(files);
        // Retain only an undispatched selection across negotiation/reversal.
        const pending = this._needsRecovery ? [] : (this._pendingFiles || []);
        if (pending.length + files.length > 64) {
            Events.fire('notify-user', 'Please send at most 64 files at a time.');
            return;
        }
        this._pendingFiles = [...pending, ...files];
        Events.fire('file-progress', { sender: this._peerId, progress: 0, status: 'Connecting…' });
        this.refresh();
    }

    _send(message) {
        if (this._isConnected()) this._channel.send(message);
    }

    _sendSignal(signal) {
        if (signal.sdp) this._diagnostics.descriptionsSent.push(signal.sdp.type);
        signal.connectionCheck = true;
        signal.reversed = !!this._reversed;
        signal.type = 'signal';
        signal.to = this._peerId;
        if (this._signalId) signal.sessionId = this._signalId;
        if (this._remoteSession) signal.toSession = this._remoteSession;
        this._server.send(signal);
    }

    _reverseRoles(notify = true) {
        // Both endpoints may fail at once: flip only once and ignore duplicate requests.
        if (this._closed || this._reversed) return;
        this._reversed = true;
        if (this._pendingFiles) Events.fire('file-progress', {
            sender: this._peerId, progress: 0, status: 'Retrying connection…'
        });
        if (notify) this._sendSignal({ restart: true, reverse: true });
        const isCaller = !this._isCaller;
        this._closeConnection();
        this._connect(this._peerId, isCaller);
    }

    retryConnection() {
        if (this._closed || !this._needsRecovery || this._isConnected()) return;
        if (this._pendingFiles) Events.fire('file-progress', {
            sender: this._peerId, progress: 0, status: 'Retrying connection…'
        });
        this._sendSignal({ restart: true });
        this._closeConnection();
        this._connect(this._peerId, this._isCaller === true);
    }

    refresh() {
        // A send after failure must restart both ends with their existing roles.
        if (this._needsRecovery) return this.retryConnection();
        this._connect(this._peerId, true);
    }

    _isConnected() {
        return this._connectedOnce && this._conn
            && !['disconnected', 'failed', 'closed'].includes(this._conn.connectionState)
            && this._channel && this._channel.readyState === 'open';
    }
}

class PeersManager {

    constructor(serverConnection) {
        this.peers = {};
        // One visible peer can have independent transfers with several of its tabs.
        this._sessions = new Map();
        this._retiredSessions = new Set();
        this._peerInfo = {};
        this._server = serverConnection;
        Events.on('peer-identity', e => {
            this._selfId = e.detail;
            this._onPeerLeft(this._selfId);
        });
        Events.on('signal', e => this._onMessage(e.detail));
        Events.on('peers', e => this._onPeers(e.detail));
        Events.on('files-selected', e => this._onFilesSelected(e.detail));
        Events.on('send-text', e => this._onSendText(e.detail));
        Events.on('peer-left', e => this._onPeerLeft(e.detail));
        Events.on('peer-updated', e => this._onPeerUpdated(e.detail));
        // The same device ID can return with a new page and fresh ICE state.
        Events.on('peer-joined', e => {
            if (e.detail.id === this._selfId) return;
            this._onPeerLeft(e.detail.id);
            this._peerInfo[e.detail.id] = e.detail;
        });
        Events.on('pagehide', () => this._clearPeers());
        Events.on('retry-failed-connections', () => {
            new Set([...Object.values(this.peers), ...this._sessions.values()]).forEach(peer => {
                if (peer instanceof RTCPeer) peer.retryConnection();
            });
        });
    }

    _onMessage(message) {
        if (message.sender === this._selfId) return;
        const key = message.sender + '/' + (message.sessionId || '');
        if (this._retiredSessions.has(key)) return;
        let peer = message.sessionId ? this._sessions.get(key) : this.peers[message.sender];
        if (message.disconnected) {
            if (peer) this._removeSession(message.sender, peer);
            return;
        }
        if (!peer) {
            peer = new RTCPeer(this._server, undefined, message.sessionId);
            peer._peerId = message.sender;
            if (!this.peers[message.sender]) this.peers[message.sender] = peer;
            if (message.sessionId) this._sessions.set(key, peer);
        }
        peer._remoteSession = message.senderSession;
        peer.onServerMessage(message);
    }

    _onPeers(peers) {
        // A fresh signaling session needs fresh connections, including retry roles.
        this._clearPeers();
        peers.forEach(peer => {
            if (peer.id === this._selfId) return;
            this._peerInfo[peer.id] = peer;
            this._createPeer(peer);
        })
    }

    _createPeer(info) {
        const peer = window.isRtcSupported && info.rtcSupported
            ? new RTCPeer(this._server, info.id, undefined, true) : new UnsupportedPeer();
        peer._remoteSession = info.connectionId;
        this.peers[info.id] = peer;
        if (peer._signalId) this._sessions.set(info.id + '/' + peer._signalId, peer);
    }

    _onPeerUpdated(message) {
        this._peerInfo[message.peer.id] = message.peer;
        if (!message.departedConnection) return;
        const sessions = new Set([...Object.values(this.peers), ...this._sessions.values()]);
        for (const peer of sessions) {
            if (peer._peerId === message.peer.id && peer._remoteSession === message.departedConnection) {
                this._removeSession(message.peer.id, peer);
            }
        }
    }

    _removeSession(peerId, peer) {
        peer.close();
        for (const [key, session] of this._sessions) {
            if (session !== peer) continue;
            this._sessions.delete(key);
            this._retiredSessions.add(key);
        }
        if (this.peers[peerId] !== peer) return;
        delete this.peers[peerId];
        const remaining = [...this._sessions.values()].find(session => session._peerId === peerId);
        if (remaining) this.peers[peerId] = remaining;
        else if (this._peerInfo[peerId]) this._createPeer(this._peerInfo[peerId]);
    }

    sendTo(peerId, message) {
        this.peers[peerId].send(message);
    }

    _onFilesSelected(message) {
        if (!this.peers[message.to] && this._peerInfo[message.to]) this._createPeer(this._peerInfo[message.to]);
        const peer = this.peers[message.to];
        if (peer) peer.sendFiles(message.files);
        else Events.fire('notify-user', 'Device is offline. Please try again.');
    }

    _onSendText(message) {
        if (typeof message.text !== 'string' || !message.text.trim()) return;
        if (new TextEncoder().encode(message.text).byteLength > 16 * 1024) {
            Events.fire('notify-user', 'Message is too long (maximum 16 KB).');
            return;
        }
        if (!this._server.send({ type: 'text', to: message.to, text: message.text })) {
            Events.fire('notify-user', 'Could not send the message. Please try again.');
        }
    }

    _clearPeers() {
        Object.keys(this.peers).forEach(peerId => this._onPeerLeft(peerId));
        this._retiredSessions.clear();
        this._peerInfo = {};
    }

    _onPeerLeft(peerId) {
        const peer = this.peers[peerId];
        delete this.peers[peerId];
        delete this._peerInfo[peerId];
        if (peer && peer.close) peer.close();
        for (const [key, session] of this._sessions) {
            if (session._peerId !== peerId) continue;
            session.close();
            this._sessions.delete(key);
            this._retiredSessions.add(key);
        }
    }

}

class UnsupportedPeer {
    sendFiles() { Events.fire('notify-user', 'This browser does not support file transfers.'); }
    close() {}
}

class FileChunker {

    constructor(file, onChunk, onPartitionEnd) {
        this._chunkSize = 64000; // 64 KB
        this._maxPartitionSize = 1e6; // 1 MB
        this._offset = 0;
        this._partitionSize = 0;
        this._file = file;
        this._onChunk = onChunk;
        this._onPartitionEnd = onPartitionEnd;
        this._reader = new FileReader();
        this._reader.addEventListener('load', e => this._onChunkRead(e.target.result));
    }

    nextPartition() {
        this._partitionSize = 0;
        this._readChunk();
    }

    _readChunk() {
        const chunk = this._file.slice(this._offset, this._offset + this._chunkSize);
        this._reader.readAsArrayBuffer(chunk);
    }

    _onChunkRead(chunk) {
        this._offset += chunk.byteLength;
        this._partitionSize += chunk.byteLength;
        this._onChunk(chunk);
        if (this.isFileEnd()) return;
        if (this._isPartitionEnd()) {
            this._onPartitionEnd(this._offset);
            return;
        }
        this._readChunk();
    }

    repeatPartition() {
        this._offset -= this._partitionSize;
        this._nextPartition();
    }

    _isPartitionEnd() {
        return this._partitionSize >= this._maxPartitionSize;
    }

    isFileEnd() {
        return this._offset >= this._file.size;
    }

    get progress() {
        return this._offset / this._file.size;
    }
}

class FileDigester {

    constructor(meta, callback) {
        this._buffer = [];
        this._bytesReceived = 0;
        this._size = meta.size;
        this._mime = meta.mime || 'application/octet-stream';
        this._name = meta.name;
        this._callback = callback;
    }

    unchunk(chunk) {
        this._buffer.push(chunk);
        this._bytesReceived += chunk.byteLength || chunk.size;
        const totalChunks = this._buffer.length;
        this.progress = this._bytesReceived / this._size;
        if (isNaN(this.progress)) this.progress = 1

        if (this._bytesReceived < this._size) return;
        // we are done
        let blob = new Blob(this._buffer, { type: this._mime });
        this._callback({
            name: this._name,
            mime: this._mime,
            size: this._size,
            blob: blob
        });
    }

}

class Events {
    static fire(type, detail) {
        window.dispatchEvent(new CustomEvent(type, { detail: detail }));
    }

    static on(type, callback) {
        return window.addEventListener(type, callback, false);
    }

    static off(type, callback) {
        return window.removeEventListener(type, callback, false);
    }
}


RTCPeer.config = {
    'sdpSemantics': 'unified-plan',
    'iceServers': [{
        urls: 'stun:stun.l.google.com:19302'
    }]
}
