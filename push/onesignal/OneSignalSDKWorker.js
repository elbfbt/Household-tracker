// OneSignal push service worker. Registered by the OneSignal SDK with the scope /push/onesignal/ so that it never
// replaces or competes with the app's own service worker (sw.js, scope /), which keeps handling offline + caching.
importScripts("https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js");
