const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { spawn } = require('child_process');
const { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate } = require('node-webrtc');

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

// Store peer connections
const peers = new Map();

// FFmpeg process for camera streaming
let ffmpegProcess = null;

// WebRTC configuration
const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

// Start camera capture with FFmpeg
function startCameraCapture() {
    if (ffmpegProcess) {
        ffmpegProcess.kill();
    }
    
    // FFmpeg command for Raspberry Pi camera
    const ffmpegArgs = [
        '-f', 'v4l2',
        '-framerate', '30',
        '-video_size', '640x480',
        '-i', '/dev/video0',
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-tune', 'zerolatency',
        '-pix_fmt', 'yuv420p',
        '-f', 'rtp',
        '-sdp_file', 'stream.sdp',
        'rtp://127.0.0.1:5004'
    ];
    
    ffmpegProcess = spawn('ffmpeg', ffmpegArgs);
    
    ffmpegProcess.stderr.on('data', (data) => {
        console.log(`FFmpeg: ${data}`);
    });
    
    ffmpegProcess.on('close', (code) => {
        console.log(`FFmpeg process exited with code ${code}`);
    });
    
    console.log('Camera capture started');
}

// Handle WebRTC connections
io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    
    socket.on('offer', async (data) => {
        try {
            const { offer } = data;
            console.log('Received offer from client');
            
            // Create peer connection
            const pc = new RTCPeerConnection(rtcConfig);
            peers.set(socket.id, pc);
            
            // Handle ICE candidates
            pc.onicecandidate = (event) => {
                if (event.candidate) {
                    socket.emit('ice-candidate', event.candidate);
                }
            };
            
            // Handle connection state changes
            pc.onconnectionstatechange = () => {
                console.log('Connection state:', pc.connectionState);
                if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
                    cleanup(socket.id);
                }
            };
            
            // Set remote description
            await pc.setRemoteDescription(new RTCSessionDescription(offer));
            
            // Add video track (this is a simplified version - you'll need to capture actual video)
            // For now, we'll create a basic answer
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            
            socket.emit('answer', answer);
            
        } catch (error) {
            console.error('Error handling offer:', error);
            socket.emit('error', error.message);
        }
    });
    
    socket.on('ice-candidate', async (candidate) => {
        try {
            const pc = peers.get(socket.id);
            if (pc) {
                await pc.addIceCandidate(new RTCIceCandidate(candidate));
            }
        } catch (error) {
            console.error('Error adding ICE candidate:', error);
        }
    });
    
    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
        cleanup(socket.id);
    });
});

// Cleanup function
function cleanup(socketId) {
    const pc = peers.get(socketId);
    if (pc) {
        pc.close();
        peers.delete(socketId);
    }
}

// Cleanup on exit
process.on('SIGINT', () => {
    console.log('Shutting down...');
    if (ffmpegProcess) {
        ffmpegProcess.kill();
    }
    peers.forEach(pc => pc.close());
    process.exit(0);
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
    console.log('Access the stream at: http://[PI_IP]:' + PORT);
    
    // Start camera capture
    setTimeout(startCameraCapture, 2000);
});
