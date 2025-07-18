#!/bin/bash

# Raspberry Pi WebRTC Stream Setup Script
# Run this script to set up the WebRTC streaming server

set -e

echo "🍓 Setting up Raspberry Pi WebRTC Stream Server..."

# Update system
echo "📦 Updating system packages..."
sudo apt-get update

# Install required system packages
echo "🔧 Installing system dependencies..."
sudo apt-get install -y \
    ffmpeg \
    v4l-utils

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "📥 Installing Node.js..."
    curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
    sudo apt-get install -y nodejs
else
    echo "✅ Node.js is already installed"
fi

# Verify Node.js version
echo "🔍 Node.js version: $(node --version)"
echo "🔍 NPM version: $(npm --version)"

# Enable camera if not already enabled
echo "📷 Checking camera configuration..."
if ! grep -q "^camera_auto_detect=1" /boot/config.txt; then
    echo "🔧 Enabling camera..."
    echo "camera_auto_detect=1" | sudo tee -a /boot/config.txt
    echo "⚠️  Camera enabled. Please reboot after setup completes."
fi

# Check if camera is available
if [ ! -e /dev/video0 ]; then
    echo "⚠️  Camera not detected at /dev/video0"
    echo "   Make sure your camera is connected and enabled in raspi-config"
    echo "   Run: sudo raspi-config -> Interface Options -> Camera -> Enable"
fi

# Create project directory structure
echo "📁 Creating project structure..."
mkdir -p public

# Install Node.js dependencies
echo "📦 Installing Node.js dependencies..."
npm install

# Set up systemd service (optional)
echo "🚀 Setting up systemd service..."
sudo tee /etc/systemd/system/webrtc-stream.service > /dev/null <<EOF
[Unit]
Description=Raspberry Pi WebRTC Stream Server
After=network.target

[Service]
Type=simple
User=pi
WorkingDirectory=$(pwd)
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

# Enable and start the service
sudo systemctl daemon-reload
sudo systemctl enable webrtc-stream.service

echo "✅ Setup complete!"
echo ""
echo "📋 Next steps:"
echo "1. Reboot if camera was just enabled: sudo reboot"
echo "2. Start the server: npm start"
echo "3. Or start as service: sudo systemctl start webrtc-stream"
echo "4. Access the stream at: http://$(hostname -I | cut -d' ' -f1):3000"
echo ""
echo "🔧 Useful commands:"
echo "   View logs: sudo journalctl -u webrtc-stream -f"
echo "   Stop service: sudo systemctl stop webrtc-stream"
echo "   Check status: sudo systemctl status webrtc-stream"
echo "   Test camera: v4l2-ctl --list-devices"
echo ""
echo "🌐 Access from other devices using the Pi's IP address"
echo "   Find IP: hostname -I"
