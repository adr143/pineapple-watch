const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { createClient } = require('@supabase/supabase-js');

// 1. Initialize Supabase - REMOVE THE QUOTES around process.env
// On Render, add these in Settings > Environment Variables
const supabaseUrl = process.env.PROJECT_LINK; 
const supabaseKey = process.env.SERVICE_ROLE; 

if (!supabaseUrl || !supabaseKey) {
    console.error("❌ ERROR: Supabase Environment Variables are missing!");
}

const supabase = createClient(supabaseUrl, supabaseKey);

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(__dirname));

wss.on('connection', (ws) => {
    ws.pendingArchive = null; 
    console.log('Node connected via WebSocket');

    ws.on('message', async (data) => {
        let isJson = false;
        let payload;

        try {
            payload = JSON.parse(data.toString());
            isJson = true;
        } catch (e) { isJson = false; }

        // --- HOURLY ARCHIVE LOGIC ---
        if (isJson && payload.type === 'hourly_archive') {
            ws.pendingArchive = payload;
            console.log(`[Archive] Metadata received for ${payload.node}. Waiting for image...`);
            return; 
        }

        // Handle Image Buffer and Save to Supabase
        if (Buffer.isBuffer(data) && ws.pendingArchive) {
            const nodeName = ws.pendingArchive.node;
            const fileName = `${nodeName}/${Date.now()}.jpg`;

            try {
                // 1. Upload Image to Storage
                const { data: storageData, error: storageError } = await supabase
                    .storage
                    .from('pinyaseek-archives')
                    .upload(fileName, data, { 
                        contentType: 'image/jpeg',
                        upsert: true 
                    });

                if (storageError) throw storageError;

                // 2. Get Public URL
                const { data: { publicUrl } } = supabase
                    .storage
                    .from('pinyaseek-archives')
                    .getPublicUrl(fileName);

                // 3. Insert NPK Data + URL into Table
                const { error: dbError } = await supabase
                    .from('hourly_logs')
                    .insert([{
                        node_id: nodeName,
                        n: ws.pendingArchive.n,
                        p: ws.pendingArchive.p,
                        k: ws.pendingArchive.k,
                        image_url: publicUrl
                    }]);

                if (dbError) throw dbError;
                console.log(`✅ Supabase Archive Success: ${nodeName}`);

            } catch (err) {
                console.error("❌ Supabase Error:", err.message);
            } finally {
                ws.pendingArchive = null; 
            }
        }

        // --- BROADCAST LIVE VIEW ---
        wss.clients.forEach((client) => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
                client.send(data);
            }
        });
    });
});

// Self-ping to keep Render awake
setInterval(() => {
    http.get(`http://${process.env.RENDER_EXTERNAL_HOSTNAME || 'localhost:3000'}`);
}, 840000); 

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Supabase Backend Live on Port ${PORT}`));