const express = require("express")
const http = require("http")
const WebSocket = require("ws")
const streamManager = require("./streamManager")

const app = express()
const server = http.createServer(app)

app.use(express.static("public"))

const wss = new WebSocket.Server({ server })

wss.on("connection", ws => {

    ws.on("message", data => {

        streamManager.updateFrame(data)

    })

    streamManager.addViewer(ws)

})

server.listen(process.env.PORT || 3000)