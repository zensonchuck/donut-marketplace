const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

let livePrices = {};

// Fetch live market listings from DonutSMP API every 60 seconds
async function fetchLivePrices() {
    try {
        const response = await axios.get('https://api.donutsmp.net/v1/auction/list/1');
        const listings = response.data;

        if (Array.isArray(listings)) {
            const priceMap = {};

            listings.forEach(entry => {
                const itemId = entry.item?.id?.replace('minecraft:', '') || 'unknown';
                const count = entry.item?.count || 1;
                const price = entry.price || 0;
                const unitPrice = price / count;

                if (!priceMap[itemId]) {
                    priceMap[itemId] = { totalUnitPrice: 0, listingsCount: 0 };
                }
                priceMap[itemId].totalUnitPrice += unitPrice;
                priceMap[itemId].listingsCount += 1;
            });

            // Calculate average live unit price for each item
            Object.keys(priceMap).forEach(itemId => {
                const avgPrice = Math.round(priceMap[itemId].totalUnitPrice / priceMap[itemId].listingsCount);
                livePrices[itemId] = avgPrice;
            });

            // Broadcast updated live prices to all connected clients
            io.emit('livePricesUpdate', livePrices);
            console.log('Successfully updated live DonutSMP prices.');
        }
    } catch (err) {
        console.error('Failed to fetch live prices from DonutSMP API:', err.message);
    }
}

// Initial fetch on server startup and interval set for every 60 seconds
fetchLivePrices();
setInterval(fetchLivePrices, 60000);

io.on('connection', (socket) => {
    socket.emit('livePricesUpdate', livePrices);
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`Melon Market running on port ${PORT}`);
});
