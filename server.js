const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;

// --------------------------------------------------
// FILE STORAGE
// --------------------------------------------------

const DATA_DIR = path.join(__dirname, "data");
const ORDERS_FILE = path.join(DATA_DIR, "orders.json");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

if (!fs.existsSync(ORDERS_FILE)) {
  fs.writeFileSync(ORDERS_FILE, "[]", "utf8");
}

// --------------------------------------------------
// APP CONFIG
// --------------------------------------------------

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname, "public")));

// --------------------------------------------------
// DATA
// --------------------------------------------------

let orders = [];
const chatHistory = new Map();

function loadOrders() {
  try {
    const raw = fs.readFileSync(ORDERS_FILE, "utf8");

    if (!raw.trim()) {
      orders = [];
      return;
    }

    const parsed = JSON.parse(raw);

    if (Array.isArray(parsed)) {
      orders = parsed;
    } else {
      orders = [];
    }

    console.log(`Loaded ${orders.length} marketplace listings.`);
  } catch (error) {
    console.error("Could not load orders.json:", error);
    orders = [];
  }
}

function saveOrders() {
  try {
    fs.writeFileSync(
      ORDERS_FILE,
      JSON.stringify(orders, null, 2),
      "utf8"
    );
  } catch (error) {
    console.error("Could not save orders.json:", error);
  }
}

loadOrders();

// --------------------------------------------------
// HELPERS
// --------------------------------------------------

function createId() {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 12)}`;
}

function cleanString(value, maxLength = 200) {
  if (value === undefined || value === null) {
    return "";
  }

  return String(value)
    .trim()
    .slice(0, maxLength);
}

function cleanPrice(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return null;
  }

  if (number < 0) {
    return null;
  }

  return Math.round(number * 100) / 100;
}

function cleanQuantity(value) {
  if (value === undefined || value === null || value === "") {
    return 1;
  }

  const number = Number(value);

  if (!Number.isFinite(number)) {
    return null;
  }

  if (number <= 0) {
    return null;
  }

  return Math.floor(number);
}

function broadcastOrders() {
  // Main/current event.
  io.emit("orders_updated", orders);

  // Compatibility events for different versions
  // of the marketplace frontend.
  io.emit("orders", orders);
  io.emit("order_list", orders);
  io.emit("market_data", orders);
}

function sendInitialOrders(socket) {
  socket.emit("init_orders", orders);
  socket.emit("initial_orders", orders);
  socket.emit("orders", orders);
  socket.emit("order_list", orders);
  socket.emit("market_data", orders);
  socket.emit("orders_updated", orders);

  socket.emit("market_status", {
    online: true,
    listings: orders.length,
    timestamp: Date.now()
  });
}

function normalizeOrder(data = {}, socket = null) {
  const type =
    cleanString(
      data.type ||
      data.orderType ||
      data.side ||
      "sell",
      20
    ).toLowerCase();

  const seller =
    cleanString(
      data.seller ||
      data.username ||
      data.player ||
      data.owner ||
      (socket && socket.username) ||
      "Unknown",
      40
    );

  const item = cleanString(
    data.item ||
    data.itemName ||
    data.name ||
    data.product,
    100
  );

  const price = cleanPrice(
    data.price ||
    data.amount ||
    data.cost
  );

  const quantity = cleanQuantity(
    data.quantity ||
    data.qty ||
    1
  );

  const note = cleanString(
    data.note ||
    data.description ||
    data.message ||
    "",
    500
  );

  if (!item) {
    return {
      error: "Item name is required."
    };
  }

  if (price === null) {
    return {
      error: "A valid price is required."
    };
  }

  if (quantity === null) {
    return {
      error: "Quantity must be a positive whole number."
    };
  }

  if (!["sell", "buy", "sale", "purchase"].includes(type)) {
    return {
      error: "Listing type must be buy or sell."
    };
  }

  const normalizedType =
    type === "sale" ? "sell" :
    type === "purchase" ? "buy" :
    type;

  return {
    id: createId(),

    type: normalizedType,

    seller,

    username: seller,

    item,

    itemName: item,

    price,

    quantity,

    qty: quantity,

    note,

    description: note,

    createdAt: Date.now(),

    timestamp: Date.now()
  };
}

// --------------------------------------------------
// HEALTH / API
// --------------------------------------------------

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    online: true,
    listings: orders.length,
    timestamp: Date.now()
  });
});

app.get("/api/orders", (req, res) => {
  res.json(orders);
});

app.get("/api/listings", (req, res) => {
  res.json(orders);
});

// --------------------------------------------------
// SOCKET.IO CONNECTION
// --------------------------------------------------

io.on("connection", (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  socket.username = "Unknown";

  // ----------------------------------------------
  // USERNAME
  // ----------------------------------------------

  socket.on("set_username", (username) => {
    const cleaned = cleanString(username, 40);

    if (cleaned) {
      socket.username = cleaned;

      socket.emit("username_set", {
        username: cleaned
      });
    }
  });

  socket.on("username", (username) => {
    const cleaned = cleanString(username, 40);

    if (cleaned) {
      socket.username = cleaned;
    }
  });

  // ----------------------------------------------
  // SEND INITIAL MARKET DATA
  // ----------------------------------------------

  sendInitialOrders(socket);

  // ----------------------------------------------
  // CREATE LISTING
  // ----------------------------------------------

  socket.on("place_order", (data = {}) => {
    console.log("place_order received:", data);

    const listing = normalizeOrder(data, socket);

    if (listing.error) {
      console.log("Invalid listing:", listing.error);

      socket.emit("order_error", {
        success: false,
        error: listing.error,
        message: listing.error
      });

      socket.emit("listing_error", {
        success: false,
        error: listing.error,
        message: listing.error
      });

      return;
    }

    orders.push(listing);

    saveOrders();

    console.log(
      `New listing: ${listing.item} - ${listing.price} by ${listing.seller}`
    );

    // Tell the person who created it.
    socket.emit("order_created", listing);

    socket.emit("listing_created", listing);

    socket.emit("listing_success", {
      success: true,
      order: listing,
      listing
    });

    // Tell every connected player.
    io.emit("new_order", listing);

    io.emit("new_order_placed", listing);

    io.emit("order_created", listing);

    // Send complete updated list too.
    broadcastOrders();
  });

  // ----------------------------------------------
  // ALTERNATIVE CREATE LISTING EVENTS
  // ----------------------------------------------

  socket.on("create_listing", (data = {}) => {
    console.log("create_listing received.");

    const listing = normalizeOrder(data, socket);

    if (listing.error) {
      socket.emit("order_error", {
        success: false,
        error: listing.error,
        message: listing.error
      });

      return;
    }

    orders.push(listing);

    saveOrders();

    socket.emit("order_created", listing);
    socket.emit("listing_created", listing);

    io.emit("new_order", listing);
    io.emit("new_order_placed", listing);

    broadcastOrders();
  });

  socket.on("new_listing", (data = {}) => {
    console.log("new_listing received.");

    const listing = normalizeOrder(data, socket);

    if (listing.error) {
      socket.emit("order_error", {
        success: false,
        error: listing.error,
        message: listing.error
      });

      return;
    }

    orders.push(listing);

    saveOrders();

    socket.emit("order_created", listing);
    socket.emit("listing_created", listing);

    io.emit("new_order", listing);
    io.emit("new_order_placed", listing);

    broadcastOrders();
  });

  // ----------------------------------------------
  // REMOVE LISTING
  // ----------------------------------------------

  socket.on("remove_order", (data = {}) => {
    const id =
      typeof data === "string"
        ? data
        : data.id ||
          data.orderId ||
          data.listingId;

    if (!id) {
      socket.emit("order_error", {
        success: false,
        error: "Listing ID is required."
      });

      return;
    }

    const index = orders.findIndex(
      (order) => String(order.id) === String(id)
    );

    if (index === -1) {
      socket.emit("order_error", {
        success: false,
        error: "Listing was not found."
      });

      return;
    }

    const removed = orders[index];

    // Only the owner should be able to remove their listing
    // when a username is available.
    const requestingUser = cleanString(
      socket.username,
      40
    );

    if (
      requestingUser &&
      requestingUser !== "Unknown" &&
      removed.seller &&
      removed.seller !== requestingUser
    ) {
      socket.emit("order_error", {
        success: false,
        error: "You can only remove your own listings."
      });

      return;
    }

    orders.splice(index, 1);

    saveOrders();

    socket.emit("order_removed", removed);

    io.emit("order_removed", removed);

    broadcastOrders();
  });

  // ----------------------------------------------
  // DELETE LISTING
  // ----------------------------------------------

  socket.on("delete_listing", (data = {}) => {
    const id =
      typeof data === "string"
        ? data
        : data.id ||
          data.orderId ||
          data.listingId;

    if (!id) {
      return;
    }

    const index = orders.findIndex(
      (order) => String(order.id) === String(id)
    );

    if (index === -1) {
      return;
    }

    const removed = orders[index];

    const requestingUser = cleanString(
      socket.username,
      40
    );

    if (
      requestingUser &&
      requestingUser !== "Unknown" &&
      removed.seller &&
      removed.seller !== requestingUser
    ) {
      return;
    }

    orders.splice(index, 1);

    saveOrders();

    io.emit("order_removed", removed);

    broadcastOrders();
  });

  // ----------------------------------------------
  // REFRESH MARKET
  // ----------------------------------------------

  socket.on("request_orders", () => {
    sendInitialOrders(socket);
  });

  socket.on("get_orders", () => {
    sendInitialOrders(socket);
  });

  socket.on("refresh_market", () => {
    sendInitialOrders(socket);
  });

  // ----------------------------------------------
  // TRADE ROOMS
  // ----------------------------------------------

  socket.on("join_trade_room", (data = {}) => {
    const room =
      typeof data === "string"
        ? data
        : data.room ||
          data.roomId ||
          data.orderId ||
          data.listingId;

    if (!room) {
      return;
    }

    socket.join(String(room));

    const roomId = String(room);

    if (!chatHistory.has(roomId)) {
      chatHistory.set(roomId, []);
    }

    socket.emit("chat_history", chatHistory.get(roomId));

    socket.emit("trade_room_joined", {
      room: roomId
    });
  });

  socket.on("leave_trade_room", (data = {}) => {
    const room =
      typeof data === "string"
        ? data
        : data.room ||
          data.roomId ||
          data.orderId ||
          data.listingId;

    if (!room) {
      return;
    }

    socket.leave(String(room));
  });

  // ----------------------------------------------
  // CHAT HISTORY
  // ----------------------------------------------

  socket.on("get_chat_history", (data = {}) => {
    const room =
      typeof data === "string"
        ? data
        : data.room ||
          data.roomId ||
          data.orderId ||
          data.listingId;

    if (!room) {
      socket.emit("chat_history", []);
      return;
    }

    const roomId = String(room);

    socket.emit(
      "chat_history",
      chatHistory.get(roomId) || []
    );
  });

  // ----------------------------------------------
  // CHAT MESSAGE
  // ----------------------------------------------

  socket.on("send_chat_message", (data = {}) => {
    const room =
      data.room ||
      data.roomId ||
      data.orderId ||
      data.listingId;

    const message =
      cleanString(
        data.message ||
        data.text ||
        data.content,
        1000
      );

    if (!room || !message) {
      return;
    }

    const roomId = String(room);

    const username =
      cleanString(
        data.username ||
        data.sender ||
        socket.username,
        40
      ) || "Unknown";

    const chatMessage = {
      id: createId(),

      room: roomId,

      username,

      sender: username,

      message,

      text: message,

      timestamp: Date.now(),

      createdAt: Date.now()
    };

    if (!chatHistory.has(roomId)) {
      chatHistory.set(roomId, []);
    }

    const history = chatHistory.get(roomId);

    history.push(chatMessage);

    // Keep the last 100 messages per room.
    if (history.length > 100) {
      history.splice(
        0,
        history.length - 100
      );
    }

    io.to(roomId).emit(
      "receive_chat_message",
      chatMessage
    );

    io.to(roomId).emit(
      "chat_message",
      chatMessage
    );
  });

  // ----------------------------------------------
  // DISCONNECT
  // ----------------------------------------------

  socket.on("disconnect", (reason) => {
    console.log(
      `Socket disconnected: ${socket.id} (${reason})`
    );
  });
});

// --------------------------------------------------
// FALLBACK FOR FRONTEND
// --------------------------------------------------

app.get("*", (req, res) => {
  res.sendFile(
    path.join(__dirname, "public", "index.html")
  );
});

// --------------------------------------------------
// START SERVER
// --------------------------------------------------

server.listen(PORT, () => {
  console.log("----------------------------------------");
  console.log("Donut Marketplace server started");
  console.log(`Port: ${PORT}`);
  console.log(`Listings loaded: ${orders.length}`);
  console.log("----------------------------------------");
});
