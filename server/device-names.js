const COLORS = [
    'Blue', 'Green', 'Red', 'Orange', 'Purple', 'Pink',
    'Yellow', 'Teal', 'Navy', 'Silver', 'Gold', 'Coral'
];

function getDeviceLabel(ua) {
    const { model, type } = ua.device || {};
    const os = (ua.os || {}).name || '';

    if (['iPhone', 'iPad', 'iPod'].includes(model)) return model;
    if (type === 'tablet') return os === 'Android' ? 'Android Tablet' : 'Tablet';
    if (type === 'mobile') {
        if (os === 'Android') return 'Android Phone';
        if (os === 'iOS') return 'iPhone';
        return 'Phone';
    }
    if (type === 'smarttv') return 'TV';
    if (type === 'console') return 'Console';
    if (type === 'wearable') return 'Watch';
    if (/Mac/i.test(os)) return 'Mac';
    if (/Windows/i.test(os)) return 'Windows PC';
    if (/Chrom(e|ium) OS/i.test(os)) return 'Chromebook';
    if (os === 'Android') return 'Android Device';
    if (/Linux|Ubuntu|Debian|Fedora|Mint|Arch|SUSE|CentOS|Gentoo/i.test(os)) return 'Linux PC';
    return 'Device';
}

function getDisplayName(peerId, deviceLabel, usedNames = new Set()) {
    // Start with the same color for the same browser identity on each visit.
    let hash = 0;
    for (let i = 0; i < peerId.length; i++) {
        hash = ((hash << 5) - hash + peerId.charCodeAt(i)) | 0;
    }
    const start = (hash >>> 0) % COLORS.length;

    // Try every color before adding a number; always check the complete name.
    for (let number = 1; ; number++) {
        for (let offset = 0; offset < COLORS.length; offset++) {
            const color = COLORS[(start + offset) % COLORS.length];
            const name = `${color} ${deviceLabel}${number === 1 ? '' : ' ' + number}`;
            if (!usedNames.has(name)) return name;
        }
    }
}

module.exports = { getDeviceLabel, getDisplayName };
