const content = {
    "name": "Snapdrop",
    "short_name": "Snapdrop",
    "icons": [{
        "src": "images/android-chrome-192x192.png",
        "sizes": "192x192",
        "type": "image/png"
    },{
        "src": "images/android-chrome-512x512.png",
        "sizes": "512x512",
        "type": "image/png"
    },{
        "src": "images/android-chrome-192x192-maskable.png",
        "sizes": "192x192",
        "type": "image/png",
        "purpose": "maskable"
    },{
        "src": "images/android-chrome-512x512-maskable.png",
        "sizes": "512x512",
        "type": "image/png",
        "purpose": "maskable"
    },{
        "src": "images/favicon-96x96.png",
        "sizes": "96x96",
        "type": "image/png"
    }],
    "background_color": "#efefef",
    "start_url": "/",
    "display": "standalone",
    "theme_color": "#3367d6",
    "share_target": {
        "method":"GET",
        "action": "/?share_target",
        "params": {
            "title": "title",
            "text": "text",
            "url": "url"
        }
    }
}

const iOSversion = parseFloat(
	('' + (/CPU.*OS ([0-9_]{1,5})|(CPU like).*AppleWebKit.*Mobile/i.exec(navigator.userAgent) || [0,''])[1])
	.replace('undefined', '3_2').replace('_', '.').replace('_', '')
) || false;


if (iOSversion && iOSversion < 13) {
    content["display"] = "minimal-ui";
}

const stringManifest = JSON.stringify(content);
const blob = new Blob([stringManifest], {type: 'application/json'});
const manifestURL = URL.createObjectURL(blob);
document.querySelector('#manifest-placeholder').setAttribute('href', manifestURL);
