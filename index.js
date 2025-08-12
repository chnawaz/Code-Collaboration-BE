import express from "express";
import http from "http";
import { Server } from "socket.io";

const app = express();
const server = http.createServer(app);
server.listen(8080, () => {
  console.log("Server is listening to port 8080");
});

// Socket setup
const io = new Server(server, {
  cors: {
    origin: "*",
  },
});

const rooms = new Map();

const ROOM_DURATION = 30 * 60 * 1000;
const TURN_DURATION = 5 * 60 * 1000;
const MAX_USERS_PER_ROOM = 2;

function generateRoomId() {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 6; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return id;
}

function generateUniqueRoomId() {
  let roomId;
  do {
    roomId = generateRoomId();
  } while (rooms.has(roomId));
  return roomId;
}

io.on("connection", (socket) => {
  console.log("Client connected", socket.id);

  let currentRoom = null;
  let currentUser = null;

  socket.on("createRoom", ({ userName }) => {
    if (!userName || userName.trim() === "") {
      socket.emit("error", {
        message: "Username is required to create a room",
      });
      return;
    }

    if (currentRoom) {
      leaveRoom(socket, currentRoom, currentUser);
    }

    const roomId = generateUniqueRoomId();
    currentRoom = roomId;
    currentUser = userName.trim();

    socket.join(roomId);

    rooms.set(roomId, {
      users: new Set([currentUser]),
      usersArray: [currentUser],
      currentTurn: 0,
      turnTimer: null,
      roomTimer: null,
      startTime: new Date(),
      code: "",
      isActive: true,
      createdBy: currentUser,
    });

    startRoomTimer(roomId);

    socket.emit("roomCreated", {
      roomId: roomId,
      message: `Room ${roomId} created successfully!`,
      creator: currentUser,
    });

    emitRoomUpdate(roomId);

    console.log(`${currentUser} created and joined room ${roomId}`);
  });

  socket.on("join", ({ roomId, userName }) => {
    if (!roomId || !userName || userName.trim() === "") {
      socket.emit("error", { message: "Room ID and username are required" });
      return;
    }

    if (!rooms.has(roomId)) {
      socket.emit("error", { message: `Room ${roomId} does not exist!` });
      return;
    }

    const room = rooms.get(roomId);
    if (room.users.size >= MAX_USERS_PER_ROOM) {
      socket.emit("error", {
        message: "Room is full! Maximum 2 developers allowed.",
      });
      return;
    }

    if (room.users.has(userName.trim())) {
      socket.emit("error", { message: "Username already taken in this room!" });
      return;
    }

    if (currentRoom) {
      leaveRoom(socket, currentRoom, currentUser);
    }

    currentRoom = roomId;
    currentUser = userName.trim();

    socket.join(roomId);

    room.users.add(currentUser);
    room.usersArray.push(currentUser);

    if (room.users.size === 2 && !room.turnTimer) {
      startTurnTimer(roomId);
    }

    socket.emit("joinedRoom", {
      roomId: roomId,
      message: `Successfully joined room ${roomId}!`,
      users: Array.from(room.users),
    });

    emitRoomUpdate(roomId);

    console.log(`${userName} joined existing room ${roomId}`);
  });

  socket.on("getRoomInfo", ({ roomId }) => {
    if (!rooms.has(roomId)) {
      socket.emit("error", { message: `Room ${roomId} does not exist!` });
      return;
    }

    const room = rooms.get(roomId);
    socket.emit("roomInfo", {
      roomId,
      users: Array.from(room.users),
      userCount: room.users.size,
      maxUsers: MAX_USERS_PER_ROOM,
      createdBy: room.createdBy,
      startTime: room.startTime,
      isActive: room.isActive,
    });
  });

  socket.on("codeChange", ({ roomId, code }) => {
    if (!rooms.has(roomId)) return;

    const room = rooms.get(roomId);
    const userIndex = room.usersArray.indexOf(currentUser);

    if (userIndex !== room.currentTurn) {
      socket.emit("error", { message: "It's not your turn to edit!" });
      return;
    }

    room.code = code;
    socket.to(roomId).emit("codeUpdate", code);
    console.log(`Code updated in room ${roomId} by ${currentUser}`);
  });

  socket.on("disconnect", () => {
    if (currentRoom && currentUser) {
      leaveRoom(socket, currentRoom, currentUser);
    }
    console.log("User disconnected", socket.id);
  });

  function leaveRoom(socket, roomId, userName) {
    if (!rooms.has(roomId)) return;

    const room = rooms.get(roomId);
    room.users.delete(userName);
    room.usersArray = room.usersArray.filter((user) => user !== userName);

    if (
      room.usersArray.length > 0 &&
      room.currentTurn >= room.usersArray.length
    ) {
      room.currentTurn = 0;
    }

    if (room.users.size === 0) {
      clearRoom(roomId);
    } else {
      emitRoomUpdate(roomId);
    }

    socket.leave(roomId);
    console.log(`${userName} left room ${roomId}`);
  }
});

function startRoomTimer(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  room.roomTimer = setTimeout(() => {
    io.to(roomId).emit("roomExpired", {
      message: "Room session has ended (30 minutes)",
    });
    clearRoom(roomId);
  }, ROOM_DURATION);

  console.log(`Room timer started for room ${roomId}`);
}

function startTurnTimer(roomId) {
  const room = rooms.get(roomId);
  if (!room || room.users.size < 2) return;

  function nextTurn() {
    if (!rooms.has(roomId) || !room.isActive) return;

    room.currentTurn = (room.currentTurn + 1) % room.usersArray.length;

    emitRoomUpdate(roomId);

    room.turnTimer = setTimeout(nextTurn, TURN_DURATION);

    console.log(
      `Turn switched in room ${roomId}. Now it's ${
        room.usersArray[room.currentTurn]
      }'s turn`
    );
  }

  room.turnTimer = setTimeout(nextTurn, TURN_DURATION);
  console.log(
    `Turn timer started for room ${roomId}. ${
      room.usersArray[room.currentTurn]
    }'s turn`
  );
}

function emitRoomUpdate(roomId) {
  if (!rooms.has(roomId)) return;

  const room = rooms.get(roomId);
  const roomInfo = {
    roomId: roomId,
    users: Array.from(room.users),
    currentTurn: room.currentTurn,
    currentPlayer: room.usersArray[room.currentTurn] || null,
    code: room.code,
    timeRemaining: {
      room: getRemainingTime(room.startTime, ROOM_DURATION),
      turn: TURN_DURATION,
    },
  };

  io.to(roomId).emit("roomUpdate", roomInfo);
}

function getRemainingTime(startTime, duration) {
  const elapsed = Date.now() - startTime.getTime();
  return Math.max(0, duration - elapsed);
}

function clearRoom(roomId) {
  if (!rooms.has(roomId)) return;

  const room = rooms.get(roomId);

  if (room.roomTimer) {
    clearTimeout(room.roomTimer);
  }
  if (room.turnTimer) {
    clearTimeout(room.turnTimer);
  }

  rooms.delete(roomId);
  console.log(`Room ${roomId} cleared`);
}

setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of rooms.entries()) {
    const elapsed = now - room.startTime.getTime();
    if (elapsed > ROOM_DURATION || room.users.size === 0) {
      io.to(roomId).emit("roomExpired", {
        message: "Room cleaned up due to inactivity",
      });
      clearRoom(roomId);
    }
  }
}, 5 * 60 * 1000);
