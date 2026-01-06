const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { spawn, exec } = require('child_process');

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
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 1000,
        minHeight: 700,
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
    });

    mainWindow.on('closed', () => {
        killAllProcesses();
        mainWindow = null;
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
        
        // Start backend in a new visible terminal window with SHOW_TERMINALS=1
        const cmd = `start "Backend Server" cmd /k "set SHOW_TERMINALS=1 && ${startBackendScript}"`;
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

function killAllProcesses() {
    // Kill the backend process if it exists
    if (backendProcess && !backendProcess.killed) {
        try {
            if (process.platform === 'win32') {
                // Windows: Kill process tree
                exec(`taskkill /PID ${backendProcess.pid} /T /F`, (error) => {
                    if (error && !error.message.includes('not found')) {
                        console.log('Backend process already terminated');
                    }
                });
            } else {
                // Unix: Kill process tree
                backendProcess.kill('SIGTERM');
                setTimeout(() => {
                    if (!backendProcess.killed) {
                        backendProcess.kill('SIGKILL');
                    }
                }, 1000);
            }
        } catch (error) {
            console.log('Error killing backend process:', error);
        }
    }

    // Kill any processes using port 8000 (our backend port)
    if (process.platform === 'win32') {
        exec('netstat -ano | findstr :8000', (error, stdout) => {
            if (!error && stdout) {
                const lines = stdout.trim().split('\n');
                const pids = new Set();
                
                lines.forEach(line => {
                    const parts = line.trim().split(/\s+/);
                    const pid = parts[parts.length - 1];
                    if (pid && pid.match(/^\d+$/) && pid !== '0') {
                        pids.add(pid);
                    }
                });
                
                pids.forEach(pid => {
                    exec(`taskkill /PID ${pid} /T /F`, (err) => {
                        // Silently fail - process might already be terminated
                    });
                });
            }
        });
    } else {
        // Unix: Find and kill processes on port 8000
        exec('lsof -ti:8000', (error, stdout) => {
            if (!error && stdout) {
                const pids = stdout.trim().split('\n');
                pids.forEach(pid => {
                    if (pid) {
                        exec(`kill -9 ${pid}`, () => {});
                    }
                });
            }
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

app.on('window-all-closed', () => {
    killAllProcesses();
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('before-quit', () => {
    killAllProcesses();
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

