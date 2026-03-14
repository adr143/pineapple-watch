const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { createClient } = require('@supabase/supabase-js');

// 1. Initialize Supabase
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
    ws.isArchiving = false; 
    ws.currentNodeId = null; // Important: Stores the identity of this specific ESP32
    
    console.log('📡 New Connection established');

    ws.on('message', async (data) => {
        let isJson = false;
        let payload;
        let messageStr = data.toString();

        // Try to parse message as JSON
        try {
            payload = JSON.parse(messageStr);
            isJson = true;
        } catch (e) { isJson = false; }

        // --- 1. TRACK NODE IDENTITY (Crucial for Multi-Node) ---
        if (!isJson && messageStr.startsWith("id:")) {
            ws.currentNodeId = messageStr.split(":")[1].trim();
            console.log(`Node identified as: ${ws.currentNodeId}`);
            // We broadcast this so the dashboard knows which node is about to send an image
        }

        // --- 2. HOURLY ARCHIVE METADATA (JSON) ---
        if (isJson && payload.type === 'hourly_archive') {
            ws.pendingArchive = payload;
            ws.isArchiving = false; 
            console.log(`[Archive] Metadata received for ${payload.node}. Waiting for HQ image...`);
        }

        // --- 3. HANDLE IMAGE BUFFER (BINARY) ---
        if (Buffer.isBuffer(data)) {
            // Handle Supabase Archiving
            if (ws.pendingArchive && !ws.isArchiving) {
                ws.isArchiving = true; 
                handleSupabaseUpload(ws, data);
            }
        }

        // --- 4. SMART BROADCAST TO DASHBOARD ---
        wss.clients.forEach((client) => {
            // Only send to browsers (dashboards), not back to the ESP32s
            if (client !== ws && client.readyState === WebSocket.OPEN) {
                
                // FIX: If we are sending a binary image, force-send the ID first
                // This ensures the dashboard's "lastIdentifiedNode" is always correct
                if (Buffer.isBuffer(data) && ws.currentNodeId) {
                    client.send(`id:${ws.currentNodeId}`);
                }
                
                client.send(data);
            }
        });
    });

    ws.on('close', () => console.log(`Node ${ws.currentNodeId || 'Unknown'} disconnected`));
});

// Helper function to keep the main loop clean
async function handleSupabaseUpload(ws, imageData) {
    const archiveData = ws.pendingArchive;
    const nodeName = archiveData.node;
    const fileName = `${nodeName}/${Date.now()}.jpg`;

    try {
        console.log(`📸 Archiving to Supabase: ${nodeName}...`);
        
        const { error: storageError } = await supabase.storage
            .from('pinyaseek-archives')
            .upload(fileName, imageData, { contentType: 'image/jpeg', upsert: true });

        if (storageError) throw storageError;

        const { data: { publicUrl } } = supabase.storage
            .from('pinyaseek-archives')
            .getPublicUrl(fileName);

        const { error: dbError } = await supabase
            .from('hourly_logs')
            .insert([{
                node_id: nodeName,
                n: archiveData.n,
                p: archiveData.p,
                k: archiveData.k,
                image_url: publicUrl
            }]);

        if (dbError) throw dbError;
        console.log(`✅ Archive Success: ${nodeName}`);

    } catch (err) {
        console.error("❌ Supabase Error:", err.message);
    } finally {
        ws.pendingArchive = null; 
    }
}

// Keep Render Awake
setInterval(() => {
    const host = process.env.RENDER_EXTERNAL_HOSTNAME;
    if (host) http.get(`http://${host}`);
}, 840000); 

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on Port ${PORT}`));