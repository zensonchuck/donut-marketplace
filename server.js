const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.static(path.join(__dirname, 'public')));

const activeOrders = [];
const chatRooms = {};

io.on('connection', (socket) => {
  console.log(`[+] User connected: ${socket.id}`);

  socket.emit('init_orders', activeOrders);

  socket.on('place_order', (orderData) => {
    if (!orderData || !orderData.item || !orderData.price) return;

    const formattedOrder = {
      id: "ORD-" + Math.floor(100000 + Math.random() * 900000),
      type: orderData.type === "WTB" ? "WTB" : "WTS",
      seller: orderData.seller || "Anonymous",
      item: String(orderData.item).trim(),
      price: String(orderData.price).trim(),
      note: String(orderData.note || "No trade note provided.").trim(),
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    activeOrders.unshift(formattedOrder);
    if (activeOrders.length > 50) activeOrders.pop();

    io.emit('new_order_placed', formattedOrder);
  });

  socket.on('join_trade_room', (orderId) => {
    socket.join(orderId);
    if (chatRooms[orderId]) {
      socket.emit('chat_history', chatRooms[orderId]);
    }
  });

  socket.on('send_chat_message', (payload) => {
    const { orderId, sender, text } = payload;
    if (!orderId || !text) return;

    const msgObj = {
      sender: sender || "Anonymous",
      text: String(text).trim(),
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    if (!chatRooms[orderId]) chatRooms[orderId] = [];
    chatRooms[orderId].push(msgObj);

    io.to(orderId).emit('receive_chat_message', msgObj);
  });

  socket.on('disconnect', () => {
    console.log(`[-] User disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`==================================================`);
  console.log(`🔥 DonutMarket Server running at http://localhost:${PORT}`);
  console.log(`==================================================`);
});