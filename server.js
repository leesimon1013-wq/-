const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require('socket.io');
const io = new Server(server, {
    cors: {
        origin: "*", // Allow all for local dev
        methods: ["GET", "POST"]
    }
});
const path = require('path');

// Simple health check endpoint for the root URL
app.get('/', (req, res) => {
    res.send('RTS Multiplayer Server is running smoothly! 🚀');
});

// --- Multiplayer Lobby State ---
// Map of room ID -> Room Object
// Room Object: { id: string, name: string, hostId: string, clients: string[], state: 'waiting' | 'playing' }
const rooms = new Map();

io.on('connection', (socket) => {
    console.log(`[+] User connected: ${socket.id}`);

    // --- Lobby Management ---

    socket.on('get_rooms', () => {
        // Send list of available waiting rooms
        const availableRooms = Array.from(rooms.values()).filter(r => r.state === 'waiting').map(r => ({
            id: r.id,
            name: r.name,
            playerCount: r.clients.length + 1 // +1 for host
        }));
        socket.emit('room_list', availableRooms);
    });

    socket.on('create_room', (data) => {
        const roomName = data.roomName || `Room-${Math.floor(Math.random() * 1000)}`;
        const roomId = `room_${socket.id}_${Date.now()}`;

        const room = {
            id: roomId,
            name: roomName,
            hostId: socket.id,
            clients: [],
            state: 'waiting'
        };

        rooms.set(roomId, room);
        socket.join(roomId);
        console.log(`[Room] ${socket.id} created room: ${roomId}`);

        socket.emit('room_created', { roomId, roomName });
        // Broadcast new room list to everyone in lobby
        io.emit('room_update');
    });

    socket.on('join_room', (roomId) => {
        const room = rooms.get(roomId);
        if (!room) {
            socket.emit('join_error', '房間不存在或已關閉');
            return;
        }
        if (room.state !== 'waiting') {
            socket.emit('join_error', '遊戲已開始');
            return;
        }
        if (room.clients.length >= 1) { // 限制 1v1 (1 Host + 1 Client)
            socket.emit('join_error', '房間已滿');
            return;
        }

        room.clients.push(socket.id);
        socket.join(roomId);
        console.log(`[Room] ${socket.id} joined room: ${roomId}`);

        // Notify Host that a client joined
        socket.to(room.hostId).emit('player_joined', { playerId: socket.id });

        // Confirm join to client
        socket.emit('room_joined', { roomId, roomName: room.name, hostId: room.hostId });

        // Update lobby
        io.emit('room_update');
    });

    socket.on('start_game', (roomId) => {
        const room = rooms.get(roomId);
        if (room && room.hostId === socket.id) {
            room.state = 'playing';
            // Notify all in room to start game logic
            io.to(roomId).emit('game_started');
            console.log(`[Room] ${roomId} started game.`);
            io.emit('room_update'); // Update lobby to remove this room
        }
    });

    // --- In-Game Synchronization ---

    // Host sends game state to relay to all clients
    socket.on('relay_state', (data) => {
        // data should contain { roomId, state: {...} }
        if (data.roomId) {
            // Send to everyone in room EXCEPT sender (host)
            // Using volatile because missing one state update is fine (it's continuous)
            socket.volatile.to(data.roomId).emit('sync_state', data.state);
        }
    });

    // Client sends command to Host
    socket.on('relay_command', (data) => {
        // data should contain { roomId, action: '...', params: {...} }
        if (data.roomId) {
            socket.to(data.roomId).emit('client_command', {
                clientId: socket.id,
                action: data.action,
                params: data.params
            });
        }
    });

    // --- Disconnect Handling ---
    socket.on('disconnect', () => {
        console.log(`[-] User disconnected: ${socket.id}`);

        // Clean up rooms
        for (const [roomId, room] of rooms.entries()) {
            if (room.hostId === socket.id) {
                // Host left, destroy room
                socket.to(roomId).emit('room_closed', '房主已離開遊戲');
                rooms.delete(roomId);
                io.emit('room_update');
            } else if (room.clients.includes(socket.id)) {
                // Client left
                room.clients = room.clients.filter(id => id !== socket.id);
                socket.to(roomId).emit('player_left', { playerId: socket.id });
                if (room.state === 'waiting') {
                    io.emit('room_update');
                }
            }
        }
    });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`=================================`);
    console.log(`  RTS Multiplayer Server Status  `);
    console.log(`  Listening on port ${PORT}      `);
    console.log(`=================================`);
});
