window.URL = window.URL || window.webkitURL;
window.isRtcSupported = !!(window.RTCPeerConnection || window.mozRTCPeerConnection || window.webkitRTCPeerConnection);
console.log('RTC diagnostics enabled (v1)');

class ServerConnection {

    constructor() {
        this._connect();
        Events.on('beforeunload', e => this._disconnect());
        Events.on('pagehide', e => this._disconnect());
        document.addEventListener('visibilitychange', e => this._onVisibilityChange());
    }

    _connect() {
        clearTimeout(this._reconnectTimer);
        if (this._isConnected() || this._isConnecting()) return;
        const ws = new WebSocket(this._endpoint());
        ws.binaryType = 'arraybuffer';
        ws.onopen = e => console.log('WS: server connected');
        ws.onmessage = e => this._onMessage(e.data);
        ws.onclose = e => this._onDisconnect();
        ws.onerror = e => console.error(e);
        this._socket = ws;
    }

    _onMessage(msg) {
        msg = JSON.parse(msg);
        console.log('WS:', msg);
        switch (msg.type) {
            case 'peers':
                Events.fire('peers', msg.peers);
                break;
            case 'peer-joined':
                Events.fire('peer-joined', msg.peer);
                break;
            case 'peer-left':
                Events.fire('peer-left', msg.peerId);
                break;
            case 'signal':
                Events.fire('signal', msg);
                break;
            case 'ping':
                this.send({ type: 'pong' });
                break;
            case 'display-name':
                Events.fire('display-name', msg);
                break;
            default:
                console.error('WS: unkown message type', msg);
        }
    }

    send(message) {
        if (!this._isConnected()) return;
        this._socket.send(JSON.stringify(message));
    }

    _endpoint() {
        // hack to detect if deployment or development environment
        const protocol = location.protocol.startsWith('https') ? 'wss' : 'ws';
        const webrtc = window.isRtcSupported ? '/webrtc' : '/fallback';
        const url = protocol + '://' + location.host + location.pathname + 'server' + webrtc;
        return url;
    }

    _disconnect() {
        this.send({ type: 'disconnect' });
        this._socket.onclose = null;
        this._socket.close();
    }

    _onDisconnect() {
        console.log('WS: server disconnected');
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
        console.log('RTC:', message);
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
            case 'text':
                this._onTextReceived(message);
                break;
        }
    }

    _onFileHeader(header) {
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

    sendText(text) {
        const unescaped = btoa(unescape(encodeURIComponent(text)));
        this.sendJSON({ type: 'text', text: unescaped });
    }

    _onTextReceived(message) {
        const escaped = decodeURIComponent(escape(atob(message.text)));
        Events.fire('text-received', { text: escaped, sender: this._peerId });
    }
}

class RTCPeer extends Peer {

    constructor(serverConnection, peerId) {
        super(serverConnection, peerId);
        this._operations = Promise.resolve();
        this._closed = false;
        if (peerId) this._connect(peerId, true);
    }

    _connect(peerId, isCaller) {
        if (this._closed || this._conn) return;
        this._peerId = peerId;
        this._isCaller = isCaller;
        const conn = new RTCPeerConnection(RTCPeer.config);
        this._conn = conn;
        this._connectedOnce = false;
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
            // Omit local addresses, candidate strings, SDP, and credentials.
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
            console.log('RTC: state changed:', conn.connectionState);
            if (conn.connectionState === 'failed') {
                this._reportDiagnostics(conn, 'connection-failed');
                if (!this._connectedOnce && !this._reversed && this._supportsReversal) return this._reverseRoles();
                this._closeConnection();
                this._needsRecovery = !this._connectedOnce;
                if (this._needsRecovery) Events.fire('connection-failed', { peerId: this._peerId });
                Events.fire('notify-user', 'Could not connect to this device. Check local network access and try again.');
            }
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
        channel.onopen = () => {
            if (this._conn === conn) {
                this._connectedOnce = true;
                console.log('RTC: channel opened with', this._peerId);
                this._reportDiagnostics(conn, 'channel-open');
            }
        };
        channel.onmessage = event => {
            if (this._conn === conn) this._onMessage(event.data);
        };
        channel.onclose = () => {
            if (this._conn === conn) this._closeConnection();
        };
    }

    _closeConnection() {
        const conn = this._conn;
        const channel = this._channel;
        this._conn = null;
        this._channel = null;
        this._pendingIce = [];
        if (channel) {
            channel.onopen = channel.onmessage = channel.onclose = null;
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
        this._closeConnection();
    }

    _onError(error) {
        console.error(error);
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
            addressKind: !address ? 'unavailable' : address.endsWith('.local') ? 'mdns'
                : address.includes(':') ? 'ipv6' : /^\d+\./.test(address) ? 'ipv4' : 'hostname'
        };
    }

    async _reportDiagnostics(conn, reason) {
        // Capture state before an asynchronous stats request or connection teardown.
        const report = {
            version: 1, reason, peer: this._peerId,
            attempt: this._reversed ? 'reversed' : 'initial',
            role: this._isCaller ? 'offerer' : 'answerer',
            connection: conn.connectionState, ice: conn.iceConnectionState,
            gathering: conn.iceGatheringState, signaling: conn.signalingState,
            localDescription: conn.localDescription && conn.localDescription.type,
            remoteDescription: conn.remoteDescription && conn.remoteDescription.type,
            ...JSON.parse(JSON.stringify(this._diagnostics)),
            pairs: [], transports: []
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
                }
            });
        } catch (error) {
            report.statsError = error.name;
        }
        console.log('RTC diagnostics: ' + JSON.stringify(report));
        return report;
    }

    _readyToSend() {
        if (this._isConnected()) return true;
        this.refresh();
        Events.fire('notify-user', 'Device is not connected yet. Please try again when connected.');
        return false;
    }

    sendFiles(files) {
        if (this._readyToSend()) super.sendFiles(files);
    }

    sendText(text) {
        if (this._readyToSend()) super.sendText(text);
    }

    _send(message) {
        if (this._isConnected()) this._channel.send(message);
    }

    _sendSignal(signal) {
        if (signal.sdp) this._diagnostics.descriptionsSent.push(signal.sdp.type);
        signal.reversed = !!this._reversed;
        signal.type = 'signal';
        signal.to = this._peerId;
        this._server.send(signal);
    }

    _reverseRoles(notify = true) {
        // Both endpoints may fail at once: flip only once and ignore duplicate requests.
        if (this._closed || this._reversed) return;
        this._reversed = true;
        if (notify) this._sendSignal({ restart: true, reverse: true });
        const isCaller = !this._isCaller;
        this._closeConnection();
        this._connect(this._peerId, isCaller);
    }

    retryConnection() {
        if (this._closed || !this._needsRecovery || this._isConnected()) return;
        this._sendSignal({ restart: true });
        this._closeConnection();
        this._connect(this._peerId, this._isCaller === true);
    }

    refresh() {
        this._connect(this._peerId, true);
    }

    _isConnected() {
        return this._channel && this._channel.readyState === 'open';
    }
}

class PeersManager {

    constructor(serverConnection) {
        this.peers = {};
        this._server = serverConnection;
        Events.on('signal', e => this._onMessage(e.detail));
        Events.on('peers', e => this._onPeers(e.detail));
        Events.on('files-selected', e => this._onFilesSelected(e.detail));
        Events.on('send-text', e => this._onSendText(e.detail));
        Events.on('peer-left', e => this._onPeerLeft(e.detail));
        Events.on('retry-failed-connections', () => {
            Object.values(this.peers).forEach(peer => {
                if (peer instanceof RTCPeer) peer.retryConnection();
            });
        });
    }

    _onMessage(message) {
        if (!this.peers[message.sender]) {
            this.peers[message.sender] = new RTCPeer(this._server);
        }
        this.peers[message.sender].onServerMessage(message);
    }

    _onPeers(peers) {
        peers.forEach(peer => {
            if (this.peers[peer.id]) {
                this.peers[peer.id].refresh();
                return;
            }
            if (window.isRtcSupported && peer.rtcSupported) {
                this.peers[peer.id] = new RTCPeer(this._server, peer.id);
            } else {
                this.peers[peer.id] = new WSPeer(this._server, peer.id);
            }
        })
    }

    sendTo(peerId, message) {
        this.peers[peerId].send(message);
    }

    _onFilesSelected(message) {
        this.peers[message.to].sendFiles(message.files);
    }

    _onSendText(message) {
        this.peers[message.to].sendText(message.text);
    }

    _onPeerLeft(peerId) {
        const peer = this.peers[peerId];
        delete this.peers[peerId];
        if (peer && peer.close) peer.close();
    }

}

class WSPeer {
    _send(message) {
        message.to = this._peerId;
        this._server.send(message);
    }
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
