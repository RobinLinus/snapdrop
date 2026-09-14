/* MessagePack/Serde envelopes. The relay never decodes the inner payload. */
class SnapdropProtocol {
    static id(bytes) {
        if (!ArrayBuffer.isView(bytes) || bytes.byteLength !== 16) throw new Error('Invalid ID');
        const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
        return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
    }

    static bytes(id) {
        if (typeof id !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) throw new Error('Invalid ID');
        return Uint8Array.from(id.replace(/-/g, '').match(/../g), hex => parseInt(hex, 16));
    }

    static encode(recipient, message) {
        const { to, toSession, sender, senderSession, ...payload } = message;
        if (message.sdp) payload.sdp = { type: message.sdp.type, sdp: message.sdp.sdp };
        if (message.ice) payload.ice = {
            candidate: message.ice.candidate,
            sdpMid: message.ice.sdpMid ?? null,
            sdpMLineIndex: message.ice.sdpMLineIndex ?? null,
            usernameFragment: message.ice.usernameFragment ?? null
        };
        const body = MessagePack.encode(payload, { ignoreUndefined: true, maxDepth: 16 });
        if (body.byteLength > 60 * 1024) throw new Error('Message too large');
        return MessagePack.encode([this.bytes(recipient), body]);
    }

    static unpack(data) {
        if (typeof data === 'string' || data.byteLength > 64 * 1024) throw new Error('Invalid message');
        return MessagePack.decode(data, {
            maxStrLength: 60 * 1024, maxBinLength: 60 * 1024,
            maxArrayLength: 512, maxMapLength: 32, maxExtLength: 0
        });
    }

    static peer(value) {
        if (!Array.isArray(value) || value.length !== 5 || typeof value[2] !== 'string'
            || ![0, 1, 2].includes(value[3]) || typeof value[4] !== 'boolean') throw new Error('Invalid peer');
        return { id: this.id(value[0]), connectionId: this.id(value[1]),
            name: { displayName: value[2], type: ['', 'mobile', 'tablet'][value[3]] }, rtcSupported: value[4] };
    }

    static decode(data) {
        const envelope = this.unpack(data);
        if (!envelope || Array.isArray(envelope) || Object.keys(envelope).length !== 1) throw new Error('Invalid envelope');
        const [kind] = Object.keys(envelope);
        const fields = envelope[kind];
        switch (kind) {
            case 'i':
                if (!Array.isArray(fields) || fields.length !== 4 || typeof fields[2] !== 'string' || typeof fields[3] !== 'string') break;
                return { type: 'display-name', message: { id: this.id(fields[0]), connectionId: this.id(fields[1]),
                    displayName: fields[2], deviceName: fields[3] } };
            case 'p':
                if (!Array.isArray(fields)) break;
                return { type: 'peers', peers: fields.map(peer => this.peer(peer)) };
            case 'j': return { type: 'peer-joined', peer: this.peer(fields) };
            case 'u':
                if (!Array.isArray(fields) || fields.length !== 2) break;
                return { type: 'peer-updated', peer: this.peer(fields[0]),
                    departedConnection: fields[1] === null ? null : this.id(fields[1]) };
            case 'l': return { type: 'peer-left', peerId: this.id(fields) };
            case 'r': {
                if (!Array.isArray(fields) || fields.length !== 3 || !ArrayBuffer.isView(fields[2])) break;
                const payload = this.unpack(fields[2]);
                if (!payload || Array.isArray(payload) || !['signal', 'text'].includes(payload.type)) break;
                if (payload.type === 'text' && (typeof payload.text !== 'string' || payload.text.length > 16 * 1024)) break;
                // Authenticate routing metadata from the outer envelope, never the payload.
                return { ...payload, sender: this.id(fields[0]), senderSession: this.id(fields[1]) };
            }
        }
        throw new Error('Invalid server message');
    }
}
