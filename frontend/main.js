const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { spawn, exec } = require('child_process');

let mainWindow;
let backendProcess;

// Set to false if you want to run the backend separately for development
const AUTO_START_BACKEND = true;

// Set to true to hide the backend terminal window
const HIDE_BACKEND_WINDOW = true;

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
    
    const spawnOptions = {
        cwd: backendPath,
        shell: true
    };

    // Hide the terminal window on Windows
    if (HIDE_BACKEND_WINDOW && process.platform === 'win32') {
        spawnOptions.windowsHide = true;
        spawnOptions.creationFlags = 0x08000000; // CREATE_NO_WINDOW flag
    } else if (HIDE_BACKEND_WINDOW) {
        spawnOptions.detached = false;
        spawnOptions.stdio = ['ignore', 'pipe', 'pipe'];
    }

    backendProcess = spawn(pythonCmd, ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8000'], spawnOptions);

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

