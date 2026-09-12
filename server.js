const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const ROOM_CAPACITY = 2;
const rooms = new Map(); // roomId -> Map(socketId -> username)

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

io.on('connection', (socket) => {
  socket.on('join-room', ({ roomId, username }) => {
    roomId = String(roomId || '').trim().slice(0, 64);
    if (!roomId) return socket.emit('error-msg', { message: 'Invalid meeting link.' });

    const roomUsers = rooms.get(roomId) || new Map();

    if (roomUsers.size >= ROOM_CAPACITY) {
      return socket.emit('room-full', { roomId });
    }

    const cleanName = String(username || '').trim().slice(0, 24) || 'Guest';
    roomUsers.set(socket.id, cleanName);
    rooms.set(roomId, roomUsers);

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.username = cleanName;

    const peers = [...roomUsers.entries()].map(([id, name]) => ({ id, name }));

    socket.emit('joined', {
      userId: socket.id,
      roomId,
      users: peers,
      isInitiator: peers.length > 1,
    });

    if (peers.length > 1) {
      const peerId = peers.find((p) => p.id !== socket.id).id;
      io.to(peerId).emit('user-joined', { userId: socket.id, username: cleanName });
    }
  });

  socket.on('signal', ({ to, data }) => {
    if (socket.data.roomId && to) io.to(to).emit('signal', { from: socket.id, data });
  });

  socket.on('chat', ({ to, text }) => {
    if (!socket.data.roomId || !to) return;
    const name = socket.data.username || 'Guest';
    io.to(to).emit('chat', {
      from: socket.id,
      fromName: name,
      text: String(text || '').slice(0, 1000),
      time: Date.now(),
    });
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const roomUsers = rooms.get(roomId);
    if (!roomUsers) return;
    roomUsers.delete(socket.id);
    socket.to(roomId).emit('user-left', { userId: socket.id });
    if (roomUsers.size === 0) rooms.delete(roomId);
    else rooms.set(roomId, roomUsers);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Video call server running on http://localhost:${PORT}`);
});