const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const { RandomForestRegression } = require('ml-random-forest');

// --- Helper: Normalize node_id ---
function formatNodeId(id) {
    if (!id) return null;
    const str = id.toString().trim();
    return str.startsWith("node_") ? str : `node_${str}`;
}

// --- Extract numeric node_id for ML ---
function getNumericNodeId(nodeId) {
    if (!nodeId) return 0;
    return Number(nodeId.toString().replace("node_", ""));
}

// --- Load trained model ---
const modelJSON = JSON.parse(fs.readFileSync('rf_model.json'));
const rf = RandomForestRegression.load(modelJSON);

// --- Supabase setup ---
const supabaseUrl = process.env.PROJECT_LINK;
const supabaseKey = process.env.SERVICE_ROLE;

if (!supabaseUrl || !supabaseKey) {
    console.error("❌ Supabase Environment Variables are missing!");
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(__dirname));

wss.on('connection', (ws) => {
    ws.pendingArchive = null;
    ws.isArchiving = false;
    ws.currentNodeId = null;
    ws.lastPrediction = null;

    console.log('📡 New Connection established');

    ws.on('message', async (data) => {
        let isJson = false;
        let payload;
        let messageStr = data.toString();

        try {
            payload = JSON.parse(messageStr);
            isJson = true;
        } catch (e) {
            isJson = false;
        }

        // --- Node identity ---
        if (!isJson && messageStr.startsWith("id:")) {
            const rawId = messageStr.split(":")[1].trim();
            ws.currentNodeId = formatNodeId(rawId);
            console.log(`Node identified as: ${ws.currentNodeId}`);
        }

        // --- Hourly archive metadata ---
        if (isJson && payload.type === 'hourly_archive') {
            payload.node = formatNodeId(payload.node);
            ws.pendingArchive = payload;
            ws.isArchiving = false;

            console.log(`[Archive] Metadata received for ${payload.node}`);
        }

        // --- Sensor + ML Prediction ---
        if (isJson && payload.type === "sensor") {
            try {
                // Normalize node_id
                payload.node_id = formatNodeId(payload.node_id);

                // Convert to numeric for ML
                const numericNodeId = getNumericNodeId(payload.node_id);

                const features = [
                    Number(payload.n),
                    Number(payload.p),
                    Number(payload.k),
                    Number(payload.days_since_start),
                    Number(payload.week),
                    Number(payload.sin_time),
                    Number(payload.cos_time),
                    numericNodeId
                ];

                // Validate input
                if (features.some(v => isNaN(v))) {
                    throw new Error("Invalid feature values");
                }

                const prediction = rf.predict([features])[0];
                payload.prediction = Math.round(prediction * 100) / 100;

                // Save last prediction (for archive)
                ws.lastPrediction = payload.prediction;

            } catch (err) {
                console.error("❌ ML Prediction Error:", err.message);
                payload.prediction = null;
            }
        }

        // --- Handle image buffer ---
        if (Buffer.isBuffer(data) && ws.pendingArchive && !ws.isArchiving) {
            ws.isArchiving = true;
            handleSupabaseUpload(ws, data);
        }

        // --- Broadcast to dashboards ---
        wss.clients.forEach((client) => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
                if (Buffer.isBuffer(data) && ws.currentNodeId) {
                    client.send(`id:${ws.currentNodeId}`);
                }

                if (isJson) {
                    client.send(JSON.stringify(payload));
                } else {
                    client.send(data);
                }
            }
        });
    });

    ws.on('close', () => {
        console.log(`Node ${ws.currentNodeId || 'Unknown'} disconnected`);
    });
});

// --- Supabase archive function ---
async function handleSupabaseUpload(ws, imageData) {
    const archiveData = ws.pendingArchive;
    const nodeName = formatNodeId(archiveData.node);
    const fileName = `${nodeName}/${Date.now()}.jpg`;

    try {
        console.log(`📸 Archiving to Supabase: ${nodeName}...`);

        // Upload image
        const { error: storageError } = await supabase.storage
            .from('pinyaseek-archives')
            .upload(fileName, imageData, {
                contentType: 'image/jpeg',
                upsert: true
            });

        if (storageError) throw storageError;

        // Get public URL
        const { data: { publicUrl } } = supabase.storage
            .from('pinyaseek-archives')
            .getPublicUrl(fileName);

        // Insert into DB
        const { error: dbError } = await supabase
            .from('hourly_logs')
            .insert([{
                node_id: nodeName,
                n: archiveData.n,
                p: archiveData.p,
                k: archiveData.k,
                image_url: publicUrl,
                prediction: ws.lastPrediction ?? null
            }]);

        if (dbError) throw dbError;

        console.log(`✅ Archive Success: ${nodeName}`);

    } catch (err) {
        console.error("❌ Supabase Error:", err.message);
    } finally {
        ws.pendingArchive = null;
        ws.isArchiving = false;
    }
}

// --- Keep Render awake ---
setInterval(() => {
    const host = process.env.RENDER_EXTERNAL_HOSTNAME;
    if (host) {
        require('http').get(`http://${host}`);
    }
}, 840000);

// --- Start server ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});