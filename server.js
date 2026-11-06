const express = require('express');
const { Pool } = require('pg');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// -------------------------------------------------------------
// DATABASE CONNECTION (Supabase PostgreSQL)
// -------------------------------------------------------------
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAPA_SECRET_KEY = process.env.CHAPA_SECRET_KEY;

// -------------------------------------------------------------
// 1. ENDPOINT: SUBMIT 7-SLOT BIDS
// -------------------------------------------------------------
app.post('/api/bids/submit', async (req, res) => {
    const { userId, auctionId, bidAmounts } = req.body;

    // Validate exactly 7 bid values
    if (!Array.isArray(bidAmounts) || bidAmounts.length !== 7) {
        return res.status(400).json({ error: "You must provide exactly 7 bid amounts." });
    }

    // Ensure all 7 guesses are unique numbers within the submission
    if (new Set(bidAmounts).size !== 7) {
        return res.status(400).json({ error: "All 7 bid guesses must be different numbers." });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Check if user has available tickets
        const creditRes = await client.query('SELECT balance FROM user_credits WHERE user_id = $1 FOR UPDATE', [userId]);
        const userBalance = creditRes.rows[0]?.balance || 0;

        if (userBalance < 1) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: "Insufficient tickets! Please recharge your account." });
        }

        // Deduct 1 ticket balance
        await client.query('UPDATE user_credits SET balance = balance - 1 WHERE user_id = $1', [userId]);

        // Create a ticket record
        const ticketRes = await client.query(
            'INSERT INTO user_tickets (user_id, auction_id, status) VALUES ($1, $2, $3) RETURNING id',
            [userId, auctionId, 'used']
        );
        const ticketId = ticketRes.rows[0].id;

        // Insert all 7 bid entries linked to this ticket
        for (let amount of bidAmounts) {
            await client.query(
                'INSERT INTO ticket_bids (ticket_id, user_id, auction_id, bid_amount) VALUES ($1, $2, $3, $4)',
                [ticketId, userId, auctionId, amount]
            );
        }

        await client.query('COMMIT');

        // Send confirmation alert via Telegram Bot
        sendTelegramAlert(userId, `🚀 *Nadabid Submission Confirmed!*\n\nYour 7 bid guesses for Auction #${auctionId} have been locked in.`);

        return res.status(200).json({ success: true, message: "7 bids placed successfully!" });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Bid submission error:", err);
        return res.status(500).json({ error: "Server error processing your bids." });
    } finally {
        client.release();
    }
});

// -------------------------------------------------------------
// 2. ENDPOINT: PAYMENT WEBHOOK CALLBACK (Chapa / Telebirr)
// -------------------------------------------------------------
app.post('/api/payment/webhook', async (req, res) => {
    const { tx_ref, status } = req.body;
    if (!tx_ref) return res.status(400).json({ error: "Missing tx_ref" });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const txRes = await client.query('SELECT * FROM transactions WHERE tx_ref = $1 FOR UPDATE', [tx_ref]);
        if (txRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: "Transaction reference not found." });
        }

        const tx = txRes.rows[0];
        if (tx.status === 'success') {
            await client.query('ROLLBACK');
            return res.status(200).json({ message: "Already processed" });
        }

        // Verify transaction status with payment gateway API
        const verified = await verifyPaymentWithProvider(tx_ref);

        if (verified && status === 'success') {
            await client.query('UPDATE transactions SET status = $1 WHERE tx_ref = $2', ['success', tx_ref]);

            // Credit tickets to user account
            await client.query(
                `INSERT INTO user_credits (user_id, balance) VALUES ($1, $2)
                 ON CONFLICT (user_id) DO UPDATE SET balance = user_credits.balance + $2`,
                [tx.user_id, tx.bids_granted]
            );

            await client.query('COMMIT');

            sendTelegramAlert(tx.user_id, `✅ *Payment Successful!*\n\nAdded *${tx.bids_granted} Ticket(s)* to your Nadabid account balance.`);
            return res.status(200).json({ status: "success" });
        } else {
            await client.query('UPDATE transactions SET status = $1 WHERE tx_ref = $2', ['failed', tx_ref]);
            await client.query('COMMIT');
            return res.status(200).json({ status: "failed" });
        }
    } catch (err) {
        await client.query('ROLLBACK');
        return res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// Helper Function: Verify Payment via Chapa
async function verifyPaymentWithProvider(tx_ref) {
    try {
        const response = await axios.get(`https://api.chapa.co/v1/transaction/verify/${tx_ref}`, {
            headers: { Authorization: `Bearer ${CHAPA_SECRET_KEY}` }
        });
        return response.data.status === 'success';
    } catch {
        return false;
    }
}

// Helper Function: Send Telegram Notification
async function sendTelegramAlert(chatId, message) {
    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: chatId, 
            text: message, 
            parse_mode: 'Markdown'
        });
    } catch (err) {
        console.error("Telegram notification error:", err.message);
    }
}

// -------------------------------------------------------------
// 3. FRONTEND SERVING & HEALTH CHECK
// -------------------------------------------------------------
app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Start Express Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Nadabid backend running on port ${PORT}`));