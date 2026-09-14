var process = require('process')
// Handle SIGINT
process.on('SIGINT', () => {
  console.info("SIGINT Received, exiting...")
  process.exit(0)
})

// Handle SIGTERM
process.on('SIGTERM', () => {
  console.info("SIGTERM Received, exiting...")
  process.exit(0)
})

const parser = require('ua-parser-js');
const { getDeviceLabel, getDisplayName } = require('./device-names');

class SnapdropServer {

    constructor(port) {
        const WebSocket = require('ws');
        this._wss = new WebSocket.Server({ port: port });
        this._wss.on('connection', (socket, request) => this._onConnection(new Peer(socket, request)));
        this._wss.on('headers', (headers, response) => this._onHeaders(headers, response));

        this._rooms = Object.create(null);

        console.log('Snapdrop is running on port', port);
    }

    _onConnection(peer) {
        peer.socket.on('message', message => this._onMessage(peer, message));
        peer.socket.on('error', () => this._leaveRoom(peer));
        peer.socket.on('close', () => this._leaveRoom(peer));
        this._joinRoom(peer);
        this._keepAlive(peer);
    }

    _onHeaders(headers, response) {
        if (Peer.cookieId(response.headers.cookie)) return;
        response.peerId = Peer.uuid();
        headers.push('Set-Cookie: peerid=' + response.peerId + "; SameSite=Strict; Secure");
    }

    _onMessage(sender, message) {
        if (sender.closed) return;
        // Try to parse message 
        try {
            message = JSON.parse(message);
        } catch (e) {
            return; // TODO: handle malformed JSON
        }

        if (!message || typeof message !== 'object') return;
        switch (message.type) {
            case 'disconnect':
                this._leaveRoom(sender);
                return;
            case 'pong':
                sender.lastBeat = Date.now();
                return;
        }

        // relay message to recipient
        if (message.to && message.to !== sender.id && this._rooms[sender.ip]) {
            const recipientId = message.to;
            const group = this._rooms[sender.ip][recipientId];
            if (!group) return;
            // Older clients do not echo negotiation IDs; preserve their reply route.
            if (!message.sessionId) {
                const previous = [...sender.routes.values()].reverse()
                    .find(route => route.peer.id === recipientId && !route.peer.closed);
                if (previous) message.sessionId = previous.sessionId;
            }
            const key = recipientId + '/' + (message.sessionId || '');
            const route = sender.routes.get(key);
            const recipient = message.toSession
                ? [...group.connections].find(connection => connection.connectionId === message.toSession)
                : (route && !route.peer.closed ? route.peer : [...group.connections].reverse().find(connection => !connection.closed));
            if (!recipient) return; // Never move a delayed answer to another tab.
            sender.routes.set(key, { peer: recipient, sessionId: message.sessionId });
            recipient.routes.set(sender.id + '/' + (message.sessionId || ''), { peer: sender, sessionId: message.sessionId });
            delete message.to;
            delete message.toSession;
            // add sender id
            message.sender = sender.id;
            message.senderSession = sender.connectionId;
            this._send(recipient, message);
            return;
        }
    }

    _joinRoom(peer) {
        // if room doesn't exist, create it
        if (!this._rooms[peer.ip]) {
            this._rooms[peer.ip] = Object.create(null);
        }

        // Tabs with the same identity share a name; only distinct peers compete.
        const existingPeer = this._rooms[peer.ip][peer.id];
        if (existingPeer) {
            peer.name = existingPeer.name;
            peer.connections = existingPeer.connections;
        } else {
            const usedNames = new Set(Object.values(this._rooms[peer.ip])
                .map(otherPeer => otherPeer.name.displayName));
            peer.name.displayName = getDisplayName(peer.id, peer._deviceLabel, usedNames);
            this._rooms[peer.ip][peer.id] = peer;
        }
        peer.connections.add(peer);

        // Identity must arrive before discovery so clients can reject themselves.
        this._send(peer, {
            type: 'display-name',
            message: { id: peer.id, connectionId: peer.connectionId,
                displayName: peer.name.displayName, deviceName: peer.name.deviceName }
        });

        // notify all other peers
        for (const otherPeerId in this._rooms[peer.ip]) {
            if (existingPeer || otherPeerId === peer.id) continue;
            const otherPeer = this._rooms[peer.ip][otherPeerId];
            this._sendToPeer(otherPeer, {
                type: 'peer-joined',
                peer: peer.getInfo()
            });
        }

        // notify peer about the other peers
        const otherPeers = [];
        for (const otherPeerId in this._rooms[peer.ip]) {
            if (otherPeerId === peer.id) continue;
            otherPeers.push(this._rooms[peer.ip][otherPeerId].getInfo());
        }

        this._send(peer, {
            type: 'peers',
            peers: otherPeers
        });

    }

    _leaveRoom(peer) {
        if (peer.closed) return;
        peer.closed = true;
        this._cancelKeepAlive(peer);
        peer.connections.delete(peer);
        peer.routes.clear();
        peer.socket.terminate();

        const room = this._rooms[peer.ip];
        if (!room || !room[peer.id] || room[peer.id].connections !== peer.connections) return;
        const departed = peer.connections.size === 0;
        if (departed) delete room[peer.id];
        else if (room[peer.id] === peer) room[peer.id] = peer.connections.values().next().value;

        for (const otherPeer of Object.values(room)) {
            for (const connection of otherPeer.connections) {
                for (const [key, route] of connection.routes) {
                    if (route.peer !== peer) continue;
                    connection.routes.delete(key);
                    if (!departed) this._send(connection, { type: 'signal', sender: peer.id,
                        senderSession: peer.connectionId, sessionId: route.sessionId, disconnected: true });
                }
            }
            if (departed) this._sendToPeer(otherPeer, { type: 'peer-left', peerId: peer.id });
        }
        if (!Object.keys(room).length) delete this._rooms[peer.ip];
    }

    _sendToPeer(peer, message) {
        for (const connection of [...peer.connections]) this._send(connection, message);
    }

    _send(peer, message) {
        if (!peer || peer.closed) return;
        if (peer.socket.readyState !== peer.socket.OPEN) return this._leaveRoom(peer);
        try {
            peer.socket.send(JSON.stringify(message), error => {
                if (error) this._leaveRoom(peer);
            });
        } catch (_) {
            this._leaveRoom(peer);
        }
    }

    _keepAlive(peer) {
        this._cancelKeepAlive(peer);
        if (peer.closed) return;
        var timeout = 30000;
        if (!peer.lastBeat) {
            peer.lastBeat = Date.now();
        }
        if (Date.now() - peer.lastBeat >= 2 * timeout) {
            this._leaveRoom(peer);
            return;
        }

        this._send(peer, { type: 'ping' });

        if (!peer.closed) peer.timerId = setTimeout(() => this._keepAlive(peer),
            Math.min(timeout, 2 * timeout - (Date.now() - peer.lastBeat)));
    }

    _cancelKeepAlive(peer) {
        if (peer && peer.timerId) {
            clearTimeout(peer.timerId);
            peer.timerId = 0;
        }
    }
}



class Peer {

    constructor(socket, request) {
        // set socket
        this.socket = socket;
        this.connectionId = Peer.uuid();
        this.connections = new Set();
        this.routes = new Map();
        this.closed = false;


        // set remote ip
        this._setIP(request);

        // set peer id
        this._setPeerId(request)
        // is WebRTC supported ?
        this.rtcSupported = request.url.indexOf('webrtc') > -1;
        // set name 
        this._setName(request);
        // for keepalive
        this.timerId = 0;
        this.lastBeat = Date.now();
    }

    _setIP(request) {
        if (request.headers['x-forwarded-for']) {
            this.ip = request.headers['x-forwarded-for'].split(/\s*,\s*/)[0];
        } else {
            this.ip = request.connection.remoteAddress;
        }
        // IPv4 and IPv6 use different values to refer to localhost
        if (this.ip == '::1' || this.ip == '::ffff:127.0.0.1') {
            this.ip = '127.0.0.1';
        }
    }

    _setPeerId(request) {
        if (request.peerId) {
            this.id = request.peerId;
        } else {
            this.id = Peer.cookieId(request.headers.cookie);
        }
    }

    toString() {
        return `<Peer id=${this.id} ip=${this.ip} rtcSupported=${this.rtcSupported}>`
    }

    static cookieId(cookie = '') {
        const match = cookie.match(/(?:^|;\s*)peerid=([a-f0-9-]{36})(?:;|$)/i);
        return match && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(match[1]) ? match[1] : null;
    }

    _setName(req) {
        let ua = parser(req.headers['user-agent']);


        let deviceName = '';
        
        if (ua.os && ua.os.name) {
            deviceName = ua.os.name.replace('Mac OS', 'Mac') + ' ';
        }
        
        if (ua.device.model) {
            deviceName += ua.device.model;
        } else {
            deviceName += ua.browser.name;
        }

        if(!deviceName)
            deviceName = 'Unknown Device';

        this._deviceLabel = getDeviceLabel(ua);
        const displayName = getDisplayName(this.id, this._deviceLabel);

        this.name = {
            model: ua.device.model,
            os: ua.os.name,
            browser: ua.browser.name,
            type: ua.device.type,
            deviceName,
            displayName
        };
    }

    getInfo() {
        return {
            id: this.id,
            name: this.name,
            rtcSupported: this.rtcSupported
        }
    }

    // return uuid of form xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
    static uuid() {
        let uuid = '',
            ii;
        for (ii = 0; ii < 32; ii += 1) {
            switch (ii) {
                case 8:
                case 20:
                    uuid += '-';
                    uuid += (Math.random() * 16 | 0).toString(16);
                    break;
                case 12:
                    uuid += '-';
                    uuid += '4';
                    break;
                case 16:
                    uuid += '-';
                    uuid += (Math.random() * 4 | 8).toString(16);
                    break;
                default:
                    uuid += (Math.random() * 16 | 0).toString(16);
            }
        }
        return uuid;
    };
}

const server = new SnapdropServer(process.env.PORT || 3000);
