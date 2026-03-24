const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { spawn } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const multer = require('multer');
const archiver = require('archiver');
const unzipper = require('unzipper');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Increase payload limits
app.use(express.json({ limit: '2gb' }));
app.use(express.urlencoded({ extended: true, limit: '2gb' }));

// Configure multer for large file uploads
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const { serverName } = req.params;
        const uploadPath = path.join(__dirname, 'servers', serverName, 'upload');
        fs.ensureDirSync(uploadPath);
        cb(null, uploadPath);
    },
    filename: function (req, file, cb) {
        const safeName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
        cb(null, safeName);
    }
});

const upload = multer({ 
    storage: storage,
    limits: { 
        fileSize: 2 * 1024 * 1024 * 1024,
        files: 50
    }
});

// Store active servers
const servers = new Map();
let activeTunnel = null;
let publicAddress = null;

// Helper: Get local IP
function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return '127.0.0.1';
}

// Helper: Start playit.gg tunnel
async function startPlayitTunnel(port) {
    return new Promise((resolve, reject) => {
        // Check if playit is installed
        const playitPath = '/data/data/com.termux/files/usr/bin/playit';
        const kaliPlayitPath = '/data/data/com.termux/files/usr/bin/start-kali';
        
        let playitCmd;
        if (fs.existsSync(playitPath)) {
            playitCmd = spawn('playit', [], { shell: true });
        } else if (fs.existsSync(kaliPlayitPath)) {
            playitCmd = spawn('start-kali', ['-c', 'playit'], { shell: true });
        } else {
            resolve({ success: false, error: 'playit.gg not installed' });
            return;
        }
        
        let output = '';
        let address = '';
        
        playitCmd.stdout.on('data', (data) => {
            output += data.toString();
            // Parse playit output for URL
            const match = output.match(/(https?:\/\/[^\s]+\.playit\.gg)/);
            const tcpMatch = output.match(/([a-z0-9-]+\.playit\.gg):(\d+)/);
            if (match && !address) {
                address = match[1];
                resolve({ success: true, address: address, type: 'http' });
            } else if (tcpMatch && !address) {
                address = `${tcpMatch[1]}:${tcpMatch[2]}`;
                resolve({ success: true, address: address, type: 'tcp' });
            }
        });
        
        playitCmd.stderr.on('data', (data) => {
            console.error('playit error:', data.toString());
        });
        
        playitCmd.on('error', (err) => {
            reject(err);
        });
        
        // Timeout after 30 seconds
        setTimeout(() => {
            if (!address) {
                resolve({ success: false, error: 'Timeout waiting for tunnel' });
            }
        }, 30000);
        
        activeTunnel = playitCmd;
    });
}

// API: Get network info (local IP and tunnel status)
app.get('/api/network/info', (req, res) => {
    res.json({
        localIP: getLocalIP(),
        publicAddress: publicAddress,
        tunnelActive: activeTunnel !== null,
        minecraftPort: 25531,
        webPort: 3000
    });
});

// API: Start tunnel
app.post('/api/network/start-tunnel', async (req, res) => {
    if (activeTunnel) {
        return res.json({ success: true, message: 'Tunnel already active', address: publicAddress });
    }
    
    try {
        const result = await startPlayitTunnel(25531);
        if (result.success) {
            publicAddress = result.address;
            res.json({ success: true, address: publicAddress, type: result.type });
        } else {
            res.json({ success: false, error: result.error });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// API: Stop tunnel
app.post('/api/network/stop-tunnel', (req, res) => {
    if (activeTunnel) {
        activeTunnel.kill();
        activeTunnel = null;
        publicAddress = null;
        res.json({ success: true });
    } else {
        res.json({ success: false, message: 'No active tunnel' });
    }
});

// API: Get server public address
app.get('/api/server/:name/address', (req, res) => {
    const { name } = req.params;
    const localIP = getLocalIP();
    const serverPort = 25531; // Your configured port
    
    res.json({
        serverName: name,
        localAddress: `${localIP}:${serverPort}`,
        publicAddress: publicAddress || null,
        tunnelActive: activeTunnel !== null
    });
});

// Middleware
app.use(express.static('public'));

// Store active servers
const serversMap = new Map();

// ==================== API ENDPOINTS ====================

// Upload server files
app.post('/api/server/upload/:serverName', upload.single('file'), async (req, res) => {
    const { serverName } = req.params;
    const uploadedFile = req.file;
    
    if (!uploadedFile) {
        return res.status(400).json({ error: 'No file uploaded' });
    }
    
    const serverPath = path.join(__dirname, 'servers', serverName);
    await fs.ensureDir(serverPath);
    
    try {
        const fileSizeMB = (uploadedFile.size / (1024 * 1024)).toFixed(2);
        
        if (uploadedFile.originalname.toLowerCase().endsWith('.zip')) {
            const zipPath = path.join(serverPath, 'upload', uploadedFile.filename);
            await fs.createReadStream(zipPath)
                .pipe(unzipper.Extract({ path: serverPath }))
                .promise();
            await fs.remove(zipPath);
            
            res.json({ success: true, message: `ZIP extracted (${fileSizeMB} MB)` });
        } else {
            const targetPath = path.join(serverPath, uploadedFile.filename);
            await fs.move(uploadedFile.path, targetPath, { overwrite: true });
            res.json({ success: true, message: `Uploaded ${uploadedFile.filename} (${fileSizeMB} MB)` });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Upload multiple files
app.post('/api/server/upload-multiple/:serverName', upload.array('files', 50), async (req, res) => {
    const { serverName } = req.params;
    const uploadedFiles = req.files;
    
    if (!uploadedFiles || uploadedFiles.length === 0) {
        return res.status(400).json({ error: 'No files uploaded' });
    }
    
    const serverPath = path.join(__dirname, 'servers', serverName);
    await fs.ensureDir(serverPath);
    
    try {
        const results = [];
        let totalSize = 0;
        
        for (const file of uploadedFiles) {
            const targetPath = path.join(serverPath, file.originalname);
            await fs.move(file.path, targetPath, { overwrite: true });
            results.push(file.originalname);
            totalSize += file.size;
        }
        
        res.json({ success: true, message: `${results.length} files uploaded`, files: results });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// List all servers
app.get('/api/servers', async (req, res) => {
    const serversPath = path.join(__dirname, 'servers');
    
    try {
        await fs.ensureDir(serversPath);
        const serverFolders = await fs.readdir(serversPath);
        
        const serversList = [];
        for (const folder of serverFolders) {
            const serverPath = path.join(serversPath, folder);
            const stat = await fs.stat(serverPath);
            
            if (stat.isDirectory()) {
                const files = await fs.readdir(serverPath);
                const jarFiles = files.filter(f => f.endsWith('.jar'));
                const hasEula = files.includes('eula.txt');
                
                let totalSize = 0;
                for (const file of files) {
                    const filePath = path.join(serverPath, file);
                    const fileStat = await fs.stat(filePath);
                    if (fileStat.isFile()) totalSize += fileStat.size;
                }
                
                const runningServer = serversMap.get(folder);
                serversList.push({
                    name: folder,
                    jarFiles: jarFiles,
                    hasEula: hasEula,
                    totalSize: totalSize,
                    fileCount: files.length,
                    status: runningServer ? runningServer.status : 'stopped',
                    uptime: runningServer && runningServer.status === 'running' ? Date.now() - runningServer.startTime : 0,
                    ram: runningServer ? runningServer.ram : null
                });
            }
        }
        
        res.json(serversList);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get server details
app.get('/api/server/:name', async (req, res) => {
    const { name } = req.params;
    const serverPath = path.join(__dirname, 'servers', name);
    
    try {
        if (!await fs.pathExists(serverPath)) {
            return res.status(404).json({ error: 'Server not found' });
        }
        
        const files = await fs.readdir(serverPath);
        const jarFiles = files.filter(f => f.endsWith('.jar'));
        
        let properties = {};
        const propsPath = path.join(serverPath, 'server.properties');
        if (await fs.pathExists(propsPath)) {
            const propsContent = await fs.readFile(propsPath, 'utf8');
            propsContent.split('\n').forEach(line => {
                if (line && !line.startsWith('#')) {
                    const [key, ...value] = line.split('=');
                    if (key && value) properties[key.trim()] = value.join('=').trim();
                }
            });
        }
        
        const runningServer = serversMap.get(name);
        res.json({
            name: name,
            jarFiles: jarFiles,
            properties: properties,
            status: runningServer ? runningServer.status : 'stopped',
            uptime: runningServer && runningServer.status === 'running' ? Date.now() - runningServer.startTime : 0,
            ram: runningServer ? runningServer.ram : null
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Start server
app.post('/api/server/:name/start', async (req, res) => {
    const { name } = req.params;
    const { jarFile, ram, javaArgs } = req.body;
    
    try {
        const serverPath = path.join(__dirname, 'servers', name);
        
        if (!await fs.pathExists(serverPath)) {
            return res.status(404).json({ error: 'Server not found' });
        }
        
        if (serversMap.has(name) && serversMap.get(name).status === 'running') {
            return res.status(400).json({ error: 'Server already running' });
        }
        
        let selectedJar = jarFile;
        if (!selectedJar) {
            const files = await fs.readdir(serverPath);
            const jarFiles = files.filter(f => f.endsWith('.jar'));
            if (jarFiles.length === 0) {
                return res.status(400).json({ error: 'No server JAR file found' });
            }
            selectedJar = jarFiles[0];
        }
        
        const jarPath = path.join(serverPath, selectedJar);
        if (!await fs.pathExists(jarPath)) {
            return res.status(404).json({ error: `JAR file ${selectedJar} not found` });
        }
        
        // Auto-accept EULA
        const eulaPath = path.join(serverPath, 'eula.txt');
        if (!await fs.pathExists(eulaPath)) {
            await fs.writeFile(eulaPath, 'eula=true\n');
        } else {
            const eulaContent = await fs.readFile(eulaPath, 'utf8');
            if (!eulaContent.includes('eula=true')) {
                await fs.writeFile(eulaPath, 'eula=true\n');
            }
        }
        
        const ramValue = ram || 1024;
        
        // Build Java arguments
        const javaCmd = [
            `-Xmx${ramValue}M`,
            `-Xms${Math.floor(ramValue/2)}M`,
            '-Dorg.jline.terminal.dumb=true',
            '-Djna.nosys=true',
            '-jar',
            selectedJar,
            'nogui'
        ];
        
        if (javaArgs && javaArgs.trim()) {
            const customArgs = javaArgs.trim().split(' ');
            javaCmd.unshift(...customArgs);
        }
        
        console.log(`Starting ${name} with: java ${javaCmd.join(' ')}`);
        
        const java = spawn('java', javaCmd, {
            cwd: serverPath,
            shell: true,
            env: { ...process.env, LD_LIBRARY_PATH: '/data/data/com.termux/files/usr/lib' }
        });
        
        serversMap.set(name, {
            process: java,
            status: 'running',
            startTime: Date.now(),
            jarFile: selectedJar,
            ram: ramValue,
            path: serverPath,
            consoleBuffer: []
        });
        
        java.stdout.on('data', (data) => {
            const output = data.toString();
            const server = serversMap.get(name);
            if (server) {
                server.consoleBuffer.push(output);
                if (server.consoleBuffer.length > 1000) server.consoleBuffer.shift();
                io.to(`server:${name}`).emit('console', output);
                console.log(`[${name}] ${output}`);
            }
        });
        
        java.stderr.on('data', (data) => {
            const error = data.toString();
            const server = serversMap.get(name);
            if (server) {
                server.consoleBuffer.push(`§cERROR: ${error}`);
                io.to(`server:${name}`).emit('console', `§cERROR: ${error}`);
            }
            console.error(`[${name}] Error: ${error}`);
        });
        
        java.on('close', (code) => {
            console.log(`[${name}] Server stopped with code ${code}`);
            const server = serversMap.get(name);
            if (server) {
                server.status = 'stopped';
                io.to(`server:${name}`).emit('status', 'stopped');
                io.to(`server:${name}`).emit('console', `§eServer stopped with exit code ${code}\n`);
            }
        });
        
        res.json({ 
            success: true, 
            message: `Server ${name} starting with ${selectedJar}`,
            jarFile: selectedJar,
            ram: ramValue
        });
        
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// Stop server
app.post('/api/server/:name/stop', (req, res) => {
    const { name } = req.params;
    const server = serversMap.get(name);
    
    if (server && server.status === 'running') {
        server.process.stdin.write('stop\n');
        setTimeout(() => {
            if (serversMap.has(name) && serversMap.get(name).status === 'running') {
                server.process.kill('SIGTERM');
                setTimeout(() => {
                    if (serversMap.has(name) && serversMap.get(name).status === 'running') {
                        server.process.kill('SIGKILL');
                    }
                }, 5000);
            }
        }, 10000);
        res.json({ success: true, message: 'Stopping server...' });
    } else {
        res.status(400).json({ error: 'Server not running' });
    }
});

// Send command
app.post('/api/server/:name/command', (req, res) => {
    const { name } = req.params;
    const { command } = req.body;
    const server = serversMap.get(name);
    
    if (server && server.status === 'running') {
        server.process.stdin.write(command + '\n');
        res.json({ success: true });
    } else {
        res.status(400).json({ error: 'Server not running' });
    }
});

// Get console history
app.get('/api/server/:name/console', (req, res) => {
    const { name } = req.params;
    const server = serversMap.get(name);
    
    if (server) {
        res.json({ console: server.consoleBuffer || [] });
    } else {
        res.json({ console: [] });
    }
});

// Get server status
app.get('/api/server/:name/status', (req, res) => {
    const { name } = req.params;
    const server = serversMap.get(name);
    
    res.json({
        status: server ? server.status : 'stopped',
        uptime: server ? Date.now() - server.startTime : 0,
        jarFile: server ? server.jarFile : null,
        ram: server ? server.ram : null
    });
});

// List files
app.get('/api/server/:name/files', async (req, res) => {
    const { name } = req.params;
    const { path: subPath = '' } = req.query;
    const serverPath = path.join(__dirname, 'servers', name, subPath);
    
    try {
        if (!await fs.pathExists(serverPath)) {
            return res.status(404).json({ error: 'Path not found' });
        }
        
        const items = await fs.readdir(serverPath);
        const fileDetails = await Promise.all(
            items.map(async item => {
                const itemPath = path.join(serverPath, item);
                const stat = await fs.stat(itemPath);
                return {
                    name: item,
                    path: path.join(subPath, item),
                    isDirectory: stat.isDirectory(),
                    size: stat.size,
                    modified: stat.mtime,
                    extension: path.extname(item)
                };
            })
        );
        
        fileDetails.sort((a, b) => {
            if (a.isDirectory && !b.isDirectory) return -1;
            if (!a.isDirectory && b.isDirectory) return 1;
            return a.name.localeCompare(b.name);
        });
        
        res.json(fileDetails);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get file content
app.get('/api/server/:name/file', async (req, res) => {
    const { name } = req.params;
    const { path: filePath } = req.query;
    const fullPath = path.join(__dirname, 'servers', name, filePath);
    
    try {
        if (!await fs.pathExists(fullPath)) {
            return res.status(404).json({ error: 'File not found' });
        }
        
        const stat = await fs.stat(fullPath);
        if (stat.isDirectory()) {
            return res.status(400).json({ error: 'Cannot read directory' });
        }
        
        if (stat.size > 5 * 1024 * 1024) {
            return res.json({ type: 'binary', message: 'File too large to edit', size: stat.size });
        }
        
        const ext = path.extname(fullPath).toLowerCase();
        const textExtensions = ['.txt', '.json', '.yml', '.properties', '.xml', '.html', '.css', '.js', '.md', '.conf', '.cfg', '.toml'];
        
        if (textExtensions.includes(ext)) {
            const content = await fs.readFile(fullPath, 'utf8');
            res.json({ type: 'text', content: content, size: stat.size });
        } else {
            res.download(fullPath, path.basename(fullPath));
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Save file
app.put('/api/server/:name/file', async (req, res) => {
    const { name } = req.params;
    const { path: filePath, content } = req.body;
    const fullPath = path.join(__dirname, 'servers', name, filePath);
    
    try {
        await fs.writeFile(fullPath, content, 'utf8');
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Delete file/folder
app.delete('/api/server/:name/file', async (req, res) => {
    const { name } = req.params;
    const { path: filePath } = req.body;
    const fullPath = path.join(__dirname, 'servers', name, filePath);
    
    try {
        await fs.remove(fullPath);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Create folder
app.post('/api/server/:name/folder', async (req, res) => {
    const { name } = req.params;
    const { path: folderPath, folderName } = req.body;
    const fullPath = path.join(__dirname, 'servers', name, folderPath, folderName);
    
    try {
        await fs.ensureDir(fullPath);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Download server backup
app.get('/api/server/:name/download', async (req, res) => {
    const { name } = req.params;
    const serverPath = path.join(__dirname, 'servers', name);
    
    try {
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename=${name}_backup.zip`);
        
        const archive = archiver('zip', { zlib: { level: 9 } });
        archive.pipe(res);
        archive.directory(serverPath, false);
        await archive.finalize();
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Delete server
app.delete('/api/server/:name', async (req, res) => {
    const { name } = req.params;
    
    try {
        const server = serversMap.get(name);
        if (server && server.status === 'running') {
            server.process.kill();
            serversMap.delete(name);
        }
        
        const serverPath = path.join(__dirname, 'servers', name);
        await fs.remove(serverPath);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Error handler
app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({ error: 'File too large', message: 'Maximum 2GB' });
        }
        return res.status(400).json({ error: err.message });
    }
    next(err);
});

// WebSocket
io.on('connection', (socket) => {
    console.log('Client connected');
    
    socket.on('subscribe', (serverName) => {
        socket.join(`server:${serverName}`);
        const server = serversMap.get(serverName);
        if (server && server.consoleBuffer) {
            socket.emit('console-history', server.consoleBuffer);
        }
    });
    
    socket.on('unsubscribe', (serverName) => {
        socket.leave(`server:${serverName}`);
    });
    
    socket.on('disconnect', () => {
        console.log('Client disconnected');
    });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`✅ Minecraft Panel running on http://localhost:${PORT}`);
    console.log(`📁 Servers directory: ${path.join(__dirname, 'servers')}`);
    console.log(`🌐 Local IP: ${getLocalIP()}:${PORT}`);
});
