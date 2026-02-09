const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { spawn, exec, execSync } = require('child_process');

let mainWindow;
let backendProcess;

// Set to false if you want to run the backend separately for development
const AUTO_START_BACKEND = true;

// Set to true to hide the backend terminal window
// Can be overridden by SHOW_TERMINALS environment variable (1 = show, 0 = hide)
// Check both environment variable and if it's set to '1' or 'true'
const SHOW_TERMINALS_ENV = process.env.SHOW_TERMINALS;
const SHOW_TERMINALS = SHOW_TERMINALS_ENV === '1' || SHOW_TERMINALS_ENV === 'true' || SHOW_TERMINALS_ENV === 'TRUE';
const HIDE_BACKEND_WINDOW = !SHOW_TERMINALS;

function createWindow() {
    const iconPath = path.join(__dirname, 'assets', 'Logo.png');
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 1000,
        minHeight: 700,
        icon: iconPath,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        },
        titleBarStyle: 'hidden',
        titleBarOverlay: {
            color: '#ffffff',
            symbolColor: '#1a1a1a',
            height: 40
        },
        backgroundColor: '#ffffff',
        show: false
    });

    mainWindow.loadFile('index.html');
    
    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
        mainWindow.maximize();
        setupFullScreenListeners();
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

ipcMain.handle('set-fullscreen', (_, flag) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setFullScreen(!!flag);
    }
});

function setupFullScreenListeners() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.on('enter-full-screen', () => {
        mainWindow.webContents.send('fullscreen-changed', true);
    });
    mainWindow.on('leave-full-screen', () => {
        mainWindow.webContents.send('fullscreen-changed', false);
    });
}

function startBackend() {
    const backendPath = path.join(__dirname, '..', 'backend');
    
    // Use the virtual environment's Python
    let pythonCmd;
    if (process.platform === 'win32') {
        pythonCmd = path.join(backendPath, 'venv', 'Scripts', 'python.exe');
    } else {
        pythonCmd = path.join(backendPath, 'venv', 'bin', 'python');
    }
    
    // If SHOW_TERMINALS is enabled, start backend in a separate visible terminal window
    if (!HIDE_BACKEND_WINDOW && process.platform === 'win32') {
        // Start in a new visible terminal window on Windows
        const startBackendScript = path.join(__dirname, '..', 'start-backend.bat');
        const { exec } = require('child_process');
        
        console.log('Starting backend in separate terminal window...');
        
        // Start backend in a new visible terminal window with SHOW_TERMINALS=1; -y so BE terminal closes smoothly
        const cmd = `start "Backend Server" cmd /k "set SHOW_TERMINALS=1 && ${startBackendScript} -y"`;
        exec(cmd, {
            cwd: path.join(__dirname, '..'),
            env: { ...process.env, SHOW_TERMINALS: '1' }
        }, (error) => {
            if (error) {
                console.error('Error starting backend in separate terminal:', error);
                // Fallback to normal spawn
                startBackendSpawn();
            } else {
                console.log('Backend started in separate terminal window');
            }
        });
        return;
    }
    
    // Normal spawn (hidden or visible based on setting)
    startBackendSpawn();
    
    function startBackendSpawn() {
        const spawnOptions = {
            cwd: backendPath,
            shell: true
        };

        // Show or hide the terminal window based on HIDE_BACKEND_WINDOW setting
        if (HIDE_BACKEND_WINDOW && process.platform === 'win32') {
            // Hide the terminal window on Windows
            spawnOptions.windowsHide = true;
            spawnOptions.creationFlags = 0x08000000; // CREATE_NO_WINDOW flag
        } else if (HIDE_BACKEND_WINDOW) {
            // Hide on other platforms
            spawnOptions.detached = false;
            spawnOptions.stdio = ['ignore', 'pipe', 'pipe'];
        } else {
            // Show terminal - don't hide it
            spawnOptions.detached = false;
            spawnOptions.stdio = 'inherit';
        }

        backendProcess = spawn(pythonCmd, ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8000'], spawnOptions);

        if (backendProcess) {
            backendProcess.stdout.on('data', (data) => {
                console.log(`Backend: ${data}`);
            });

            backendProcess.stderr.on('data', (data) => {
                console.error(`Backend Error: ${data}`);
            });

            backendProcess.on('close', (code) => {
                console.log(`Backend process exited with code ${code}`);
            });
        }
    }
}

/**
 * Terminate the backend and any process on port 8000.
 * On Windows: try graceful close first (taskkill without /F, like -y/smooth), then force if needed.
 * @param {() => void} [callback] - Called when all kill operations are finished. If omitted, runs without waiting.
 */
function killAllProcesses(callback) {
    const done = () => {
        if (typeof callback === 'function') callback();
    };

    // 1) Kill the backend process if we spawned it
    if (backendProcess && !backendProcess.killed) {
        try {
            if (process.platform === 'win32') {
                try {
                    // Graceful first (no /F) so BE closes smoothly
                    execSync(`taskkill /PID ${backendProcess.pid} /T`, { stdio: 'ignore' });
                } catch (e) {
                    // Process may already be gone or didn't exit; force if still running
                    try {
                        execSync(`taskkill /PID ${backendProcess.pid} /T /F`, { stdio: 'ignore' });
                    } catch (e2) { /* ignore */ }
                }
            } else {
                backendProcess.kill('SIGTERM');
                setTimeout(() => {
                    if (backendProcess && !backendProcess.killed) {
                        backendProcess.kill('SIGKILL');
                    }
                }, 500);
            }
        } catch (error) {
            console.log('Error killing backend process:', error);
        }
    }

    // 2) Kill any process using port 8000 (covers backend started in separate terminal)
    if (process.platform === 'win32') {
        exec('netstat -ano | findstr :8000', (error, stdout) => {
            if (error || !stdout || !stdout.trim()) {
                done();
                return;
            }
            const pids = new Set();
            stdout.trim().split('\n').forEach(line => {
                const parts = line.trim().split(/\s+/);
                const pid = parts[parts.length - 1];
                if (pid && /^\d+$/.test(pid) && pid !== '0') pids.add(pid);
            });
            const arr = [...pids];
            if (arr.length === 0) {
                done();
                return;
            }
            // Graceful first (no /F) so BE terminal closes smoothly
            let completed = 0;
            arr.forEach(pid => {
                exec(`taskkill /PID ${pid} /T`, () => {
                    completed++;
                    if (completed === arr.length) {
                        // After short delay, force any remaining on port 8000
                        setTimeout(() => {
                            exec('netstat -ano | findstr :8000', (err2, out2) => {
                                if (err2 || !out2 || !out2.trim()) {
                                    done();
                                    return;
                                }
                                const pids2 = new Set();
                                out2.trim().split('\n').forEach(line => {
                                    const parts = line.trim().split(/\s+/);
                                    const p = parts[parts.length - 1];
                                    if (p && /^\d+$/.test(p) && p !== '0') pids2.add(p);
                                });
                                const arr2 = [...pids2];
                                if (arr2.length === 0) {
                                    done();
                                    return;
                                }
                                let doneCount = 0;
                                arr2.forEach(p => {
                                    exec(`taskkill /PID ${p} /T /F`, () => {
                                        doneCount++;
                                        if (doneCount === arr2.length) done();
                                    });
                                });
                            });
                        }, 2000);
                    }
                });
            });
        });
    } else {
        exec('lsof -ti:8000', (error, stdout) => {
            if (error || !stdout || !stdout.trim()) {
                done();
                return;
            }
            const pids = stdout.trim().split('\n').filter(Boolean);
            if (pids.length === 0) {
                done();
                return;
            }
            let completed = 0;
            pids.forEach(pid => {
                exec(`kill -9 ${pid}`, () => {
                    completed++;
                    if (completed === pids.length) done();
                });
            });
        });
    }
}

app.whenReady().then(() => {
    if (AUTO_START_BACKEND) {
        startBackend();
        // Give backend time to start
        setTimeout(createWindow, 2000);
    } else {
        // Backend running separately, start immediately
        createWindow();
    }

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

/** Set when we have finished killing backend and are calling app.quit(); prevents before-quit from re-running kill. */
let exitingAfterKill = false;

app.on('window-all-closed', () => {
    killAllProcesses(() => {
        if (process.platform !== 'darwin') {
            exitingAfterKill = true;
            app.quit();
        }
    });
});

app.on('before-quit', (event) => {
    if (exitingAfterKill) return;
    event.preventDefault();
    exitingAfterKill = true;
    killAllProcesses(() => {
        app.quit();
    });
});

// Handle app termination
process.on('SIGTERM', () => {
    killAllProcesses();
    app.quit();
});

process.on('SIGINT', () => {
    killAllProcesses();
    app.quit();
});

