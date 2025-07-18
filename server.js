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
    },
    // Optimize Socket.IO for low latency
    pingTimeout: 60000,
    pingInterval: 25000,
    transports: ['websocket']
});

// Serve static files
app.use(express.static('public'));

// Store active connections
const activeConnections = new Map();

// FFmpeg process for camera streaming
let ffmpegProcess = null;

// Zero-latency camera capture using libcamera-vid with hardware encoding
function startCameraCapture() {
    if (ffmpegProcess) {
        ffmpegProcess.kill('SIGTERM');
    }

    // Optimized command for Pi Camera Module v2.1 with zero latency
    const command = `libcamera-vid -t 0 --width 640 --height 480 --framerate 30 --inline --flush --codec h264 --level 4.0 --bitrate 1500000 --intra 30 -o - | ffmpeg -i - -c:v copy -f mpegts -fflags nobuffer -flags low_delay -muxdelay 0 -`;

    console.log('Starting zero-latency camera capture with libcamera → ffmpeg pipeline');

    ffmpegProcess = spawn('bash', ['-c', command]);

    // Handle video data with minimal buffering
    ffmpegProcess.stdout.on('data', (data) => {
        // Emit immediately without buffering
        io.emit('video-data', data);
    });

    ffmpegProcess.stderr.on('data', (data) => {
        const output = data.toString();
        if (output.includes('frame=') || output.includes('fps=')) {
            console.log('FFmpeg status:', output.trim());
        } else if (!output.includes('deprecated')) {
            console.log('FFmpeg:', output);
        }
    });

    ffmpegProcess.on('close', (code) => {
        console.log(`FFmpeg process exited with code ${code}`);
        if (code !== 0 && code !== null) {
            console.error('FFmpeg crashed, attempting restart in 2 seconds...');
            setTimeout(startCameraCapture, 2000);
        }
    });

    ffmpegProcess.on('error', (error) => {
        console.error('FFmpeg error:', error);
    });

    console.log('Zero-latency camera capture started');
}

// Ultra-low latency version (I-frame only, higher bitrate)
function startUltraLowLatencyCapture() {
    if (ffmpegProcess) {
        ffmpegProcess.kill('SIGTERM');
    }

    // I-frame only for absolute minimum latency
    const command = `libcamera-vid -t 0 --width 640 --height 480 --framerate 30 --inline --flush --codec h264 --level 4.0 --bitrate 3000000 --intra 1 -o - | ffmpeg -i - -c:v copy -f mpegts -fflags nobuffer -flags low_delay -muxdelay 0 -muxpreload 0 -`;

    console.log('Starting ULTRA-low latency camera capture (I-frame only)');

    ffmpegProcess = spawn('bash', ['-c', command]);

    ffmpegProcess.stdout.on('data', (data) => {
        io.emit('video-data', data);
    });

    ffmpegProcess.stderr.on('data', (data) => {
        const output = data.toString();
        if (!output.includes('deprecated') && !output.includes('frame=')) {
            console.log('FFmpeg:', output);
        }
    });

    ffmpegProcess.on('close', (code) => {
        console.log(`Ultra-low latency FFmpeg process exited with code ${code}`);
        if (code !== 0 && code !== null) {
            console.error('FFmpeg crashed, attempting restart in 2 seconds...');
            setTimeout(startUltraLowLatencyCapture, 2000);
        }
    });

    ffmpegProcess.on('error', (error) => {
        console.error('FFmpeg error:', error);
    });

    console.log('Ultra-low latency capture started');
}

// Fallback to raspivid (legacy)
function startRaspividCapture() {
    if (ffmpegProcess) {
        ffmpegProcess.kill('SIGTERM');
    }
    
    const raspividArgs = [
        '-t', '0',           // Run indefinitely
        '-w', '640',         // Width
        '-h', '480',         // Height
        '-fps', '30',        // Increased frame rate
        '-b', '2000000',     // Higher bitrate
        '-g', '30',          // GOP size
        '-o', '-'            // Output to stdout
    ];
    
    console.log('Starting raspivid capture (fallback)...');
    
    ffmpegProcess = spawn('raspivid', raspividArgs);
    
    ffmpegProcess.stdout.on('data', (data) => {
        io.emit('video-data', data);
    });
    
    ffmpegProcess.stderr.on('data', (data) => {
        console.log('Raspivid:', data.toString());
    });
    
    ffmpegProcess.on('close', (code) => {
        console.log(`Raspivid process exited with code ${code}`);
        if (code !== 0 && code !== null) {
            console.error('Raspivid crashed, attempting restart in 2 seconds...');
            setTimeout(startRaspividCapture, 2000);
        }
    });
    
    ffmpegProcess.on('error', (error) => {
        console.error('Raspivid error:', error);
        console.log('Falling back to basic FFmpeg...');
        setTimeout(startCameraCapture, 2000);
    });
    
    console.log('Raspivid capture started');
}

// Check camera availability
function checkCamera() {
    return new Promise((resolve, reject) => {
        // Check for libcamera-vid first (preferred for Pi Camera Module v2.1)
        const libcameraCheck = spawn('which', ['libcamera-vid']);
        libcameraCheck.on('close', (code) => {
            if (code === 0) {
                resolve('libcamera-vid');
            } else {
                // Fall back to raspivid
                const raspividCheck = spawn('which', ['raspivid']);
                raspividCheck.on('close', (code) => {
                    if (code === 0) {
                        resolve('raspivid');
                    } else {
                        reject(new Error('No camera software found'));
                    }
                });
            }
        });
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
    
    socket.on('start-stream', (options = {}) => {
        console.log('Client requested stream start');
        if (!ffmpegProcess) {
            checkCamera().then((cameraType) => {
                if (cameraType === 'libcamera-vid') {
                    if (options.ultraLowLatency) {
                        startUltraLowLatencyCapture();
                    } else {
                        startCameraCapture();
                    }
                } else if (cameraType === 'raspivid') {
                    startRaspividCapture();
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
        camera: fs.existsSync('/dev/video0') ? 'available' : 'checking...'
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
        console.log(`Camera software detected: ${cameraType}`);
        console.log('Ready for zero-latency streaming!');
    }).catch((error) => {
        console.warn('Camera check failed:', error.message);
        console.log('Stream will start when client connects');
    });
});
