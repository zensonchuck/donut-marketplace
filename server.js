const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const readline = require("readline");

const app = express();
const server = http.createServer(app);

const { Server } = require("socket.io");

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = Number(process.env.PORT) || 3000;

// ============================================================
// CONFIGURATION
// ============================================================

const DATA_DIR = path.join(__dirname, "data");

const USERS_FILE = path.join(DATA_DIR, "users.json");
const LISTINGS_FILE = path.join(DATA_DIR, "listings.json");
const FUNDING_FILE = path.join(DATA_DIR, "funding.json");
const TRADES_FILE = path.join(DATA_DIR, "trades.json");
const CHAT_FILE = path.join(DATA_DIR, "chat.json"); // NEW: persist trade-room chat across restarts

const SESSION_LENGTH = 1000 * 60 * 60 * 24 * 7; // 7 days
const OWNER_SESSION_LENGTH = 1000 * 60 * 60 * 4; // 4 hours

const sessions = new Map();
const ownerSessions = new Map();

// ============================================================
// SECURITY
// ============================================================

// IMPORTANT:
//
// Do NOT put the owner password here.
//
// The password hash must be stored in the environment variable:
//
// OWNER_PASSWORD_HASH
//
// Generate the hash with:
// node make-owner-hash.js
//
// Then put the generated hash into Render's environment variables.

const OWNER_PASSWORD_HASH =
  process.env.OWNER_PASSWORD_HASH || "";

const OWNER_USERNAME =
  process.env.OWNER_USERNAME || "Baychilly";

const MIDDLEMAN_USERNAME =
  process.env.MIDDLEMAN_USERNAME || "Baychilly";

// ============================================================
// APP SETUP
// ============================================================

app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname, "public")));

// ============================================================
// DATA STORAGE
// ============================================================

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function ensureFile(file) {
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, "[]", "utf8");
  }
}

ensureFile(USERS_FILE);
ensureFile(LISTINGS_FILE);
ensureFile(FUNDING_FILE);
ensureFile(TRADES_FILE);
ensureFile(CHAT_FILE); // NEW

function loadJSON(file) {
  try {
    const data = fs.readFileSync(file, "utf8");

    if (!data.trim()) {
      return [];
    }

    const parsed = JSON.parse(data);

    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error("Failed to load:", file);
    console.error(error.message);

    return [];
  }
}

function saveJSON(file, data) {
  try {
    const temporaryFile = `${file}.tmp`;

    fs.writeFileSync(
      temporaryFile,
      JSON.stringify(data, null, 2),
      "utf8"
    );

    fs.renameSync(temporaryFile, file);

    return true;
  } catch (error) {
    console.error("Failed to save:", file);
    console.error(error.message);

    return false;
  }
}

let users = loadJSON(USERS_FILE);
let listings = loadJSON(LISTINGS_FILE);
let fundingRequests = loadJSON(FUNDING_FILE);
let trades = loadJSON(TRADES_FILE);

// NEW: chat is stored as a flat array of { room, sender, text, timestamp }
// and grouped in memory by room for fast lookups.
let chatLog = loadJSON(CHAT_FILE);

const chatMessages = {}; // orderId/room -> [{ sender, text, timestamp }]

for (const entry of chatLog) {
  if (!entry || !entry.room) {
    continue;
  }

  if (!chatMessages[entry.room]) {
    chatMessages[entry.room] = [];
  }

  chatMessages[entry.room].push({
    sender: entry.sender,
    text: entry.text,
    timestamp: entry.timestamp
  });
}

function persistChatMessage(room, message) {
  chatLog.push({
    room,
    sender: message.sender,
    text: message.text,
    timestamp: message.timestamp
  });

  saveJSON(CHAT_FILE, chatLog);
}

// ============================================================
// GENERAL HELPERS
// ============================================================

function id() {
  return crypto.randomUUID();
}

function clean(value, max = 200) {
  if (
    value === undefined ||
    value === null
  ) {
    return "";
  }

  return String(value)
    .trim()
    .slice(0, max);
}

function normalizeUsername(username) {
  return clean(username, 24)
    .replace(/[^a-zA-Z0-9_]/g, "");
}

function validUsername(username) {
  return (
    username.length >= 3 &&
    username.length <= 24
  );
}

function validPassword(password) {
  return (
    typeof password === "string" &&
    password.length >= 6 &&
    password.length <= 200
  );
}

function hashPassword(password) {
  const salt = crypto.randomBytes(32);

  const derivedKey = crypto.scryptSync(
    password,
    salt,
    64,
    {
      N: 16384,
      r: 8,
      p: 1
    }
  );

  return [
    salt.toString("hex"),
    derivedKey.toString("hex")
  ].join(":");
}

function verifyPassword(password, storedHash) {
  try {
    if (!password || !storedHash) {
      return false;
    }

    const parts = storedHash.split(":");

    if (parts.length !== 2) {
      return false;
    }

    const salt = Buffer.from(parts[0], "hex");
    const expected = Buffer.from(parts[1], "hex");

    const actual = crypto.scryptSync(
      password,
      salt,
      expected.length,
      {
        N: 16384,
        r: 8,
        p: 1
      }
    );

    if (actual.length !== expected.length) {
      return false;
    }

    return crypto.timingSafeEqual(
      actual,
      expected
    );
  } catch {
    return false;
  }
}

function cleanNumber(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return null;
  }

  if (number < 0) {
    return null;
  }

  return Math.floor(number);
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    balance: user.balance,
    createdAt: user.createdAt
  };
}

// NEW: converts an internal listing object into the shape
// index.html's normalizeListing() expects over sockets.
function toClientOrder(listing) {
  return {
    id: listing.id,
    item: listing.spawnerType,
    price: listing.price,
    seller: listing.seller,
    type: listing.type || "sell",
    note: listing.note || "",
    timestamp: listing.createdAt,
    quantity: listing.quantity,
    status: listing.status
  };
}

// ============================================================
// SESSION HELPERS
// ============================================================

function createSession(userId) {
  const token = crypto.randomBytes(48).toString("hex");

  sessions.set(token, {
    userId,
    expires: Date.now() + SESSION_LENGTH
  });

  return token;
}

function getUserFromToken(token) {
  if (!token) {
    return null;
  }

  const session = sessions.get(token);

  if (!session) {
    return null;
  }

  if (session.expires < Date.now()) {
    sessions.delete(token);
    return null;
  }

  const user = users.find(
    user => user.id === session.userId
  );

  if (!user) {
    sessions.delete(token);
    return null;
  }

  return user;
}

function createOwnerSession() {
  const token = crypto.randomBytes(64).toString("hex");

  ownerSessions.set(token, {
    expires:
      Date.now() + OWNER_SESSION_LENGTH
  });

  return token;
}

function isOwnerToken(token) {
  if (!token) {
    return false;
  }

  const session = ownerSessions.get(token);

  if (!session) {
    return false;
  }

  if (session.expires < Date.now()) {
    ownerSessions.delete(token);
    return false;
  }

  return true;
}

function getToken(req) {
  const header =
    req.headers.authorization || "";

  if (!header.startsWith("Bearer ")) {
    return null;
  }

  return header.slice(7);
}

function requireUser(req, res, next) {
  const token = getToken(req);
  const user = getUserFromToken(token);

  if (!user) {
    return res.status(401).json({
      success: false,
      error: "You must be signed in."
    });
  }

  req.user = user;
  req.token = token;

  next();
}

function requireOwner(req, res, next) {
  const token =
    req.headers["x-owner-token"];

  if (!isOwnerToken(token)) {
    return res.status(403).json({
      success: false,
      error: "Owner authorization required."
    });
  }

  next();
}

// ============================================================
// HEALTH
// ============================================================

app.get("/health", (req, res) => {
  res.json({
    success: true,
    online: true,
    service: "Donut Spawner Market",
    users: users.length,
    listings: listings.length,
    trades: trades.length
  });
});

// ============================================================
// AUTHENTICATION
// ============================================================

// CREATE ACCOUNT

app.post("/api/auth/register", (req, res) => {
  const username =
    normalizeUsername(req.body.username);

  const password =
    req.body.password;

  if (!validUsername(username)) {
    return res.status(400).json({
      success: false,
      error:
        "Username must be 3-24 letters, numbers, or underscores."
    });
  }

  if (!validPassword(password)) {
    return res.status(400).json({
      success: false,
      error:
        "Password must contain at least 6 characters."
    });
  }

  const exists = users.some(
    user =>
      user.username.toLowerCase() ===
      username.toLowerCase()
  );

  if (exists) {
    return res.status(409).json({
      success: false,
      error: "That username is already taken."
    });
  }

  const user = {
    id: id(),

    username,

    passwordHash:
      hashPassword(password),

    balance: 0,

    createdAt: Date.now()
  };

  users.push(user);

  saveJSON(USERS_FILE, users);

  const token = createSession(user.id);

  res.json({
    success: true,

    token,

    user: publicUser(user)
  });
});

// LOGIN

app.post("/api/auth/login", (req, res) => {
  const username =
    normalizeUsername(req.body.username);

  const password =
    req.body.password;

  const user = users.find(
    item =>
      item.username.toLowerCase() ===
      username.toLowerCase()
  );

  if (
    !user ||
    !verifyPassword(
      password,
      user.passwordHash
    )
  ) {
    return res.status(401).json({
      success: false,
      error: "Invalid username or password."
    });
  }

  const token = createSession(user.id);

  res.json({
    success: true,

    token,

    user: publicUser(user)
  });
});

// CURRENT USER

app.get(
  "/api/auth/me",
  requireUser,
  (req, res) => {
    res.json({
      success: true,
      user: publicUser(req.user)
    });
  }
);

// LOGOUT

app.post(
  "/api/auth/logout",
  requireUser,
  (req, res) => {
    sessions.delete(req.token);

    res.json({
      success: true
    });
  }
);

// ============================================================
// OWNER AUTHENTICATION
// ============================================================

// OWNER LOGIN

app.post(
  "/api/owner/login",
  (req, res) => {
    const password =
      req.body.password;

    // If OWNER_PASSWORD_HASH has not been configured,
    // owner access is disabled completely.

    if (!OWNER_PASSWORD_HASH) {
      return res.status(503).json({
        success: false,
        error:
          "Owner authentication has not been configured."
      });
    }

    if (
      typeof password !== "string" ||
      !verifyPassword(
        password,
        OWNER_PASSWORD_HASH
      )
    ) {
      return res.status(403).json({
        success: false,
        error: "Incorrect owner password."
      });
    }

    const token =
      createOwnerSession();

    res.json({
      success: true,
      token,
      username: OWNER_USERNAME
    });
  }
);

// OWNER LOGOUT

app.post(
  "/api/owner/logout",
  requireOwner,
  (req, res) => {
    const token =
      req.headers["x-owner-token"];

    ownerSessions.delete(token);

    res.json({
      success: true
    });
  }
);

// OWNER STATUS

app.get(
  "/api/owner/status",
  requireOwner,
  (req, res) => {
    res.json({
      success: true,
      owner: OWNER_USERNAME
    });
  }
);

// ============================================================
// USER BALANCE
// ============================================================

app.get(
  "/api/account",
  requireUser,
  (req, res) => {
    res.json({
      success: true,
      user: publicUser(req.user)
    });
  }
);

// ============================================================
// FUNDING REQUESTS
// ============================================================

app.post(
  "/api/funding/request",
  requireUser,
  (req, res) => {
    const amount =
      cleanNumber(req.body.amount);

    if (
      amount === null ||
      amount <= 0
    ) {
      return res.status(400).json({
        success: false,
        error: "Enter a valid amount."
      });
    }

    if (amount > 1000000000) {
      return res.status(400).json({
        success: false,
        error: "Amount is too large."
      });
    }

    const request = {
      id: id(),

      userId: req.user.id,

      username: req.user.username,

      amount,

      status: "pending",

      createdAt: Date.now()
    };

    fundingRequests.push(request);

    saveJSON(
      FUNDING_FILE,
      fundingRequests
    );

    res.json({
      success: true,
      request
    });
  }
);

// USER'S FUNDING REQUESTS

app.get(
  "/api/funding/my",
  requireUser,
  (req, res) => {
    res.json({
      success: true,

      requests:
        fundingRequests.filter(
          request =>
            request.userId ===
            req.user.id
        )
    });
  }
);

// ============================================================
// OWNER: FUND USER
// ============================================================

app.post(
  "/api/owner/give-funds",
  requireOwner,
  (req, res) => {
    const username =
      normalizeUsername(
        req.body.username
      );

    const amount =
      cleanNumber(req.body.amount);

    if (!username) {
      return res.status(400).json({
        success: false,
        error: "Username required."
      });
    }

    if (
      amount === null ||
      amount <= 0
    ) {
      return res.status(400).json({
        success: false,
        error: "Valid amount required."
      });
    }

    const user = users.find(
      item =>
        item.username.toLowerCase() ===
        username.toLowerCase()
    );

    if (!user) {
      return res.status(404).json({
        success: false,
        error: "User not found."
      });
    }

    user.balance += amount;

    saveJSON(
      USERS_FILE,
      users
    );

    res.json({
      success: true,

      user: publicUser(user),

      amount
    });
  }
);

// ============================================================
// OWNER: FUNDING REQUESTS
// ============================================================

app.get(
  "/api/owner/funding",
  requireOwner,
  (req, res) => {
    res.json({
      success: true,
      requests: fundingRequests
    });
  }
);

// APPROVE FUNDING

app.post(
  "/api/owner/funding/:id/approve",
  requireOwner,
  (req, res) => {
    const request =
      fundingRequests.find(
        item =>
          item.id === req.params.id
      );

    if (!request) {
      return res.status(404).json({
        success: false,
        error: "Funding request not found."
      });
    }

    if (
      request.status !== "pending"
    ) {
      return res.status(400).json({
        success: false,
        error: "Request has already been processed."
      });
    }

    const user = users.find(
      item =>
        item.id === request.userId
    );

    if (!user) {
      return res.status(404).json({
        success: false,
        error: "User no longer exists."
      });
    }

    user.balance += request.amount;

    request.status = "approved";

    request.approvedAt = Date.now();

    saveJSON(
      USERS_FILE,
      users
    );

    saveJSON(
      FUNDING_FILE,
      fundingRequests
    );

    res.json({
      success: true,
      user: publicUser(user)
    });
  }
);

// DENY FUNDING

app.post(
  "/api/owner/funding/:id/deny",
  requireOwner,
  (req, res) => {
    const request =
      fundingRequests.find(
        item =>
          item.id === req.params.id
      );

    if (!request) {
      return res.status(404).json({
        success: false,
        error: "Funding request not found."
      });
    }

    if (
      request.status !== "pending"
    ) {
      return res.status(400).json({
        success: false,
        error: "Request has already been processed."
      });
    }

    request.status = "denied";

    request.deniedAt = Date.now();

    saveJSON(
      FUNDING_FILE,
      fundingRequests
    );

    res.json({
      success: true
    });
  }
);

// ============================================================
// SPAWNER MARKETPLACE
// ============================================================

app.get(
  "/api/spawners",
  (req, res) => {
    res.json({
      success: true,
      listings
    });
  }
);

// CREATE SPAWNER LISTING

app.post(
  "/api/spawners",
  requireUser,
  (req, res) => {
    const spawnerType =
      clean(
        req.body.spawnerType ||
        req.body.item ||
        req.body.type,
        80
      );

    const price =
      cleanNumber(req.body.price);

    const quantity =
      cleanNumber(
        req.body.quantity || 1
      );

    if (!spawnerType) {
      return res.status(400).json({
        success: false,
        error: "Spawner type is required."
      });
    }

    if (
      price === null ||
      price <= 0
    ) {
      return res.status(400).json({
        success: false,
        error: "Enter a valid price."
      });
    }

    if (
      quantity === null ||
      quantity <= 0
    ) {
      return res.status(400).json({
        success: false,
        error: "Enter a valid quantity."
      });
    }

    const listing = {
      id: id(),

      sellerId: req.user.id,

      seller:
        req.user.username,

      spawnerType,

      quantity,

      price,

      status: "active",

      createdAt: Date.now()
    };

    listings.push(listing);

    saveJSON(
      LISTINGS_FILE,
      listings
    );

    io.emit(
      "spawner_listing_created",
      listing
    );

    io.emit(
      "listings_updated",
      listings
    );

    res.json({
      success: true,
      listing
    });
  }
);

// ============================================================
// REMOVE OWN LISTING
// ============================================================

app.delete(
  "/api/spawners/:id",
  requireUser,
  (req, res) => {
    const index =
      listings.findIndex(
        listing =>
          listing.id ===
          req.params.id
      );

    if (index === -1) {
      return res.status(404).json({
        success: false,
        error: "Listing not found."
      });
    }

    const listing =
      listings[index];

    if (
      listing.sellerId !==
      req.user.id
    ) {
      return res.status(403).json({
        success: false,
        error:
          "You can only remove your own listings."
      });
    }

    if (
      listing.status !== "active"
    ) {
      return res.status(400).json({
        success: false,
        error:
          "This listing cannot be removed right now."
      });
    }

    listings.splice(index, 1);

    saveJSON(
      LISTINGS_FILE,
      listings
    );

    io.emit(
      "spawner_listing_removed",
      listing.id
    );

    io.emit(
      "listings_updated",
      listings
    );

    res.json({
      success: true
    });
  }
);

// ============================================================
// OWNER: REMOVE ANY LISTING
// ============================================================

app.delete(
  "/api/owner/spawners/:id",
  requireOwner,
  (req, res) => {
    const index =
      listings.findIndex(
        listing =>
          listing.id ===
          req.params.id
      );

    if (index === -1) {
      return res.status(404).json({
        success: false,
        error: "Listing not found."
      });
    }

    const removed =
      listings.splice(index, 1)[0];

    saveJSON(
      LISTINGS_FILE,
      listings
    );

    io.emit(
      "spawner_listing_removed",
      removed.id
    );

    io.emit(
      "listings_updated",
      listings
    );

    res.json({
      success: true
    });
  }
);

// ============================================================
// BUY SPAWNER
// ============================================================

app.post(
  "/api/spawners/:id/buy",
  requireUser,
  (req, res) => {
    const listing =
      listings.find(
        item =>
          item.id ===
          req.params.id
      );

    if (!listing) {
      return res.status(404).json({
        success: false,
        error: "Listing not found."
      });
    }

    if (
      listing.status !== "active"
    ) {
      return res.status(400).json({
        success: false,
        error:
          "This listing is no longer available."
      });
    }

    if (
      listing.sellerId ===
      req.user.id
    ) {
      return res.status(400).json({
        success: false,
        error:
          "You cannot buy your own listing."
      });
    }

    if (
      req.user.balance <
      listing.price
    ) {
      return res.status(400).json({
        success: false,
        error: "Insufficient balance."
      });
    }

    // Lock the listing immediately.
    listing.status =
      "escrow";

    // Remove coins from buyer.
    req.user.balance -=
      listing.price;

    const trade = {
      id: id(),

      listingId:
        listing.id,

      buyerId:
        req.user.id,

      buyer:
        req.user.username,

      sellerId:
        listing.sellerId,

      seller:
        listing.seller,

      spawnerType:
        listing.spawnerType,

      quantity:
        listing.quantity,

      price:
        listing.price,

      status:
        "awaiting_middleman",

      middleman:
        MIDDLEMAN_USERNAME,

      createdAt:
        Date.now()
    };

    trades.push(trade);

    saveJSON(
      USERS_FILE,
      users
    );

    saveJSON(
      LISTINGS_FILE,
      listings
    );

    saveJSON(
      TRADES_FILE,
      trades
    );

    io.emit(
      "spawner_trade_created",
      trade
    );

    io.emit(
      "listings_updated",
      listings
    );

    res.json({
      success: true,

      message:
        "Purchase started. Funds are being held in escrow.",

      trade,

      user:
        publicUser(req.user)
    });
  }
);

// ============================================================
// USER TRADES
// ============================================================

app.get(
  "/api/trades",
  requireUser,
  (req, res) => {
    res.json({
      success: true,

      trades:
        trades.filter(
          trade =>
            trade.buyerId ===
              req.user.id ||
            trade.sellerId ===
              req.user.id
        )
    });
  }
);

// ============================================================
// OWNER: ALL TRADES
// ============================================================

app.get(
  "/api/owner/trades",
  requireOwner,
  (req, res) => {
    res.json({
      success: true,
      trades
    });
  }
);

// ============================================================
// MIDDLEMAN: RECEIVED SPAWNER
// ============================================================

app.post(
  "/api/trades/:id/middleman-received",
  requireOwner,
  (req, res) => {
    const trade =
      trades.find(
        item =>
          item.id ===
          req.params.id
      );

    if (!trade) {
      return res.status(404).json({
        success: false,
        error: "Trade not found."
      });
    }

    if (
      trade.status !==
      "awaiting_middleman"
    ) {
      return res.status(400).json({
        success: false,
        error:
          "Trade is not waiting for the middleman."
      });
    }

    trade.status =
      "middleman_received";

    trade.middlemanReceivedAt =
      Date.now();

    saveJSON(
      TRADES_FILE,
      trades
    );

    io.emit(
      "trade_updated",
      trade
    );

    res.json({
      success: true,
      trade
    });
  }
);

// ============================================================
// MIDDLEMAN: ITEM DELIVERED
// ============================================================

app.post(
  "/api/trades/:id/item-delivered",
  requireOwner,
  (req, res) => {
    const trade =
      trades.find(
        item =>
          item.id ===
          req.params.id
      );

    if (!trade) {
      return res.status(404).json({
        success: false,
        error: "Trade not found."
      });
    }

    if (
      trade.status !==
      "middleman_received"
    ) {
      return res.status(400).json({
        success: false,
        error:
          "The middleman must confirm receipt first."
      });
    }

    trade.status =
      "item_delivered";

    trade.itemDeliveredAt =
      Date.now();

    saveJSON(
      TRADES_FILE,
      trades
    );

    io.emit(
      "trade_updated",
      trade
    );

    res.json({
      success: true,
      trade
    });
  }
);

// ============================================================
// MIDDLEMAN: RELEASE PAYMENT
// ============================================================

app.post(
  "/api/trades/:id/release",
  requireOwner,
  (req, res) => {
    const trade =
      trades.find(
        item =>
          item.id ===
          req.params.id
      );

    if (!trade) {
      return res.status(404).json({
        success: false,
        error: "Trade not found."
      });
    }

    if (
      trade.status !==
      "item_delivered"
    ) {
      return res.status(400).json({
        success: false,
        error:
          "The item must be confirmed as delivered first."
      });
    }

    const seller =
      users.find(
        user =>
          user.id ===
          trade.sellerId
      );

    if (!seller) {
      return res.status(404).json({
        success: false,
        error:
          "Seller account not found."
      });
    }

    // RELEASE ESCROW TO SELLER

    seller.balance +=
      trade.price;

    trade.status =
      "completed";

    trade.completedAt =
      Date.now();

    saveJSON(
      USERS_FILE,
      users
    );

    saveJSON(
      TRADES_FILE,
      trades
    );

    // Remove the listing.
    const listingIndex =
      listings.findIndex(
        listing =>
          listing.id ===
          trade.listingId
      );

    if (listingIndex !== -1) {
      listings.splice(
        listingIndex,
        1
      );
    }

    saveJSON(
      LISTINGS_FILE,
      listings
    );

    io.emit(
      "trade_completed",
      trade
    );

    io.emit(
      "listings_updated",
      listings
    );

    res.json({
      success: true,

      trade,

      seller:
        publicUser(seller)
    });
  }
);

// ============================================================
// OWNER: USERS
// ============================================================

app.get(
  "/api/owner/users",
  requireOwner,
  (req, res) => {
    res.json({
      success: true,

      users:
        users.map(
          publicUser
        )
    });
  }
);

// ============================================================
// SOCKET.IO
// ============================================================

io.on("connection", socket => {
  console.log(
    "Socket connected:",
    socket.id
  );

  socket.emit(
    "spawner_market_snapshot",
    listings
  );

  socket.emit(
    "listings_updated",
    listings
  );

  // NEW: index.html's normalizeListing() expects the "orders"
  // event on connect, in the {item, price, seller, type, ...} shape.
  socket.emit(
    "orders",
    listings.map(toClientOrder)
  );

  socket.on(
    "get_spawner_listings",
    () => {
      socket.emit(
        "spawner_market_snapshot",
        listings
      );
    }
  );

  socket.on(
    "request_market",
    () => {
      socket.emit(
        "spawner_market_snapshot",
        listings
      );
    }
  );

  // NEW: index.html calls this on load and on reconnect.
  socket.on(
    "get_orders",
    () => {
      socket.emit(
        "orders",
        listings.map(toClientOrder)
      );
    }
  );

  // NEW: this is the handler that was completely missing before.
  // index.html's submitOrder() emits "place_order" with an ack
  // callback and waits on it (or on order_created/new_order) — with
  // no listener here, that callback never fired and the "Publish"
  // button was stuck showing "Publishing..." until the client's own
  // 15-second timeout gave up.
  socket.on(
    "place_order",
    (payload, callback) => {
      try {
        const spawnerType = clean(
          payload?.item ||
            payload?.spawnerType ||
            payload?.type,
          80
        );

        const price = cleanNumber(
          payload?.price
        );

        const quantity = cleanNumber(
          payload?.quantity || 1
        );

        const note = clean(
          payload?.note,
          300
        );

        const orderType =
          payload?.type === "buy"
            ? "buy"
            : "sell";

        // NEW: a persistent per-browser id (not tied to a real
        // account) that lets change_username find every listing
        // this browser created, so a rename can update them.
        const clientId = clean(
          payload?.clientId,
          100
        ) || null;

        if (!spawnerType) {
          if (
            typeof callback === "function"
          ) {
            callback({
              success: false,
              message:
                "Spawner type is required."
            });
          }

          return;
        }

        if (
          price === null ||
          price <= 0
        ) {
          if (
            typeof callback === "function"
          ) {
            callback({
              success: false,
              message: "Enter a valid price."
            });
          }

          return;
        }

        if (
          quantity === null ||
          quantity <= 0
        ) {
          if (
            typeof callback === "function"
          ) {
            callback({
              success: false,
              message:
                "Enter a valid quantity."
            });
          }

          return;
        }

        // NOTE: socket-created listings have no authenticated
        // user attached (unlike POST /api/spawners, which uses
        // requireUser), so sellerId stays null and seller falls
        // back to whatever the client sent, or "Unknown".
        const listing = {
          id: id(),

          sellerId: null,

          seller:
            clean(payload?.seller, 24) ||
            "Unknown",

          // NEW: stored internally only - never sent back to
          // clients via toClientOrder, since other players have no
          // need to see it. Used purely to match this listing back
          // to its owner on a later username change.
          clientId,

          spawnerType,

          type: orderType,

          note,

          quantity,

          price,

          status: "active",

          createdAt: Date.now()
        };

        listings.push(listing);

        saveJSON(
          LISTINGS_FILE,
          listings
        );

        const clientOrder =
          toClientOrder(listing);

        io.emit(
          "new_order",
          clientOrder
        );

        io.emit(
          "order_created",
          clientOrder
        );

        io.emit(
          "orders",
          listings.map(toClientOrder)
        );

        io.emit(
          "spawner_listing_created",
          listing
        );

        io.emit(
          "listings_updated",
          listings
        );

        if (
          typeof callback === "function"
        ) {
          callback({
            success: true,
            order: clientOrder
          });
        }
      } catch (error) {
        console.error(
          "place_order failed:",
          error
        );

        if (
          typeof callback === "function"
        ) {
          callback({
            success: false,
            message:
              "Server error while creating the listing."
          });
        }
      }
    }
  );

  socket.on(
    "join_trade_room",
    data => {
      const room =
        typeof data === "string"
          ? data
          : data?.tradeId ||
            data?.orderId ||
            data?.roomId;

      if (!room) {
        return;
      }

      socket.join(
        String(room)
      );
    }
  );

  // NEW: index.html's openChatModal() calls this right after
  // join_trade_room to load prior messages for that listing.
  socket.on(
    "get_chat_history",
    orderId => {
      const room = String(orderId || "");

      socket.emit(
        "chat_history",
        chatMessages[room] || []
      );
    }
  );

  // NEW: index.html's sendChatMessage() emits this; with no
  // listener before, messages typed in the negotiation chat
  // went nowhere and no one ever received them.
  socket.on(
    "send_chat_message",
    data => {
      const room = String(
        data?.orderId || ""
      );

      if (!room) {
        return;
      }

      const text = clean(
        data?.text,
        500
      );

      if (!text) {
        return;
      }

      const message = {
        sender:
          clean(data?.sender, 24) ||
          "Unknown",

        text,

        timestamp: Date.now()
      };

      if (!chatMessages[room]) {
        chatMessages[room] = [];
      }

      chatMessages[room].push(
        message
      );

      persistChatMessage(
        room,
        message
      );

      io.to(room).emit(
        "receive_chat_message",
        message
      );

      // Also echo back to the sender directly, in case they
      // haven't been added to the room yet for any reason.
      socket.emit(
        "receive_chat_message",
        message
      );
    }
  );

  socket.on(
    "leave_trade_room",
    data => {
      const room =
        typeof data === "string"
          ? data
          : data?.tradeId ||
            data?.orderId ||
            data?.roomId;

      if (room) {
        socket.leave(
          String(room)
        );
      }
    }
  );

  // NEW: index.html's saveUsername() emits this after a rename.
  // We find every listing tagged with the same clientId (set when
  // that browser created the listing via place_order) and update
  // the displayed seller name, then broadcast the change so it
  // shows up live for every connected player - including the
  // person who just renamed, on their own listing.
  socket.on(
    "change_username",
    (payload, callback) => {
      try {
        const clientId = clean(
          payload?.clientId,
          100
        );

        const newUsername = clean(
          payload?.username,
          24
        );

        if (!clientId || !newUsername) {
          if (
            typeof callback === "function"
          ) {
            callback({
              success: false,
              message:
                "Missing username or client id."
            });
          }

          return;
        }

        let updatedAny = false;

        for (const listing of listings) {
          if (
            listing.clientId &&
            listing.clientId === clientId
          ) {
            listing.seller = newUsername;
            updatedAny = true;
          }
        }

        if (updatedAny) {
          saveJSON(
            LISTINGS_FILE,
            listings
          );

          for (const listing of listings) {
            if (listing.clientId === clientId) {
              io.emit(
                "order_updated",
                toClientOrder(listing)
              );
            }
          }

          io.emit(
            "listings_updated",
            listings
          );

          io.emit(
            "orders",
            listings.map(toClientOrder)
          );
        }

        if (
          typeof callback === "function"
        ) {
          callback({
            success: true,
            updatedListings: updatedAny
          });
        }
      } catch (error) {
        console.error(
          "change_username failed:",
          error
        );

        if (
          typeof callback === "function"
        ) {
          callback({
            success: false,
            message:
              "Server error while updating username."
          });
        }
      }
    }
  );

  socket.on(
    "disconnect",
    () => {
      console.log(
        "Socket disconnected:",
        socket.id
      );
    }
  );
});

// ============================================================
// FRONTEND FALLBACK
// ============================================================

app.get("*", (req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      "public",
      "index.html"
    )
  );
});

// ============================================================
// START
// ============================================================

server.listen(
  PORT,
  () => {
    console.log(
      "=========================================="
    );

    console.log(
      "DONUT SPAWNER MARKET"
    );

    console.log(
      `Port: ${PORT}`
    );

    console.log(
      `Users: ${users.length}`
    );

    console.log(
      `Listings: ${listings.length}`
    );

    console.log(
      `Owner: ${OWNER_USERNAME}`
    );

    if (!OWNER_PASSWORD_HASH) {
      console.log(
        "WARNING: OWNER_PASSWORD_HASH IS NOT SET"
      );
    } else {
      console.log(
        "Owner password: securely hashed"
      );
    }

    console.log(
      "=========================================="
    );
  }
);
