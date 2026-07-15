// Runtime configuration for the web app.
//
// Loaded before renderer.js. `window.API_BASE` is the base URL for all backend API
// calls. It is chosen by environment: on localhost (local dev / Electron) it points
// at the local backend; anywhere else (e.g. the Vercel deployment) it points at the
// production backend on Northflank.
(function () {
    var LOCAL_API = 'http://127.0.0.1:8000/api';
    var PROD_API = 'https://v1--lushwear-ims--44bb74tlkh9m.code.run/api';

    if (window.API_BASE) return; // allow an explicit override if one is already set

    var host = window.location.hostname;
    var isLocal = host === 'localhost' || host === '127.0.0.1' || host === '';
    window.API_BASE = isLocal ? LOCAL_API : PROD_API;
})();
