const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Serve static files
app.use(express.static('public'));

// Store active connections
const activeConnections = new Map();

// FFmpeg process for camera streaming
let ffmpegProcess = null;

// Start camera capture with FFmpeg and stream via WebSocket
function startCameraCapture() {
    if (ffmpegProcess) {
        ffmpegProcess.kill('SIGTERM');
    }

    const command = `
        libcamera-vid -t 0 --width 640 --height 480 --framerate 20 --inline --flush -o - |
        ffmpeg -i - -c:v libx264 -preset ultrafast -tune zerolatency
        -profile:v baseline -level 3.0 -pix_fmt yuv420p
        -x264opts keyint=20:min-keyint=20:scenecut=0:bframes=0
        -bufsize 64k -maxrate 1000k -g 20
        -fflags nobuffer -flags low_delay -strict experimental
        -f mpegts -`
    `;

    console.log('Starting camera capture with libcamera → ffmpeg pipeline');

    ffmpegProcess = spawn('bash', ['-c', command]);

    ffmpegProcess.stdout.on('data', (data) => {
        io.emit('video-data', data);
    });

    ffmpegProcess.stderr.on('data', (data) => {
        const output = data.toString();
        if (output.includes('frame=') || output.includes('fps=')) {
            console.log('FFmpeg status:', output.trim());
        } else {
            console.log('FFmpeg:', output);
        }
    });

    ffmpegProcess.on('close', (code) => {
        console.log(`FFmpeg process exited with code ${code}`);
        if (code !== 0 && code !== null) {
            console.error('FFmpeg crashed, attempting restart in 5 seconds...');
            setTimeout(startCameraCapture, 5000);
        }
    });

    ffmpegProcess.on('error', (error) => {
        console.error('FFmpeg error:', error);
    });

    console.log('Camera capture started');
}

// Alternative: Use raspivid for better Pi compatibility
function startRaspividCapture() {
    if (ffmpegProcess) {
        ffmpegProcess.kill('SIGTERM');
    }
    
    // Use raspivid for better Raspberry Pi compatibility
    const raspividArgs = [
        '-t', '0',           // Run indefinitely
        '-w', '640',         // Width
        '-h', '480',         // Height
        '-fps', '20',        // Frame rate
        '-b', '1000000',     // Bitrate
        '-o', '-'            // Output to stdout
    ];
    
    console.log('Starting raspivid capture...');
    
    ffmpegProcess = spawn('raspivid', raspividArgs);
    
    // Handle video data
    ffmpegProcess.stdout.on('data', (data) => {
        // Broadcast H.264 data to all connected clients
        io.emit('video-data', data);
    });
    
    ffmpegProcess.stderr.on('data', (data) => {
        console.log('Raspivid:', data.toString());
    });
    
    ffmpegProcess.on('close', (code) => {
        console.log(`Raspivid process exited with code ${code}`);
        if (code !== 0 && code !== null) {
            console.error('Raspivid crashed, attempting restart in 5 seconds...');
            setTimeout(startRaspividCapture, 5000);
        }
    });
    
    ffmpegProcess.on('error', (error) => {
        console.error('Raspivid error:', error);
        console.log('Falling back to FFmpeg...');
        setTimeout(startCameraCapture, 2000);
    });
    
    console.log('Raspivid capture started');
}

// Check camera availability
function checkCamera() {
    return new Promise((resolve, reject) => {
        if (fs.existsSync('/dev/video0')) {
            resolve('v4l2');
        } else {
            // Check if raspivid is available
            const raspivid = spawn('which', ['raspivid']);
            raspivid.on('close', (code) => {
                if (code === 0) {
                    resolve('raspivid');
                } else {
                    reject(new Error('No camera found'));
                }
            });
        }
    });
}

// Handle WebSocket connections
io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    activeConnections.set(socket.id, socket);
    
    // Send current status
    socket.emit('status', { 
        connected: true, 
        streaming: ffmpegProcess !== null,
        clients: activeConnections.size
    });
    
    socket.on('start-stream', () => {
        console.log('Client requested stream start');
        if (!ffmpegProcess) {
            checkCamera().then((cameraType) => {
                if (cameraType === 'raspivid') {
                    startRaspividCapture();
                } else {
                    startCameraCapture();
                }
            }).catch((error) => {
                console.error('Camera check failed:', error);
                socket.emit('error', 'Camera not available');
            });
        }
    });
    
    socket.on('stop-stream', () => {
        console.log('Client requested stream stop');
        if (ffmpegProcess) {
            ffmpegProcess.kill('SIGTERM');
            ffmpegProcess = null;
        }
    });
    
    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
        activeConnections.delete(socket.id);
        
        // Stop streaming if no clients connected
        if (activeConnections.size === 0 && ffmpegProcess) {
            console.log('No clients connected, stopping stream');
            ffmpegProcess.kill('SIGTERM');
            ffmpegProcess = null;
        }
    });
});

// API endpoint to check server status
app.get('/api/status', (req, res) => {
    res.json({
        streaming: ffmpegProcess !== null,
        clients: activeConnections.size,
        camera: fs.existsSync('/dev/video0') ? 'available' : 'not found'
    });
});

// Cleanup on exit
process.on('SIGINT', () => {
    console.log('Shutting down...');
    if (ffmpegProcess) {
        ffmpegProcess.kill('SIGTERM');
    }
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('Received SIGTERM, shutting down...');
    if (ffmpegProcess) {
        ffmpegProcess.kill('SIGTERM');
    }
    process.exit(0);
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
    console.log('Access the stream at: http://[PI_IP]:' + PORT);
    
    // Check camera availability on startup
    checkCamera().then((cameraType) => {
        console.log(`Camera detected: ${cameraType}`);
    }).catch((error) => {
        console.warn('Camera check failed:', error.message);
        console.log('Stream will start when client connects');
    });
});
