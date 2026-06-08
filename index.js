const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ["http://localhost:5173", "https://befastgames.ir"],
    methods: ["GET", "POST"],
  },
});

// 1. World Map Database (Classified strictly by East vs West Longitude)
const COUNTRY_DATABASE = [
  { name: "United States", code: "us", side: "west" },
  { name: "Canada", code: "ca", side: "west" },
  { name: "Brazil", code: "br", side: "west" },
  { name: "Mexico", code: "mx", side: "west" },
  { name: "Argentina", code: "ar", side: "west" },
  { name: "Colombia", code: "co", side: "west" },
  { name: "Peru", code: "pe", side: "west" },
  { name: "Chile", code: "cl", side: "west" },

  { name: "Iran", code: "ir", side: "east" },
  { name: "Japan", code: "jp", side: "east" },
  { name: "Australia", code: "au", side: "east" },
  { name: "China", code: "cn", side: "east" },
  { name: "Germany", code: "de", side: "east" },
  { name: "India", code: "in", side: "east" },
  { name: "South Africa", code: "za", side: "east" },
  { name: "Saudi Arabia", code: "sa", side: "east" },
];

const rooms = new Map();
const PENALTY_COOLDOWN = 1000; // 1-second freeze for incorrect answers

function generateRandomFlags() {
  const shuffled = [...COUNTRY_DATABASE].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, 4);
}

io.on("connection", (socket) => {
  console.log(`Connected: ${socket.id}`);

  socket.on("create_room", (playerName) => {
    const roomId = Math.random().toString(36).substring(2, 7).toUpperCase();
    rooms.set(roomId, {
      hostId: socket.id,
      players: {
        [socket.id]: {
          name: playerName,
          score: 0,
          correctlySorted: [],
          penaltyUntil: 0,
          readyForRematch: false,
        },
      },
      flags: [],
      gameStarted: false,
    });
    socket.join(roomId);
    socket.emit("room_created", {
      roomId,
      players: rooms.get(roomId).players,
      hostId: socket.id,
    });
  });

  socket.on("join_room", ({ roomId, playerName }) => {
    const room = rooms.get(roomId);
    if (!room) return socket.emit("error_message", "Room not found.");
    if (room.gameStarted)
      return socket.emit("error_message", "Game in progress.");
    if (Object.keys(room.players).length >= 8)
      return socket.emit("error_message", "Room is full.");

    room.players[socket.id] = {
      name: playerName,
      score: 0,
      correctlySorted: [],
      penaltyUntil: 0,
      readyForRematch: false,
    };
    socket.join(roomId);
    io.to(roomId).emit("room_updated", {
      players: room.players,
      hostId: room.hostId,
    });
  });

  socket.on("start_game", (roomId) => {
    const room = rooms.get(roomId);
    if (!room || room.hostId !== socket.id || room.gameStarted) return;
    if (Object.keys(room.players).length < 2)
      return socket.emit("error_message", "Need at least 2 players.");

    room.gameStarted = true;
    room.flags = generateRandomFlags();

    Object.keys(room.players).forEach((id) => {
      room.players[id].score = 0;
      room.players[id].correctlySorted = [];
      room.players[id].penaltyUntil = 0;
      room.players[id].readyForRematch = false;
    });

    io.to(roomId).emit("game_start", {
      flags: room.flags,
      players: room.players,
    });
  });

  // Handle Drag & Drop side validation
  socket.on("flag_drop", ({ roomId, countryName, selectedSide }) => {
    const room = rooms.get(roomId);
    if (!room || !room.gameStarted) return;

    const player = room.players[socket.id];
    if (!player) return;

    const now = Date.now();
    if (now < player.penaltyUntil) {
      return socket.emit("error_message", "Action locked! Penalty active.");
    }

    const matchedCountry = room.flags.find((c) => c.name === countryName);
    if (!matchedCountry) return;

    // Validate Placement against the 'side' property (west vs east)
    if (matchedCountry.side === selectedSide) {
      if (!player.correctlySorted.includes(countryName)) {
        player.correctlySorted.push(countryName);
        player.score = player.correctlySorted.length;

        if (player.score === 4) {
          room.gameStarted = false;
          io.to(roomId).emit("game_over", {
            winnerName: player.name,
            players: room.players,
          });
        } else {
          io.to(roomId).emit("progress_update", { players: room.players });
        }
      }
    } else {
      player.penaltyUntil = now + PENALTY_COOLDOWN;
      socket.emit("penalty_triggered", { cooldown: PENALTY_COOLDOWN });
    }
  });

  socket.on("play_again", (roomId) => {
    const room = rooms.get(roomId);
    if (!room) return;

    if (room.players[socket.id]) room.players[socket.id].readyForRematch = true;

    const playerIds = Object.keys(room.players);
    const allReady = playerIds.every((id) => room.players[id].readyForRematch);

    if (allReady) {
      room.flags = generateRandomFlags();
      room.gameStarted = true;
      playerIds.forEach((id) => {
        room.players[id].score = 0;
        room.players[id].correctlySorted = [];
        room.players[id].penaltyUntil = 0;
        room.players[id].readyForRematch = false;
      });
      io.to(roomId).emit("game_start", {
        flags: room.flags,
        players: room.players,
      });
    } else {
      io.to(roomId).emit("rematch_waiting", { players: room.players });
    }
  });

  socket.on("leave_room", (roomId) => {
    const room = rooms.get(roomId);
    if (room) {
      delete room.players[socket.id];
      socket.leave(roomId);
      if (Object.keys(room.players).length === 0) {
        rooms.delete(roomId);
      } else {
        if (room.hostId === socket.id)
          room.hostId = Object.keys(room.players)[0];
        io.to(roomId).emit("room_updated", {
          players: room.players,
          hostId: room.hostId,
        });
        if (room.gameStarted && Object.keys(room.players).length < 2) {
          room.gameStarted = false;
          io.to(roomId).emit("game_over", {
            winnerName: "System (Opponents left)",
          });
        }
      }
    }
    socket.emit("left_room_success");
  });

  socket.on("disconnect", () => {
    for (const [roomId, room] of rooms.entries()) {
      if (room.players[socket.id]) {
        delete room.players[socket.id];
        if (room.hostId === socket.id)
          room.hostId = Object.keys(room.players)[0] || null;
        if (Object.keys(room.players).length === 0) {
          rooms.delete(roomId);
        } else {
          io.to(roomId).emit("room_updated", {
            players: room.players,
            hostId: room.hostId,
          });
          if (room.gameStarted && Object.keys(room.players).length < 2) {
            room.gameStarted = false;
            io.to(roomId).emit("game_over", {
              winnerName: "System (Opponents disconnected)",
            });
          }
        }
      }
    }
  });
});

server.listen(3001, () => console.log("Server running on port 3001"));
