const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { spawn } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const multer = require('multer');
const archiver = require('archiver');
const unzipper = require('unzipper');

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

// Store active servers with more details
const servers = new Map();

// Middleware
app.use(express.static('public'));

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
                
                const runningServer = servers.get(folder);
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
        
        // Read server.properties
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
        
        const runningServer = servers.get(name);
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
        
        if (servers.has(name) && servers.get(name).status === 'running') {
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
        
        // Auto-accept EULA if not present
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
        const javaCmd = [
            `-Xmx${ramValue}M`,
            `-Xms${Math.floor(ramValue/2)}M`,
            '-XX:+UseG1GC',
            '-XX:+ParallelRefProcEnabled',
            '-XX:MaxGCPauseMillis=200',
            '-XX:+UnlockExperimentalVMOptions',
            '-XX:+DisableExplicitGC',
            '-XX:+AlwaysPreTouch',
            '-XX:G1NewSizePercent=30',
            '-XX:G1MaxNewSizePercent=40',
            '-XX:G1HeapRegionSize=8M',
            '-XX:G1ReservePercent=20',
            '-XX:G1HeapWastePercent=5',
            '-XX:G1MixedGCCountTarget=4',
            '-XX:InitiatingHeapOccupancyPercent=15',
            '-XX:G1MixedGCLiveThresholdPercent=90',
            '-XX:G1RSetUpdatingPauseTimePercent=5',
            '-XX:SurvivorRatio=32',
            '-XX:+PerfDisableSharedMem',
            '-XX:MaxTenuringThreshold=1',
            ...(javaArgs ? javaArgs.split(' ') : []),
            '-jar',
            selectedJar,
            'nogui'
        ];
        
        console.log(`Starting ${name} with ${ramValue}MB RAM`);
        
        const java = spawn('java', javaCmd, {
            cwd: serverPath,
            shell: true,
            env: { ...process.env, TERM: 'dumb' } // Prevent ANSI escape issues
        });
        
        servers.set(name, {
            process: java,
            status: 'running',
            startTime: Date.now(),
            jarFile: selectedJar,
            ram: ramValue,
            path: serverPath,
            consoleBuffer: []
        });
        
        // Handle output with buffering
        java.stdout.on('data', (data) => {
            const output = data.toString();
            const server = servers.get(name);
            if (server) {
                server.consoleBuffer.push(output);
                if (server.consoleBuffer.length > 1000) server.consoleBuffer.shift();
                io.to(`server:${name}`).emit('console', output);
            }
        });
        
        java.stderr.on('data', (data) => {
            const error = data.toString();
            const server = servers.get(name);
            if (server) {
                server.consoleBuffer.push(`ERROR: ${error}`);
                io.to(`server:${name}`).emit('console', `§cERROR: ${error}`);
            }
        });
        
        java.on('close', (code) => {
            console.log(`[${name}] Server stopped with code ${code}`);
            const server = servers.get(name);
            if (server) {
                server.status = 'stopped';
                io.to(`server:${name}`).emit('status', 'stopped');
                io.to(`server:${name}`).emit('console', `\n§eServer stopped with exit code ${code}\n`);
            }
        });
        
        res.json({ success: true, message: `Starting with ${selectedJar}`, ram: ramValue });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Stop server
app.post('/api/server/:name/stop', (req, res) => {
    const { name } = req.params;
    const server = servers.get(name);
    
    if (server && server.status === 'running') {
        server.process.stdin.write('stop\n');
        setTimeout(() => {
            if (servers.has(name) && servers.get(name).status === 'running') {
                server.process.kill('SIGTERM');
                setTimeout(() => {
                    if (servers.has(name) && servers.get(name).status === 'running') {
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
    const server = servers.get(name);
    
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
    const server = servers.get(name);
    
    if (server) {
        res.json({ console: server.consoleBuffer || [] });
    } else {
        res.json({ console: [] });
    }
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
        const server = servers.get(name);
        if (server && server.status === 'running') {
            server.process.kill();
            servers.delete(name);
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
        const server = servers.get(serverName);
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`✅ Minecraft Panel running on http://localhost:${PORT}`);
    console.log(`📁 Servers directory: ${path.join(__dirname, 'servers')}`);
});