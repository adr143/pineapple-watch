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
    ws.isArchiving = false; // LOCK: Prevents multiple uploads for one image
    ws.currentNodeId = null; // Track which node this socket belongs to
    
    console.log('Node connected via WebSocket');

    ws.on('message', async (data) => {
        let isJson = false;
        let payload;

        // Try to parse message as JSON
        try {
            payload = JSON.parse(data.toString());
            isJson = true;
        } catch (e) { isJson = false; }

        // --- 1. HANDLE NODE IDENTIFICATION ---
        if (!isJson && data.toString().startsWith("id:")) {
            ws.currentNodeId = data.toString().split(":")[1];
            return;
        }

        // --- 2. HOURLY ARCHIVE METADATA (JSON) ---
        if (isJson && payload.type === 'hourly_archive') {
            ws.pendingArchive = payload;
            ws.isArchiving = false; // Reset lock for new archive cycle
            console.log(`[Archive] Metadata received for ${payload.node}. Waiting for image...`);
            return; 
        }

        // --- 3. HANDLE IMAGE BUFFER (BINARY) ---
        if (Buffer.isBuffer(data)) {
            // Check if this buffer is part of an archive request
            if (ws.pendingArchive && !ws.isArchiving) {
                ws.isArchiving = true; // SET LOCK IMMEDIATELY
                
                const archiveData = ws.pendingArchive;
                const nodeName = archiveData.node;
                const fileName = `${nodeName}/${Date.now()}.jpg`;

                try {
                    console.log(`📸 Processing Supabase Archive for ${nodeName}...`);
                    
                    // A. Upload Image to Storage
                    const { error: storageError } = await supabase.storage
                        .from('pinyaseek-archives')
                        .upload(fileName, data, { 
                            contentType: 'image/jpeg',
                            upsert: true 
                        });

                    if (storageError) throw storageError;

                    // B. Get Public URL
                    const { data: { publicUrl } } = supabase.storage
                        .from('pinyaseek-archives')
                        .getPublicUrl(fileName);

                    // C. Insert NPK Data + URL into Table
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
                    console.log(`✅ Supabase Archive Success: ${nodeName}`);

                } catch (err) {
                    console.error("❌ Supabase Error:", err.message);
                } finally {
                    ws.pendingArchive = null; 
                    // Note: ws.isArchiving remains true until the next 'hourly_archive' 
                    // JSON arrives to ignore any remaining image chunks.
                }
            }
        }

        // --- 4. BROADCAST EVERYTHING TO DASHBOARD ---
        wss.clients.forEach((client) => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
                client.send(data);
            }
        });
    });

    ws.on('close', () => console.log('Node disconnected'));
});

// Self-ping to keep Render awake (14 mins)
setInterval(() => {
    const host = process.env.RENDER_EXTERNAL_HOSTNAME;
    if (host) {
        http.get(`http://${host}`);
    }
}, 840000); 

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Supabase Backend Live on Port ${PORT}`));